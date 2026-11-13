import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authorizeDevice } from "../src/authorization.js";
import { configureClient } from "../src/runtime.js";
import { loadConfig, loadCredential, saveConfig } from "../src/storage.js";
import type { AuthorizationNotice } from "../src/authorization.js";

async function fixture() {
  let request: Record<string, unknown> = {};
  let exchange: Record<string, unknown> | undefined;
  let cancellations = 0;
  let redirect = "";
  let maliciousConsent = false;
  const key = "abr_device_" + "k".repeat(43);
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    response.setHeader("content-type", "application/json");
    if (incoming.url === "/api/device-authorizations" && incoming.method === "POST") {
      request = body;
      redirect = String(body.redirect_uri);
      response.end(
        JSON.stringify({
          id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          authorization_url: maliciousConsent
            ? "https://other.invalid/?authorize=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            : `${origin}/?authorize=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
          expires_at: Date.now() / 1000 + 300,
        }),
      );
    } else if (incoming.url === "/api/device-authorizations/token") {
      exchange = body;
      assert.equal(
        createHash("sha256").update(body.code_verifier).digest("base64url"),
        request.code_challenge,
      );
      assert.equal(body.redirect_uri, request.redirect_uri);
      response.end(
        JSON.stringify({
          device_id: "dev_fixture",
          key,
          name: "Fixture Mac",
          kind: "computer",
          capabilities: ["screen", "input", "shell", "files"],
        }),
      );
    } else if (incoming.method === "DELETE") {
      cancellations++;
      response.end('{"ok":true}');
    } else {
      response.writeHead(404).end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    key,
    get request() {
      return request;
    },
    get exchange() {
      return exchange;
    },
    get cancellations() {
      return cancellations;
    },
    get redirect() {
      return redirect;
    },
    maliciousConsent() {
      maliciousConsent = true;
    },
    callback(values: Record<string, string>) {
      const url = new URL(redirect);
      for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
      return fetch(url);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("desktop browser authorization uses PKCE, rejects unrelated callbacks and keeps secrets off UI notices", async () => {
  const remote = await fixture();
  const notices: AuthorizationNotice[] = [];
  let callbackWork!: Promise<void>;
  try {
    const result = await authorizeDevice(remote.origin, {
      onAuthorization(notice) {
        notices.push(notice);
        callbackWork = (async () => {
          assert.equal((await remote.callback({ state: "wrong-state", code: "c".repeat(43) })).status, 400);
          assert.equal(remote.exchange, undefined);
          assert.equal(
            (await remote.callback({ state: String(remote.request.state), code: "c".repeat(43) })).status,
            200,
          );
        })();
      },
    });
    await callbackWork;
    assert.equal(result.device.key, remote.key);
    assert.equal(result.url, remote.origin);
    assert.equal(remote.request.kind, "computer");
    assert.deepEqual(remote.request.capabilities, ["screen", "input", "shell", "files"]);
    const serialized = JSON.stringify(notices);
    assert.ok(!serialized.includes(remote.key));
    assert.ok(!serialized.includes(String(remote.exchange?.code_verifier)));
    await assert.rejects(fetch(remote.redirect));
    assert.equal(remote.cancellations, 0);
  } finally {
    await remote.close();
  }
});

test("desktop denial and cancellation close the callback listener and cancel the pending request", async () => {
  for (const outcome of ["deny", "cancel"] as const) {
    const remote = await fixture();
    const abort = new AbortController();
    let callbackWork: Promise<Response> | undefined;
    try {
      await assert.rejects(
        authorizeDevice(remote.origin, {
          signal: abort.signal,
          onAuthorization() {
            if (outcome === "cancel") abort.abort();
            else
              callbackWork = remote.callback({ state: String(remote.request.state), error: "access_denied" });
          },
        }),
        /取消/,
      );
      if (callbackWork) assert.equal((await callbackWork).status, 200);
      assert.equal(remote.exchange, undefined);
      assert.equal(remote.cancellations, 1);
      await assert.rejects(fetch(remote.redirect));
    } finally {
      await remote.close();
    }
  }
});

test("desktop timeout and cross-origin consent page cannot replace an existing binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abridge-authorize-"));
  const remote = await fixture();
  try {
    await configureClient(directory, {
      url: "https://existing.invalid",
      device_key: "abr_device_" + "o".repeat(43),
      capabilities: { shell: true },
    });
    const old = await loadConfig(directory);
    await saveConfig(directory, { ...old, paused: true, pause_reason: "manual" });
    await assert.rejects(authorizeDevice(remote.origin, { timeoutMs: 40, onAuthorization() {} }), /过期/);
    assert.equal(remote.cancellations, 1);
    remote.maliciousConsent();
    await assert.rejects(
      authorizeDevice(remote.origin, {
        onAuthorization() {
          assert.fail("Untrusted browser page was opened");
        },
      }),
      /不匹配/,
    );
    assert.equal((await loadConfig(directory)).url, "https://existing.invalid");
    assert.equal((await loadConfig(directory)).paused, true);
    assert.equal(await loadCredential(directory, "https://existing.invalid"), "abr_device_" + "o".repeat(43));
    await configureClient(directory, {
      url: remote.origin,
      device_key: remote.key,
      capabilities: { files: true },
    });
    const rebound = await loadConfig(directory);
    assert.equal(rebound.paused, true);
    assert.equal(rebound.pause_reason, "manual");
    assert.equal(rebound.capabilities.screen, false);
    assert.equal(rebound.capabilities.files, true);
  } finally {
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop authorization pipe commits only after consent, without sending the credential to the UI", async () => {
  const remote = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "abridge-authorize-pipe-"));
  const oldKey = "abr_device_" + "p".repeat(43);
  await configureClient(directory, {
    url: "https://previous.invalid",
    device_key: oldKey,
    capabilities: { shell: true },
  });
  await saveConfig(directory, { ...(await loadConfig(directory)), paused: true, pause_reason: "manual" });
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/desktop/src/cli.ts", "--state-dir", directory, "authorize", "--stdin"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  const output: string[] = [];
  let completed = false;
  try {
    child.stdin.write(JSON.stringify({ url: remote.origin }) + "\n");
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      output.push(line);
      const event = JSON.parse(line);
      if (event.event === "authorization") {
        assert.equal(await loadCredential(directory, "https://previous.invalid"), oldKey);
        await remote.callback({ state: String(remote.request.state), code: "c".repeat(43) });
      } else if (event.event === "ready") {
        assert.equal(await loadCredential(directory, "https://previous.invalid"), oldKey);
        assert.equal((await loadConfig(directory)).url, "https://previous.invalid");
        child.stdin.write(JSON.stringify({ command: "commit", capabilities: { files: true } }) + "\n");
      } else if (event.event === "complete") {
        completed = true;
        child.stdin.end();
      } else assert.fail("Unexpected authorization event: " + event.event);
    }
    assert.equal((await exited)[0], 0);
    assert.equal(completed, true);
    assert.equal(await loadCredential(directory, remote.origin), remote.key);
    assert.equal((await loadConfig(directory)).paused, true);
    assert.equal((await loadConfig(directory)).capabilities.files, true);
    assert.ok(!output.join("").includes(remote.key));
    assert.ok(!output.join("").includes(String(remote.exchange?.code_verifier)));
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing the authorization pipe cancels the pending request and keeps the old binding", async () => {
  const remote = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "abridge-authorize-pipe-"));
  const oldKey = "abr_device_" + "q".repeat(43);
  await configureClient(directory, { url: "https://previous.invalid", device_key: oldKey });
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/desktop/src/cli.ts", "--state-dir", directory, "authorize", "--stdin"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  try {
    child.stdin.write(JSON.stringify({ url: remote.origin }) + "\n");
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const event = JSON.parse(line);
      if (event.event === "authorization") child.stdin.end();
      else assert.equal(event.event, "error");
    }
    assert.equal((await exited)[0], 1);
    assert.equal(remote.exchange, undefined);
    assert.equal(remote.cancellations, 1);
    assert.equal(await loadCredential(directory, "https://previous.invalid"), oldKey);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});
