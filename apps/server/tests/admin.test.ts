import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { adminOverviewSchema } from "@abridge/protocol";
import { createServer } from "../src/server.js";
import { AdminAuth, ADMIN_SESSION_SECONDS } from "../src/admin.js";

const password = "fixture-password-1234";
async function fixture(adminToken?: string) {
  const dir = await mkdtemp(join(tmpdir(), "abridge-admin-"));
  const config = { dbPath: join(dir, "server.db"), port: 0, adminToken };
  const server = await createServer(config);
  await server.start();
  return {
    ...server,
    config,
    dir,
    async dispose() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
function headers(token: string) {
  return { host: "127.0.0.1", authorization: "Bearer " + token };
}

test("admin token and browser sessions persist across restart, rotation revokes both, env overrides file", async () => {
  const f = await fixture();
  let current = f;
  try {
    const token = f.adminToken;
    const path = f.config.dbPath + ".admin-token";
    assert.equal((await readFile(path, "utf8")).trim(), token);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    const login = await f.app.inject({
      method: "POST",
      url: "/api/admin/session",
      headers: headers(token),
      payload: {},
    });
    assert.equal(login.statusCode, 200);
    const setCookie = String(login.headers["set-cookie"]);
    assert.match(setCookie, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000/);
    const cookie = setCookie.split(";")[0]!;
    await f.close();
    const restarted = await createServer(f.config);
    current = { ...f, ...restarted };
    assert.equal(restarted.adminToken, token);
    assert.equal(
      (await restarted.app.inject({ url: "/api/admin/session", headers: { host: "localhost", cookie } }))
        .statusCode,
      200,
    );
    await restarted.close();
    const reset = await createServer({ ...f.config, resetAdminToken: true });
    current = { ...f, ...reset };
    assert.notEqual(reset.adminToken, token);
    for (const auth of [{ cookie }, { authorization: "Bearer " + token }])
      assert.equal(
        (await reset.app.inject({ url: "/api/admin/overview", headers: { host: "localhost", ...auth } }))
          .statusCode,
        401,
      );
    const saved = (await readFile(path, "utf8")).trim();
    await reset.close();
    const override = "fixture-admin-environment-token-1234567890";
    const configured = await createServer({ ...f.config, adminToken: override });
    current = { ...f, ...configured };
    assert.equal(configured.adminToken, override);
    assert.equal(
      (await readFile(path, "utf8")).trim(),
      saved,
      "Env override must not overwrite the saved token",
    );
    assert.equal(
      (await configured.app.inject({ url: "/api/admin/overview", headers: headers(saved) })).statusCode,
      401,
    );
    assert.equal(
      (await configured.app.inject({ url: "/api/admin/overview", headers: headers(override) })).statusCode,
      200,
    );
    await configured.close();
    await assert.rejects(createServer({ ...f.config, adminToken: "short" }), /32–512/);
    await assert.rejects(
      createServer({ ...f.config, adminToken: override, resetAdminToken: true }),
      /Change ABRIDGE_ADMIN_TOKEN/,
    );
    const recovered = await createServer(f.config);
    current = { ...f, ...recovered };
    assert.equal(recovered.adminToken, saved, "Invalid config must release the instance lock");
  } finally {
    await current.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("signed administrator sessions reject tampering, expiration and other identities", () => {
  const auth = new AdminAuth("fixture-token-12345678901234567890");
  const session = auth.createSession();
  assert.equal(auth.acceptsSession(session), true);
  assert.equal(auth.acceptsSession(session + "x"), false);
  assert.equal(new AdminAuth("other-token-12345678901234567890").acceptsSession(session), false);
  assert.equal(auth.acceptsSession(auth.token), false);
  for (const expires of [
    Math.floor(Date.now() / 1000) - 1,
    Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS + 60,
  ]) {
    const value = expires + "." + "a".repeat(32);
    const signature = createHmac("sha256", auth.token)
      .update("abridge-admin-session:" + value)
      .digest("base64url");
    assert.equal(auth.acceptsSession(value + "." + signature), false);
  }
});

test("only administrators create accounts, identities stay independent, overview excludes secrets and revoked devices", async () => {
  const f = await fixture();
  let socket: WebSocket | undefined;
  try {
    const call = (
      method: "GET" | "POST" | "DELETE",
      url: string,
      auth: Record<string, string> = {},
      payload?: object,
    ) =>
      f.app.inject({ method, url, headers: { host: "127.0.0.1", ...auth }, ...(payload ? { payload } : {}) });
    assert.equal((await call("GET", "/api/admin/overview")).statusCode, 401);
    assert.equal(
      (await call("POST", "/api/admin/users", {}, { username: "owner", password })).statusCode,
      401,
    );
    const token = { authorization: "Bearer " + f.adminToken };
    const adminLogin = await call("POST", "/api/admin/session", token, {});
    const adminCookie = String(adminLogin.headers["set-cookie"]).split(";")[0]!;
    const admin = { cookie: adminCookie };
    assert.equal((await call("GET", "/api/me", admin)).statusCode, 401);
    assert.equal((await call("GET", "/api/devices", token)).statusCode, 401);
    assert.equal(
      (await call("POST", "/api/admin/users", token, { username: "owner", password: "short" })).statusCode,
      422,
    );
    assert.equal(
      (await call("POST", "/api/admin/users", token, { username: "owner", password, role: "admin" }))
        .statusCode,
      422,
    );
    const created = await call("POST", "/api/admin/users", token, { username: " Owner ", password });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(Object.keys(created.json()).sort(), ["id", "username"]);
    assert.equal(created.json().username, "owner");
    assert.equal(created.headers["set-cookie"], undefined);
    assert.equal(
      (await call("POST", "/api/admin/users", admin, { username: "OWNER", password })).statusCode,
      409,
    );
    const second = await call("POST", "/api/admin/users", admin, { username: "empty", password });
    assert.equal(second.statusCode, 201);
    const login = await call("POST", "/api/login", {}, { username: "owner", password });
    const userCookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const user = { cookie: userCookie };
    assert.equal((await call("GET", "/api/admin/overview", user)).statusCode, 401);
    assert.equal(
      (await call("POST", "/api/admin/users", user, { username: "forbidden", password })).statusCode,
      401,
    );
    const computer = f.store.createDevice(created.json().id, "Workstation", ["shell"]);
    const browser = f.store.createDevice(created.json().id, "Chromium", ["browser"], "browser");
    const revoked = f.store.createDevice(created.json().id, "Removed", ["shell"]);
    f.store.revokeDevice(revoked.device.id);
    const grant = f.store.createGrant(created.json().id, "Agent", {
      mode: "all",
      capabilities: ["shell"],
      overrides: [],
    });
    for (const key of [computer.key, browser.key, grant.key])
      assert.equal(
        (await call("GET", "/api/admin/overview", { authorization: "Bearer " + key })).statusCode,
        401,
      );
    const address = f.app.server.address();
    assert.ok(address && typeof address !== "string");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/device`, {
      headers: { authorization: "Bearer " + computer.key },
    });
    await once(socket, "open");
    const welcome = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "hello",
        protocol: "abridge/1",
        platform: "linux",
        version: "0.4.0",
        paused: true,
        capabilities: { shell: true },
      }),
    );
    await welcome;
    const result = await call("GET", "/api/admin/overview", admin);
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    const overview = adminOverviewSchema.parse(result.json());
    assert.deepEqual(overview.totals, { users: 2, devices: 2, online_devices: 1, computers: 1, browsers: 1 });
    const owner = overview.users.find((u) => u.username === "owner")!;
    assert.equal(owner.devices.length, 2);
    assert.equal(owner.online_count, 1);
    assert.equal(owner.devices.find((d) => d.id === computer.device.id)?.paused, true);
    const empty = overview.users.find((u) => u.username === "empty")!;
    assert.deepEqual(empty.devices, []);
    assert.equal(empty.computer_count, 0);
    for (const secret of [
      password,
      f.adminToken,
      computer.key,
      browser.key,
      "token_digest",
      "password_hash",
      "salt",
    ])
      assert.equal(result.body.includes(secret), false, secret);
    const both = { cookie: userCookie + "; " + adminCookie };
    assert.equal((await call("GET", "/api/me", both)).statusCode, 200);
    assert.equal((await call("GET", "/api/admin/session", both)).statusCode, 200);
    const logout = await call("DELETE", "/api/admin/session", both, {});
    assert.match(String(logout.headers["set-cookie"]), /^abridge_admin=;.*Max-Age=0/);
    assert.equal((await call("GET", "/api/me", user)).statusCode, 200);
    for (const origin of ["https://evil.example", "chrome-extension://" + "a".repeat(32)])
      assert.equal(
        (await call("POST", "/api/admin/users", { ...token, origin }, { username: "cross-origin", password }))
          .statusCode,
        403,
      );
    assert.equal((await call("GET", "/api/setup")).statusCode, 404);
    assert.equal((await call("POST", "/api/setup", token, { username: "legacy", password })).statusCode, 404);
  } finally {
    socket?.terminate();
    await f.dispose();
  }
});

test("administrator sign-in attempts are bounded and HTTPS sessions set Secure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-admin-secure-"));
  const server = await createServer({
    dbPath: join(dir, "server.db"),
    publicOrigin: "https://bridge.example.com",
    port: 0,
  });
  try {
    for (let index = 0; index < 11; index++) {
      const response = await server.app.inject({
        method: "POST",
        url: "/api/admin/session",
        headers: { host: "bridge.example.com", authorization: "Bearer invalid" },
        payload: {},
      });
      assert.equal(response.statusCode, index < 10 ? 401 : 429);
    }
    const response = await server.app.inject({
      method: "POST",
      url: "/api/admin/session",
      headers: { host: "bridge.example.com", authorization: "Bearer " + server.adminToken },
      payload: {},
    });
    assert.equal(response.statusCode, 200, "Bad-token traffic must not block a valid administrator");
    assert.match(String(response.headers["set-cookie"]), /; Secure$/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt persisted credentials fail closed without exposing contents", async () => {
  const f = await fixture();
  await f.close();
  try {
    await writeFile(f.config.dbPath + ".admin-token", "invalid-fixture-secret");
    await assert.rejects(
      createServer(f.config),
      (error: Error) =>
        !error.message.includes("invalid-fixture-secret") && error.message.includes("--reset-admin-token"),
    );
    const recovered = await createServer({ ...f.config, resetAdminToken: true });
    await recovered.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
