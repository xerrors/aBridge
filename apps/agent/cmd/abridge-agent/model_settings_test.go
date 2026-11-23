package main

import "testing"

func TestModelSettingsUsesSystemDeepSeekKeyOnlyForOfficialEndpoint(t *testing.T) {
	env := map[string]string{"DEEPSEEK_API_KEY": "system-test-value"}
	get := func(name string) string { return env[name] }
	address, name, key, err := modelSettings(get)
	if err != nil || address != deepSeekURL || name != deepSeekModel || key != env["DEEPSEEK_API_KEY"] {
		t.Fatal("default DeepSeek configuration unavailable")
	}
	env["ABRIDGE_MODEL_URL"] = "https://custom.example/v1"
	env["ABRIDGE_MODEL"] = "custom-model"
	_, _, key, err = modelSettings(get)
	if err != nil || key != "" {
		t.Fatal("custom model endpoint must require its own credentials")
	}
}
