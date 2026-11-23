package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/xerrors/aBridge/apps/agent/internal/mcp"
	"github.com/xerrors/aBridge/apps/agent/internal/model"
)

type oneDecision struct{}

func (oneDecision) Next(_ context.Context, _ []model.Message, _ []mcp.Tool) (model.Message, error) {
	return model.Message{Role: "assistant", ToolCalls: []model.ToolCall{{
		ID: "decision", Name: "computer_act",
		Arguments: json.RawMessage(`{"session_id":"wrong-session","observation_id":"seen","action":{"type":"click","element_ref":"e4"}}`),
	}}}, nil
}

type disconnectedInput struct {
	calls   []string
	session string
}

func (b *disconnectedInput) Tools(context.Context) ([]mcp.Tool, error) {
	schema := json.RawMessage(`{"type":"object","properties":{"session_id":{"type":"string"}},"required":["session_id"]}`)
	return []mcp.Tool{{Name: "computer_observe", InputSchema: schema}, {Name: "computer_act", InputSchema: schema}}, nil
}

func (b *disconnectedInput) Call(_ context.Context, name string, args map[string]json.RawMessage) (mcp.Result, error) {
	b.calls = append(b.calls, name)
	var text string
	switch name {
	case "device_get":
		text = `{"platform":"android","status":"online","interaction_state":"ready"}`
	case "session_open":
		text = `{"id":"authorized","device":{"platform":"android"},"available_tools":["computer_observe","computer_act"]}`
	case "computer_observe":
		text = `{"status":"executed","result":{"observation_id":"seen","focus_status":"confirmed","elements":[]}}`
	case "computer_act":
		_ = json.Unmarshal(args["session_id"], &b.session)
		return mcp.Result{}, errors.New("connection lost")
	case "session_close":
		text = `{"status":"stopped"}`
	}
	return mcp.Result{Text: json.RawMessage(text)}, nil
}

func TestUncertainActionStopsAndClosesTheSession(t *testing.T) {
	b := &disconnectedInput{}
	r := Runner{Bridge: b, Planner: oneDecision{}}
	var steps []string
	_, err := r.Run(context.Background(), "task", "dev", "tap the button", func(_, status string) { steps = append(steps, status) })
	if err == nil || !slices.Equal(steps, []string{"executed", "outcome_unknown"}) {
		t.Fatalf("response error=%v, steps %v", err, steps)
	}
	if b.session != "authorized" || !slices.Equal(withoutDeviceChecks(b.calls), []string{"session_open", "computer_observe", "computer_act", "session_close"}) {
		t.Fatalf("session %s, calls %v", b.session, b.calls)
	}
}

type prematureText struct{}

func (prematureText) Next(context.Context, []model.Message, []mcp.Tool) (model.Message, error) {
	return model.Message{Role: "assistant", Content: "I will click the button."}, nil
}

func TestTextWithoutFinishToolDoesNotCompleteTheTask(t *testing.T) {
	b := &disconnectedInput{}
	r := Runner{Bridge: b, Planner: prematureText{}}
	_, err := r.Run(context.Background(), "task", "dev", "tap the button", func(string, string) {})
	if err == nil || !slices.Equal(withoutDeviceChecks(b.calls), []string{"session_open", "computer_observe", "session_close"}) {
		t.Fatalf("response error=%v, calls %v", err, b.calls)
	}
}

func withoutDeviceChecks(calls []string) []string {
	return slices.DeleteFunc(slices.Clone(calls), func(call string) bool { return call == "device_get" })
}

type standbyBridge struct {
	disconnectedInput
	states       []string
	observations int
	opened       int
	operationIDs []string
	refuseFirst  bool
	refuseAction bool
}

func (b *standbyBridge) Call(ctx context.Context, name string, args map[string]json.RawMessage) (mcp.Result, error) {
	if name == "device_get" {
		b.calls = append(b.calls, name)
		state := "ready"
		if len(b.states) > 0 {
			state, b.states = b.states[0], b.states[1:]
		}
		connection := "online"
		if state == "offline" {
			connection, state = "offline", ""
		}
		text, _ := json.Marshal(map[string]any{"platform": "android", "status": connection, "interaction_state": state})
		return mcp.Result{Text: text}, nil
	}
	if name == "session_open" {
		b.calls = append(b.calls, name)
		b.opened++
		text := fmt.Sprintf(`{"id":"session-%d","device":{"platform":"android"},"available_tools":["computer_observe","computer_act"]}`, b.opened)
		return mcp.Result{Text: json.RawMessage(text)}, nil
	}
	if name == "computer_observe" {
		b.calls = append(b.calls, name)
		b.observations++
		var id string
		_ = json.Unmarshal(args["operation_id"], &id)
		b.operationIDs = append(b.operationIDs, id)
		if b.refuseFirst {
			b.refuseFirst = false
			b.states = append([]string{"locked", "ready"}, b.states...)
			return mcp.Result{IsError: true, Text: json.RawMessage(`{"status":"refused","error":{"code":"device_locked"}}`)}, nil
		}
		text := fmt.Sprintf(`{"status":"executed","result":{"observation_id":"seen-%d","focus_status":"confirmed","elements":[]}}`, b.observations)
		return mcp.Result{Text: json.RawMessage(text)}, nil
	}
	if name == "computer_act" && b.refuseAction {
		b.refuseAction = false
		b.calls = append(b.calls, name)
		return mcp.Result{IsError: true, Text: json.RawMessage(`{"error":{"code":"session_connection_lost"}}`)}, nil
	}
	return b.disconnectedInput.Call(ctx, name, args)
}

type finishingPlanner struct {
	actionFirst bool
	calls       int
	history     []model.Message
}

func (p *finishingPlanner) Next(_ context.Context, history []model.Message, _ []mcp.Tool) (model.Message, error) {
	p.calls++
	p.history = slices.Clone(history)
	if p.actionFirst && p.calls == 1 {
		return oneDecision{}.Next(context.Background(), nil, nil)
	}
	return model.Message{Role: "assistant", ToolCalls: []model.ToolCall{{ID: "finished", Name: "finish_task", Arguments: json.RawMessage(`{"status":"completed","result":"verified"}`)}}}, nil
}

func TestLockedInitialDeviceWaitsBeforeSessionAndModel(t *testing.T) {
	bridge := &standbyBridge{states: []string{"locked", "ready"}}
	planner := &finishingPlanner{}
	var states []string
	value, err := (Runner{Bridge: bridge, Planner: planner}).Run(context.Background(), "task", "dev", "describe", func(_, status string) { states = append(states, status) })
	if err != nil || value != "verified" || planner.calls != 1 {
		t.Fatalf("value %q error %v planner calls %d", value, err, planner.calls)
	}
	if !slices.Equal(states[:2], []string{"waiting_for_unlock", "running"}) || bridge.calls[0] != "device_get" || bridge.calls[1] != "device_get" {
		t.Fatalf("states %v calls %v", states, bridge.calls)
	}
}

func TestLockDuringPlanningDiscardsActionAndObservesAgain(t *testing.T) {
	bridge := &standbyBridge{states: []string{"ready", "ready", "locked", "ready"}}
	planner := &finishingPlanner{actionFirst: true}
	_, err := (Runner{Bridge: bridge, Planner: planner}).Run(context.Background(), "task", "dev", "tap", func(string, string) {})
	if err != nil || bridge.opened != 2 || bridge.observations != 2 || slices.Contains(bridge.calls, "computer_act") {
		t.Fatalf("error %v opened %d observations %d calls %v", err, bridge.opened, bridge.observations, bridge.calls)
	}
	if bridge.operationIDs[0] == bridge.operationIDs[1] {
		t.Fatalf("new observations reused operation id %v", bridge.operationIDs)
	}
	last := planner.history[len(planner.history)-1]
	if last.Role != "tool" || last.ToolCallID != "decision" || !strings.Contains(last.Content, "seen-2") || !strings.Contains(last.Content, "not executed") {
		t.Fatalf("recovery history %#v", last)
	}
}

func TestObservationAdmissionRaceWaitsAndRefreshesSession(t *testing.T) {
	bridge := &standbyBridge{refuseFirst: true}
	planner := &finishingPlanner{}
	_, err := (Runner{Bridge: bridge, Planner: planner}).Run(context.Background(), "task", "dev", "describe", func(string, string) {})
	if err != nil || bridge.opened != 2 || bridge.observations != 2 || planner.calls != 1 {
		t.Fatalf("error %v opened %d observations %d planner calls %d", err, bridge.opened, bridge.observations, planner.calls)
	}
}

func TestWaitHonorsDeadlineWithoutOpeningSession(t *testing.T) {
	bridge := &standbyBridge{states: []string{"offline"}}
	planner := &finishingPlanner{}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Millisecond)
	defer cancel()
	var states []string
	_, err := (Runner{Bridge: bridge, Planner: planner}).Run(ctx, "task", "dev", "describe", func(_, status string) { states = append(states, status) })
	if !errors.Is(err, context.DeadlineExceeded) || bridge.opened != 0 || planner.calls != 0 || !slices.Equal(states, []string{"waiting_for_device"}) {
		t.Fatalf("error %v states %v opened %d planner calls %d", err, states, bridge.opened, planner.calls)
	}
}

func TestScreenOffWaitHasDistinctStatus(t *testing.T) {
	bridge := &standbyBridge{states: []string{"screen_off"}}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Millisecond)
	defer cancel()
	var states []string
	_, err := (Runner{Bridge: bridge}).Run(ctx, "task", "dev", "describe", func(_, status string) { states = append(states, status) })
	if !errors.Is(err, context.DeadlineExceeded) || !slices.Equal(states, []string{"waiting_for_screen"}) {
		t.Fatalf("error %v states %v", err, states)
	}
}

func TestReconnectBetweenReadinessChecksReopensSessionWithoutReplayingInput(t *testing.T) {
	bridge := &standbyBridge{refuseAction: true}
	planner := &finishingPlanner{actionFirst: true}
	_, err := (Runner{Bridge: bridge, Planner: planner}).Run(context.Background(), "task", "dev", "tap", func(string, string) {})
	if err != nil || bridge.opened != 2 || bridge.observations != 2 || planner.calls != 2 {
		t.Fatalf("error %v opened %d observations %d planner calls %d", err, bridge.opened, bridge.observations, planner.calls)
	}
	var inputs int
	for _, call := range bridge.calls {
		if call == "computer_act" {
			inputs++
		}
	}
	if inputs != 1 {
		t.Fatalf("refused input was replayed: %v", bridge.calls)
	}
	last := planner.history[len(planner.history)-1]
	if last.Role != "user" || !strings.Contains(last.Content, "seen-2") {
		t.Fatalf("missing recovery observation: %#v", last)
	}
}
