import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { on, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { createServer } from "../src/server.js";
import { Identity, validateIdentityConfig } from "../src/identity.js";
import { Store } from "../src/store.js";
import { BridgeError } from "../src/types.js";

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
  const serverConfig = {
    dbPath: join(dir, "server.db"),
    publicOrigin: origin,
    identity: config,
    port: 0,
  };
  let server = await createServer(serverConfig);
  let serverUrl = await server.start();
  let identity = new Identity(config, origin, server.store);
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
  async function personalBrowserRequest(action: "status" | "provision", claims = {}, subject = "user-a") {
    const path = "/api/personal-browsers/" + action;
    const signed = await token(subject, {
      aud: origin + path,
      purpose: "abridge-personal-browser-" + action,
      installation_id: "cube-install",
      revision: 0,
      ...claims,
    });
    return fetch(serverUrl + path, {
      method: action === "status" ? "GET" : "POST",
      headers: { authorization: "Bearer " + signed },
    });
  }
  async function redeemBrowser(device_id: string, bootstrap_token: string) {
    return fetch(serverUrl + "/api/managed-browsers/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_id, bootstrap_token }),
    });
  }
  return {
    get server() {
      return server;
    },
    get serverUrl() {
      return serverUrl;
    },
    get identity() {
      return identity;
    },
    login,
    token,
    personalBrowserRequest,
    redeemBrowser,
    setWrongNonce: () => {
      wrongNonce = true;
    },
    issuer,
    setUnavailable: () => {
      unavailable = true;
    },
    calls: () => ({ tokenCalls, stolenCalls }),
    async restart() {
      await server.close();
      server = await createServer(serverConfig);
      serverUrl = await server.start();
      identity = new Identity(config, origin, server.store);
    },
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

test("current main schema keeps device credentials when the managed table is added", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-managed-schema-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "server.db");
  const original = new Store(path);
  const owner = await original.createUser("standard-owner", "fixture-password");
  const { device, key } = original.createDevice(owner.id, "Standard Linux", ["shell"]);
  original.close();

  const db = new DatabaseSync(path);
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 6);
  db.exec("DROP TABLE managed_browsers");
  db.close();
  const compatible = new Store(path);
  assert.equal(compatible.authenticateDevice(key)?.id, device.id);
  compatible.close();

  const readback = new DatabaseSync(path);
  assert.equal(readback.prepare("PRAGMA user_version").get()!.user_version, 6);
  assert.equal(readback.prepare("SELECT COUNT(*) AS count FROM managed_browsers").get()!.count, 0);
  readback.exec(
    "DROP TABLE managed_browsers; CREATE TABLE managed_browsers(sandbox_id TEXT, generation INT, stopped_at REAL);",
  );
  readback.prepare("INSERT INTO managed_browsers VALUES ('old-sandbox',1,-1)").run();
  readback.close();

  assert.throws(() => new Store(path), { code: "managed_browser_schema_mismatch" });
  const legacy = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(legacy.prepare("SELECT sandbox_id FROM managed_browsers").get()!.sandbox_id, "old-sandbox");
    assert.equal(legacy.prepare("PRAGMA user_version").get()!.user_version, 6);
  } finally {
    legacy.close();
  }
});

test("managed browser enrollment fences tickets, device keys and MCP access by binding revision", async (t) => {
  const f = await fixture({ managedBrowserEnabled: true });
  const origin = "http://127.0.0.1:43219";
  const root = "/api/managed-browsers/";
  const uid = "workload";
  const binding = (revision: number, installation_id = "install-a") => ({ revision, installation_id });
  async function request(action: "status" | "provision" | "stop", claims = {}, subject = uid) {
    const token = await f.token(subject, {
      aud: origin + root + action,
      purpose: "abridge-managed-browser-" + action,
      ...claims,
    });
    return f.server.app.inject({
      method: action === "status" ? "GET" : "POST",
      url: root + action,
      headers: { authorization: "Bearer " + token },
    });
  }
  async function redeem(device_id: string, bootstrap_token: string) {
    return f.server.app.inject({
      method: "POST",
      url: root + "redeem",
      payload: { device_id, bootstrap_token },
    });
  }
  const sockets: WebSocket[] = [];
  async function connect(device_key: string, autoPong = true) {
    const socket = new WebSocket(f.serverUrl.replace("http:", "ws:") + "/ws/browser", {
      origin: "chrome-extension://" + "a".repeat(32),
      autoPong,
    });
    sockets.push(socket);
    await once(socket, "open", { signal: AbortSignal.timeout(3000) });
    const welcome = once(socket, "message", { signal: AbortSignal.timeout(3000) });
    const ping = autoPong ? undefined : once(socket, "ping", { signal: AbortSignal.timeout(3000) });
    socket.send(
      JSON.stringify({
        type: "hello",
        protocol: "abridge/1",
        platform: "Browser extension",
        version: "0.4.23",
        paused: false,
        instance_id: "managed-test",
        device_key,
        capabilities: { browser: true },
      }),
    );
    const [frame] = await welcome;
    const connected = JSON.parse(frame.toString());
    assert.equal(connected.type, "welcome");
    return { socket, epoch: connected.connection_epoch, ping };
  }
  function deviceAPI(key: string, method: "GET" | "PATCH" = "GET") {
    return f.server.app.inject({
      method,
      url: "/api/device",
      headers: { authorization: "Bearer " + key },
      ...(method === "PATCH" && { payload: { name: "Candidate" } }),
    });
  }
  function abandon(key: string) {
    return f.server.app.inject({
      method: "POST",
      url: root + "abandon",
      headers: { authorization: "Bearer " + key, origin: "chrome-extension://" + "a".repeat(32) },
    });
  }
  async function waitForActivation(key: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (f.server.store.authenticateDevice(key)) return;
      await delay(20);
    }
    assert.fail("The browser never became active");
  }
  try {
    assert.deepEqual((await request("status")).json(), {
      version: 2,
      enabled: true,
      browser_origin: origin,
      binding: null,
    });
    assert.deepEqual(f.server.store.users(), []);
    assert.deepEqual(f.server.store.activeDevices(), []);
    assert.equal(
      (await request("provision", { ...binding(0), purpose: "abridge-managed-browser-status" })).statusCode,
      401,
    );
    assert.equal(
      (await request("provision", { ...binding(0), aud: origin + root + "status" })).statusCode,
      401,
    );

    const opened = await request("provision", binding(0));
    assert.equal(opened.statusCode, 200, opened.body);
    const first = opened.json();
    assert.equal(first.revision, 1);
    assert.equal(first.key_issued, false);
    assert.ok(first.bootstrap_token);
    assert.equal((await request("provision", binding(1))).json().bootstrap_token, first.bootstrap_token);
    assert.equal((await request("status", {}, "another-workload")).json().binding, null);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 61_000 });
    let renewed: string;
    try {
      assert.equal((await redeem(first.device_id, first.bootstrap_token)).statusCode, 400);
      const current = (await request("provision", binding(1))).json();
      assert.equal(current.revision, 1);
      assert.equal(current.device_id, first.device_id);
      assert.ok(current.bootstrap_token);
      assert.notEqual(current.bootstrap_token, first.bootstrap_token);
      renewed = current.bootstrap_token;
    } finally {
      t.mock.timers.reset();
    }
    assert.equal((await redeem(first.device_id, first.bootstrap_token)).statusCode, 400);
    assert.equal((await redeem(first.device_id, renewed)).statusCode, 200);
    assert.equal((await redeem(first.device_id, renewed)).statusCode, 400);
    // Lost response: same binding cannot silently re-issue a key.
    const issued = (await request("provision", binding(1))).json();
    assert.equal(issued.key_issued, true);
    assert.equal(issued.status, "offline");
    assert.equal(issued.bootstrap_token, undefined);

    const recovered = await request("provision", { ...binding(1), replace: true });
    assert.equal(recovered.statusCode, 200, recovered.body);
    const second = recovered.json();
    assert.equal(second.revision, 2);
    assert.equal(second.device_id, first.device_id);
    const redeemed = await redeem(first.device_id, second.bootstrap_token);
    assert.equal(redeemed.statusCode, 200, redeemed.body);
    const key = redeemed.json().key;
    const { socket, epoch } = await connect(key);
    await waitForActivation(key);
    assert.equal((await request("status")).json().binding.status, "online");
    assert.equal((await request("provision", binding(2, "install-b"))).statusCode, 409);
    for (const local of [
      { paused: true, capabilities: { browser: true } },
      { paused: false, capabilities: { browser: false } },
    ]) {
      const updates = on(socket, "message", { signal: AbortSignal.timeout(3000) });
      socket.send(JSON.stringify({ type: "capabilities", connection_epoch: epoch, ...local }));
      for await (const [frame] of updates) {
        const type = JSON.parse(frame.toString()).type;
        if (type === "heartbeat_ack") break;
        assert.equal(type, "stop");
      }
      const blocked = await request("provision", { ...binding(2, "install-b"), replace: true });
      assert.equal(blocked.statusCode, 409);
      assert.equal(blocked.json().error.code, "device_paused");
      assert.equal((await request("status")).json().binding.revision, 2);
      assert.equal(f.server.store.authenticateDevice(key)?.id, first.device_id);
    }
    const resumed = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "capabilities",
        connection_epoch: epoch,
        paused: false,
        capabilities: { browser: true },
      }),
    );
    assert.equal(JSON.parse((await resumed)[0].toString()).type, "heartbeat_ack");

    const token = await f.token(uid, binding(2));
    const connection = await f.identity.authenticate(token);
    assert.ok(connection);
    assert.equal(await f.identity.authenticate(await f.token(uid)), undefined);
    assert.equal(await f.identity.authenticate(await f.token("other-workload", binding(2))), undefined);
    f.server.store.createDevice(connection.owner_id, "Other browser", ["browser"], "browser");
    assert.deepEqual(
      f.server.control.devices(connection).map((device) => device.id),
      [first.device_id],
    );
    assert.throws(() =>
      f.server.store.updateAgentConnection(
        connection.id,
        connection.name,
        {
          mode: "all",
          capabilities: ["browser"],
          overrides: [],
        },
        null,
      ),
    );
    const session = await f.server.control.openSession(connection, first.device_id, ["browser"]);

    const replaced = await request("provision", { ...binding(2, "install-b"), replace: true });
    assert.equal(replaced.statusCode, 200, replaced.body);
    const third = replaced.json();
    assert.equal(third.device_id, first.device_id);
    assert.equal(third.revision, 3);
    assert.equal(third.pending, true);
    const during = (await request("status")).json();
    assert.equal(during.binding.revision, 2);
    assert.equal(during.binding.status, "online");
    assert.equal(during.replacement.revision, 3);
    assert.equal(f.server.store.session(session.id)?.status, "active");
    assert.equal((await deviceAPI(key)).statusCode, 200);
    assert.equal((await f.identity.authenticate(token))?.id, connection.id);
    const current = binding(3, "install-b");
    assert.equal(await f.identity.authenticate(await f.token(uid, current)), undefined);
    assert.equal((await request("provision", { ...binding(2, "install-c"), replace: true })).statusCode, 409);
    assert.equal((await request("stop", current)).statusCode, 409);

    const candidate = await redeem(first.device_id, third.bootstrap_token);
    assert.equal(candidate.statusCode, 200, candidate.body);
    assert.equal(candidate.json().pending, true);
    const candidateKey = candidate.json().key;
    assert.equal((await deviceAPI(candidateKey)).json().pending, true);
    assert.equal((await deviceAPI(candidateKey, "PATCH")).statusCode, 401);
    assert.equal((await redeem(first.device_id, third.bootstrap_token)).statusCode, 400);
    const failed = await connect(candidateKey, false);
    await failed.ping;
    await once(failed.socket, "close", { signal: AbortSignal.timeout(4000) });
    assert.equal((await deviceAPI(key)).statusCode, 200);
    assert.equal((await f.identity.authenticate(token))?.id, connection.id);
    assert.equal(f.server.store.session(session.id)?.status, "active");
    assert.equal((await request("status")).json().binding.status, "online");
    assert.equal((await abandon(candidateKey)).json().status, "abandoned");
    assert.equal((await deviceAPI(candidateKey)).statusCode, 401);
    assert.equal((await request("status")).json().replacement, undefined);

    const retried = await request("provision", { ...binding(2, "install-b"), replace: true });
    assert.equal(retried.statusCode, 200, retried.body);
    const previousAttemptKey = (await redeem(first.device_id, retried.json().bootstrap_token)).json().key;
    const previousAttempt = await connect(previousAttemptKey, false);
    const [challenge] = (await previousAttempt.ping)!;
    const superseded = await request("provision", { ...binding(2, "install-b"), replace: true });
    assert.equal(superseded.statusCode, 200, superseded.body);
    assert.equal(superseded.json().key_issued, false);
    assert.equal((await deviceAPI(previousAttemptKey)).statusCode, 401);
    assert.equal((await abandon(previousAttemptKey)).json().status, "invalid");
    const previousAttemptClosed = once(previousAttempt.socket, "close", {
      signal: AbortSignal.timeout(3000),
    });
    previousAttempt.socket.pong(challenge);
    assert.equal((await previousAttemptClosed)[0], 4401);
    assert.equal((await f.identity.authenticate(token))?.id, connection.id);
    assert.equal(f.server.store.session(session.id)?.status, "active");
    const newKey = (await redeem(first.device_id, superseded.json().bootstrap_token)).json().key;
    const oldClose = once(socket, "close", { signal: AbortSignal.timeout(3000) });
    const { socket: currentSocket } = await connect(newKey);
    assert.deepEqual((await oldClose).slice(0, 1), [4403]);
    assert.equal((await deviceAPI(newKey)).json().pending, undefined);
    assert.equal((await abandon(newKey)).json().status, "active");
    assert.equal((await request("status")).json().replacement, undefined);
    assert.equal(f.server.store.authenticateDevice(key), undefined);
    assert.notEqual(f.server.store.session(session.id)?.status, "active");
    assert.equal(await f.identity.authenticate(token), undefined);
    assert.throws(() => f.server.control.devices(connection), /revoked/);
    assert.equal((await request("provision", { ...binding(2), replace: true })).statusCode, 409);
    assert.equal((await request("stop", binding(2))).statusCode, 409);

    const currentClose = once(currentSocket, "close");
    const beforeStop = await request("provision", { ...binding(3, "install-c"), replace: true });
    assert.equal(beforeStop.json().pending, true);
    const stopped = await request("stop", current);
    assert.equal(stopped.json().status, "revoked");
    assert.deepEqual((await currentClose).slice(0, 1), [4403]);
    assert.equal(f.server.store.authenticateDevice(newKey), undefined);
    assert.equal(await f.identity.authenticate(await f.token(uid, current)), undefined);
    assert.equal((await request("status")).json().binding.status, "revoked");
    assert.equal((await redeem(first.device_id, beforeStop.json().bootstrap_token)).statusCode, 400);
    assert.equal((await request("provision", { ...current, replace: true })).statusCode, 403);
    assert.equal((await request("stop", current)).json().status, "revoked");
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await f.close();
  }
});

const liveBrowserLauncher = process.env.ABRIDGE_BROWSER_TEST_LAUNCHER;
const liveBrowserPython = process.env.ABRIDGE_BROWSER_TEST_PYTHON || "python3";
test(
  "packaged browser restores an online binding after a failed cutover against a real Server",
  { skip: !liveBrowserLauncher, timeout: 100_000 },
  async (t) => {
    const f = await fixture({ managedBrowserEnabled: true });
    const state = await mkdtemp(join(tmpdir(), "abridge-cutover-"));
    const run = promisify(execFile);
    type Handoff = { device_id: string; revision: number; bootstrap_token?: string };
    async function cli(action: "start" | "stop" | "status", handoff?: Handoff) {
      const command = run(liveBrowserPython, ["-I", liveBrowserLauncher!, action], {
        env: { ...process.env, ABRIDGE_BROWSER_HOME: state },
        timeout: 48_000,
      });
      command.child.stdin?.end(handoff && JSON.stringify({ ...handoff, browser_origin: f.serverUrl }));
      return JSON.parse((await command).stdout) as { connected?: boolean; revision?: number };
    }
    async function provision(revision: number, replace = false): Promise<Handoff> {
      const reply = await f.personalBrowserRequest("provision", { revision, replace });
      assert.equal(reply.status, 200);
      return reply.json();
    }
    async function expectOnline(revision: number) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const local = await cli("status");
        if (local.connected) {
          assert.equal(local.revision, revision);
          const response = await f.personalBrowserRequest("status");
          const { binding } = await response.json();
          assert.equal(binding.revision, revision);
          assert.equal(binding.status, "online");
          return;
        }
        await delay(250);
      }
      assert.fail("The browser never reached the requested online revision");
    }
    let blocked = true;
    let failedAttempts = 0;
    const attach = f.server.control.attachConnection.bind(f.server.control);
    t.mock.method(f.server.control, "attachConnection", async (...args: Parameters<typeof attach>) => {
      if (blocked && f.server.store.browserReplacementDevice(args[0])) {
        failedAttempts++;
        throw new BridgeError("device_offline", "Fixture rejects candidate connection", 503);
      }
      return attach(...args);
    });
    try {
      const original = await provision(0);
      await cli("start", original);
      await expectOnline(original.revision);

      const rejected = await provision(original.revision, true);
      await assert.rejects(cli("start", rejected), { code: 1 });
      assert.ok(failedAttempts > 0);
      await cli("start", { device_id: original.device_id, revision: original.revision });
      await expectOnline(original.revision);

      blocked = false;
      const retry = await provision(original.revision, true);
      await cli("start", retry);
      await expectOnline(retry.revision);
      await cli("stop");
      await cli("start", { device_id: retry.device_id, revision: retry.revision });
      await expectOnline(retry.revision);
    } finally {
      await cli("stop").catch(() => {});
      await f.close();
      await rm(state, { recursive: true, force: true });
    }
  },
);

test("a locally paused enrollment survives Server restart and blocks prepared candidates", async () => {
  const f = await fixture({ managedBrowserEnabled: true });
  const { personalBrowserRequest: request, redeemBrowser: redeem } = f;
  const sockets: WebSocket[] = [];
  async function begin(device_key: string) {
    const socket = new WebSocket(f.serverUrl.replace("http:", "ws:") + "/ws/browser", {
      origin: "chrome-extension://" + "a".repeat(32),
    });
    sockets.push(socket);
    await once(socket, "open", { signal: AbortSignal.timeout(3000) });
    socket.send(
      JSON.stringify({
        type: "hello",
        protocol: "abridge/1",
        platform: "Browser extension",
        version: "0.5.1",
        paused: false,
        instance_id: "pause-restart",
        device_key,
        capabilities: { browser: true },
      }),
    );
    return socket;
  }
  try {
    const first = await (await request("provision")).json();
    const priorKey = (await (await redeem(first.device_id, first.bootstrap_token)).json()).key;
    const original = await begin(priorKey);
    const [frame] = await once(original, "message", { signal: AbortSignal.timeout(3000) });
    const { connection_epoch } = JSON.parse(frame.toString());
    const staged = await (await request("provision", { revision: first.revision, replace: true })).json();
    const stagedKey = (await (await redeem(first.device_id, staged.bootstrap_token)).json()).key;
    const updates = on(original, "message", { signal: AbortSignal.timeout(3000) });
    original.send(JSON.stringify({ type: "capabilities", connection_epoch, paused: true }));
    for await (const [update] of updates) if (JSON.parse(update.toString()).type === "heartbeat_ack") break;
    assert.equal((await (await request("status")).json()).binding.status, "paused");
    await f.restart();
    assert.equal((await (await request("status")).json()).binding.status, "paused");
    assert.equal((await request("provision", { revision: first.revision, replace: true })).status, 409);
    const candidate = await begin(stagedKey);
    await once(candidate, "close", { signal: AbortSignal.timeout(4000) });
    assert.equal(f.server.store.authenticateDevice(stagedKey), undefined);
    assert.equal(f.server.store.authenticateDevice(priorKey)?.id, first.device_id);
    assert.equal((await (await request("status")).json()).binding.status, "paused");
    await begin(priorKey);
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await (await request("status")).json()).binding.status === "online") return;
      await delay(25);
    }
    assert.fail("The enrolled browser did not clear the persisted block on explicit local resume");
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await f.close();
  }
});

test("managed registration requires opt-in and isolates workload subjects from personal login", async () => {
  const disabled = await fixture();
  const origin = "http://127.0.0.1:43219";
  async function request(
    f: typeof disabled,
    subject: string,
    action: "status" | "provision",
    scope = "managed",
  ) {
    const url = `/api/${scope}-browsers/${action}`;
    const token = await f.token(subject, {
      aud: origin + url,
      purpose: `abridge-${scope}-browser-${action}`,
      installation_id: "install",
      revision: 0,
    });
    return f.server.app.inject({
      method: action === "status" ? "GET" : "POST",
      url,
      headers: { authorization: "Bearer " + token },
    });
  }
  try {
    assert.equal((await request(disabled, "workload", "status")).json().enabled, false);
    assert.equal((await request(disabled, "workload", "provision")).statusCode, 404);
    assert.equal((await request(disabled, "personal", "status", "personal")).json().enabled, false);
    assert.equal((await request(disabled, "personal", "provision", "personal")).statusCode, 404);
  } finally {
    await disabled.close();
  }
  const active = await fixture({ managedBrowserEnabled: true });
  try {
    assert.equal((await active.login("personal")).result.statusCode, 302);
    assert.equal((await request(active, "personal", "provision")).statusCode, 403);
    assert.equal((await request(active, "workload", "provision")).statusCode, 200);
    assert.equal((await active.login("workload")).result.statusCode, 403);
    assert.equal((await request(active, "workload", "provision", "personal")).statusCode, 403);
    assert.ok(await active.identity.authenticate(await active.token("personal")));
  } finally {
    await active.close();
  }
});

test("personal enrollment gives the normal OIDC account an ordinary browser", async () => {
  const f = await fixture({ managedBrowserEnabled: true });
  const origin = "http://127.0.0.1:43219";
  const { personalBrowserRequest: request, redeemBrowser: redeem } = f;
  let socket: WebSocket | undefined;
  async function mcp(name: string, args = {}, subject = "user-a") {
    return fetch(f.serverUrl + "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + (await f.token(subject)),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
  }
  async function toolResult<T>(response: Response): Promise<T> {
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result: { content: { text: string }[] } };
    return JSON.parse(body.result.content[0]!.text) as T;
  }
  try {
    assert.equal((await (await request("status")).json()).binding, null);
    assert.deepEqual(f.server.store.users(), []);
    assert.equal((await request("provision", { purpose: "abridge-managed-browser-provision" })).status, 401);
    assert.equal((await request("provision", { aud: origin + "/mcp" })).status, 401);
    assert.equal((await request("provision", { client_id: "other-client" })).status, 401);
    assert.deepEqual(f.server.store.activeDevices(), []);

    const enrolled = await request("provision", { name: "Same Display Name" });
    assert.equal(enrolled.status, 200);
    const { device_id, revision, bootstrap_token } = await enrolled.json();
    assert.equal(revision, 1);
    assert.equal(enrolled.headers.get("cache-control"), "no-store");
    const redeemed = await redeem(device_id, bootstrap_token);
    assert.equal(redeemed.status, 200);
    const { key } = await redeemed.json();
    assert.equal((await redeem(device_id, bootstrap_token)).status, 400);
    const connection = (await f.identity.authenticate(await f.token()))!;
    assert.equal(connection.name, "Yuxi 平台连接");
    assert.equal(connection.policy.mode, "all");
    assert.ok(connection.policy.capabilities.includes("shell"));
    assert.equal(f.server.store.authenticateDevice(key)?.owner_id, connection.owner_id);
    assert.equal((await (await request("status", {}, "user-b")).json()).binding, null);
    assert.equal(
      await f.identity.authenticate(await f.token("user-a", { revision, installation_id: "cube-install" })),
      undefined,
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
        version: "0.5.0",
        platform: "Browser extension",
        instance_id: "personal-test",
        device_key: key,
        capabilities: { browser: true },
        paused: true,
      }),
    );
    const connected = JSON.parse((await welcome)[0].toString());
    assert.equal(connected.type, "welcome");
    const readMcpDevices = async (subject = "user-a") =>
      (
        await toolResult<{ devices: { id: string; status: string; available: { browser: boolean } }[] }>(
          await mcp("devices_list", {}, subject),
        )
      ).devices;
    const args = { device_id, capabilities: ["browser"] };
    assert.deepEqual(
      (await readMcpDevices()).map((d) => [d.id, d.status, d.available.browser]),
      [[device_id, "online", false]],
    );
    assert.equal(
      (await toolResult<{ error: { code: string } }>(await mcp("session_open", args))).error.code,
      "device_paused",
    );
    const blocked = await request("provision", { revision, replace: true });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error.code, "device_paused");
    const resumed = once(socket, "message");
    socket.send(
      JSON.stringify({ type: "capabilities", connection_epoch: connected.connection_epoch, paused: false }),
    );
    assert.equal(JSON.parse((await resumed)[0].toString()).type, "heartbeat_ack");
    assert.equal(
      (await toolResult<{ device: { id: string } }>(await mcp("session_open", args))).device.id,
      device_id,
    );

    const loggedIn = await f.login();
    const cookie = String(loggedIn.result.headers["set-cookie"]).split(";")[0]!;
    const consoleDevices = await fetch(f.serverUrl + "/api/devices", { headers: { cookie } });
    assert.deepEqual(
      (await consoleDevices.json()).devices.map((d: { id: string }) => d.id),
      [device_id],
    );
    const loginB = await f.login("user-b");
    const other = (await f.identity.authenticate(await f.token("user-b")))!;
    assert.equal(loginB.result.statusCode, 302);
    assert.deepEqual(await readMcpDevices("user-b"), []);
    f.server.store.updateAgentConnection(other.id, other.name, { mode: "selected", devices: [] }, null);
    assert.equal((await request("provision", {}, "user-b")).status, 200);
    assert.equal((await f.identity.authenticate(await f.token("user-b")))?.id, other.id);
    assert.deepEqual(await readMcpDevices("user-b"), []);

    await f.server.control.revokeAgentConnection(connection);
    const replaced = await request("provision", { revision, replace: true });
    assert.equal(replaced.status, 200);
    const current = await replaced.json();
    assert.equal(current.device_id, device_id);
    assert.equal(current.revision, revision + 1);
    assert.equal(current.pending, true);
    assert.equal(f.server.store.authenticateDevice(key)?.id, device_id);
    assert.equal((await mcp("devices_list")).status, 401);
    const revoke = await fetch(f.serverUrl + "/api/devices/" + device_id + "/revoke", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(revoke.status, 200);
    assert.equal((await redeem(device_id, current.bootstrap_token)).status, 400);
    assert.equal((await request("provision", { revision, replace: true })).status, 403);
    assert.equal((await (await request("status")).json()).binding.status, "revoked");
  } finally {
    socket?.terminate();
    await f.close();
  }
});

test("console credential rotation invalidates pending personal tickets and allows one explicit rebind", async (t) => {
  const f = await fixture({ managedBrowserEnabled: true });
  const { personalBrowserRequest: request, redeemBrowser: redeem } = f;
  let socket: WebSocket | undefined;
  try {
    const created = await request("provision");
    assert.equal(created.status, 200);
    const first = await created.json();
    const initial = await redeem(first.device_id, first.bootstrap_token);
    assert.equal(initial.status, 200);
    const guestKey = (await initial.json()).key as string;
    const { result: login } = await f.login();
    assert.equal(login.statusCode, 302);
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const read = async () => (await (await request("status")).json()).binding;
    const identify = async (key: string) =>
      fetch(f.serverUrl + "/api/device", { headers: { authorization: "Bearer " + key } });
    async function rotate(): Promise<string> {
      const response = await fetch(f.serverUrl + "/api/devices/" + first.device_id + "/credentials", {
        method: "POST",
        headers: { cookie },
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.id, first.device_id);
      return body.key as string;
    }

    assert.equal((await read()).key_issued, true);
    const manual = await rotate();
    const next = await read();
    assert.deepEqual(next, {
      installation_id: first.installation_id,
      revision: first.revision + 1,
      device_id: first.device_id,
      status: "offline",
      key_issued: false,
    });
    assert.equal((await identify(guestKey)).status, 401);
    const prepared = await request("provision", { revision: next.revision });
    assert.equal(prepared.status, 200);
    const pending = await prepared.json();
    assert.equal(pending.revision, next.revision);
    assert.equal((await identify(manual)).status, 200);

    const replacement = await rotate();
    const latest = await read();
    assert.equal(latest.revision, next.revision + 1);
    assert.equal(latest.key_issued, false);
    assert.equal((await redeem(first.device_id, pending.bootstrap_token)).status, 400);
    assert.equal((await request("provision", { revision: next.revision })).status, 409);
    const provisioned = await request("provision", { revision: latest.revision });
    assert.equal(provisioned.status, 200);
    const current = await provisioned.json();
    assert.equal(current.revision, latest.revision);
    const identity = await identify(replacement);
    assert.equal(identity.status, 200);
    const originalDevice = await identity.json();

    socket = new WebSocket(f.serverUrl.replace("http:", "ws:") + "/ws/browser", {
      origin: "chrome-extension://" + "a".repeat(32),
    });
    await once(socket, "open", { signal: AbortSignal.timeout(3000) });
    const welcome = once(socket, "message", { signal: AbortSignal.timeout(3000) });
    socket.send(
      JSON.stringify({
        type: "hello",
        protocol: "abridge/1",
        version: "0.5.0",
        platform: "Browser extension",
        instance_id: "rotation-test",
        device_key: replacement,
        capabilities: { browser: true },
        paused: true,
      }),
    );
    const online = JSON.parse((await welcome)[0].toString());
    assert.equal(online.device_id, first.device_id);
    assert.equal((await redeem(first.device_id, current.bootstrap_token)).status, 400);
    assert.equal((await identify(replacement)).status, 200);
    assert.equal((await read()).key_issued, false);
    const resumed = once(socket, "message", { signal: AbortSignal.timeout(3000) });
    socket.send(
      JSON.stringify({ type: "capabilities", connection_epoch: online.connection_epoch, paused: false }),
    );
    assert.equal(JSON.parse((await resumed)[0].toString()).type, "heartbeat_ack");

    const closed = once(socket, "close", { signal: AbortSignal.timeout(3000) });
    const rebound = await redeem(first.device_id, current.bootstrap_token);
    assert.equal(rebound.status, 200);
    assert.equal((await closed)[0], 4403);
    assert.equal((await identify(replacement)).status, 401);
    const restored = await identify((await rebound.json()).key);
    assert.deepEqual(await restored.json(), originalDevice);
    assert.equal((await read()).revision, latest.revision);
    assert.equal((await read()).key_issued, true);

    // Rotate once more while redemption is closing the previous connection.
    await rotate();
    const ready = await read();
    const ticket = await (await request("provision", { revision: ready.revision })).json();
    const invalidate = f.server.control.invalidateDevice.bind(f.server.control);
    let activeKey = "";
    t.mock.method(
      f.server.control,
      "invalidateDevice",
      async (id: string) => {
        await invalidate(id);
        activeKey = await rotate();
      },
      { times: 1 },
    );
    const stale = await redeem(first.device_id, ticket.bootstrap_token);
    assert.equal(stale.status, 409);
    const conflict = await stale.json();
    assert.equal(conflict.error.code, "stale_binding");
    assert.equal(conflict.key, undefined);
    assert.equal((await identify(activeKey)).status, 200);
    assert.equal((await read()).revision, ready.revision + 1);
  } finally {
    socket?.terminate();
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
    const session = await f.server.control.openSession(agentConnection, device.id, ["files"]);
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
    const session = await f.server.control.openSession(updated, device.id, ["files"]);
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
