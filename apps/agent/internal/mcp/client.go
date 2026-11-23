// Package mcp implements the stateless JSON HTTP subset used by aBridge.
package mcp

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

const maxResponseBytes = 24 << 20

type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}
type Image struct {
	Data     string `json:"data"`
	MIMEType string `json:"mimeType"`
}
type Result struct {
	Text    json.RawMessage `json:"text"`
	IsError bool            `json:"isError"`
	Images  []Image         `json:"images,omitempty"`
}
type Client struct {
	endpoint, key string
	http          *http.Client
	sequence      atomic.Uint64
}

func New(endpoint, key string, client *http.Client) *Client {
	if client == nil {
		client = &http.Client{Timeout: 90 * time.Second}
	}
	return &Client{endpoint: endpoint, key: key, http: client}
}

func (c *Client) request(ctx context.Context, method string, params any, target any) error {
	id := c.sequence.Add(1)
	body, err := json.Marshal(struct {
		Version string `json:"jsonrpc"`
		ID      uint64 `json:"id"`
		Method  string `json:"method"`
		Params  any    `json:"params"`
	}{"2.0", id, method, params})
	if err != nil {
		return fmt.Errorf("encode MCP request: %w", err)
	}
	if len(body) > 2<<20 {
		return fmt.Errorf("MCP request exceeds size limit")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("invalid MCP endpoint")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-03-26")
	if c.key != "" {
		req.Header.Set("Authorization", "Bearer "+c.key)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("MCP transport failed: %w", ctxError(ctx, err))
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("MCP HTTP status %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
	if err != nil {
		return fmt.Errorf("read MCP response: %w", err)
	}
	if len(data) > maxResponseBytes {
		return fmt.Errorf("MCP response exceeds size limit")
	}
	var envelope struct {
		Version string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Result  json.RawMessage `json:"result"`
		Error   *struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err = json.Unmarshal(data, &envelope); err != nil {
		return fmt.Errorf("invalid MCP JSON response")
	}
	var responseID uint64
	if envelope.Version != "2.0" || json.Unmarshal(envelope.ID, &responseID) != nil || responseID != id {
		return fmt.Errorf("MCP response envelope mismatch")
	}
	if envelope.Error != nil {
		return fmt.Errorf("MCP RPC error %d", envelope.Error.Code)
	}
	if len(envelope.Result) == 0 || bytes.Equal(envelope.Result, []byte("null")) {
		return fmt.Errorf("MCP response missing result")
	}
	if err = json.Unmarshal(envelope.Result, target); err != nil {
		return fmt.Errorf("invalid MCP result: %w", err)
	}
	return nil
}

// Avoid including URLs (which may contain credentials) in transport errors.
func ctxError(ctx context.Context, _ error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return fmt.Errorf("connection or protocol error")
}

func (c *Client) Tools(ctx context.Context) ([]Tool, error) {
	result := []Tool{}
	cursor := ""
	seen := map[string]bool{}
	names := map[string]bool{}
	for page := 0; page < 32; page++ {
		params := map[string]string{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var out struct {
			Tools      []Tool `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}
		if err := c.request(ctx, "tools/list", params, &out); err != nil {
			return nil, err
		}
		if out.Tools == nil {
			return nil, fmt.Errorf("MCP tools/list missing tools")
		}
		for _, t := range out.Tools {
			var schema map[string]json.RawMessage
			if strings.TrimSpace(t.Name) == "" || names[t.Name] || json.Unmarshal(t.InputSchema, &schema) != nil || schema == nil {
				return nil, fmt.Errorf("invalid or duplicate MCP tool definition")
			}
			names[t.Name] = true
			result = append(result, t)
		}
		if len(result) > 1024 {
			return nil, fmt.Errorf("MCP tool count exceeds limit")
		}
		if out.NextCursor == "" {
			return result, nil
		}
		if seen[out.NextCursor] {
			return nil, fmt.Errorf("MCP pagination repeated cursor")
		}
		seen[out.NextCursor] = true
		cursor = out.NextCursor
	}
	return nil, fmt.Errorf("MCP pagination exceeds limit")
}

func (c *Client) Call(ctx context.Context, name string, args map[string]json.RawMessage) (Result, error) {
	var result Result
	if strings.TrimSpace(name) == "" {
		return result, fmt.Errorf("MCP tool name is required")
	}
	if args == nil {
		args = map[string]json.RawMessage{}
	}
	var out struct {
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Data     string `json:"data"`
			MIMEType string `json:"mimeType"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := c.request(ctx, "tools/call", map[string]any{"name": name, "arguments": args}, &out); err != nil {
		return result, err
	}
	if out.Content == nil {
		return result, fmt.Errorf("MCP tools/call missing content")
	}
	texts := []json.RawMessage{}
	for _, b := range out.Content {
		switch b.Type {
		case "text":
			value := json.RawMessage(b.Text)
			if !json.Valid(value) {
				value, _ = json.Marshal(b.Text)
			}
			texts = append(texts, value)
		case "image":
			if !strings.HasPrefix(b.MIMEType, "image/") {
				return result, fmt.Errorf("invalid MCP image MIME type")
			}
			if _, err := base64.StdEncoding.DecodeString(b.Data); err != nil {
				return result, fmt.Errorf("invalid MCP image data")
			}
			result.Images = append(result.Images, Image{Data: b.Data, MIMEType: b.MIMEType})
		default:
			return result, fmt.Errorf("unsupported MCP content type %q", b.Type)
		}
	}
	result.IsError = out.IsError
	if len(texts) == 1 {
		result.Text = texts[0]
	} else {
		result.Text, _ = json.Marshal(texts)
	}
	return result, nil
}
