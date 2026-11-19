import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createServer } from "../src/server.js";
import { Identity, validateIdentityConfig } from "../src/identity.js";

/** 使用真实 HTTP OIDC 替身，保留真实签名与本地数据库。 */
async function fixture(
  options: {
    backchannel?: boolean;
    foreignToken?: boolean;
    redirectToken?: boolean;
    delegationEnabled?: boolean;
    managedBrowserEnabled?: boolean;
    allowInsecureHttp?: boolean;
    publicOrigin?: string;
    httpIssuer?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "abridge-oidc-"));
  const provider = Fastify();
  const pair = await generateKeyPair("RS256");
  const publicKey = { ...(await exportJWK(pair.publicKey)), kid: "fixture", alg: "RS256", use: "sig" };
  let issuer = "",
    sub = "user-a",
    wrongNonce = false,
    unavailable = false;
  const codes = new Map<string, URLSearchParams>();
  let tokenCalls = 0,
    stolenCalls = 0;
  provider.get("/.well-known/openid-configuration", async () => ({
    issuer,
    authorization_endpoint: issuer + "/authorize",
    token_endpoint: options.foreignToken ? "http://outside.invalid/token" : issuer + "/token",
    jwks_uri: issuer + "/jwks",
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  }));
  provider.get("/jwks", async (_request, reply) =>
    unavailable ? reply.code(503).send({ error: "unavailable" }) : { keys: [publicKey] },
  );
  provider.get("/authorize", async (request, reply) => {
    const params = new URLSearchParams(request.url.split("?")[1]);
    const code = String(codes.size + 1);
    codes.set(code, params);
    const target = new URL(params.get("redirect_uri")!);
    target.searchParams.set("state", params.get("state")!);
    target.searchParams.set("code", code);
    return reply.redirect(target.href);
  });
  provider.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, new URLSearchParams(String(body))),
  );
  provider.post("/stolen", async () => {
    stolenCalls++;
    return {};
  });
  provider.post("/token", async (request, reply) => {
    tokenCalls++;
    if (unavailable) return reply.code(503).send({ error: "temporarily_unavailable" });
    if (options.redirectToken) return reply.redirect(issuer + "/stolen");
    const body = request.body as URLSearchParams;
    const params = codes.get(body.get("code")!);
    if (
      !params ||
      body.get("client_secret") !== "fixture-secret" ||
      createHash("sha256").update(body.get("code_verifier")!).digest("base64url") !==
        params.get("code_challenge")
    )
      return reply.code(400).send({ error: "invalid_grant" });
    codes.delete(body.get("code")!);
    const token = await new SignJWT({
      nonce: wrongNonce ? "bad" : params.get("nonce"),
      name: "Same Display Name",
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(issuer)
      .setAudience("abridge")
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(pair.privateKey);
    return { token_type: "Bearer", access_token: "fixture-access", expires_in: 60, id_token: token };
  });
  const backchannelOrigin = await provider.listen({ host: "127.0.0.1", port: 0 });
  issuer = options.backchannel
    ? options.httpIssuer
      ? "http://identity.example"
      : "https://identity.example"
    : backchannelOrigin;
  const origin = options.publicOrigin ?? "http://127.0.0.1:43219";
  const config = {
    issuer,
    clientId: "abridge",
    clientName: "Yuxi",
    clientSecret: "fixture-secret",
    delegationEnabled: options.delegationEnabled ?? true,
    managedBrowserEnabled: options.managedBrowserEnabled,
    allowInsecureHttp: options.allowInsecureHttp,
    ...(options.backchannel ? { backchannelOrigin } : {}),
  };
  const server = await createServer({
    dbPath: join(dir, "server.db"),
    publicOrigin: origin,
    identity: config,
    port: 0,
  });
  const serverUrl = await server.start();
  const identity = new Identity(config, origin, server.store);
  async function login(subject = "user-a", returnTo = "/#authorize=fixture") {
    sub = subject;
    const start = await server.app.inject({
      url: "/api/auth/oidc/login?return_to=" + encodeURIComponent(returnTo),
      headers: { host: new URL(origin).host },
    });
    assert.equal(start.statusCode, 302, start.body);
    const authorization = new URL(start.headers.location!);
    assert.equal(authorization.origin, issuer);
    const browserTarget = new URL(authorization.pathname + authorization.search, backchannelOrigin);
    const auth = await fetch(browserTarget, { redirect: "manual" });
    const callback = new URL(auth.headers.get("location")!);
    const result = await server.app.inject({
      url: callback.pathname + callback.search,
      headers: { host: new URL(origin).host, cookie: String(start.headers["set-cookie"]).split(";")[0]! },
    });
    return { result, callback, binding: String(start.headers["set-cookie"]).split(";")[0]! };
  }
  async function token(subject = "user-a", extra: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: issuer,
      sub: subject,
      aud: origin + "/mcp",
      iat: now,
      exp: now + 60,
      purpose: "abridge-delegation",
      client_id: "abridge",
      ...extra,
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .sign(pair.privateKey);
  }
  return {
    server,
    serverUrl,
    identity,
    login,
    token,
    setWrongNonce: () => {
      wrongNonce = true;
    },
    issuer,
    setUnavailable: () => {
      unavailable = true;
    },
    calls: () => ({ tokenCalls, stolenCalls }),
    async close() {
      await server.close();
      await provider.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("OIDC login isolates stable identities, persists mapping and defaults platform access to all owned devices", async () => {
  const f = await fixture();
  try {
    const local = await f.server.store.createUser("same display name", "fixture-password-123");
    const a = await f.login();
    assert.equal(a.result.statusCode, 302, a.result.body);
    assert.equal(a.result.headers.location, "/#authorize=fixture");
    const cookie = String(a.result.headers["set-cookie"]).split(";")[0]!;
    const me = await f.server.app.inject({ url: "/api/me", headers: { cookie } });
    const userA = me.json<{ id: string; username: string }>();
    assert.notEqual(userA.id, local.id);
    const b = await f.login("user-b");
    const userB = (
      await f.server.app.inject({
        url: "/api/me",
        headers: { cookie: String(b.result.headers["set-cookie"]).split(";")[0]! },
      })
    ).json<{ id: string }>();
    assert.notEqual(userA.id, userB.id);
    await f.login();
    assert.equal(f.server.store.users().length, 3);
    assert.equal(await f.server.store.verifyUser(userA.username, "fixture-password-123"), undefined);
    assert.equal((await f.server.store.login(local.username, "fixture-password-123"))?.user.id, local.id);
    const agentConnection = await f.identity.authenticate(await f.token());
    assert.ok(agentConnection);
    assert.equal(agentConnection.token_digest, null);
    assert.equal(agentConnection.name, "Yuxi 平台连接");
    assert.deepEqual(agentConnection.policy, {
      mode: "all",
      capabilities: ["screen", "input", "shell", "files", "browser"],
      overrides: [],
    });
    assert.deepEqual(f.server.control.devices(agentConnection), []);
    const replay = await f.server.app.inject({
      url: a.callback.pathname + a.callback.search,
      headers: { cookie: a.binding },
    });
    assert.equal(replay.statusCode, 400);
    const rotate = await f.server.app.inject({
      method: "POST",
      url: "/api/agent-connections/" + agentConnection.id + "/rotate",
      headers: { cookie },
      payload: {},
    });
    assert.equal(rotate.statusCode, 409);
  } finally {
    await f.close();
  }
});

test("managed browser registration, one-time redemption and MCP use share a scoped, revocable binding", async () => {
  const f = await fixture({ managedBrowserEnabled: true });
  let socket: WebSocket | undefined;
  const subject = "shadow-app-user";
  const root = "/api/managed-browsers/";
  const origin = "http://127.0.0.1:43219";
  const iat = Math.floor(Date.now() / 1000) - 1;
  function grant(path: string, action: string, generation = 1, user = subject) {
    return f.token(user, {
      aud: origin + path,
      purpose: "abridge-managed-browser-" + action,
      sandbox_id: "workspace",
      generation,
      iat,
      exp: iat + 60,
    });
  }
  const provision = async (generation = 1) =>
    f.server.app.inject({
      method: "POST",
      url: root + "provision",
      headers: { authorization: "Bearer " + (await grant(root + "provision", "provision", generation)) },
    });
  const redeem = (deviceId: string, token: string) =>
    f.server.app.inject({
      method: "POST",
      url: root + "redeem",
      payload: { device_id: deviceId, bootstrap_token: token },
    });
  try {
    const wrong = await f.server.app.inject({
      method: "POST",
      url: root + "provision",
      headers: { authorization: "Bearer " + (await grant("/mcp", "delegation")) },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(f.server.store.users().length, 0);

    const first = await provision();
    assert.equal(first.statusCode, 200, first.body);
    const registration = first.json<{ device_id: string; status: string; bootstrap_token: string }>();
    assert.equal(registration.status, "offline");
    assert.deepEqual((await provision()).json(), registration);
    const { device_id: deviceId, bootstrap_token: bootstrap } = registration;
    const issued = await redeem(deviceId, bootstrap);
    assert.equal(issued.statusCode, 200, issued.body);
    assert.equal((await redeem(deviceId, bootstrap)).statusCode, 400);
    assert.equal(f.calls().tokenCalls, 0, "registration requires no browser login");

    const key = issued.json<{ key: string }>().key;
    const delegation = await grant("/mcp", "delegation");
    const connection = await f.identity.authenticate(delegation);
    assert.ok(connection);
    assert.equal(await f.identity.authenticate(await f.token(subject)), undefined);
    assert.equal(
      await f.identity.authenticate(await grant("/mcp", "delegation", 1, "other-app-user")),
      undefined,
    );
    f.server.store.createDevice(connection.owner_id, "Other browser", ["browser"], "browser");
    assert.throws(() =>
      f.server.store.updateAgentConnection(
        connection.id,
        connection.name,
        { mode: "all", capabilities: ["browser"], overrides: [] },
        null,
      ),
    );

    socket = new WebSocket(f.serverUrl.replace("http:", "ws:") + "/ws/browser", {
      origin: "chrome-extension://" + "a".repeat(32),
    });
    await once(socket, "open");
    const welcome = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "hello",
        protocol: "abridge/1",
        platform: "Browser extension",
        version: "0.4.23",
        paused: false,
        instance_id: "managed-test",
        device_key: key,
        capabilities: { browser: true },
      }),
    );
    const [frame] = await welcome;
    assert.equal(JSON.parse(frame.toString()).type, "welcome");
    assert.deepEqual((await provision()).json(), {
      device_id: deviceId,
      status: "online",
      browser_origin: origin,
    });

    const list = await f.server.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer " + delegation, accept: "application/json, text/event-stream" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "devices_list", arguments: {} },
      },
    });
    assert.equal(list.statusCode, 200, list.body);
    const devices = JSON.parse(list.json().result.content[0].text).devices as { id: string }[];
    assert.deepEqual(
      devices.map((device) => device.id),
      [deviceId],
    );
    const session = f.server.control.openSession(connection, deviceId, ["browser"]);
    const reconnect = await provision(2);
    assert.equal(reconnect.statusCode, 200, reconnect.body);
    assert.equal(reconnect.json().device_id, deviceId);
    assert.equal(f.server.store.authenticateDevice(key), undefined);
    assert.notEqual(f.server.store.session(session.id)?.status, "active");
    assert.equal(await f.identity.authenticate(delegation), undefined);
    assert.equal((await provision()).statusCode, 409);
    const stop = await f.server.app.inject({
      method: "POST",
      url: root + "stop",
      headers: { authorization: "Bearer " + (await grant(root + "stop", "stop", 2)) },
    });
    assert.equal(stop.statusCode, 200, stop.body);
    assert.equal(await f.identity.authenticate(await grant("/mcp", "delegation", 2)), undefined);
    assert.equal((await redeem(deviceId, reconnect.json().bootstrap_token)).statusCode, 400);
    f.server.store.revokeDevice(deviceId);
    assert.equal((await provision(3)).statusCode, 403);
  } finally {
    socket?.terminate();
    await f.close();
  }
});

test("managed registration is disabled unless the issuer is explicitly trusted for it", async () => {
  const f = await fixture();
  try {
    const response = await f.server.app.inject({ method: "POST", url: "/api/managed-browsers/provision" });
    assert.equal(response.statusCode, 404);
  } finally {
    await f.close();
  }
});

test("first-time human managed registration links the normal platform delegation to only that browser", async () => {
  const f = await fixture({ managedBrowserEnabled: true });
  try {
    const path = "/api/managed-browsers/provision";
    const registration = await f.server.app.inject({
      method: "POST",
      url: path,
      headers: {
        authorization:
          "Bearer " +
          (await f.token("managed-human", {
            aud: "http://127.0.0.1:43219" + path,
            purpose: "abridge-managed-browser-provision",
            sandbox_id: "workspace",
            generation: 1,
            user_kind: "human",
          })),
      },
    });
    assert.equal(registration.statusCode, 200, registration.body);
    const standard = await f.identity.authenticate(await f.token("managed-human"));
    assert.ok(standard);
    f.server.store.createDevice(standard.owner_id, "Other device", ["files"]);
    assert.deepEqual(
      f.server.control.devices(standard).map((device) => device.id),
      [registration.json().device_id],
    );
    f.server.store.revokeAgentConnection(standard.id);
    assert.equal(await f.identity.authenticate(await f.token("managed-human")), undefined);
  } finally {
    await f.close();
  }
});

test("OIDC rejects browser mismatch, nonce mismatch and external return paths", async () => {
  const f = await fixture();
  try {
    const started = await f.server.app.inject({ url: "/api/auth/oidc/login" });
    const approved = await fetch(started.headers.location!, { redirect: "manual" });
    const returned = new URL(approved.headers.get("location")!);
    const mismatch = await f.server.app.inject({
      url: returned.pathname + returned.search,
      headers: { cookie: "abridge_oidc=wrong-browser" },
    });
    assert.equal(mismatch.statusCode, 400);
    assert.equal(f.server.store.users().length, 0);
    const bad = await f.server.app.inject({ url: "/api/auth/oidc/callback?state=absent&code=fixture" });
    assert.equal(bad.statusCode, 400);
    for (const path of [
      "//evil.example",
      "https://evil.example",
      "/api/admin",
      "/?authorize=a&token=secret",
      "/?authorize=",
    ]) {
      assert.equal(
        (await f.server.app.inject({ url: "/api/auth/oidc/login?return_to=" + encodeURIComponent(path) }))
          .statusCode,
        422,
      );
    }
    f.setWrongNonce();
    assert.equal((await f.login()).result.statusCode, 401);
    assert.equal(f.server.store.users().length, 0);
  } finally {
    await f.close();
  }
});

test("delegation enforces claims and current persisted Agent connection policy, revocation survives login", async () => {
  const f = await fixture();
  try {
    assert.equal(
      await f.identity.authenticate(await f.token()),
      undefined,
      "login required before delegation",
    );
    await f.login();
    const agentConnection = await f.identity.authenticate(await f.token());
    assert.ok(agentConnection);
    for (const extra of [
      { purpose: "id_token" },
      { client_id: "other" },
      { aud: "other" },
      { iss: "https://other.example" },
      { exp: Math.floor(Date.now() / 1000) + 3600 },
      { iat: Math.floor(Date.now() / 1000) + 30 },
      { exp: 1 },
    ])
      assert.equal(await f.identity.authenticate(await f.token("user-a", extra)), undefined);
    const { device, key: deviceKey } = f.server.store.createDevice(agentConnection.owner_id, "Mine", [
      "files",
    ]);
    const b = await f.login("user-b");
    assert.equal(b.result.statusCode, 302);
    const other = await f.identity.authenticate(await f.token("user-b"));
    assert.ok(other);
    const foreign = f.server.store.createDevice(other.owner_id, "Other", ["files"]).device;
    assert.throws(() =>
      f.server.store.updateAgentConnection(
        agentConnection.id,
        agentConnection.name,
        { mode: "selected", devices: [{ device_id: foreign.id, capabilities: ["files"] }] },
        null,
      ),
    );
    f.server.store.updateAgentConnection(
      agentConnection.id,
      agentConnection.name,
      { mode: "selected", devices: [{ device_id: device.id, capabilities: ["files"] }] },
      null,
    );
    assert.deepEqual(
      f.server.control.devices(agentConnection).map((d) => d.id),
      [device.id],
    );
    assert.deepEqual(
      f.server.control.devices(other).map((d) => d.id),
      [foreign.id],
    );
    await f.server.control.attachConnection(
      deviceKey,
      "computer",
      { capabilities: { files: true } },
      { async send() {}, async close() {} },
    );
    const session = f.server.control.openSession(agentConnection, device.id, ["files"]);
    await f.server.control.updateAgentConnection(
      agentConnection,
      agentConnection.name,
      { mode: "selected", devices: [] },
      null,
    );
    assert.notEqual(f.server.store.session(session.id)?.status, "active");
    await assert.rejects(
      f.server.control.execute(agentConnection, session.id, "file_read", { path: "/fixture" }),
    );
    assert.deepEqual(f.server.control.devices(agentConnection), []);
    await f.login();
    assert.deepEqual(
      (await f.identity.authenticate(await f.token()))?.policy,
      { mode: "selected", devices: [] },
      "repeat login preserves a customized empty scope",
    );
    const response = await fetch(f.serverUrl + "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + (await f.token()),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "devices_list", arguments: {} },
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result: { content: { text: string }[] } };
    assert.deepEqual(JSON.parse(body.result.content[0]!.text).devices, []);
    f.server.store.revokeAgentConnection(agentConnection.id);
    assert.equal(await f.identity.authenticate(await f.token()), undefined);
    assert.throws(() => f.server.control.devices(agentConnection));
    await f.login();
    assert.equal(await f.identity.authenticate(await f.token()), undefined);
    const admin = await f.server.app.inject({
      url: "/api/admin/overview",
      headers: { authorization: "Bearer " + (await f.token()) },
    });
    assert.equal(admin.statusCode, 401);
  } finally {
    await f.close();
  }
});

test("standalone stays enabled and partial OIDC configuration fails before acquiring state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-standalone-"));
  const config = { dbPath: join(dir, "server.db") };
  try {
    for (const identity of [
      { clientId: "x" },
      { issuer: "https://issuer.example" },
      { delegationEnabled: true },
    ])
      await assert.rejects(createServer({ ...config, identity }));
    for (const backchannelOrigin of [
      "http://api:5050/",
      "http://user:secret@api:5050",
      "http://api:5050/path",
      "http://api:5050?x=1",
      "http://api:5050#fragment",
      "ftp://api:5050",
    ]) {
      await assert.rejects(
        createServer({
          ...config,
          publicOrigin: "https://bridge.example",
          identity: {
            issuer: "https://issuer.example",
            clientId: "abridge",
            clientSecret: "fixture",
            backchannelOrigin,
          },
        }),
        /pure HTTP\(S\) origin/,
      );
    }
    const server = await createServer(config);
    try {
      assert.deepEqual((await server.app.inject({ url: "/api/auth/oidc/config" })).json(), {
        enabled: false,
      });
      assert.equal((await server.app.inject({ url: "/api/auth/oidc/login" })).statusCode, 404);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("private backchannel preserves canonical issuer for login and delegated JWKS validation", async () => {
  const f = await fixture({ backchannel: true });
  try {
    assert.equal((await f.login()).result.statusCode, 302);
    const agentConnection = await f.identity.authenticate(await f.token());
    assert.ok(agentConnection);
    assert.equal(
      await f.identity.authenticate(await f.token("user-a", { iss: "http://api:5050" })),
      undefined,
    );
    assert.equal(f.calls().tokenCalls, 1);
  } finally {
    await f.close();
  }
});

test("backchannel never maps foreign insecure endpoints or follows token redirects", async () => {
  for (const options of [{ foreignToken: true }, { redirectToken: true }]) {
    const f = await fixture({ backchannel: true, ...options });
    try {
      assert.equal((await f.login()).result.statusCode, 503);
      assert.equal(f.calls().tokenCalls, options.foreignToken ? 0 : 1);
      assert.equal(f.calls().stolenCalls, 0);
      assert.equal(f.server.store.users().length, 0);
    } finally {
      await f.close();
    }
  }
});

test("real device authorization survives OIDC login and redeems under the mapped owner", async () => {
  const f = await fixture({ backchannel: true });
  try {
    const verifier = "v".repeat(43),
      callback = "http://127.0.0.1:51234/abridge/callback";
    const response = await fetch(f.serverUrl + "/api/device-authorizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "computer",
        name: "Bound after OIDC",
        capabilities: ["files"],
        redirect_uri: callback,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state: "fixture-device-binding-state",
      }),
    });
    assert.equal(response.status, 200);
    const started = (await response.json()) as { id: string; authorization_url: string };
    const actualUrl = new URL(started.authorization_url);
    assert.equal(actualUrl.searchParams.get("authorize"), started.id);
    const login = await f.login("user-a", actualUrl.pathname + actualUrl.search);
    assert.equal(login.result.statusCode, 302);
    assert.equal(login.result.headers.location, "/?authorize=" + started.id);
    const cookie = String(login.result.headers["set-cookie"]).split(";")[0]!;
    const user = f.server.store.account(cookie.split("=")[1]!)!;
    const route = f.serverUrl + "/api/device-authorizations/" + started.id;
    assert.equal((await fetch(route)).status, 401);
    const view = await fetch(route, { headers: { cookie } });
    assert.equal(view.status, 200);
    assert.equal(((await view.json()) as { id: string }).id, started.id);
    const wrong = await fetch(route + "/decision", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ approve: true, expected_user_id: "other-user" }),
    });
    assert.equal(wrong.status, 409);
    const decision = await fetch(route + "/decision", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ approve: true, expected_user_id: user.id }),
    });
    assert.equal(decision.status, 200);
    const returned = new URL(((await decision.json()) as { redirect_url: string }).redirect_url);
    const redeemed = await fetch(f.serverUrl + "/api/device-authorizations/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: returned.searchParams.get("code"),
        code_verifier: verifier,
        redirect_uri: callback,
      }),
    });
    assert.equal(redeemed.status, 200);
    const device = (await redeemed.json()) as { device_id: string };
    assert.equal(f.server.store.device(device.device_id)?.owner_id, user.id);
    assert.deepEqual(
      f.server.control.devices((await f.identity.authenticate(await f.token()))!).map((d) => d.id),
      [device.device_id],
    );
  } finally {
    await f.close();
  }
});

test("explicit platform reauthorization creates all-device Agent connection without reviving old sessions", async () => {
  const f = await fixture();
  try {
    const login = await f.login();
    const cookie = String(login.result.headers["set-cookie"]).split(";")[0]!;
    const agentConnection = (await f.identity.authenticate(await f.token()))!;
    const { device, key } = f.server.store.createDevice(agentConnection.owner_id, "Device", ["files"]);
    const updated = f.server.store.updateAgentConnection(
      agentConnection.id,
      agentConnection.name,
      { mode: "selected", devices: [{ device_id: device.id, capabilities: ["files"] }] },
      null,
    );
    await f.server.control.attachConnection(
      key,
      "computer",
      { capabilities: { files: true } },
      { async send() {}, async close() {} },
    );
    const session = f.server.control.openSession(updated, device.id, ["files"]);
    const route = "/api/agent-connections/" + agentConnection.id + "/reconnect";
    assert.equal(
      (await f.server.app.inject({ method: "POST", url: route, headers: { cookie }, payload: {} }))
        .statusCode,
      409,
    );
    await f.server.control.revokeAgentConnection(updated);
    const another = await f.login("user-b");
    const foreignCookie = String(another.result.headers["set-cookie"]).split(";")[0]!;
    assert.equal(
      (
        await f.server.app.inject({
          method: "POST",
          url: route,
          headers: { cookie: foreignCookie },
          payload: {},
        })
      ).statusCode,
      404,
    );
    assert.equal((await f.server.app.inject({ method: "POST", url: route, payload: {} })).statusCode, 401);
    assert.equal(
      (
        await f.server.app.inject({
          method: "POST",
          url: route,
          headers: { cookie, origin: "https://evil.example" },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(await f.identity.authenticate(await f.token()), undefined);
    await f.login();
    assert.equal(
      await f.identity.authenticate(await f.token()),
      undefined,
      "login does not recreate a revoked platform connection",
    );
    const listing = await f.server.app.inject({ url: "/api/agent-connections", headers: { cookie } });
    assert.equal(
      listing
        .json<{ connections: { id: string; can_reconnect: boolean }[] }>()
        .connections.find((g) => g.id === agentConnection.id)?.can_reconnect,
      true,
    );
    const response = await f.server.app.inject({
      method: "POST",
      url: route,
      headers: { cookie },
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    const replacement = response.json<{ id: string; policy: unknown }>();
    assert.notEqual(replacement.id, agentConnection.id);
    assert.deepEqual(replacement.policy, {
      mode: "all",
      capabilities: ["screen", "input", "shell", "files", "browser"],
      overrides: [],
    });
    const restored = (await f.identity.authenticate(await f.token()))!;
    assert.deepEqual(
      f.server.control.devices(restored).map((d) => d.id),
      [device.id],
    );
    const later = f.server.store.createDevice(
      restored.owner_id,
      "Later browser",
      ["browser"],
      "browser",
    ).device;
    assert.deepEqual(
      new Set(f.server.control.devices(restored).map((d) => d.id)),
      new Set([device.id, later.id]),
    );
    assert.equal((await f.identity.authenticate(await f.token()))?.id, replacement.id);
    assert.notEqual(f.server.store.session(session.id)?.status, "active");
    assert.ok(f.server.store.agentConnection(agentConnection.id)?.revoked_at);
    assert.equal(
      f.server.store.canReconnectPlatformAgentConnection(f.server.store.agentConnection(agentConnection.id)!),
      false,
    );
    assert.throws(() => f.server.control.devices(updated));
    assert.equal(
      (await f.server.app.inject({ method: "POST", url: route, headers: { cookie }, payload: {} }))
        .statusCode,
      409,
    );
    const manual = f.server.store.createAgentConnection(agentConnection.owner_id, "Manual", {
      mode: "selected",
      devices: [],
    });
    f.server.store.revokeAgentConnection(manual.agentConnection.id);
    assert.equal(
      (
        await f.server.app.inject({
          method: "POST",
          url: "/api/agent-connections/" + manual.agentConnection.id + "/reconnect",
          headers: { cookie },
          payload: {},
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});

test("OIDC public callback origin rejects plaintext remote and non-origin URLs", () => {
  const config = { issuer: "https://identity.example", clientId: "bridge", clientSecret: "fixture" };
  for (const origin of [
    "http://bridge.example",
    "https://user:secret@bridge.example",
    "https://bridge.example/path",
    "https://bridge.example?x=1",
  ])
    assert.throws(() => validateIdentityConfig(config, origin), /public origin requires HTTPS/);
  for (const origin of ["https://bridge.example", "http://127.0.0.1:1234", "http://localhost:1234"])
    assert.doesNotThrow(() => validateIdentityConfig(config, origin));
});

test("ordinary OIDC creates an account without platform connections", async () => {
  const f = await fixture({ delegationEnabled: false });
  try {
    const login = await f.login();
    assert.equal(login.result.statusCode, 302);
    const cookie = String(login.result.headers["set-cookie"]).split(";")[0]!;
    const agentConnections = await f.server.app.inject({
      url: "/api/agent-connections",
      headers: { cookie },
    });
    assert.deepEqual(agentConnections.json().connections, []);
    assert.equal(f.server.store.users().length, 1);
  } finally {
    await f.close();
  }
});

test("identity outages remain unavailable and local persistence failures are not login rejection", async () => {
  const f = await fixture();
  try {
    await f.login();
    const token = await f.token();
    const method = mock.method(f.server.store, "delegatedAgentConnection", () => {
      throw new Error("fixture database failure");
    });
    await assert.rejects(f.identity.authenticate(token), /fixture database failure/);
    method.mock.restore();
    const createLogin = mock.method(f.server.store, "createLogin", () => {
      throw new Error("fixture session failure");
    });
    assert.equal((await f.login()).result.statusCode, 500);
    createLogin.mock.restore();
    f.setUnavailable();
    assert.equal((await f.login()).result.statusCode, 503);
    const uncached = new Identity(
      { issuer: f.issuer, clientId: "abridge", clientSecret: "fixture-secret", delegationEnabled: true },
      "http://127.0.0.1:43219",
      f.server.store,
    );
    await assert.rejects(
      uncached.authenticate(token),
      (error: unknown) => error instanceof Error && "status" in error && error.status === 503,
    );
  } finally {
    await f.close();
  }
});

test("public HTTP OIDC is an explicit opt-in and still rejects invalid URLs", () => {
  const base = { issuer: "https://identity.example", clientId: "bridge", clientSecret: "fixture" };
  assert.throws(() => validateIdentityConfig(base, "http://bridge.example"), /requires HTTPS/);
  const enabled = { ...base, allowInsecureHttp: true };
  assert.doesNotThrow(() => validateIdentityConfig(enabled, "http://bridge.example"));
  assert.doesNotThrow(() =>
    validateIdentityConfig({ ...enabled, issuer: "http://identity.example" }, "http://bridge.example"),
  );
  for (const origin of [
    "ftp://bridge.example",
    "http://user:secret@bridge.example",
    "http://bridge.example/path",
    "http://bridge.example?x=1",
    "http://bridge.example#x",
  ]) {
    assert.throws(() => validateIdentityConfig(enabled, origin));
  }
  for (const issuer of [
    "ftp://identity.example",
    "http://user:secret@identity.example",
    "http://identity.example?x=1",
    "http://identity.example#x",
  ]) {
    assert.throws(() => validateIdentityConfig({ ...enabled, issuer }, "http://bridge.example"));
  }
});

test("opted-in public HTTP callback supports HTTPS and HTTP issuers without weakening identity checks", async () => {
  for (const httpIssuer of [false, true]) {
    const f = await fixture({
      backchannel: true,
      httpIssuer,
      publicOrigin: "http://bridge.example:8765",
      allowInsecureHttp: true,
    });
    try {
      const login = await f.login();
      assert.equal(login.result.statusCode, 302, login.result.body);
      assert.equal(login.callback.origin, "http://bridge.example:8765");
      assert.doesNotMatch(String(login.result.headers["set-cookie"]), /; Secure/);
      const cookie = String(login.result.headers["set-cookie"]).split(";")[0]!;
      const me = await f.server.app.inject({
        url: "/api/me",
        headers: { host: "bridge.example:8765", origin: "http://bridge.example:8765", cookie },
      });
      assert.equal(me.statusCode, 200, me.body);
      assert.ok(await f.identity.authenticate(await f.token()));
      assert.equal(
        await f.identity.authenticate(await f.token("user-a", { aud: "http://other.example/mcp" })),
        undefined,
      );
      f.setWrongNonce();
      assert.equal((await f.login()).result.statusCode, 401);
    } finally {
      await f.close();
    }
  }
});
