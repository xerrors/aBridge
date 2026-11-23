package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/xerrors/aBridge/apps/agent/internal/mcp"
)

const deviceWaitTimeout = time.Minute
const devicePollInterval = time.Second

type deviceState struct {
	Platform         string `json:"platform"`
	Status           string `json:"status"`
	Paused           bool   `json:"paused"`
	InteractionState string `json:"interaction_state"`
}

func resultError(result mcp.Result) string {
	var failure struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(result.Text, &failure)
	return failure.Error.Code
}

func (r Runner) waitForDevice(ctx context.Context, deviceID string, onStep func(string, string)) (bool, error) {
	waiting, cancel := context.WithTimeout(ctx, deviceWaitTimeout)
	defer cancel()
	waited := false
	lastState := ""
	for {
		if err := waiting.Err(); err != nil {
			return waited, err
		}
		args := map[string]json.RawMessage{}
		put(args, "device_id", deviceID)
		result, err := r.Bridge.Call(waiting, "device_get", args)
		if err != nil {
			return waited, fmt.Errorf("read device readiness: %w", err)
		}
		if result.IsError {
			return waited, fmt.Errorf("device readiness refused (%s)", resultError(result))
		}
		var device deviceState
		if json.Unmarshal(result.Text, &device) != nil || device.Platform != "android" {
			return waited, errors.New("selected device is not Android or its state is invalid")
		}
		if device.Paused {
			return waited, errors.New("device access is paused; resume access locally")
		}
		state := ""
		switch {
		case device.Status == "offline":
			state = "waiting_for_device"
		case device.Status != "online":
			return waited, errors.New("device connection state is invalid")
		case device.InteractionState == "locked":
			state = "waiting_for_unlock"
		case device.InteractionState == "screen_off":
			state = "waiting_for_screen"
		case device.InteractionState != "" && device.InteractionState != "ready":
			return waited, errors.New("device interaction state is invalid")
		}
		if state == "" {
			if waited {
				onStep("device_wait", "running")
			}
			return waited, nil
		}
		waited = true
		if lastState != state {
			onStep("device_wait", state)
			lastState = state
		}
		timer := time.NewTimer(devicePollInterval)
		select {
		case <-waiting.Done():
			timer.Stop()
			return waited, fmt.Errorf("%s: %w", state, waiting.Err())
		case <-timer.C:
		}
	}
}

func deviceWaitError(code string) bool {
	return code == "device_offline" || code == "device_locked" || code == "screen_off"
}

func recoverableSessionError(code string) bool {
	return deviceWaitError(code) || code == "session_closed" || code == "session_expired" ||
		code == "session_connection_lost" || code == "session_connection_replaced" || code == "session_server_restarted"
}
