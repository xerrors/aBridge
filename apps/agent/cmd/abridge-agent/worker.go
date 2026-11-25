package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/xerrors/aBridge/apps/agent/internal/agent"
	"github.com/xerrors/aBridge/apps/agent/internal/mcp"
	"github.com/xerrors/aBridge/apps/agent/internal/model"
)

type workerTask struct {
	ID       string `json:"id"`
	Device   string `json:"device_id"`
	Prompt   string `json:"prompt"`
	Lease    string `json:"lease_token"`
	AgentKey string `json:"agent_key"`
}

type taskWorker struct {
	base, key, modelURL, modelName, modelKey string
	http                                     *http.Client
}

func (w *taskWorker) request(ctx context.Context, path string, body, target any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, w.base+"/api/task-worker"+path, bytes.NewReader(data))
	if err != nil {
		return errors.New("invalid task server URL")
	}
	req.Header.Set("Authorization", "Bearer "+w.key)
	req.Header.Set("Content-Type", "application/json")
	res, err := w.http.Do(req)
	if err != nil {
		return errors.New("task server transport failed")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("task server HTTP status %d", res.StatusCode)
	}
	if target == nil {
		_, err = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
		return err
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(target)
}

func (w *taskWorker) run(ctx context.Context, parallelism int) {
	var workers sync.WaitGroup
	for i := 0; i < parallelism; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for ctx.Err() == nil {
				var claim struct {
					Task *workerTask `json:"task"`
				}
				if err := w.request(ctx, "/claim", struct{}{}, &claim); err != nil {
					if ctx.Err() == nil {
						log.Printf("task claim: %v", err)
					}
				} else if claim.Task != nil {
					if !validID(claim.Task.ID) || !validID(claim.Task.Device) || claim.Task.Lease == "" || claim.Task.AgentKey == "" {
						log.Print("task claim has invalid fields")
						return
					}
					w.execute(ctx, *claim.Task)
					continue
				}
				timer := time.NewTimer(time.Second)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
		}()
	}
	workers.Wait()
}

type executionReporter struct {
	worker          *taskWorker
	task            workerTask
	cancel          context.CancelFunc
	mu              sync.Mutex
	sequence        int
	failed, unknown bool
}

func (r *executionReporter) event(tool, status, summary string, receipt any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failed {
		return
	}
	r.sequence++
	event := map[string]any{"lease_token": r.task.Lease, "sequence": r.sequence, "status": status}
	if tool != "" {
		event["tool"] = tool
	}
	if summary != "" {
		event["summary"] = boundedText(summary, 3000)
	}
	if receipt != nil {
		data, err := json.Marshal(receipt)
		if err == nil {
			event["receipt"] = boundedText(string(data), 6000)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.worker.request(ctx, "/"+r.task.ID+"/events", event, nil); err != nil {
		r.failed = true
		r.cancel()
	}
	if status == "outcome_unknown" {
		r.unknown = true
	}
}

func boundedText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && (s[n]&0xc0) == 0x80 {
		n--
	}
	return s[:n]
}

type reportingPlanner struct {
	planner  agent.Planner
	reporter *executionReporter
}

func (p reportingPlanner) Next(ctx context.Context, history []model.Message, tools []mcp.Tool) (model.Message, error) {
	decision, err := p.planner.Next(ctx, history, tools)
	if err == nil {
		summary := strings.TrimSpace(decision.Content)
		if summary == "" && len(decision.ToolCalls) > 0 {
			summary = "Next tool: " + decision.ToolCalls[0].Name
		}
		// Only public assistant content is reported. ReasoningContent remains private to the model conversation.
		p.reporter.event("", "decision", summary, nil)
	}
	return decision, err
}

type reportingBridge struct {
	bridge        agent.Bridge
	reporter      *executionReporter
	sessions      map[string]bool
	uncertainOpen bool
}

func (b *reportingBridge) Tools(ctx context.Context) ([]mcp.Tool, error) { return b.bridge.Tools(ctx) }
func (b *reportingBridge) Call(ctx context.Context, name string, args map[string]json.RawMessage) (mcp.Result, error) {
	if name == "session_open" && (len(b.sessions) > 0 || b.uncertainOpen) {
		return mcp.Result{}, errors.New("previous session cleanup not confirmed")
	}
	if name != "session_close" && name != "device_get" {
		b.reporter.event(name, "started", "", args)
	}
	if name != "session_close" && ctx.Err() != nil {
		return mcp.Result{}, ctx.Err()
	}
	result, err := b.bridge.Call(ctx, name, args)
	if name == "session_open" {
		if err != nil {
			b.uncertainOpen = true
		} else if !result.IsError {
			var session struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(result.Text, &session) != nil || session.ID == "" {
				b.uncertainOpen = true
			} else {
				b.sessions[session.ID] = true
			}
		}
	}
	if name == "session_close" && err == nil && !result.IsError {
		var closed struct {
			Status  string `json:"status"`
			Session string `json:"session_id"`
		}
		var id string
		_ = json.Unmarshal(args["session_id"], &id)
		if json.Unmarshal(result.Text, &closed) == nil && closed.Status == "stopped" && closed.Session == id {
			delete(b.sessions, id)
		}
	}
	status := "returned"
	if err != nil {
		status = "error"
		if name == "computer_act" {
			status = "outcome_unknown"
		}
	}
	if result.IsError {
		status = "refused"
	}
	var receipt any
	if len(result.Text) > 0 {
		_ = json.Unmarshal(result.Text, &receipt)
	}
	if name != "device_get" {
		b.reporter.event(name, status, "", receipt)
	}
	return result, err
}

func (w *taskWorker) execute(parent context.Context, task workerTask) {
	ctx, cancel := context.WithTimeout(parent, 3*time.Minute)
	defer cancel()
	reporter := &executionReporter{worker: w, task: task, cancel: cancel}
	bridge := &reportingBridge{bridge: mcp.New(w.base+"/mcp", task.AgentKey, w.http), reporter: reporter, sessions: map[string]bool{}}
	runner := agent.Runner{Bridge: bridge, Planner: reportingPlanner{model.New(w.modelURL, w.modelKey, w.modelName, w.http), reporter}}
	heartbeatDone := make(chan struct{})
	heartbeatStop := make(chan struct{})
	stopped, heartbeatFailed := false, false
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeatStop:
				return
			case <-ticker.C:
				pulse, release := context.WithTimeout(context.Background(), 5*time.Second)
				var answer struct {
					Stop bool `json:"stop"`
				}
				err := w.request(pulse, "/"+task.ID+"/heartbeat", map[string]string{"lease_token": task.Lease}, &answer)
				release()
				if err != nil {
					heartbeatFailed = true
					cancel()
					return
				}
				if answer.Stop {
					stopped = true
					cancel()
				}
			}
		}
	}()
	result, err := runner.Run(ctx, task.ID, task.Device, task.Prompt, func(tool, status string) {
		if tool == "device_wait" && strings.HasPrefix(status, "waiting_for_") {
			reporter.event(tool, "waiting", status, nil)
		} else {
			reporter.event(tool, status, "", nil)
		}
	})
	close(heartbeatStop)
	<-heartbeatDone
	cleanup := len(bridge.sessions) == 0 && !bridge.uncertainOpen
	status := "done"
	if err != nil {
		status = "failed"
	}
	if stopped {
		status = "stopped"
	}
	if !cleanup || reporter.failed || reporter.unknown || heartbeatFailed {
		status = "unknown"
	}
	finish := map[string]any{"lease_token": task.Lease, "status": status, "cleanup_confirmed": cleanup}
	if result != "" {
		finish["result"] = boundedText(result, 4000)
	}
	if err != nil {
		finish["error"] = boundedText(err.Error(), 3000)
	}
	finishCtx, release := context.WithTimeout(context.Background(), 5*time.Second)
	defer release()
	if err := w.request(finishCtx, "/"+task.ID+"/finish", finish, nil); err != nil {
		retryCtx, retryRelease := context.WithTimeout(context.Background(), 5*time.Second)
		defer retryRelease()
		if retryErr := w.request(retryCtx, "/"+task.ID+"/finish", finish, nil); retryErr != nil {
			log.Printf("task %s finish could not be confirmed: %v", task.ID, retryErr)
		}
	}
}
