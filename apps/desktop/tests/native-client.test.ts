import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, chmod, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { hostname, networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DESKTOP_AUTH_CALLBACK_PATH,
  VERSION,
  deviceAuthorizationCancelSchema,
  deviceAuthorizationRequestSchema,
  deviceAuthorizationTokenRequestSchema,
  deviceDetailsSchema,
  deviceHelloSchema,
} from "@abridge/protocol";
const exec = promisify(execFile);
const binary = resolve(
  process.env.ABRIDGE_NATIVE_TEST_APP ?? "dist/desktop/aBridge.app",
  "Contents/MacOS/abridge-desktop",
);
const native = process.platform === "darwin" && process.arch === "arm64";
const deviceKey = "abr_device_fixture";
const browserDeviceKey = "abr_device_browser_fixture";
const authorizationPath = "/api/device-authorizations";
const authorizationId = "a".repeat(43);
const authorizationCode = "c".repeat(43);
type Frame = Record<string, unknown>;
async function until<T>(
  check: () => T | Promise<T>,
  message: string | (() => string) = "Expected state",
  timeout = 8000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  throw Error(typeof message === "function" ? message() : message);
}
async function fixture({
  host = "127.0.0.1",
  urlHost = host,
  seedBinding = true,
}: { host?: string; urlHost?: string; seedBinding?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "abridge-native-client-"));
  await chmod(directory, 0o700);
  let name = "Fixture Mac",
    responseId = "fixture",
    socketKey = deviceKey;
  let upgradeStatus: number | undefined;
  let renameResponse: { status: number; body: string } | undefined;
  const requests: {
    method: string | undefined;
    path: string | undefined;
    authorization: string | undefined;
    body: unknown;
  }[] = [];
  const http = createServer(async (request, response) => {
    let rawBody = "";
    for await (const chunk of request) rawBody += chunk;
    const body: unknown = rawBody ? JSON.parse(rawBody) : null;
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body,
    });
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === authorizationPath) {
      response.end(
        JSON.stringify({
          id: authorizationId,
          authorization_url: authorizationURL,
          expires_at: Date.now() / 1000 + 60,
        }),
      );
      return;
    }
    if (request.method === "DELETE" && request.url === `${authorizationPath}/${authorizationId}`) {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && request.url === `${authorizationPath}/token`) {
      socketKey = browserDeviceKey;
      response.end(
        JSON.stringify({
          device_id: responseId,
          key: browserDeviceKey,
          name,
          kind: "computer",
          capabilities: ["files"],
        }),
      );
      return;
    }
    assert.equal(request.url, "/api/device");
    assert.equal(request.headers.authorization, `Bearer ${deviceKey}`);
    if (request.method === "PATCH" && renameResponse) {
      response.writeHead(renameResponse.status).end(renameResponse.body);
      return;
    }
    if (request.method === "PATCH") name = (body as { name: string }).name;
    response.end(
      JSON.stringify(
        request.method === "PATCH"
          ? { id: responseId, name }
          : { id: responseId, name, kind: "computer", capabilities: ["shell", "files"] },
      ),
    );
  });
  await once(http.listen(0, host), "listening");
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const url = `http://${urlHost}:${address.port}`;
  const authorizationURL = `${url}/?authorize=${authorizationId}`;
  const server = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    assert.equal(request.url, "/ws/device");
    assert.equal(request.headers.authorization, `Bearer ${socketKey}`);
    if (upgradeStatus !== undefined) {
      socket.end(
        `HTTP/1.1 ${upgradeStatus} Fixture response\r\nContent-Length: ${deviceKey.length}\r\nConnection: close\r\n\r\n${deviceKey}`,
      );
      return;
    }
    server.handleUpgrade(request, socket, head, (ws) => server.emit("connection", ws));
  });
  let peer: WebSocket | undefined,
    epoch = 0,
    sequence = 0,
    child: ChildProcess | undefined;
  let stderr = "";
  const frames: Frame[] = [];
  let binaryFrames = 0;
  server.on("connection", (socket) => {
    peer = socket;
    epoch++;
    sequence = 0;
    socket.on("message", (bytes, isBinary) => {
      // The production device endpoint accepts JSON text frames only.
      if (isBinary) {
        binaryFrames++;
        socket.close(4400, "JSON text is required");
        return;
      }
      const frame = JSON.parse(bytes.toString()) as Frame;
      frames.push(frame);
      if (frame.type === "hello")
        socket.send(
          JSON.stringify({
            type: "welcome",
            protocol: "abridge/1",
            device_id: "fixture",
            device_name: name,
            connection_epoch: epoch,
            capabilities: ["shell", "files"],
            owner_name: "Fixture Owner",
            lease_seconds: 30,
            heartbeat_interval: 10,
          }),
        );
      if (frame.type === "heartbeat")
        socket.send(JSON.stringify({ type: "heartbeat_ack", connection_epoch: epoch, device_name: name }));
      if (frame.type === "unbind") socket.send(JSON.stringify({ type: "revoke", connection_epoch: epoch }));
    });
  });
  if (seedBinding) {
    await mkdir(join(directory, "credentials"), { mode: 0o700 });
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({
        url,
        paused: false,
        capabilities: { shell: true, files: true, screen: false, input: false },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "credentials/device.json"),
      JSON.stringify({ server_url: url, device_key: deviceKey }),
      { mode: 0o600 },
    );
  }
  async function cli(...args: string[]): Promise<Frame> {
    const result = await exec(binary, [...args, "--state-dir", directory], { timeout: 20000 });
    return JSON.parse(result.stdout) as Frame;
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const running = child;
    const exited = new Promise<void>((done) => running.once("exit", () => done()));
    running.kill("SIGTERM");
    const forced = setTimeout(() => running.kill("SIGKILL"), 6000);
    await exited;
    clearTimeout(forced);
  }
  async function start() {
    child = spawn(binary, ["run", "--state-dir", directory], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (data) => {
      stderr += String(data);
    });
    child.stdout!.on("data", (data) => {
      stderr += String(data);
    });
    let connection: unknown;
    await until(
      async () => {
        assert.equal(binaryFrames, 0, "Native client must send JSON text WebSocket frames");
        const status = await cli("status");
        connection = status.connection;
        return connection === "online" && status;
      },
      () =>
        `Native client failed to connect (status=${connection}, socket connections=${epoch}, hello frames=${frames.filter((frame) => frame.type === "hello").length}, exit=${child?.exitCode}, signal=${child?.signalCode}): ${stderr.trim()}`,
    );
  }
  function dispatch(id: string, tool: string, args: Frame, extra: Frame = {}) {
    peer!.send(
      JSON.stringify({
        type: "dispatch",
        protocol: "abridge/1",
        device_id: "fixture",
        connection_epoch: epoch,
        sequence: ++sequence,
        device_credential_version: 1,
        session_capabilities: ["shell", "files"],
        operation_id: id,
        session_id: "fixture_session",
        client_name: "Fixture Agent",
        tool,
        arguments: args,
        expires_at: Date.now() / 1000 + 30,
        ...extra,
      }),
    );
  }
  async function result(id: string, after = 0) {
    return until(
      () => frames.slice(after).find((f) => f.type === "result" && f.operation_id === id),
      `Missing result ${id}; ${stderr}`,
    );
  }
  return {
    directory,
    url,
    requests,
    cli,
    start,
    stop,
    dispatch,
    result,
    frames,
    get peer() {
      return peer!;
    },
    get epoch() {
      return epoch;
    },
    set name(value: string) {
      name = value;
    },
    set responseId(value: string) {
      responseId = value;
    },
    set upgradeStatus(value: number | undefined) {
      upgradeStatus = value;
    },
    set renameResponse(value: { status: number; body: string } | undefined) {
      renameResponse = value;
    },
    async close() {
      await stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((done) => server.close(() => done()));
      await new Promise<void>((done) => http.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function authorize(directory: string, input: Frame, approveInBrowser?: () => Promise<void>) {
  const child = spawn(binary, ["--state-dir", directory, "authorize", "--stdin"], {
    cwd: dirname(binary),
    env: { ...process.env, ABRIDGE_PARENT_PID: String(process.pid) },
    stdio: "pipe",
  });
  const exited = once(child, "close");
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 15000);
  const events: Frame[] = [];
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += String(data)));
  try {
    child.stdin.write(JSON.stringify(input) + "\n");
    for await (const line of createInterface({ input: child.stdout })) {
      const event = JSON.parse(line) as Frame;
      events.push(event);
      if (event.event === "authorization") {
        if (approveInBrowser) await approveInBrowser();
        else child.stdin.end();
      }
      if (event.event === "ready")
        child.stdin.write(JSON.stringify({ command: "commit", capabilities: { files: true } }) + "\n");
    }
    const [code, signal] = await exited;
    assert.equal(signal, null, `Authorization helper terminated: ${stderr}`);
    return { code, events };
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited.catch(() => {});
  }
}

test(
  "native client: startup loads independently of broken binding and bundles no JS runtime",
  { skip: !native },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "abridge-native-startup-"));
    try {
      const status = JSON.parse(
        (await exec(binary, ["status", "--state-dir", join(dir, "not-created")])).stdout,
      ) as Frame;
      assert.equal(status.connection, "offline");
      assert.deepEqual(await readdir(dir), []);
      await writeFile(join(dir, "config.json"), "broken binding", { mode: 0o600 });
      const { stdout } = await exec(binary, ["startup-check", "--state-dir", dir]);
      assert.deepEqual(JSON.parse(stdout), { ready: true, native: true, version: VERSION });
      assert.equal(await readFile(join(dir, "config.json"), "utf8"), "broken binding");
      const smoke = JSON.parse(
        (await exec(binary, ["smoke", "--state-dir", dir], { timeout: 30000 })).stdout,
      ) as Frame;
      assert.equal(smoke.embedded, true);
      assert.equal(smoke.desktop_actions, 0);
      assert.equal(smoke.authorizations, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("native client: local status write errors survive runtime exit", { skip: !native }, async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.directory, "status.json"));
    await assert.rejects(f.cli("run"), (failure: unknown) => {
      assert.ok(failure instanceof Error && "stdout" in failure);
      const result = JSON.parse(String(failure.stdout)) as { error: Frame; ok: boolean };
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "status_write_failed");
      assert.match(String(result.error.message), /无法保存本机连接状态.*目录可写.*磁盘空间/);
      assert.equal(String(result.error.message).includes(f.directory), false);
      return true;
    });
  } finally {
    await f.close();
  }
});

function testHttpConsent(label: string, bindAddress?: string, urlHost?: string) {
  test(
    `native client: bundled helper authorizes and reconnects over HTTP with exact origin consent (${label})`,
    { skip: !native },
    async () => {
      const address =
        bindAddress ??
        Object.values(networkInterfaces())
          .flat()
          .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
      assert.ok(address, "HTTP consent regression requires a non-loopback IPv4 address on this Mac");
      if (urlHost && urlHost !== address)
        assert.deepEqual(await lookup(urlHost, { all: true }), [{ address, family: 4 }]);
      const f = await fixture({ host: address, urlHost, seedBinding: false });
      try {
        const mismatched = new URL(f.url);
        mismatched.port = mismatched.port === "8080" ? "8081" : "8080";
        for (const device_key of [undefined, deviceKey]) {
          for (const http_confirmed_origin of [undefined, mismatched.origin]) {
            const { code, events } = await authorize(f.directory, {
              url: f.url,
              device_key,
              http_confirmed_origin,
            });
            assert.equal(code, 1);
            assert.deepEqual(
              events.map((event) => event.event),
              ["error"],
            );
            assert.match(String(events[0]?.error), /未加密.*HTTP/);
            assert.deepEqual(f.requests, [], "Consent must be checked before the helper contacts the server");
          }
        }

        const input = { url: f.url, http_confirmed_origin: f.url };
        const browser = await authorize(f.directory, input);
        assert.equal(browser.code, 1);
        assert.deepEqual(
          browser.events.map((event) => event.event),
          ["authorization", "error"],
          `HTTP requests received: ${f.requests.length}. Helper events: ${JSON.stringify(browser.events)}`,
        );
        assert.equal(browser.events[0]?.authorization_url, `${f.url}/?authorize=${authorizationId}`);
        assert.deepEqual(
          f.requests.map(({ method, path }) => [method, path]),
          [
            ["POST", authorizationPath],
            ["DELETE", `${authorizationPath}/${authorizationId}`],
          ],
        );
        const request = deviceAuthorizationRequestSchema.parse(f.requests[0]?.body);
        const cancellation = deviceAuthorizationCancelSchema.parse(f.requests[1]?.body);
        assert.equal(request.kind, "computer");
        assert.equal(
          createHash("sha256").update(cancellation.code_verifier).digest("base64url"),
          request.code_challenge,
        );
        assert.deepEqual(await readdir(f.directory), []);

        const approvalOffset = f.requests.length;
        const approval = await authorize(f.directory, input, async () => {
          const start = deviceAuthorizationRequestSchema.parse(f.requests[approvalOffset]?.body);
          const callback = new URL(start.redirect_uri);
          assert.equal(callback.protocol, "http:");
          assert.equal(callback.hostname, "127.0.0.1");
          assert.equal(callback.pathname, DESKTOP_AUTH_CALLBACK_PATH);
          callback.searchParams.set("state", start.state);
          callback.searchParams.set("code", authorizationCode);
          const response = await fetch(callback, { redirect: "error", signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, 200);
          await response.text();
        });
        assert.equal(approval.code, 0, JSON.stringify(approval.events));
        assert.deepEqual(
          approval.events.map((event) => event.event),
          ["authorization", "ready", "complete"],
        );
        const approvalRequests = f.requests.slice(approvalOffset);
        assert.deepEqual(
          approvalRequests.map(({ method, path }) => [method, path]),
          [
            ["POST", authorizationPath],
            ["POST", `${authorizationPath}/token`],
          ],
        );
        const start = deviceAuthorizationRequestSchema.parse(approvalRequests[0]?.body);
        const exchange = deviceAuthorizationTokenRequestSchema.parse(approvalRequests[1]?.body);
        assert.equal(exchange.code, authorizationCode);
        assert.equal(exchange.redirect_uri, start.redirect_uri);
        assert.equal(
          createHash("sha256").update(exchange.code_verifier).digest("base64url"),
          start.code_challenge,
        );
        assert.deepEqual(JSON.parse(await readFile(join(f.directory, "credentials/device.json"), "utf8")), {
          server_url: f.url,
          device_key: browserDeviceKey,
        });
        await f.start();
        f.peer.terminate();
        await until(
          () => f.frames.filter((frame) => frame.type === "hello").length >= 2,
          "Expected HTTP WebSocket reconnect",
        );
        await until(async () => (await f.cli("status")).connection === "online");
        await f.stop();

        const tokenOffset = f.requests.length;
        const token = await authorize(f.directory, { ...input, device_key: deviceKey });
        assert.equal(token.code, 0, JSON.stringify(token.events));
        assert.deepEqual(
          token.events.map((event) => event.event),
          ["ready", "complete"],
        );
        assert.deepEqual(f.requests.slice(tokenOffset), [
          { method: "GET", path: "/api/device", authorization: `Bearer ${deviceKey}`, body: null },
        ]);
        const config = JSON.parse(await readFile(join(f.directory, "config.json"), "utf8")) as Frame;
        assert.equal(config.http_confirmed_origin, f.url);
        assert.deepEqual(JSON.parse(await readFile(join(f.directory, "credentials/device.json"), "utf8")), {
          server_url: f.url,
          device_key: deviceKey,
        });
      } finally {
        await f.close();
      }
    },
  );
}

testHttpConsent("LAN IPv4");
const testHttpAddress = process.env.ABRIDGE_NATIVE_TEST_HTTP_ADDRESS;
const testHttpHostname = process.env.ABRIDGE_NATIVE_TEST_HTTP_HOSTNAME;
if (testHttpAddress && testHttpHostname) {
  testHttpConsent(`TEST-NET IPv4 ${testHttpAddress}`, testHttpAddress);
  testHttpConsent(`DNS hostname ${testHttpHostname}`, testHttpAddress, testHttpHostname);
}

test(
  "native client: connection status diagnoses invalid frames and failed WebSocket upgrades",
  { skip: !native },
  async () => {
    const f = await fixture();
    try {
      await f.start();
      let latest: Frame | undefined;
      async function expectConnectionError(connection: string, pattern: RegExp) {
        const message = await until(
          async () => {
            latest = await f.cli("status");
            const message = String(latest.error);
            return latest.connection === connection && pattern.test(message) ? message : undefined;
          },
          () => `Missing ${pattern} in ${connection} status (last status: ${JSON.stringify(latest)})`,
        );
        assert.equal(message.includes(deviceKey), false);
        assert.equal(message.includes(f.url), false);
      }

      f.upgradeStatus = 404;
      f.peer.send(`Invalid frame with private content ${deviceKey}`);
      await expectConnectionError("offline", /无效的设备消息.*版本/);
      await expectConnectionError("offline", /WebSocket.*HTTP 404/);
      assert.notEqual(JSON.parse(await readFile(join(f.directory, "config.json"), "utf8")).revoked, true);

      f.upgradeStatus = undefined;
      const recovered = await until(async () => {
        const status = await f.cli("status");
        return status.connection === "online" ? status : undefined;
      });
      assert.equal(recovered.error, "");

      f.upgradeStatus = 403;
      f.peer.terminate();
      await expectConnectionError("revoked", /HTTP 403.*访问规则.*重新绑定/);
      assert.equal(JSON.parse(await readFile(join(f.directory, "config.json"), "utf8")).revoked, true);
    } finally {
      await f.close();
    }
  },
);

test(
  "native client: signed runtime speaks protocol, persists no-replay journal and rejects invalid admission",
  { skip: !native },
  async () => {
    const f = await fixture();
    try {
      await f.start();
      const hello = f.frames.find((frame) => frame.type === "hello")!;
      assert.equal(hello.platform, "darwin");
      assert.equal(hello.version, VERSION);
      const details = deviceHelloSchema.parse(hello).details!;
      assert.equal(details.os, "macos");
      assert.equal(details.architecture, "arm64");
      assert.match(details.os_version ?? "", /^\d+\.\d+\.\d+$/);
      const expectedHostname = deviceDetailsSchema.shape.hostname.safeParse(hostname());
      assert.equal(details.hostname, expectedHostname.success ? expectedHostname.data : undefined);
      assert.deepEqual(hello.capabilities, {
        browser: false,
        files: true,
        input: false,
        screen: false,
        shell: true,
      });
      const file = join(f.directory, "effect.txt");
      f.dispatch("write_once", "file_write", { path: file, content: "first" });
      assert.equal((await f.result("write_once")).status, "executed");
      const offset = f.frames.length;
      f.dispatch("write_once", "file_write", { path: file, content: "first" });
      assert.equal((await f.result("write_once", offset)).status, "executed");
      assert.deepEqual((await f.result("write_once", offset)).result, {
        deduplicated: true,
        prior_status: "executed",
      });
      const offset2 = f.frames.length;
      f.dispatch("write_once", "file_write", { path: file, content: "changed" });
      assert.equal(((await f.result("write_once", offset2)).error as Frame).code, "idempotency_conflict");
      f.dispatch("nul", "command_execute", { command: "echo\0secret" });
      assert.equal(((await f.result("nul")).error as Frame).code, "invalid_arguments");
      f.dispatch("expired", "files_list", { path: f.directory }, { expires_at: Date.now() / 1000 - 1 });
      assert.equal(((await f.result("expired")).error as Frame).code, "dispatch_expired");
      f.dispatch("browser", "browser_open", { url: "https://example.com" });
      assert.equal(((await f.result("browser")).error as Frame).code, "capability_unavailable");
      f.dispatch("denied", "file_read", { path: file }, { session_capabilities: ["shell"] });
      assert.equal(((await f.result("denied")).error as Frame).code, "capability_unavailable");
      await f.stop();
      await f.start();
      const afterRestart = f.frames.length;
      f.dispatch("write_once", "file_write", { path: file, content: "first" });
      assert.equal(((await f.result("write_once", afterRestart)).error as Frame).code, "duplicate_operation");
      assert.equal(await readFile(file, "utf8"), "first");
    } finally {
      await f.close();
    }
  },
);

test(
  "native client: pause cancels process groups, survives reconnect and never replays an interrupted write",
  { skip: !native },
  async () => {
    const f = await fixture();
    try {
      await f.start();
      const file = join(f.directory, "must-not-exist");
      f.dispatch("interrupted", "command_execute", { command: `sleep 10; printf effect > '${file}'` });
      await until(async () => (await f.cli("status")).active_operations === 1);
      assert.equal((await f.cli("control", "pause")).paused, true);
      const receipt = await f.result("interrupted");
      assert.equal(receipt.status, "outcome_unknown");
      f.peer.terminate();
      await until(() => f.frames.filter((x) => x.type === "hello").length === 2);
      await until(async () => (await f.cli("status")).connection === "online");
      assert.equal((await f.cli("status")).paused, true);
      f.dispatch("paused", "files_list", { path: f.directory });
      assert.equal(((await f.result("paused")).error as Frame).code, "device_paused");
      await f.cli("control", "resume");
      const offset = f.frames.length;
      f.dispatch("interrupted", "command_execute", { command: `sleep 10; printf effect > '${file}'` });
      assert.equal((await f.result("interrupted", offset)).status, "outcome_unknown");
      await assert.rejects(readFile(file));
      await f.cli("control", "capability", "--capability", "files", "--enabled", "false");
      f.dispatch("disabled", "files_list", { path: f.directory });
      assert.equal(((await f.result("disabled")).error as Frame).code, "capability_unavailable");
    } finally {
      await f.close();
    }
  },
);

test(
  "native client: names, local controls, closed sessions and unbind preserve lifecycle boundaries",
  { skip: !native },
  async () => {
    const f = await fixture();
    try {
      await f.start();
      assert.equal((await f.cli("status")).device_name, "Fixture Mac");
      const credentials = await readFile(join(f.directory, "credentials/device.json"));
      assert.equal((await f.cli("control", "rename", "--name", "  New Mac  ")).device_name, "New Mac");
      assert.deepEqual(await readFile(join(f.directory, "credentials/device.json")), credentials);
      f.name = "Console Name";
      f.peer.send(
        JSON.stringify({ type: "heartbeat_ack", connection_epoch: f.epoch, device_name: "Console Name" }),
      );
      await until(async () => (await f.cli("status")).device_name === "Console Name");
      async function expectRenameFailure(pattern: RegExp) {
        await assert.rejects(f.cli("control", "rename", "--name", "Rejected rename"), (failure: unknown) => {
          assert.ok(failure instanceof Error && "stdout" in failure);
          const result = JSON.parse(String(failure.stdout)) as { error: Frame; ok: boolean };
          assert.equal(result.ok, false);
          assert.equal(result.error.code, "rename_failed");
          assert.match(String(result.error.message), pattern);
          assert.equal(String(result.error.message).includes(deviceKey), false);
          return true;
        });
      }
      f.renameResponse = { status: 503, body: deviceKey };
      await expectRenameFailure(/修改设备名称失败.*HTTP 503/);
      f.renameResponse = { status: 200, body: deviceKey };
      await expectRenameFailure(/无效的设备名称响应.*Server 版本/);
      f.renameResponse = undefined;
      f.responseId = deviceKey;
      await expectRenameFailure(/其他设备的响应.*Server 地址/);
      assert.equal((await f.cli("status")).device_name, "Console Name");
      f.peer.send(
        JSON.stringify({ type: "session_close", connection_epoch: f.epoch, session_id: "fixture_session" }),
      );
      f.dispatch("closed", "files_list", { path: f.directory });
      assert.equal(((await f.result("closed")).error as Frame).code, "session_closed");
      const result = await f.cli("control", "unbind");
      assert.equal(result.unbound, true);
      assert.equal(result.cloud_revoked, true);
      await assert.rejects(readFile(join(f.directory, "credentials/device.json")));
      const status = await until(async () => {
        const value = await f.cli("status");
        return value.connection === "offline" && value;
      });
      assert.ok(status);
      assert.equal(status.active_operations, 0);
      assert.equal(JSON.stringify(status).includes("abr_device_"), false);
    } finally {
      await f.close();
    }
  },
);

test(
  "native client: operation limit, cancellation and revoked credentials fail closed",
  { skip: !native },
  async () => {
    const f = await fixture();
    try {
      await f.start();
      for (let i = 0; i < 8; i++) f.dispatch(`busy_${i}`, "command_execute", { command: "sleep 20" });
      await until(async () => (await f.cli("status")).active_operations === 8);
      f.dispatch("overflow", "files_list", { path: f.directory });
      assert.equal(((await f.result("overflow")).error as Frame).code, "device_busy");
      f.peer.send(JSON.stringify({ type: "cancel", connection_epoch: f.epoch, operation_ids: ["busy_0"] }));
      assert.equal((await f.result("busy_0")).status, "outcome_unknown");
      await f.cli("control", "stop");
      for (let i = 1; i < 8; i++) assert.equal((await f.result(`busy_${i}`)).status, "outcome_unknown");
      assert.equal((await f.cli("status")).active_operations, 0);
      f.upgradeStatus = 401;
      f.peer.terminate();
      const revoked = await until(async () => {
        const status = await f.cli("status");
        return status.connection === "revoked" ? status : undefined;
      });
      assert.match(String(revoked.error), /设备凭证.*重新绑定.*HTTP 401/);
      assert.equal(
        (JSON.parse(await readFile(join(f.directory, "config.json"), "utf8")) as Frame).revoked,
        true,
      );
    } finally {
      await f.close();
    }
  },
);
