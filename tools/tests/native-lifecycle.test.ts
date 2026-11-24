import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { chmod, mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../lib/process.js";

test(
  "native lifecycle preserves private state, no-replay journal, control and authorization boundaries",
  { skip: process.platform !== "darwin", timeout: 60000 },
  async (t) => {
    const work = await mkdtemp(join(tmpdir(), "abridge-native-lifecycle-"));
    const root = resolve(import.meta.dirname, "../..");
    const executable = join(work, "bin/test");
    try {
      await mkdir(join(work, "bin"));
      await mkdir(join(work, "Resources"));
      await copyFile(
        join(root, "dist/desktop/desktop-contract.json"),
        join(work, "Resources/desktop-contract.json"),
      );
      await run("/usr/bin/swiftc", [
        "-swift-version",
        "6",
        "-parse-as-library",
        ...[
          "JSON",
          "Contract",
          "Storage",
          "LocalControl",
          "DeviceServerTransport",
          "DeviceServerSession",
          "Authorization",
        ].map((name) => join(root, `apps/desktop/native/runtime/${name}.swift`)),
        join(root, "tools/fixtures/native-lifecycle.swift"),
        "-lsqlite3",
        "-o",
        executable,
      ]);
      await t.test("private storage, URL consent, journal recovery and socket ownership", async () => {
        assert.match(await run(executable, []), /native lifecycle storage\/socket: checks passed/);
      });
      for (const scenario of [
        "pkce",
        "manual",
        "denial",
        "signal",
        "eof",
        "parent",
        "expired",
        "cross-origin",
        "invalid-token",
        "unsafe-binding-file",
        "wrong-kind",
        "redirect",
        "connection-refused",
        "server-refused",
        "missing-route",
        "grant-rejected",
        "malformed-token",
        "incompatible-token",
        "token-timeout",
      ] as const) {
        await t.test(scenario, async () => {
          const directory = await mkdtemp(join(work, "state-"));
          await mkdir(join(directory, "credentials"), { mode: 0o700 });
          const previous = {
            url: "https://previous.invalid",
            capabilities: { shell: true },
            paused: true,
            pause_reason: "manual",
          };
          const oldCredential = { server_url: previous.url, device_key: "abr_device_old" };
          await writeFile(join(directory, "config.json"), JSON.stringify(previous), { mode: 0o600 });
          await writeFile(join(directory, "credentials/device.json"), JSON.stringify(oldCredential), {
            mode: 0o600,
          });
          let request: Record<string, unknown> = {},
            exchange: Record<string, unknown> | undefined;
          let cancellations = 0;
          const responseSecret = "abr_device_fixture_secret";
          const server = createServer(async (incoming, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
            response.setHeader("content-type", "application/json");
            if (incoming.url === "/api/device") {
              assert.equal(incoming.headers.authorization, "Bearer abr_device_new");
              if (scenario === "redirect") {
                response.writeHead(302, { location: "http://127.0.0.1:1/" + responseSecret }).end("{}");
                return;
              }
              response.writeHead(scenario === "invalid-token" ? 401 : 200).end(
                JSON.stringify({
                  id: "fixture-device",
                  name: "Fixture",
                  kind: scenario === "wrong-kind" ? "browser" : "computer",
                  capabilities: ["files"],
                }),
              );
            } else if (incoming.url === "/api/device-authorizations" && incoming.method === "POST") {
              request = body;
              if (scenario === "server-refused") {
                response
                  .writeHead(401)
                  .end(JSON.stringify({ error: { code: "unauthorized", message: responseSecret } }));
                return;
              }
              if (scenario === "missing-route") {
                response.writeHead(404).end(JSON.stringify({ message: responseSecret }));
                return;
              }
              response.end(
                JSON.stringify({
                  id: "a".repeat(43),
                  authorization_url:
                    scenario === "cross-origin" ? "https://other.invalid/authorize" : origin + "/authorize",
                  expires_at:
                    Date.now() / 1000 + (scenario === "expired" ? -1 : scenario === "token-timeout" ? 5 : 60),
                }),
              );
            } else if (incoming.url === "/api/device-authorizations/token") {
              exchange = body;
              assert.equal(
                createHash("sha256").update(String(body.code_verifier)).digest("base64url"),
                request.code_challenge,
              );
              assert.equal(body.redirect_uri, request.redirect_uri);
              if (scenario === "grant-rejected") {
                response
                  .writeHead(400)
                  .end(JSON.stringify({ error: { code: "invalid_grant", message: responseSecret } }));
                return;
              }
              if (scenario === "malformed-token") {
                response.end('{"key":' + JSON.stringify(responseSecret));
                return;
              }
              if (scenario === "incompatible-token") {
                response.end(JSON.stringify({ key: responseSecret }));
                return;
              }
              if (scenario === "token-timeout") {
                response.flushHeaders();
                return;
              }
              response.end(
                JSON.stringify({
                  device_id: "fixture-device",
                  key: "abr_device_new",
                  name: "Fixture",
                  kind: "computer",
                  capabilities: ["files"],
                }),
              );
            } else if (incoming.method === "DELETE") {
              cancellations++;
              response.end('{"ok":true}');
            } else response.writeHead(404).end("{}");
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          const address = server.address();
          assert.ok(address && typeof address !== "string");
          const origin = `http://127.0.0.1:${address.port}`;
          if (scenario === "connection-refused")
            await new Promise<void>((resolve) => server.close(() => resolve()));
          const manual = [
            "manual",
            "invalid-token",
            "unsafe-binding-file",
            "wrong-kind",
            "redirect",
          ].includes(scenario);
          const child = spawn(executable, ["authorize", directory], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              ...process.env,
              ABRIDGE_PARENT_PID: String(scenario === "parent" ? 2147483647 : process.pid),
            },
          });
          const exited = once(child, "exit");
          const output: string[] = [];
          let completed = false;
          let authorizationError: unknown;
          let stderr = "";
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          const watchdog = setTimeout(() => child.kill("SIGKILL"), 10000);
          const callback = async (values: Record<string, string>) => {
            const url = new URL(String(request.redirect_uri));
            for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
            return fetch(url);
          };
          try {
            child.stdin.write(
              JSON.stringify({ url: origin, ...(manual ? { device_key: "abr_device_new" } : {}) }) + "\n",
            );
            for await (const line of createInterface({ input: child.stdout })) {
              output.push(line);
              const event = JSON.parse(line) as Record<string, unknown>;
              if (event.event === "authorization") {
                if (scenario === "parent") continue;
                assert.deepEqual(
                  JSON.parse(await readFile(join(directory, "credentials/device.json"), "utf8")),
                  oldCredential,
                );
                if (scenario === "signal") child.kill("SIGTERM");
                else if (scenario === "eof") child.stdin.end();
                else if (scenario === "denial")
                  assert.equal(
                    (await callback({ state: String(request.state), error: "access_denied" })).status,
                    200,
                  );
                else {
                  assert.ok(
                    [
                      "pkce",
                      "grant-rejected",
                      "malformed-token",
                      "incompatible-token",
                      "token-timeout",
                    ].includes(scenario),
                  );
                  if (scenario === "pkce") {
                    assert.equal(
                      (await callback({ state: "wrong-state", code: "c".repeat(43) })).status,
                      400,
                    );
                    assert.equal(exchange, undefined);
                  }
                  const response = await callback({ state: String(request.state), code: "c".repeat(43) });
                  assert.equal(response.status, 200);
                  assert.equal(await response.text(), "已收到授权，请返回 aBridge 查看绑定结果。");
                }
              } else if (event.event === "ready") {
                assert.ok(scenario === "pkce" || scenario === "manual" || scenario === "unsafe-binding-file");
                assert.deepEqual(
                  JSON.parse(await readFile(join(directory, "config.json"), "utf8")),
                  previous,
                );
                if (scenario === "unsafe-binding-file") await chmod(join(directory, "config.json"), 0o644);
                child.stdin.write(
                  JSON.stringify({ command: "commit", capabilities: { files: true } }) + "\n",
                );
              } else if (event.event === "complete") {
                completed = true;
                child.stdin.end();
              } else {
                assert.equal(event.event, "error");
                authorizationError = event.error;
              }
            }
            const success = scenario === "pkce" || scenario === "manual";
            assert.equal((await exited)[0], success ? 0 : 1, stderr);
            assert.equal(completed, success);
            const diagnostics = output.join("\n") + stderr;
            assert.ok(!diagnostics.includes("abr_device_new"));
            assert.ok(!diagnostics.includes(responseSecret));
            if (exchange) assert.ok(!diagnostics.includes(String(exchange.code_verifier)));
            if (scenario === "connection-refused") {
              assert.match(String(authorizationError), /^发起浏览器授权失败。无法连接 Server/);
            } else if (scenario === "server-refused") {
              assert.match(String(authorizationError), /^发起浏览器授权失败。.*访问规则（HTTP 401）$/);
            } else if (scenario === "missing-route") {
              assert.match(String(authorizationError), /^发起浏览器授权失败。.*Server 版本（HTTP 404）$/);
            } else if (scenario === "unsafe-binding-file") {
              assert.match(
                String(authorizationError),
                /已取得设备凭据，但未能保存本机绑定。.*所有者与访问权限/,
              );
              assert.ok(!diagnostics.includes(directory));
            } else if (scenario === "invalid-token") {
              assert.match(
                String(authorizationError),
                /^验证设备凭证失败。设备凭证无效或已撤销，请使用此 Server 的 Device Key（HTTP 401）$/,
              );
            } else if (scenario === "wrong-kind") {
              assert.match(String(authorizationError), /^验证设备凭证失败。.*请换用电脑设备的 Device Key$/);
            } else if (scenario === "redirect") {
              assert.match(
                String(authorizationError),
                /^验证设备凭证失败。.*最终的 Server 地址（HTTP 302）$/,
              );
            } else if (scenario === "denial") {
              assert.equal(authorizationError, "浏览器授权已取消。如需绑定，请重新发起");
            } else if (scenario === "expired") {
              assert.equal(authorizationError, "授权已过期，请重新发起");
            } else if (scenario === "cross-origin") {
              assert.match(
                String(authorizationError),
                /^发起浏览器授权失败。.*检查所填地址及 Server 对外地址设置$/,
              );
              assert.ok(!diagnostics.includes("https://other.invalid/authorize"));
            } else if (scenario === "grant-rejected") {
              assert.match(
                String(authorizationError),
                /^兑换设备凭证失败。.*请重新发起浏览器授权（HTTP 400）$/,
              );
            } else if (scenario === "malformed-token") {
              assert.match(String(authorizationError), /^兑换设备凭证失败。Server 返回了无效的 JSON 响应/);
            } else if (scenario === "incompatible-token") {
              assert.match(String(authorizationError), /^兑换设备凭证失败。.*请检查 Server 地址和版本$/);
            } else if (scenario === "token-timeout") {
              assert.match(String(authorizationError), /^兑换设备凭证失败。连接 Server 超时/);
            }
            const config = JSON.parse(
              await readFile(join(directory, "config.json"), "utf8"),
            ) as typeof previous;
            const credential = JSON.parse(await readFile(join(directory, "credentials/device.json"), "utf8"));
            assert.equal(config.paused, true);
            assert.equal(config.pause_reason, "manual");
            if (success) {
              assert.equal(config.url, origin);
              assert.equal(credential.device_key, "abr_device_new");
            } else {
              assert.deepEqual(config, previous);
              assert.deepEqual(credential, oldCredential);
            }
            if (!manual && !["parent", "connection-refused"].includes(scenario)) {
              const startRejected = scenario === "server-refused" || scenario === "missing-route";
              assert.equal(cancellations, success || startRejected ? 0 : 1);
              await assert.rejects(fetch(String(request.redirect_uri)));
            }
          } finally {
            clearTimeout(watchdog);
            if (child.exitCode === null) child.kill("SIGKILL");
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        });
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);
