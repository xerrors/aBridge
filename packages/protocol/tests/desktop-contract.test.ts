import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { desktopContract, windowsDesktopContract } from "../src/desktop-contract.js";
import {
  DESKTOP_OBSERVATION_SECONDS,
  deviceAuthorizationRequestSchema,
  deviceAuthorizationTokenRequestSchema,
  windowsShellRequestSchema,
} from "../src/index.js";

test("Windows private host schemas do not enter the shared native asset", () => {
  const common = desktopContract();
  const before = JSON.stringify(common);
  const windows = windowsDesktopContract();
  for (const [name, schema] of Object.entries({
    windowsShellRequest: windowsShellRequestSchema,
    deviceAuthorizationRequest: deviceAuthorizationRequestSchema,
    deviceAuthorizationTokenRequest: deviceAuthorizationTokenRequestSchema,
  })) {
    assert.equal(Object.hasOwn(common.schemas, name), false);
    assert.deepEqual(windows.schemas[name], z.toJSONSchema(schema, { io: "input" }));
  }
  assert.equal(Object.hasOwn(common.limits, "desktopObservationSeconds"), false);
  assert.equal(windows.limits.desktopObservationSeconds, DESKTOP_OBSERVATION_SECONDS);
  for (const [name, schema] of Object.entries(common.schemas)) {
    assert.deepEqual(windows.schemas[name], schema);
  }
  assert.equal(JSON.stringify(common), before);
  assert.equal(JSON.stringify(desktopContract()), before);
});
