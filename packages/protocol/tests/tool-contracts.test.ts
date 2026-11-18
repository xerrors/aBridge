import { test } from "node:test";
import assert from "node:assert/strict";
import {
  browserActionSchema,
  browserLocateActSchema,
  parseDeviceToolRequest,
  toolArgumentSchemas,
} from "@abridge/protocol";

test("browser action references and locator inputs share the same action limits", () => {
  const action = { type: "press", key: "k".repeat(32) };
  assert.equal(browserActionSchema.safeParse({ ...action, element_ref: "e1" }).success, true);
  assert.equal(browserLocateActSchema.safeParse({ selector: "#field", action }).success, true);
  for (const length of [0, 33]) {
    const invalid = { ...action, key: "k".repeat(length) };
    assert.equal(browserActionSchema.safeParse({ ...invalid, element_ref: "e1" }).success, false);
    assert.equal(browserLocateActSchema.safeParse({ selector: "#field", action: invalid }).success, false);
  }
});

test("tool parsing preserves defaults and rejects invalid combinations before execution", () => {
  const action = parseDeviceToolRequest({
    tool: "browser_act",
    arguments: { observation_id: "obs_12345678", action: { type: "click", element_ref: "e1" } },
  });
  assert.equal(action.tool, "browser_act");
  assert.deepEqual(action.arguments, {
    observation_id: "obs_12345678",
    action: { type: "click", element_ref: "e1" },
    observe_after: true,
    screenshot: false,
    wait_after_ms: 2000,
  });
  for (const request of [
    { tool: "computer_observe", arguments: { window_id: 1 } },
    { tool: "computer_observe", arguments: { desktop: true, pid: 1 } },
    { tool: "browser_wait", arguments: { selector: "#field", state: "value" } },
    { tool: "browser_wait", arguments: { selector: "#field", value: "3" } },
    { tool: "browser_act", arguments: { ...action.arguments, verify: { selector: "#field", value: "3" } } },
    { tool: "browser_open", arguments: { url: "https://example.test", observe_after: false } },
    { tool: "browser_act", arguments: { ...action.arguments, screenshot: true, observe_after: false } },
  ])
    assert.throws(() => parseDeviceToolRequest(request));
});

test("file and shell argument boundaries share UTF8 and NUL validation", () => {
  assert.equal(
    toolArgumentSchemas.file_write.safeParse({ path: "/fixture", content: "😀 中文" }).success,
    true,
  );
  assert.equal(
    toolArgumentSchemas.file_write.safeParse({ path: "/fixture", content: "\ud800" }).success,
    false,
  );
  assert.equal(
    toolArgumentSchemas.file_write.safeParse({ path: "/fixture", content: "中".repeat(349526) }).success,
    false,
  );
  assert.equal(toolArgumentSchemas.command_execute.safeParse({ command: "echo\0secret" }).success, false);
  assert.equal(toolArgumentSchemas.computer_windows.safeParse({}).success, false);
});
