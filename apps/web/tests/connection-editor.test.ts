import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionExpiry } from "../src/connection-editor.js";

test("editing a connection preserves its exact expiry unless its date or validity changes", () => {
  const original = new Date(2030, 5, 15, 10, 30, 12).getTime() / 1000;
  assert.equal(connectionExpiry(true, "2030-06-15", original), original);
  assert.equal(connectionExpiry(false, "2030-06-15", original), null);
  assert.equal(
    connectionExpiry(true, "2030-06-16", original),
    new Date(2030, 5, 16, 23, 59, 59).getTime() / 1000,
  );
  assert.equal(connectionExpiry(true, "2030-06-15"), new Date(2030, 5, 15, 23, 59, 59).getTime() / 1000);
});
