import { test } from "node:test";
import assert from "node:assert/strict";
import { executionSteps } from "../src/features/tasks/trace.js";
test("worker decision, arguments, receipt and callback form one collapsed step per tool call", () => {
  const steps = executionSteps([
    { sequence: 1, status: "decision", summary: "打开目标", created_at: 1 },
    { sequence: 2, tool: "browser_code", status: "started", receipt: '{"code":"observe()"}', created_at: 2 },
    { sequence: 3, tool: "browser_code", status: "returned", receipt: '{"ok":true}', created_at: 3 },
    { sequence: 4, tool: "browser_code", status: "executed", created_at: 4 },
    { sequence: 5, status: "decision", summary: "再观察一次", created_at: 5 },
    { sequence: 6, tool: "browser_code", status: "started", receipt: '{"code":"observe()"}', created_at: 6 },
    { sequence: 7, tool: "browser_code", status: "error", receipt: '{"error":"offline"}', created_at: 7 },
  ]);
  assert.equal(steps.length, 2);
  assert.equal(steps[0]?.summary, "打开目标");
  assert.equal(steps[0]?.arguments, '{"code":"observe()"}');
  assert.equal(steps[0]?.receipt, '{"ok":true}');
  assert.equal(steps[1]?.status, "error");
  assert.equal(steps[1]?.image, undefined);
});
test("independent cleanup and final decisions remain visible and event input is unchanged", () => {
  const events = [
    { sequence: 2, tool: "session_close", status: "returned", created_at: 2 },
    { sequence: 1, status: "decision", summary: "完成", created_at: 1 },
  ];
  const before = JSON.stringify(events);
  const steps = executionSteps(events);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.tool, "session_close");
  assert.equal(JSON.stringify(events), before);
});
