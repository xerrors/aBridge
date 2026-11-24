package model

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/xerrors/aBridge/apps/agent/internal/mcp"
)

func TestThinkingHistoryRoundTripWithToolCalls(t *testing.T) {
	requests := make(chan struct {
		Messages []wireMessage
		Effort   string `json:"reasoning_effort"`
	}, 2)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Messages []wireMessage
			Effort   string `json:"reasoning_effort"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		requests <- in
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":null,"reasoning_content":"thinking-field-test","tool_calls":[{"id":"call_one","type":"function","function":{"name":"observe","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`)
	}))
	defer s.Close()
	client := New(s.URL, "test", "deepseek-flash", s.Client())
	tools := []mcp.Tool{{Name: "observe", InputSchema: json.RawMessage(`{"type":"object","properties":{}}`)}}
	messages := []Message{{Role: "user", Content: "observe"}}
	response, err := client.Next(context.Background(), messages, tools)
	if err != nil {
		t.Fatal(err)
	}
	<-requests
	messages = append(messages, response, Message{Role: "tool", ToolCallID: "call_one", Content: `{"status":"executed"}`})
	if _, err := client.Next(context.Background(), messages, tools); err != nil {
		t.Fatal(err)
	}
	replayed := <-requests
	if replayed.Effort != "low" || len(replayed.Messages) != 3 || replayed.Messages[1].ReasoningContent != "thinking-field-test" || replayed.Messages[2].ToolCallID != "call_one" {
		t.Fatal("model request lost thinking or tool call history")
	}
}
