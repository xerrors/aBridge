import { z } from "zod";
import { fail } from "./types.js";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export async function requestBinding<T>(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit & { signal: AbortSignal },
  schema: z.ZodType<T>,
  verifyingToken = false,
): Promise<T> {
  const signal = AbortSignal.any([init.signal, AbortSignal.timeout(10000)]);
  let response: Response;
  let body: string;
  try {
    response = await fetcher(url, { ...init, credentials: "omit", redirect: "error", signal });
    body = await response.text();
  } catch {
    if (init.signal.aborted) throw init.signal.reason;
    if (signal.aborted) throw fail("server_timeout", "等待 Server 响应超时，请检查地址和网络后重试。");
    throw fail("server_unreachable", "无法连接 Server，请检查地址、端口、网络或 HTTPS 证书。");
  }

  if (verifyingToken && response.status === 401)
    throw fail("invalid_token", "设备 Token 无效或已撤销（HTTP 401）。");

  let value: unknown;
  const status = `HTTP ${response.status}`;
  try {
    if (body.trim()) value = JSON.parse(body);
  } catch {
    // Use the HTTP status and response shape instead of exposing the parser or response body.
  }
  if (!response.ok) {
    const parsed = errorSchema.safeParse(value);
    if (parsed.success) throw fail(parsed.data.error.code, `${parsed.data.error.message}（${status}）`);
    throw fail("server_http_error", `Server 返回 ${status}，请检查服务地址或反向代理配置。`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const reason = body.trim() ? "响应不符合 aBridge 接口" : "响应为空";
    throw fail("invalid_server_response", `Server ${reason}（${status}），请检查服务地址、端口和版本。`);
  }
  return parsed.data;
}
