import { test } from "node:test";
import assert from "node:assert/strict";
import { takeAdminToken } from "../src/instance-admin-session.js";

test("admin links remove their bootstrap secret while preserving the page and query", () => {
  const address = new URL("https://bridge.example.com/?source=terminal#admin_token=abr_admin_fixture");
  let replacement: string | undefined;
  assert.equal(
    takeAdminToken(address, (url) => {
      replacement = url;
    }),
    "abr_admin_fixture",
  );
  assert.equal(replacement, "/?source=terminal#admin");
  assert.equal(replacement.includes("abr_admin_fixture"), false);
});

test("invalid admin links still erase the secret before reporting failure", () => {
  for (const hash of ["#admin_token=", "#admin_token=first&admin_token=second"]) {
    let stripped = false;
    assert.throws(() =>
      takeAdminToken({ hash, pathname: "/", search: "" }, () => {
        stripped = true;
      }),
    );
    assert.equal(stripped, true);
  }
});

test("ordinary visits do not modify navigation fragments or invent admin credentials", () => {
  assert.equal(
    takeAdminToken({ hash: "#devices", pathname: "/", search: "" }, () =>
      assert.fail("unexpected navigation"),
    ),
    "",
  );
});

test("logout waits for a pending token exchange so a late cookie cannot restore administrator access", async () => {
  const { AdminSessionRequests } = await import("../src/instance-admin-session.js");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let hasCookie = false;
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const posting = new Promise<void>((resolve) => {
    started = resolve;
  });
  globalThis.fetch = async (_url, options) => {
    const method = options?.method ?? "GET";
    calls.push(method);
    if (method === "POST") {
      started();
      await pending;
      hasCookie = true;
      return Response.json({ admin: true });
    }
    hasCookie = false;
    return Response.json({ ok: true });
  };
  try {
    const requests = new AdminSessionRequests();
    const exchange = requests.exchange("fixture-root-token");
    await posting;
    const logout = requests.logout();
    await Promise.resolve();
    assert.deepEqual(calls, ["POST"], "Logout must not race the earlier Set-Cookie response");
    release();
    await Promise.all([exchange, logout]);
    assert.deepEqual(calls, ["POST", "DELETE"]);
    assert.equal(hasCookie, false, "The last logout determines the final browser cookie");
  } finally {
    release();
    globalThis.fetch = originalFetch;
  }
});

test("a failed token exchange does not prevent a queued administrator logout", async () => {
  const { AdminSessionRequests } = await import("../src/instance-admin-session.js");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(options?.method ?? "GET");
    return options?.method === "POST"
      ? Response.json({ error: { message: "Invalid token" } }, { status: 401 })
      : Response.json({ ok: true });
  };
  try {
    const requests = new AdminSessionRequests();
    const exchange = requests.exchange("invalid");
    const logout = requests.logout();
    await assert.rejects(exchange, /Invalid token/);
    await logout;
    assert.deepEqual(calls, ["POST", "DELETE"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
