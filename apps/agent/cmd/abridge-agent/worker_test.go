package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type workerFixture struct {
	mu                       sync.Mutex
	events                   []map[string]any
	finish                   map[string]any
	methods                  []string
	badCleanup, stop         bool
	failedEvents, failedOpen bool
}

func (f *workerFixture) serve(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/task-worker/") {
		if r.Header.Get("Authorization") != "Bearer worker-secret" {
			w.WriteHeader(401)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		defer f.mu.Unlock()
		if strings.HasSuffix(r.URL.Path, "/events") {
			if f.failedEvents {
				w.WriteHeader(503)
				return
			}
			f.events = append(f.events, body)
		}
		if strings.HasSuffix(r.URL.Path, "/finish") {
			f.finish = body
		}
		if strings.HasSuffix(r.URL.Path, "/heartbeat") {
			_ = json.NewEncoder(w).Encode(map[string]any{"stop": f.stop})
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.URL.Path == "/chat/completions" {
		if f.stop {
			_, _ = io.Copy(io.Discard, r.Body)
			<-r.Context().Done()
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "tool_calls", "message": map[string]any{"role": "assistant", "content": "Verified target screen", "reasoning_content": "PRIVATE REASONING MUST NOT APPEAR", "tool_calls": []any{map[string]any{"id": "finish", "type": "function", "function": map[string]any{"name": "finish_task", "arguments": `{"status":"completed","result":"Target verified"}`}}}}}}})
		return
	}
	if r.URL.Path != "/mcp" || r.Header.Get("Authorization") != "Bearer scoped-secret" {
		w.WriteHeader(401)
		return
	}
	var request struct {
		ID     uint64 `json:"id"`
		Method string `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	_ = json.NewDecoder(r.Body).Decode(&request)
	var result any
	if request.Method == "tools/list" {
		result = map[string]any{"tools": []any{map[string]any{"name": "computer_observe", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}}, map[string]any{"name": "computer_act", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}}}}
	} else {
		f.mu.Lock()
		f.methods = append(f.methods, request.Params.Name)
		f.mu.Unlock()
		text := `{}`
		switch request.Params.Name {
		case "device_get":
			text = `{"platform":"android","status":"online","interaction_state":"ready"}`
		case "session_open":
			if f.failedOpen {
				w.WriteHeader(503)
				return
			}
			text = `{"id":"session-test","device":{"platform":"android"},"available_tools":["computer_observe","computer_act"]}`
		case "session_close":
			if f.badCleanup {
				text = `{"status":"stopped","session_id":"different"}`
			} else {
				text = `{"status":"stopped","session_id":"session-test"}`
			}
		case "computer_observe":
			text = `{"status":"executed","operation_id":"op_test","result":{"observation_id":"obs_test","focus_status":"confirmed","elements":[]}}`
		}
		result = map[string]any{"structuredContent": json.RawMessage(text), "content": []any{map[string]any{"type": "text", "text": text}}}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
}

func TestWorkerReportsEventsAndWaitsForCleanup(t *testing.T) {
	for _, bad := range []bool{false, true} {
		t.Run(map[bool]string{false: "confirmed", true: "unconfirmed"}[bad], func(t *testing.T) {
			fixture := &workerFixture{badCleanup: bad}
			server := httptest.NewServer(http.HandlerFunc(fixture.serve))
			defer server.Close()
			worker := taskWorker{base: server.URL, key: "worker-secret", modelURL: server.URL, modelName: "fixture", http: server.Client()}
			worker.execute(context.Background(), workerTask{ID: "task-test", Device: "device-test", Prompt: "reach target", Lease: "lease", AgentKey: "scoped-secret"})
			want := "done"
			if bad {
				want = "unknown"
			}
			if fixture.finish["status"] != want || fixture.finish["cleanup_confirmed"] != !bad {
				t.Fatalf("finish: %#v", fixture.finish)
			}
			if len(fixture.methods) == 0 || fixture.methods[len(fixture.methods)-1] != "session_close" {
				t.Fatalf("missing final close: %v", fixture.methods)
			}
			decision, receipt := false, false
			for i, event := range fixture.events {
				if event["sequence"] != float64(i+1) {
					t.Fatalf("sequence: %#v", event)
				}
				encoded, _ := json.Marshal(event)
				if strings.Contains(string(encoded), "PRIVATE REASONING") {
					t.Fatal("private reasoning leaked")
				}
				if event["status"] == "decision" {
					decision = true
				}
				if event["tool"] == "computer_observe" && event["status"] == "returned" {
					_, receipt = event["receipt"].(string)
				}
			}
			if !decision || !receipt {
				t.Fatalf("missing decision or string receipt: %#v", fixture.events)
			}
		})
	}
}

func TestWorkerHeartbeatStopsBlockedPlannerAndClosesSession(t *testing.T) {
	fixture := &workerFixture{stop: true}
	server := httptest.NewServer(http.HandlerFunc(fixture.serve))
	defer server.Close()
	worker := taskWorker{base: server.URL, key: "worker-secret", modelURL: server.URL, modelName: "fixture", http: server.Client()}
	worker.execute(context.Background(), workerTask{ID: "task-test", Device: "device-test", Prompt: "reach target", Lease: "lease", AgentKey: "scoped-secret"})
	if fixture.finish["status"] != "stopped" || fixture.finish["cleanup_confirmed"] != true {
		t.Fatalf("finish: %#v", fixture.finish)
	}
}

func TestWorkerFailureDoesNotClaimCleanupWithoutProof(t *testing.T) {
	for _, stage := range []string{"events", "open"} {
		t.Run(stage, func(t *testing.T) {
			fixture := &workerFixture{failedEvents: stage == "events", failedOpen: stage == "open"}
			server := httptest.NewServer(http.HandlerFunc(fixture.serve))
			defer server.Close()
			worker := taskWorker{base: server.URL, key: "worker-secret", modelURL: server.URL, modelName: "fixture", http: server.Client()}
			worker.execute(context.Background(), workerTask{ID: "task-test", Device: "device-test", Prompt: "reach target", Lease: "lease", AgentKey: "scoped-secret"})
			if fixture.finish["status"] != "unknown" || fixture.finish["cleanup_confirmed"] != (stage == "events") {
				t.Fatalf("finish: %#v", fixture.finish)
			}
			if stage == "events" && (len(fixture.methods) != 1 || fixture.methods[0] != "device_get") {
				t.Fatalf("MCP executed after event reporting failed: %v", fixture.methods)
			}
		})
	}
}
