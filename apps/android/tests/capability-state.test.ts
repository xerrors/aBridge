import assert from "node:assert/strict";
import test from "node:test";
import { capabilityStatus, type CapabilityState } from "../ui/src/capability-state.js";

const ready: CapabilityState = {
  connection: "Online",
  agentAllowed: true,
  interactionState: "ready",
  enabledCapabilities: ["screen", "input", "files"],
  grantedCapabilities: ["screen", "input", "files"],
  directoryAuthorized: true,
};

test("reports why a locally enabled Android capability cannot be used", () => {
  assert.equal(capabilityStatus({ ...ready, connection: "Offline" }, "screen"), "设备离线");
  assert.equal(capabilityStatus({ ...ready, agentAllowed: false }, "input"), "Agent 访问已关闭");
  assert.equal(
    capabilityStatus({ ...ready, enabledCapabilities: ["input"], connection: "Offline" }, "screen"),
    "本机未开启",
  );
  assert.equal(capabilityStatus({ ...ready, connection: "ServiceUnavailable" }, "screen"), "无障碍未连接");
  assert.equal(capabilityStatus({ ...ready, grantedCapabilities: [] }, "screen"), "服务器未授权");
});

test("uses the local prerequisite to explain absence from server grants", () => {
  const grantedCapabilities = ["files"] as CapabilityState["grantedCapabilities"];
  assert.equal(
    capabilityStatus({ ...ready, interactionState: "locked", grantedCapabilities }, "screen"),
    "等待解锁",
  );
  assert.equal(capabilityStatus({ ...ready, interactionState: "screen_off" }, "input"), "等待亮屏");
  assert.equal(capabilityStatus({ ...ready, interactionState: "locked" }, "files"), null);
  assert.equal(
    capabilityStatus({ ...ready, directoryAuthorized: false, grantedCapabilities: [] }, "files"),
    "未授权工作目录",
  );
  assert.equal(capabilityStatus(ready, "files"), null);
});
