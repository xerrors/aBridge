import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackProfileName, profileDeviceName, registrationDeviceName } from "../src/profile-name.js";

function profileApi(allowed: boolean, read = async () => ({ email: "work@example.test", id: "fixture" })) {
  let reads = 0;
  return {
    permissions: {
      contains: async (permissions: chrome.permissions.Permissions) => {
        assert.deepEqual(permissions, { permissions: ["identity.email"] });
        return allowed;
      },
      request: async () => assert.fail("Default naming must never request permission"),
    },
    identity: {
      getProfileUserInfo: async (details: chrome.identity.ProfileDetails) => {
        reads++;
        assert.deepEqual(details, { accountStatus: "ANY" });
        return read();
      },
    },
    get reads() {
      return reads;
    },
  };
}

test("first binding uses a manual fallback without requesting access to the Profile account", async () => {
  const api = profileApi(false);
  assert.equal(await profileDeviceName(api), "Chrome · Profile");
  assert.equal(api.reads, 0);
});

test("an already-granted Profile permission names the browser from its account email", async () => {
  const api = profileApi(true);
  assert.equal(await profileDeviceName(api), "Chrome · work@example.test");
  assert.equal(api.reads, 1);
  const long = await profileDeviceName(profileApi(true, async () => ({ email: "a".repeat(100), id: "id" })));
  assert.equal(long.length, 80, "The suggestion must fit the binding name field");
});

test("missing accounts and unsupported Profile reads preserve the editable fallback", async () => {
  for (const read of [
    async () => ({ email: "", id: "" }),
    async () => {
      throw new Error("Profile identity unavailable");
    },
  ])
    assert.equal(await profileDeviceName(profileApi(true, read)), fallbackProfileName);
});

test("a delayed Profile read preserves edits, cleared fields, and restored binding or pending-flow names", async () => {
  let resolve!: (value: { email: string; id: string }) => void;
  const suggestion = profileDeviceName(
    profileApi(true, () => new Promise((complete) => (resolve = complete))),
  );
  await new Promise<void>((complete) => setImmediate(complete));
  resolve({ email: "work@example.test", id: "fixture" });
  const name = await suggestion;
  assert.equal(registrationDeviceName("My browser", true, undefined, name), "My browser");
  assert.equal(registrationDeviceName("", true, undefined, name), "");
  assert.equal(registrationDeviceName(fallbackProfileName, false, "Saved device", name), "Saved device");
  assert.equal(
    registrationDeviceName(fallbackProfileName, false, "Awaiting consent", name),
    "Awaiting consent",
  );
  assert.equal(
    registrationDeviceName(fallbackProfileName, false, undefined, name),
    "Chrome · work@example.test",
  );
});
