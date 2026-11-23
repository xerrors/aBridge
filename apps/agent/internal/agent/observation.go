package agent

import (
	"encoding/json"
	"unicode/utf8"
)

type screenElement struct {
	Ref           string `json:"element_ref"`
	Text          string `json:"text"`
	Role          string `json:"role,omitempty"`
	Clickable     bool   `json:"clickable,omitempty"`
	Editable      bool   `json:"editable,omitempty"`
	LongClickable bool   `json:"long_clickable,omitempty"`
	Scrollable    bool   `json:"scrollable,omitempty"`
	Checkable     bool   `json:"checkable,omitempty"`
	Checked       bool   `json:"checked"`
	Enabled       bool   `json:"enabled"`
}

type observationView struct {
	ID       string          `json:"observation_id"`
	Focus    string          `json:"focus_status"`
	Actions  []string        `json:"supported_actions"`
	Keys     []string        `json:"supported_keys"`
	Elements []screenElement `json:"elements"`
}

func compactObservation(raw json.RawMessage) json.RawMessage {
	var view observationView
	if json.Unmarshal(raw, &view) != nil || view.ID == "" {
		return raw
	}
	visible := make([]screenElement, 0, min(48, len(view.Elements)))
	for _, element := range view.Elements {
		if element.Text == "" && !element.Clickable && !element.Editable && !element.LongClickable && !element.Scrollable {
			continue
		}
		if utf8.RuneCountInString(element.Text) > 220 {
			element.Text = string([]rune(element.Text)[:220]) + "…"
		}
		visible = append(visible, element)
		if len(visible) == 48 {
			break
		}
	}
	view.Elements = visible
	encoded, _ := json.Marshal(view)
	return encoded
}

func modelResult(raw json.RawMessage) string {
	var receipt map[string]json.RawMessage
	if json.Unmarshal(raw, &receipt) != nil || receipt == nil {
		return string(raw)
	}
	delete(receipt, "session")
	if content := receipt["result"]; len(content) > 0 {
		var result map[string]json.RawMessage
		if json.Unmarshal(content, &result) == nil && result != nil {
			if nested := result["observation"]; len(nested) > 0 {
				result["observation"] = compactObservation(nested)
				receipt["result"], _ = json.Marshal(result)
			} else {
				receipt["result"] = compactObservation(content)
			}
		}
	}
	encoded, _ := json.Marshal(receipt)
	return string(encoded)
}

func observed(raw json.RawMessage) string {
	var current struct {
		ID          string          `json:"observation_id"`
		Focus       string          `json:"focus_status"`
		Observation json.RawMessage `json:"observation"`
	}
	if json.Unmarshal(raw, &current) != nil {
		return ""
	}
	if len(current.Observation) > 0 {
		if json.Unmarshal(current.Observation, &current) != nil {
			return ""
		}
	}
	if current.Focus != "confirmed" {
		return ""
	}
	return current.ID
}
