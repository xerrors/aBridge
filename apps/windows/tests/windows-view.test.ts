import test from "node:test";
import assert from "node:assert/strict";
import { windowsView } from "../src/windows-view.js";

const now = 2_000_000;
const ready = { bound: true, connection: "online", updated_at: now / 1000, paused: false };
test("Windows status never presents a failed or stale observation as ready", () => {
  for (const status of [
    undefined,
    { ...ready, updated_at: now / 1000 - 11 },
    { ...ready, updated_at: now / 1000 + 60 },
  ]) {
    const view = windowsView(status, now);
    assert.equal(view.kind, "unknown");
    assert.equal(view.online, false);
    assert.equal(view.operations, 0);
  }
});
test("Windows shows offline and pause independently without offering false readiness", () => {
  const view = windowsView({ ...ready, connection: "offline", paused: true, active_operations: 3 }, now);
  assert.equal(view.kind, "offline");
  assert.match(view.label, /离线.*暂停/);
  assert.equal(view.operations, 0);
  assert.equal(view.paused, true);
  assert.equal(windowsView({ ...ready, paused: true, active_operations: 2 }, now).kind, "paused");
});
test("Windows distinguishes authorization, idle connection and actual activity", () => {
  assert.equal(windowsView({ bound: false, busy: true }, now).kind, "authorizing");
  assert.equal(windowsView({ bound: false }, now).kind, "unbound");
  assert.equal(windowsView(ready, now).kind, "ready");
  assert.equal(windowsView({ ...ready, active_operations: 2 }, now).kind, "active");
  for (const active_operations of [-1, NaN, Infinity, 0.5, "bad"]) {
    assert.equal(windowsView({ ...ready, active_operations }, now).kind, "ready");
  }
});
