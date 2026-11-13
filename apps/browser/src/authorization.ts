import {
  BROWSER_AUTH_CALLBACK_PATH,
  deviceAuthorizationStartSchema,
  deviceAuthorizationTokenSchema,
} from "@abridge/protocol";
import { z } from "zod";
import { fail } from "./types.js";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const secret = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
export async function authorizeBrowser(options: {
  server: string;
  name: string;
  redirectUri: string;
  open: (url: string) => Promise<string | undefined>;
  signal: AbortSignal;
  started: (expiresAt: number) => void;
  fetch?: typeof fetch;
}) {
  const fetcher = options.fetch ?? fetch;
  const verifier = secret(),
    state = secret();
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const redirect = new URL(options.redirectUri);
  if (
    redirect.protocol !== "https:" ||
    !/^[a-p]{32}\.chromiumapp\.org$/.test(redirect.hostname) ||
    redirect.pathname !== BROWSER_AUTH_CALLBACK_PATH ||
    redirect.port ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  )
    throw fail("invalid_redirect", "浏览器授权回调地址无效");
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(options.signal.reason ?? fail("authorization_cancelled", "授权已取消"));
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) cancel();
  let requestId: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  async function request(path: string, body: object, method = "POST", signal = controller.signal) {
    const response = await fetcher(options.server + path, {
      method,
      credentials: "omit",
      redirect: "error",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const error = errorSchema.safeParse(value);
      throw fail(
        error.success ? error.data.error.code : "authorization_failed",
        error.success ? error.data.error.message : "授权请求失败，请重新尝试",
      );
    }
    return value;
  }
  try {
    controller.signal.throwIfAborted();
    const start = deviceAuthorizationStartSchema.parse(
      await request("/api/device-authorizations", {
        kind: "browser",
        name: options.name,
        capabilities: ["browser"],
        redirect_uri: options.redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }),
    );
    requestId = start.id;
    const page = new URL(start.authorization_url);
    if (
      page.origin !== new URL(options.server).origin ||
      page.username ||
      page.password ||
      page.pathname !== "/" ||
      page.searchParams.get("authorize") !== start.id ||
      page.hash
    )
      throw fail("invalid_authorization_url", "Server 返回了无效的授权页面");
    const remaining = start.expires_at * 1000 - Date.now();
    if (remaining <= 0 || remaining > 600_000) throw fail("authorization_expired", "授权已过期，请重新发起");
    timeout = setTimeout(
      () => controller.abort(fail("authorization_expired", "授权已过期，请重新发起")),
      remaining,
    );
    options.started(start.expires_at);
    const returned = await new Promise<string | undefined>((resolve, reject) => {
      const aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", aborted, { once: true });
      if (controller.signal.aborted) {
        aborted();
        return;
      }
      options
        .open(start.authorization_url)
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener("abort", aborted));
    });
    controller.signal.throwIfAborted();
    if (!returned) throw fail("authorization_cancelled", "授权窗口已关闭");
    const callback = new URL(returned);
    if (
      callback.origin !== redirect.origin ||
      callback.pathname !== redirect.pathname ||
      callback.username ||
      callback.password ||
      callback.hash ||
      callback.searchParams.getAll("state").length !== 1 ||
      callback.searchParams.get("state") !== state
    )
      throw fail("invalid_callback", "授权回调不匹配，请重新发起");
    if (callback.searchParams.has("error")) throw fail("authorization_denied", "未授权连接，请重新发起授权");
    const codes = callback.searchParams.getAll("code");
    if (codes.length !== 1 || !/^[A-Za-z0-9_-]{32,128}$/.test(codes[0]!))
      throw fail("invalid_callback", "授权页面未返回有效的授权码");
    const token = deviceAuthorizationTokenSchema.parse(
      await request("/api/device-authorizations/token", {
        code: codes[0],
        code_verifier: verifier,
        redirect_uri: options.redirectUri,
      }),
    );
    if (token.kind !== "browser" || token.capabilities.length !== 1 || token.capabilities[0] !== "browser")
      throw fail("invalid_device", "Server 返回了不匹配的设备授权");
    return token;
  } catch (error) {
    if (requestId)
      await request(
        `/api/device-authorizations/${requestId}`,
        { code_verifier: verifier },
        "DELETE",
        AbortSignal.timeout(5000),
      ).catch(() => {});
    if (options.signal.aborted) throw fail("authorization_cancelled", "授权已取消");
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", cancel);
  }
}
