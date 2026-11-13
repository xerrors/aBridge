import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deviceAuthorizationRequestSchema,
  deviceAuthorizationStartSchema,
  deviceAuthorizationTokenSchema,
  deviceAuthorizationViewSchema,
} from "@abridge/protocol";
import { createServer } from "../src/server.js";
import { DeviceAuthorizations } from "../src/device-authorization.js";
import { BridgeError } from "../src/types.js";

const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const callback = "http://127.0.0.1:51234/abridge/callback";
const state = "browser-authorization-fixture-state";
const request = (changes: Record<string, unknown> = {}) =>
  deviceAuthorizationRequestSchema.parse({
    kind: "computer",
    name: "Fixture Mac",
    capabilities: ["screen", "input"],
    redirect_uri: callback,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...changes,
  });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "abridge-authorization-"));
  const server = await createServer({ dbPath: join(directory, "server.db"), port: 0 });
  const user = await server.store.createUser("fixture", "fixture-password-long");
  const login = (await server.store.login("fixture", "fixture-password-long"))!;
  const cookie = "abridge_session=" + login.token;
  return {
    ...server,
    user,
    cookie,
    async dispose() {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const status = (code: number, errorCode: string) => (error: unknown) =>
  error instanceof BridgeError && error.status === code && error.code === errorCode;

test("browser consent returns a one-time code; PKCE and exact callback protect device issuance", async () => {
  const f = await fixture();
  try {
    const started = await f.app.inject({
      method: "POST",
      url: "/api/device-authorizations",
      payload: request(),
    });
    assert.equal(started.statusCode, 200);
    const start = deviceAuthorizationStartSchema.parse(started.json());
    assert.equal(new URL(start.authorization_url).searchParams.get("authorize"), start.id);
    assert.equal(f.store.devices(f.user.id).length, 0);
    const route = "/api/device-authorizations/" + start.id;
    const publicView = await f.app.inject({ method: "GET", url: route, headers: { cookie: f.cookie } });
    const view = deviceAuthorizationViewSchema.parse(publicView.json());
    assert.equal(view.status, "pending");
    assert.deepEqual(
      Object.keys(view).sort(),
      ["id", "kind", "name", "capabilities", "expires_at", "status"].sort(),
    );
    assert.equal((await f.app.inject({ method: "GET", url: route })).statusCode, 401);
    const changedAccount = await f.app.inject({
      method: "POST",
      url: route + "/decision",
      headers: { cookie: f.cookie },
      payload: { approve: true, expected_user_id: "different-account" },
    });
    assert.equal(changedAccount.statusCode, 409);
    assert.equal(changedAccount.json().error.code, "account_changed");
    const decision = await f.app.inject({
      method: "POST",
      url: route + "/decision",
      headers: { cookie: f.cookie },
      payload: { approve: true, expected_user_id: f.user.id },
    });
    assert.equal(decision.statusCode, 200);
    const returned = new URL(decision.json().redirect_url);
    assert.equal(returned.origin + returned.pathname, callback);
    assert.equal(returned.searchParams.get("state"), state);
    assert.deepEqual([...returned.searchParams.keys()].sort(), ["code", "state"]);
    assert.equal(f.store.devices(f.user.id).length, 0);
    const code = returned.searchParams.get("code")!;
    const token = (changes: Record<string, unknown> = {}) =>
      f.app.inject({
        method: "POST",
        url: "/api/device-authorizations/token",
        payload: { code, code_verifier: verifier, redirect_uri: callback, ...changes },
      });
    assert.equal((await token({ code_verifier: "b".repeat(43) })).statusCode, 400);
    assert.equal((await token({ redirect_uri: callback.replace("51234", "51235") })).statusCode, 400);
    assert.equal(f.store.devices(f.user.id).length, 0);
    const redeemed = await token();
    assert.equal(redeemed.statusCode, 200);
    const bound = deviceAuthorizationTokenSchema.parse(redeemed.json());
    assert.equal(bound.name, "Fixture Mac");
    assert.equal(f.store.devices(f.user.id).length, 1);
    assert.equal(f.store.device(bound.device_id)?.owner_id, f.user.id);
    assert.equal((await token()).statusCode, 400);
    assert.equal(f.store.devices(f.user.id).length, 1);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: route + "/decision",
          headers: { cookie: f.cookie },
          payload: { approve: true, expected_user_id: f.user.id },
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.dispose();
  }
});

test("extension callback must match its origin and approval remains restricted to the management origin", async () => {
  const f = await fixture();
  const extension = "a".repeat(32);
  const origin = "chrome-extension://" + extension;
  const browser = request({
    kind: "browser",
    name: "Fixture Chrome",
    capabilities: ["browser"],
    redirect_uri: `https://${extension}.chromiumapp.org/abridge-authorize`,
  });
  try {
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/device-authorizations",
          headers: { origin: "https://evil.invalid" },
          payload: browser,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/device-authorizations",
          headers: { origin },
          payload: request(),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/device-authorizations",
          headers: { origin: "chrome-extension://" + "b".repeat(32) },
          payload: browser,
        })
      ).statusCode,
      403,
    );
    const started = await f.app.inject({
      method: "POST",
      url: "/api/device-authorizations",
      headers: { origin },
      payload: browser,
    });
    assert.equal(started.statusCode, 200);
    const { id } = deviceAuthorizationStartSchema.parse(started.json());
    const route = "/api/device-authorizations/" + id;
    assert.equal(
      (await f.app.inject({ method: "GET", url: route, headers: { origin, cookie: f.cookie } })).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: route + "/decision",
          headers: { origin, cookie: f.cookie },
          payload: { approve: true, expected_user_id: f.user.id },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: route + "/decision",
          payload: { approve: true, expected_user_id: f.user.id },
        })
      ).statusCode,
      401,
    );
    const decision = await f.app.inject({
      method: "POST",
      url: route + "/decision",
      headers: { cookie: f.cookie },
      payload: { approve: true, expected_user_id: f.user.id },
    });
    const code = new URL(decision.json().redirect_url).searchParams.get("code")!;
    const payload = { code, code_verifier: verifier, redirect_uri: browser.redirect_uri };
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/device-authorizations/token",
          headers: { origin: "chrome-extension://" + "b".repeat(32) },
          payload,
        })
      ).statusCode,
      403,
    );
    const token = await f.app.inject({
      method: "POST",
      url: "/api/device-authorizations/token",
      headers: { origin },
      payload,
    });
    assert.equal(token.statusCode, 200);
    assert.deepEqual(token.json().capabilities, ["browser"]);
    assert.equal(
      (await f.app.inject({ method: "POST", url: "/api/browser/register", headers: { origin }, payload: {} }))
        .statusCode,
      403,
    );
  } finally {
    await f.dispose();
  }
});

test("denial, cancellation, expiry and account isolation never create a device", async () => {
  const f = await fixture();
  let now = 100;
  const service = new DeviceAuthorizations(f.store, () => now);
  const other = { id: "another-account", username: "other" };
  try {
    const denied = service.start(request(), undefined, "http://127.0.0.1:8765");
    const denyResult = new URL(service.decide(denied.id, f.user, false).redirect_url);
    assert.equal(denyResult.searchParams.get("error"), "access_denied");
    assert.equal(denyResult.searchParams.get("state"), state);
    assert.equal(denyResult.searchParams.has("code"), false);
    assert.throws(() => service.view(denied.id, other), status(404, "not_found"));
    assert.throws(() => service.decide(denied.id, other, true), status(404, "not_found"));
    const cancelled = service.start(request(), undefined, "http://127.0.0.1:8765");
    assert.throws(
      () => service.cancel(cancelled.id, "b".repeat(43), undefined),
      status(400, "invalid_grant"),
    );
    service.cancel(cancelled.id, verifier, undefined);
    assert.throws(() => service.decide(cancelled.id, f.user, true), status(409, "authorization_complete"));
    const approved = service.start(request(), undefined, "http://127.0.0.1:8765");
    const code = new URL(service.decide(approved.id, f.user, true).redirect_url).searchParams.get("code")!;
    assert.throws(() => service.view(approved.id, other), status(404, "not_found"));
    service.cancel(approved.id, verifier, undefined);
    assert.throws(
      () => service.redeem({ code, code_verifier: verifier, redirect_uri: callback }, undefined),
      status(400, "invalid_grant"),
    );
    const expired = service.start(request(), undefined, "http://127.0.0.1:8765");
    const expiredCode = new URL(service.decide(expired.id, f.user, true).redirect_url).searchParams.get(
      "code",
    )!;
    now = expired.expires_at;
    assert.throws(() => service.view(expired.id, f.user), status(410, "authorization_expired"));
    assert.throws(() => service.decide(expired.id, f.user, true), status(410, "authorization_expired"));
    assert.throws(
      () => service.redeem({ code: expiredCode, code_verifier: verifier, redirect_uri: callback }, undefined),
      status(400, "invalid_grant"),
    );
    assert.equal(f.store.devices(f.user.id).length, 0);
  } finally {
    await f.dispose();
  }
});

test("callback allowlist and strict capability contract reject redirects outside the selected client", async () => {
  const f = await fixture();
  const service = new DeviceAuthorizations(f.store);
  try {
    for (const redirect_uri of [
      "https://evil.invalid/abridge/callback",
      "http://localhost:51234/abridge/callback",
      "http://0.0.0.0:51234/abridge/callback",
      "http://127.0.0.1/abridge/callback",
      "http://127.0.0.1:51234/other",
      "http://127.0.0.1:51234/abridge/callback?code=other",
      "http://127.0.0.1:51234/abridge/callback#fragment",
      "http://user@127.0.0.1:51234/abridge/callback",
    ])
      assert.throws(
        () => service.start(request({ redirect_uri }), undefined, "http://127.0.0.1"),
        status(422, "invalid_redirect"),
      );
    assert.doesNotThrow(() =>
      service.start(
        request({ redirect_uri: "http://[::1]:51234/abridge/callback" }),
        undefined,
        "http://127.0.0.1",
      ),
    );
    assert.equal(
      deviceAuthorizationRequestSchema.safeParse({ ...request(), capabilities: ["browser"] }).success,
      false,
    );
    assert.equal(
      deviceAuthorizationRequestSchema.safeParse({ ...request(), unexpected: "field" }).success,
      false,
    );
    assert.equal(
      deviceAuthorizationRequestSchema.safeParse({ ...request(), code_challenge_method: "plain" }).success,
      false,
    );
    for (const redirect_uri of [
      `https://${"a".repeat(32)}.chromiumapp.org/other`,
      `https://${"a".repeat(32)}.chromiumapp.org.evil.invalid/abridge-authorize`,
      `https://${"a".repeat(32)}.chromiumapp.org:8443/abridge-authorize`,
    ])
      assert.throws(
        () =>
          service.start(
            request({ kind: "browser", capabilities: ["browser"], redirect_uri }),
            undefined,
            "http://127.0.0.1",
          ),
        status(422, "invalid_redirect"),
      );
  } finally {
    await f.dispose();
  }
});

test("authorization requests are bounded and initiating clients are rate limited", async () => {
  const f = await fixture();
  const service = new DeviceAuthorizations(f.store);
  try {
    for (let i = 0; i < 1000; i++) service.start(request(), undefined, "http://127.0.0.1");
    assert.throws(() => service.start(request(), undefined, "http://127.0.0.1"), status(429, "rate_limited"));
    for (let i = 0; i < 30; i++)
      assert.equal(
        (await f.app.inject({ method: "POST", url: "/api/device-authorizations", payload: request() }))
          .statusCode,
        200,
      );
    assert.equal(
      (await f.app.inject({ method: "POST", url: "/api/device-authorizations", payload: request() }))
        .statusCode,
      429,
    );
  } finally {
    await f.dispose();
  }
});
