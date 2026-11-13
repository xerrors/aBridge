/** An owned form/cookie target. Never connects to personal websites or accounts. */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: { state: { type: "string" }, port: { type: "string", default: "0" } },
});
if (!values.state) throw new Error("--state is required");
const file = resolve(values.state),
  cookie = randomBytes(24).toString("base64url");
const state = {
  code: randomBytes(3).toString("hex").toUpperCase(),
  text: "",
  submit_count: 0,
  port: 0,
  cookie_verified: false,
};
await mkdir(dirname(file), { recursive: true, mode: 0o700 });
let writing = Promise.resolve();
const persist = () => {
  const text = JSON.stringify(state, null, 2) + "\n";
  writing = writing
    .catch(() => {})
    .then(async () => {
      await writeFile(file + ".tmp", text, { mode: 0o600 });
      await rename(file + ".tmp", file);
    });
  return writing;
};
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
const server = createServer((request, response) => {
  void (async () => {
    if (request.method === "GET" && request.url === "/seed") {
      response
        .writeHead(303, {
          "Set-Cookie": `abridge_fixture=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
          Location: "/",
        })
        .end();
      return;
    }
    if (request.method === "POST" && request.url === "/submit") {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 4096) {
          response.writeHead(400).end();
          return;
        }
      }
      const text = new URLSearchParams(body).get("message") ?? "";
      if (Array.from(text).length > 500) {
        response.writeHead(400).end();
        return;
      }
      state.text = text;
      state.submit_count++;
      await persist();
      response.writeHead(303, { Location: "/" }).end();
      return;
    }
    if (request.method !== "GET" || request.url !== "/") {
      response.writeHead(404).end();
      return;
    }
    state.cookie_verified = (request.headers.cookie ?? "")
      .split(";")
      .some((part) => part.trim() === `abridge_fixture=${cookie}`);
    await persist();
    response
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      .end(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>aBridge 浏览器验收</title><style>body{font:16px/1.5 system-ui;max-width:560px;margin:24px auto;color:#172336}input{display:block;padding:10px;margin:10px 0}button{background:#0066dd;color:white;border:0;padding:10px 18px}</style><main><h1>aBridge 浏览器验收</h1><p>页面验证码：<strong>${state.code}</strong></p><p>当前会话：${state.cookie_verified ? "已登录" : "未登录"}</p><form action="/submit" method="post"><label for="message">验收输入</label><input id="message" name="message" maxlength="500" value="${escape(state.text)}" autocomplete="off"><button type="submit">提交验证</button></form><output>提交次数：${state.submit_count}</output><p>已保存内容：${escape(state.text)}</p></main></html>`,
      );
  })().catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
await new Promise<void>((ok) => server.listen(Number(values.port), "127.0.0.1", ok));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Listen failed");
state.port = address.port;
await persist();
console.log(JSON.stringify({ url: `http://127.0.0.1:${address.port}/`, state: file }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
