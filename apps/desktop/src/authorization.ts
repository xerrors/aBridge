/** Browser consent and PKCE stay in the device runtime; credentials never enter the browser redirect. */
import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import {
  DESKTOP_CAPABILITIES,
  DESKTOP_AUTH_CALLBACK_PATH,
  deviceAuthorizationRequestSchema,
  deviceAuthorizationStartSchema,
  deviceAuthorizationTokenRequestSchema,
  deviceAuthorizationTokenSchema,
} from "@abridge/protocol";
import { DesktopError } from "./errors.js";
import { normalizeServerUrl } from "./storage.js";

export type AuthorizationNotice = {
  event: "authorization";
  authorization_url: string;
  expires_at: number;
};
export type AuthorizedDevice = {
  url: string;
  device: z.infer<typeof deviceAuthorizationTokenSchema>;
};
type AuthorizationOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  onAuthorization: (notice: AuthorizationNotice) => void;
};

async function responseJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new DesktopError("authorization_failed", `授权服务请求失败 (${response.status})`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new DesktopError("invalid_response", "授权服务未返回结果");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) throw new DesktopError("invalid_response", "授权服务返回结果过大");
      chunks.push(value);
    }
    const result = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!result.success) throw new DesktopError("invalid_response", "授权服务返回无效结果");
    return result.data;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof SyntaxError) throw new DesktopError("invalid_response", "授权服务返回无效结果");
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function authorizeDevice(url: string, options: AuthorizationOptions): Promise<AuthorizedDevice> {
  const serverUrl = normalizeServerUrl(url);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 300000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let authorizationId: string | undefined;
  let completed = false;
  let expires: ReturnType<typeof setTimeout> | undefined;
  const expiry = new AbortController();
  const requestSignal = AbortSignal.any([signal, expiry.signal]);
  let acceptCode!: (code: string) => void;
  let rejectCode!: (reason: unknown) => void;
  const callback = new Promise<string>((resolve, reject) => {
    acceptCode = resolve;
    rejectCode = reject;
  });
  // Attach a handler before requesting consent so an early cancellation is never unhandled.
  void callback.catch(() => {});
  let redirectUri = "";
  let received = false;
  const listener = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    response.setHeader("connection", "close");
    let target: URL;
    try {
      target = new URL(request.url ?? "/", redirectUri);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const expected = new URL(redirectUri);
    const supplied = target.searchParams.get("state") ?? "";
    const code = target.searchParams.get("code");
    const error = target.searchParams.get("error");
    if (
      request.method !== "GET" ||
      request.headers.host !== expected.host ||
      target.origin !== expected.origin ||
      target.pathname !== DESKTOP_AUTH_CALLBACK_PATH ||
      target.searchParams.getAll("state").length !== 1 ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(state) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(state)) ||
      received ||
      (code === null) === (error === null) ||
      (code !== null &&
        (target.searchParams.getAll("code").length !== 1 || !/^[A-Za-z0-9_-]{16,256}$/.test(code))) ||
      (error !== null && target.searchParams.getAll("error").length !== 1)
    ) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("无效授权回调。请返回 aBridge 重试。");
      return;
    }
    received = true;
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(error ? "已取消授权，可以返回 aBridge。" : "授权已确认，可以返回 aBridge。", () => {
      if (error) rejectCode(new DesktopError("access_denied", "浏览器授权已取消"));
      else acceptCode(code!);
    });
  });
  listener.requestTimeout = 5000;
  listener.headersTimeout = 5000;
  const abortCallback = () =>
    rejectCode(new DesktopError("authorization_cancelled", "授权已取消或过期，请重新发起"));
  requestSignal.addEventListener("abort", abortCallback, { once: true });
  try {
    requestSignal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        listener.off("error", reject);
        resolve();
      });
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Loopback listener unavailable");
    redirectUri = `http://127.0.0.1:${address.port}${DESKTOP_AUTH_CALLBACK_PATH}`;
    const body = deviceAuthorizationRequestSchema.parse({
      kind: "computer",
      name: hostname().slice(0, 80) || "Mac",
      capabilities: [...DESKTOP_CAPABILITIES],
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
    });
    const started = await responseJson(
      await fetch(serverUrl + "/api/device-authorizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: requestSignal,
      }),
      deviceAuthorizationStartSchema,
    );
    authorizationId = started.id;
    const consent = new URL(started.authorization_url);
    if (
      consent.origin !== new URL(serverUrl).origin ||
      consent.username ||
      consent.password ||
      consent.hash ||
      started.expires_at * 1000 <= Date.now()
    )
      throw new DesktopError("invalid_response", "授权页面与服务地址不匹配或已过期");
    expires = setTimeout(() => expiry.abort(), Math.min(300000, started.expires_at * 1000 - Date.now()));
    options.onAuthorization({
      event: "authorization",
      authorization_url: consent.href,
      expires_at: started.expires_at,
    });
    const code = await callback;
    requestSignal.throwIfAborted();
    const tokenBody = deviceAuthorizationTokenRequestSchema.parse({
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    const device = await responseJson(
      await fetch(serverUrl + "/api/device-authorizations/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tokenBody),
        redirect: "error",
        signal: requestSignal,
      }),
      deviceAuthorizationTokenSchema,
    );
    if (
      device.kind !== "computer" ||
      device.capabilities.some(
        (cap) => !DESKTOP_CAPABILITIES.includes(cap as (typeof DESKTOP_CAPABILITIES)[number]),
      )
    )
      throw new DesktopError("invalid_response", "授权服务返回了不匹配的设备类型");
    completed = true;
    return { url: serverUrl, device };
  } catch (error) {
    if (requestSignal.aborted)
      throw new DesktopError("authorization_cancelled", "授权已取消或过期，请重新发起");
    throw error;
  } finally {
    if (expires) clearTimeout(expires);
    requestSignal.removeEventListener("abort", abortCallback);
    listener.closeAllConnections();
    if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
    if (authorizationId && !completed) {
      await fetch(serverUrl + "/api/device-authorizations/" + encodeURIComponent(authorizationId), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code_verifier: verifier }),
        redirect: "error",
        signal: AbortSignal.timeout(1000),
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
    }
  }
}
