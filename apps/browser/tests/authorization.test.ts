import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { authorizeBrowser } from "../src/authorization.js";

const server = "https://bridge.fixture";
const redirectUri = `https://${"a".repeat(32)}.chromiumapp.org/abridge-authorize`;
const requestId = "r".repeat(43),
  code = "c".repeat(43);
function provider(callback: (request: Record<string, unknown>) => string | Promise<string>) {
  let request: Record<string, unknown> = {};
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (input, init) => {
    const url = String(input),
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    calls.push({ url, body });
    if (url === server + "/api/device-authorizations") {
      request = body;
      return Response.json({
        id: requestId,
        authorization_url: `${server}/?authorize=${requestId}`,
        expires_at: Date.now() / 1000 + 300,
      });
    }
    if (url.endsWith("/token")) {
      assert.equal(body.code, code);
      assert.equal(body.redirect_uri, request.redirect_uri);
      assert.equal(
        createHash("sha256").update(String(body.code_verifier)).digest("base64url"),
        request.code_challenge,
      );
      return Response.json({
        device_id: "dev_fixture",
        key: "abr_device_fixture",
        name: "Fixture Browser",
        kind: "browser",
        capabilities: ["browser"],
      });
    }
    assert.equal(init?.method, "DELETE");
    assert.equal(
      createHash("sha256").update(String(body.code_verifier)).digest("base64url"),
      request.code_challenge,
    );
    return Response.json({ ok: true });
  }) satisfies typeof fetch;
  return { calls, fetcher, open: async () => callback(request) };
}
const run = (fixture: ReturnType<typeof provider>, signal = new AbortController().signal) =>
  authorizeBrowser({
    server,
    name: "Fixture Browser",
    redirectUri,
    open: fixture.open,
    signal,
    fetch: fixture.fetcher,
    started: () => {},
  });

test("extension exchanges one code bound to its private PKCE verifier and callback", async () => {
  const fixture = provider((request) => `${redirectUri}?code=${code}&state=${request.state}`);
  const token = await run(fixture);
  assert.equal(token.key, "abr_device_fixture");
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[0]!.body.kind, "browser");
  assert.ok(!("code_verifier" in fixture.calls[0]!.body));
  assert.deepEqual(fixture.calls[0]!.body.capabilities, ["browser"]);
});

test("binding failures preserve HTTP status and explain empty or unexpected Server responses", async () => {
  for (const [response, message] of [
    [new Response(null, { status: 502 }), /HTTP 502.*服务地址/],
    [new Response(null), /响应为空.*HTTP 200/],
    [new Response("<html>fixture</html>"), /响应不符合 aBridge 接口.*HTTP 200/],
    [Response.json({ unrelated: true }), /响应不符合 aBridge 接口.*HTTP 200/],
    [
      Response.json({ error: { code: "invalid_origin", message: "请检查 Server URL" } }, { status: 403 }),
      /请检查 Server URL.*HTTP 403/,
    ],
  ] as const) {
    await assert.rejects(
      run({
        calls: [],
        fetcher: async () => response,
        open: async () => assert.fail("unexpected response cannot open an authorization window"),
      }),
      message,
    );
  }
  await assert.rejects(
    run({
      calls: [],
      fetcher: async () => {
        throw new TypeError("Failed to fetch");
      },
      open: async () => assert.fail("network failure cannot open an authorization window"),
    }),
    /无法连接 Server.*地址、端口/,
  );
});

test("foreign callbacks, duplicate state/code, denial and missing codes never exchange credentials", async () => {
  for (const callback of [
    (request: Record<string, unknown>) => `https://evil.fixture/?code=${code}&state=${request.state}`,
    () => `${redirectUri}?code=${code}&state=unrelated`,
    (request: Record<string, unknown>) =>
      `${redirectUri}?code=${code}&state=${request.state}&state=${request.state}`,
    (request: Record<string, unknown>) => `${redirectUri}?code=${code}&code=${code}&state=${request.state}`,
    (request: Record<string, unknown>) => `${redirectUri}?error=access_denied&state=${request.state}`,
    (request: Record<string, unknown>) => `${redirectUri}?state=${request.state}`,
  ]) {
    const fixture = provider(callback);
    await assert.rejects(run(fixture));
    assert.ok(!fixture.calls.some((call) => call.url.endsWith("/token")));
    assert.ok(
      fixture.calls.at(-1)!.url.endsWith(requestId),
      "failed flows cancel the pending server request",
    );
  }
});

test("cancelling while the browser waits returns without accepting a late approval", async () => {
  const controller = new AbortController();
  let opened!: () => void;
  const opening = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const fixture = provider(() => {
    opened();
    return new Promise<string>(() => {});
  });
  const flow = run(fixture, controller.signal);
  await opening;
  controller.abort();
  await assert.rejects(flow, /授权已取消/);
  assert.ok(!fixture.calls.some((call) => call.url.endsWith("/token")));
});
