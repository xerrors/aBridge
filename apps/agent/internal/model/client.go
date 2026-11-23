// Package model implements OpenAI-compatible chat completions with native tools.
package model

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/xerrors/aBridge/apps/agent/internal/mcp"
)

type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}
type Message struct {
	Role             string     `json:"role"`
	Content          string     `json:"content"`
	ReasoningContent string     `json:"reasoning_content,omitempty"`
	ToolCallID       string     `json:"tool_call_id,omitempty"`
	ToolCalls        []ToolCall `json:"tool_calls,omitempty"`
}
type Client struct {
	endpoint, key, model string
	http                 *http.Client
}

func New(endpoint, key, model string, client *http.Client) *Client {
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}
	endpoint = strings.TrimRight(endpoint, "/")
	if !strings.HasSuffix(endpoint, "/chat/completions") {
		endpoint += "/chat/completions"
	}
	return &Client{endpoint: endpoint, key: key, model: model, http: client}
}

type wireCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}
type wireMessage struct {
	Role             string     `json:"role"`
	Content          string     `json:"content"`
	ReasoningContent string     `json:"reasoning_content,omitempty"`
	ToolCallID       string     `json:"tool_call_id,omitempty"`
	ToolCalls        []wireCall `json:"tool_calls,omitempty"`
}

func (c *Client) Next(ctx context.Context, history []Message, tools []mcp.Tool) (Message, error) {
	var empty Message
	if strings.TrimSpace(c.model) == "" {
		return empty, fmt.Errorf("model name is required")
	}
	messages := make([]wireMessage, 0, len(history))
	for _, m := range history {
		switch m.Role {
		case "system", "user", "assistant", "tool":
		default:
			return empty, fmt.Errorf("invalid message role")
		}
		w := wireMessage{Role: m.Role, Content: m.Content, ReasoningContent: m.ReasoningContent, ToolCallID: m.ToolCallID}
		if m.Role == "tool" && m.ToolCallID == "" {
			return empty, fmt.Errorf("tool message missing tool_call_id")
		}
		for _, t := range m.ToolCalls {
			if m.Role != "assistant" || t.ID == "" || t.Name == "" || !objectJSON(t.Arguments) {
				return empty, fmt.Errorf("invalid tool call in history")
			}
			call := wireCall{ID: t.ID, Type: "function"}
			call.Function.Name = t.Name
			call.Function.Arguments = string(t.Arguments)
			w.ToolCalls = append(w.ToolCalls, call)
		}
		messages = append(messages, w)
	}
	functions := make([]any, 0, len(tools))
	allowed := map[string]bool{}
	for _, t := range tools {
		if t.Name == "" || !objectJSON(t.InputSchema) || allowed[t.Name] {
			return empty, fmt.Errorf("invalid model tool definition")
		}
		allowed[t.Name] = true
		functions = append(functions, map[string]any{"type": "function", "function": map[string]any{"name": t.Name, "description": t.Description, "parameters": t.InputSchema}})
	}
	payload := map[string]any{"model": c.model, "messages": messages, "stream": false}
	if len(functions) > 0 {
		payload["tools"] = functions
		payload["tool_choice"] = "auto"
		if strings.HasPrefix(c.model, "deepseek-") {
			payload["reasoning_effort"] = "low"
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return empty, fmt.Errorf("encode model request: %w", err)
	}
	if len(body) > 16<<20 {
		return empty, fmt.Errorf("model request exceeds size limit")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return empty, fmt.Errorf("invalid model endpoint")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if c.key != "" {
		req.Header.Set("Authorization", "Bearer "+c.key)
	}
	res, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return empty, ctx.Err()
		}
		return empty, fmt.Errorf("model connection or protocol error")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return empty, fmt.Errorf("model HTTP status %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, (8<<20)+1))
	if err != nil {
		return empty, fmt.Errorf("read model response: %w", err)
	}
	if len(data) > 8<<20 {
		return empty, fmt.Errorf("model response exceeds size limit")
	}
	var out struct {
		Choices []struct {
			Message      wireMessage `json:"message"`
			FinishReason string      `json:"finish_reason"`
		} `json:"choices"`
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &out) != nil {
		return empty, fmt.Errorf("invalid model JSON response")
	}
	if len(out.Error) > 0 && string(out.Error) != "null" {
		return empty, fmt.Errorf("model returned an API error")
	}
	if len(out.Choices) != 1 {
		return empty, fmt.Errorf("model response must contain one choice")
	}
	choice := out.Choices[0]
	m := choice.Message
	if m.Role != "assistant" {
		return empty, fmt.Errorf("model response is not an assistant message")
	}
	if choice.FinishReason != "stop" && choice.FinishReason != "tool_calls" {
		return empty, fmt.Errorf("model completion incomplete (%s)", choice.FinishReason)
	}
	result := Message{Role: "assistant", Content: m.Content, ReasoningContent: m.ReasoningContent}
	ids := map[string]bool{}
	for _, t := range m.ToolCalls {
		if t.Type != "function" || t.ID == "" || ids[t.ID] || !allowed[t.Function.Name] || !objectJSON([]byte(t.Function.Arguments)) {
			return empty, fmt.Errorf("model returned invalid tool call")
		}
		ids[t.ID] = true
		result.ToolCalls = append(result.ToolCalls, ToolCall{ID: t.ID, Name: t.Function.Name, Arguments: json.RawMessage(t.Function.Arguments)})
	}
	if len(result.ToolCalls) == 0 && strings.TrimSpace(result.Content) == "" {
		return empty, fmt.Errorf("model returned an empty assistant message")
	}
	if choice.FinishReason == "tool_calls" && len(result.ToolCalls) == 0 {
		return empty, fmt.Errorf("model tool-call completion has no calls")
	}
	return result, nil
}
func objectJSON(data []byte) bool {
	var value map[string]json.RawMessage
	return json.Unmarshal(data, &value) == nil && value != nil
}
