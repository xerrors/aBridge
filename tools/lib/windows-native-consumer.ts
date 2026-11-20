/** Real native runtime against an owned loopback Server and temporary files. No user accounts or desktop input. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";

type ObjectValue = Record<string, unknown>;
async function until<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 45000;
  do {
    const value = await read();
    if (accept(value)) return value;
    await delay(40);
  } while (Date.now() < deadline);
  throw Error(`Native client did not complete: ${label}`);
}
export async function checkNativeConsumer(executable: string, directory: string): Promise<void> {
  const deviceKey = "abr_device_native_fixture_" + "k".repeat(32);
  let revoked = 0;
  let origin = "";
  let authorization: ObjectValue = {};
  let exchanges = 0;
  const callbackChecks: Promise<void>[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/api/device-authorizations")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as ObjectValue;
      if (request.url === "/api/device-authorizations" && request.method === "POST") {
        authorization = body;
        response.end(
          JSON.stringify({
            id: "a".repeat(43),
            authorization_url: origin + "/?authorize=fixture",
            expires_at: Date.now() / 1000 + 60,
          }),
        );
        const callback = new URL(String(body.redirect_uri));
        callback.searchParams.set("state", "incorrect");
        callback.searchParams.set("code", "b".repeat(43));
        const callbackCheck = (async () => {
          assert.equal((await fetch(callback)).status, 400, "Wrong callback state must be rejected");
          callback.searchParams.set("state", String(body.state));
          assert.equal((await fetch(callback)).status, 200);
        })();
        void callbackCheck.catch(() => {});
        callbackChecks.push(callbackCheck);
      } else if (request.url.endsWith("/token")) {
        assert.equal(
          createHash("sha256").update(String(body.code_verifier)).digest("base64url"),
          authorization.code_challenge,
        );
        assert.equal(body.redirect_uri, authorization.redirect_uri);
        exchanges++;
        response.end(
          JSON.stringify({
            device_id: "dev_fixture",
            key: deviceKey,
            name: "Native fixture",
            kind: "computer",
            capabilities: ["shell", "files"],
          }),
        );
      } else {
        response.end('{"ok":true}');
      }
      return;
    }
    if (request.headers.authorization !== `Bearer ${deviceKey}`) {
      response.writeHead(401).end("{}");
      return;
    }
    if (request.url === "/api/device" && request.method === "GET") {
      response.end(
        JSON.stringify({
          id: "dev_fixture",
          name: "Native fixture",
          kind: "computer",
          capabilities: ["shell", "files"],
        }),
      );
    } else {
      response.writeHead(404).end("{}");
    }
  });
  const websocket = new WebSocketServer({ server });
  const messages: ObjectValue[] = [];
  let peer: WebSocket | undefined;
  websocket.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${deviceKey}`);
    peer = socket;
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString()) as ObjectValue;
      messages.push(message);
      if (message.type === "hello")
        socket.send(
          JSON.stringify({
            type: "welcome",
            protocol: "abridge/1",
            device_id: "dev_fixture",
            connection_epoch: 1,
            capabilities: ["shell", "files"],
            owner_name: "Fixture",
            lease_seconds: 30,
            heartbeat_interval: 10,
          }),
        );
      if (message.type === "heartbeat") socket.send('{"type":"heartbeat_ack","connection_epoch":1}');
      if (message.type === "unbind") {
        revoked++;
        socket.send('{"type":"revoke","connection_epoch":1}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  const state = join(directory, "native-state");
  const host = spawn(
    executable,
    ["--native-host", "--state-dir", state, "--parent-pid", String(process.pid)],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: directory,
    },
  );
  let errors = "";
  let protocolError: Error | undefined;
  host.stdin.on("error", () => {});
  host.stderr.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-4096);
  });
  const replies = new Map<number, ObjectValue>();
  const lines = createInterface({ input: host.stdout });
  lines.on("line", (line) => {
    try {
      const value = JSON.parse(line) as ObjectValue;
      if (typeof value.id === "number") replies.set(value.id, value);
    } catch {
      protocolError = Error("Native host emitted invalid JSON");
    }
  });
  let id = 0;
  const action = async (name: string, args: ObjectValue = {}) => {
    const requestId = ++id;
    host.stdin.write(JSON.stringify({ id: requestId, action: name, args }) + "\n");
    const result = await until(
      () => {
        if (protocolError) throw protocolError;
        if (replies.has(requestId)) return replies.get(requestId);
        assert.equal(host.exitCode, null, `Host exited: ${errors}`);
        return replies.get(requestId);
      },
      Boolean,
      name,
    );
    assert.ok(result);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  let sequence = 0;
  const dispatch = (operation: string, tool: string, args: ObjectValue) => {
    assert.ok(peer);
    const frame = {
      type: "dispatch",
      protocol: "abridge/1",
      device_id: "dev_fixture",
      connection_epoch: 1,
      operation_id: operation,
      session_id: "sess_fixture",
      session_capabilities: ["shell", "files"],
      device_credential_version: 1,
      sequence: ++sequence,
      expires_at: Date.now() / 1000 + 30,
      tool,
      arguments: args,
    };
    peer.send(JSON.stringify(frame));
    return frame;
  };
  const receipt = (operation: string, count = 1) =>
    until(
      () => messages.filter((m) => m.type === "result" && m.operation_id === operation),
      (results) => results.length >= count,
      operation,
    ).then((results) => results[count - 1]!);
  try {
    const initial = await action("status");
    assert.equal(initial.bound, false);
    await action("bind", {
      url: origin,
      capabilities: { screen: false, input: false, shell: true, files: true },
    });
    await Promise.all(callbackChecks);
    assert.equal(exchanges, 1, "Browser authorization must exchange a PKCE-bound code");
    await until(
      () => action("status"),
      (s) => s.connection === "online",
      "browser-bound online",
    );
    await action("unbind");
    await action("bind", {
      url: `http://127.0.0.1:${address.port}`,
      device_key: deviceKey,
      capabilities: { screen: false, input: false, shell: true, files: true },
    });
    await until(
      () => action("status"),
      (s) => s.connection === "online",
      "online",
    );
    await action("resume");
    const effect = join(directory, "native-effect.txt");
    const first = dispatch("native_write", "file_write", {
      path: effect,
      content: "中文 fixture",
      overwrite: true,
    });
    assert.equal((await receipt("native_write")).status, "executed");
    assert.equal(await readFile(effect, "utf8"), "中文 fixture");
    await writeFile(effect, "external change");
    peer!.send(JSON.stringify(first));
    assert.equal((await receipt("native_write", 2)).status, "executed");
    assert.equal(await readFile(effect, "utf8"), "external change", "Duplicate writes must not replay");
    dispatch("native_read", "file_read", { path: effect });
    const read = await receipt("native_read");
    assert.equal(read.status, "executed");
    assert.match(JSON.stringify(read.result), /external change/);
    dispatch("native_shell", "command_execute", {
      command: "Write-Output 'native-shell-fixture'",
      // This checks packaged execution, not startup latency on a cold shared runner.
      timeout: 30,
    });
    const shell = await receipt("native_shell");
    assert.equal(shell.status, "executed");
    assert.match(JSON.stringify(shell.result), /native-shell-fixture/);
    await action("pause");
    dispatch("native_paused", "file_write", { path: effect, content: "forbidden", overwrite: true });
    assert.equal((await receipt("native_paused")).status, "refused");
    assert.equal(await readFile(effect, "utf8"), "external change");
    assert.equal((await action("status")).paused, true);
    await action("resume");
    await action("capability", { capability: "files", enabled: false });
    dispatch("native_disabled", "file_read", { path: effect });
    assert.equal((await receipt("native_disabled")).status, "refused");
    await action("unbind");
    assert.equal(revoked, 2, "Each unbind must revoke the Server credential");
    await action("quit");
    await until(
      () => host.exitCode,
      (code) => code !== null,
      "graceful exit",
    );
    assert.equal(host.exitCode, 0, errors);
  } finally {
    lines.close();
    host.stdin.end();
    if (host.exitCode === null && host.pid)
      spawnSync("taskkill.exe", ["/PID", String(host.pid), "/T", "/F"], { windowsHide: true });
    for (const socket of websocket.clients) socket.terminate();
    await new Promise<void>((resolve) => websocket.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
