import test from "node:test";
import assert from "node:assert/strict";
import { desktopActivity } from "../src/windows-activity.js";

test("desktop activity hides on pause, disconnect, completion, shell-only work and stale status", () => {
  const active = {
    connection: "online",
    paused: false,
    active_operations: 1,
    desktop_active_until: 130,
    updated_at: 100,
  };
  assert.equal(desktopActivity(active, 100), true);
  for (const change of [
    { paused: true },
    { connection: "offline" },
    { active_operations: 0 },
    { desktop_active_until: 0 },
    { updated_at: 97 },
    { updated_at: 103 },
    { updated_at: undefined },
    { active_operations: "1" },
  ])
    assert.equal(desktopActivity({ ...active, ...change }, 100), false);
  assert.equal(desktopActivity({}, 100), false);
  assert.equal(desktopActivity(active, 130), false);
});
