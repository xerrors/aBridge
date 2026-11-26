import { test } from "node:test";
import assert from "node:assert/strict";
import { platformIcon, platformName } from "../src/components/icons.js";
import { deviceTypeLabel } from "../src/features/devices/metadata.js";
import { deviceViewSchema } from "@abridge/protocol";
import { existsSync } from "node:fs";

const device = {
  id: "fixture-device",
  name: "Fixture computer",
  kind: "computer",
  capabilities: ["shell"],
  status: "offline",
  paused: false,
  available: {},
  active_operations: [],
  last_seen: null,
  created_at: 0,
};

test("unknown platform metadata stays unknown in device labels and icons", () => {
  for (const platform of [undefined, null, "", " \t "]) {
    const parsed = deviceViewSchema.parse({ ...device, platform });
    assert.equal(parsed.platform, null);
    assert.equal(platformName(parsed.platform), "未知平台");
    assert.equal(platformIcon(parsed.platform), undefined);
  }
});

test("offline platforms retain their label without inventing a browser brand", () => {
  for (const status of ["online", "offline"]) {
    const computer = deviceViewSchema.parse({ ...device, status, platform: " win32 " });
    assert.equal(platformName(computer.platform), "Windows");
    assert.equal(platformIcon(computer.platform), "windows");
    const browser = deviceViewSchema.parse({
      ...device,
      status,
      kind: "browser",
      capabilities: ["browser"],
      platform: "Browser extension",
    });
    assert.equal(platformName(browser.platform), "浏览器扩展");
    assert.equal(platformIcon(browser.platform), undefined);
  }
});

test("Chrome keeps its label and shipped icon online and offline", () => {
  for (const status of ["online", "offline"]) {
    const browser = deviceViewSchema.parse({
      ...device,
      kind: "browser",
      capabilities: ["browser"],
      status,
      platform: "chrome",
    });
    assert.equal(platformName(browser.platform), "Chrome");
    assert.equal(platformIcon(browser.platform), "chrome");
    assert.ok(existsSync(new URL("../../../docs/assets/brand/platforms/chrome.svg", import.meta.url)));
  }
});

test("native device type labels use reported platforms rather than transport kind or chat support", () => {
  for (const [platform, expected] of [
    ["android", "Android"],
    [" iOS ", "iOS"],
    ["darwin", "macOS"],
    ["win32", "Windows"],
    ["linux", "Linux"],
    ["Custom OS", "Custom OS"],
  ]) {
    for (const status of ["online", "offline"]) {
      for (const chat_available of [true, false]) {
        const parsed = deviceViewSchema.parse({ ...device, platform, status });
        assert.equal(deviceTypeLabel({ ...parsed, ...{ chat_available } }), expected);
      }
    }
  }
});

test("device type labels keep browsers distinct and missing native platforms neutral", () => {
  for (const platform of [undefined, null, "", " "]) {
    assert.equal(deviceTypeLabel({ kind: "computer", platform }), "本机设备");
    assert.equal(deviceTypeLabel({ kind: "browser", platform }), "浏览器");
  }
  assert.equal(deviceTypeLabel({ kind: "browser", platform: "chrome" }), "浏览器");
});
