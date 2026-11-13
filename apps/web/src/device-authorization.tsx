import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { z } from "zod";
import {
  BROWSER_AUTH_CALLBACK_PATH,
  DESKTOP_AUTH_CALLBACK_PATH,
  deviceAuthorizationDecisionResultSchema,
  deviceAuthorizationViewSchema,
  type DeviceKind,
} from "@abridge/protocol";
import { api, ApiError } from "./api.js";
import { Authentication } from "./authentication.js";
import { Brand, capabilityLabels } from "./components.js";
import { useUserSession } from "./session.js";

type Authorization = z.infer<typeof deviceAuthorizationViewSchema>;

/** Keep authorization codes on the registered local or extension callback. */
export function authorizationCallbackUrl(value: string, kind: DeviceKind): string {
  const url = new URL(value);
  const parameters = [...url.searchParams.keys()];
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const denied = url.searchParams.get("error") === "access_denied";
  if (
    url.username ||
    url.password ||
    url.hash ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(state) ||
    parameters.length !== 2 ||
    parameters.filter((key) => key === "state").length !== 1 ||
    (code !== null
      ? !/^[A-Za-z0-9_-]{1,512}$/.test(code) || parameters.filter((key) => key === "code").length !== 1
      : !denied || parameters.filter((key) => key === "error").length !== 1)
  )
    throw new Error("授权回传地址无效，请回到客户端重新发起授权。");
  const valid =
    kind === "computer"
      ? url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname) &&
        !!url.port &&
        Number(url.port) > 0 &&
        url.pathname === DESKTOP_AUTH_CALLBACK_PATH
      : url.protocol === "https:" &&
        /^[a-p]{32}\.chromiumapp\.org$/.test(url.hostname) &&
        !url.port &&
        url.pathname === BROWSER_AUTH_CALLBACK_PATH;
  if (!valid) throw new Error("授权回传地址无效，请回到客户端重新发起授权。");
  return url.href;
}

function failureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 410) return "授权请求已过期，请回到客户端重新发起授权。";
    if (error.status === 404) return "授权请求不存在或已失效，请回到客户端重新发起授权。";
    if (error.code === "authorization_complete") return "这次授权已处理，请回到客户端查看结果。";
  }
  return error instanceof Error ? error.message : "无法读取授权请求，请重试。";
}

export function DeviceAuthorization({ requestId }: { requestId: string }) {
  const [notice, setNotice] = useState("");
  const notify = useCallback((message: string) => setNotice(message), []);
  const { user, phase, authenticate, logout, requireLogin, reloadIdentity } = useUserSession(notify, false);
  const [request, setRequest] = useState<Authorization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [callback, setCallback] = useState("");
  const [approved, setApproved] = useState(false);
  const submitting = useRef(false);
  const validId = /^[A-Za-z0-9_-]{1,160}$/.test(requestId);

  useEffect(() => {
    document.title = "设备授权 · aBridge";
  }, []);
  useEffect(() => {
    if (phase !== "ready" || !user || !validId) return;
    let active = true;
    setLoading(true);
    setRequest(null);
    setError("");
    setCallback("");
    setExpired(false);
    void api(`/api/device-authorizations/${encodeURIComponent(requestId)}`, deviceAuthorizationViewSchema)
      .then((value) => {
        if (value.id !== requestId) throw new Error("授权请求不匹配，请回到客户端重新发起授权。");
        if (active) setRequest(value);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        if (caught instanceof ApiError && caught.status === 401) {
          notify("登录已过期，请重新登录以继续授权。");
          requireLogin();
        } else setError(failureMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [phase, user?.id, requestId, validId, revision, notify, requireLogin]);
  useEffect(() => {
    if (!request || request.status !== "pending") return;
    const remaining = request.expires_at * 1000 - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [request]);

  const decide = async (approve: boolean) => {
    if (!user || !request || request.status !== "pending" || expired || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `/api/device-authorizations/${encodeURIComponent(requestId)}/decision`,
        deviceAuthorizationDecisionResultSchema,
        { approve, expected_user_id: user.id },
      );
      const target = authorizationCallbackUrl(result.redirect_url, request.kind);
      setApproved(approve);
      setCallback(target);
      location.replace(target);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        notify("登录已过期，请重新登录以继续授权。");
        requireLogin();
      } else if (caught instanceof ApiError && caught.code === "account_changed") {
        notify("当前登录账户已更换，请核对账户后重新确认。");
        reloadIdentity();
      } else if (caught instanceof ApiError && caught.status === 410) {
        setExpired(true);
      } else {
        setError(failureMessage(caught));
        if (caught instanceof ApiError && caught.code === "authorization_complete")
          setRevision((value) => value + 1);
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const changeAccount = async () => {
    setBusy(true);
    try {
      await logout();
      setNotice("");
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  if (validId && (phase !== "ready" || !user))
    return (
      <Authentication
        phase={phase}
        notice={notice}
        authenticate={async (form) => {
          await authenticate(form);
          setNotice("");
        }}
      />
    );

  const completed = request !== null && request.status !== "pending";
  return (
    <main class="authorization-wrap" id="main">
      <section class="authorization-panel" aria-labelledby="authorization-title">
        <Brand />
        <div class="authorization-heading">
          <p class="muted small">{location.origin}</p>
          <h1 id="authorization-title">设备授权</h1>
        </div>
        {notice && phase === "ready" && (
          <p class="authorization-status" role="status">
            {notice}
          </p>
        )}
        {!validId ? (
          <p role="alert">授权链接无效，请回到客户端重新发起授权。</p>
        ) : loading ? (
          <p role="status" class="muted">
            正在读取授权请求…
          </p>
        ) : callback ? (
          <div class="authorization-result" role="status">
            <h2>{approved ? "已授权" : "已拒绝授权"}</h2>
            <p class="muted">正在返回客户端。若页面没有跳转，可以点击下方按钮。</p>
            <button class="primary" onClick={() => location.replace(callback)}>
              返回客户端
            </button>
          </div>
        ) : (
          <>
            {request && (
              <>
                <div class="authorization-device">
                  <span class="authorization-device-kind">
                    {request.kind === "computer" ? "Mac" : "浏览器"}
                  </span>
                  <h2>{request.name}</h2>
                </div>
                <dl class="authorization-details">
                  <div>
                    <dt>绑定账户</dt>
                    <dd>{user?.username}</dd>
                  </div>
                  <div>
                    <dt>申请能力</dt>
                    <dd>
                      {request.capabilities.map((capability) => capabilityLabels[capability]).join("、")}
                    </dd>
                  </div>
                </dl>
                {expired ? (
                  <p class="authorization-status" role="status">
                    授权请求已过期，请回到客户端重新发起授权。
                  </p>
                ) : completed ? (
                  <p class="authorization-status" role="status">
                    {request.status === "denied"
                      ? "这次授权已拒绝。"
                      : request.status === "cancelled"
                        ? "这次授权已取消。"
                        : "这次授权已处理，请回到客户端查看结果。"}
                  </p>
                ) : (
                  <>
                    <p class="muted small authorization-note">
                      确认后将此设备绑定到当前账户。Agent 的设备访问权限仍按现有设置生效。
                    </p>
                    <div class="authorization-actions">
                      <button disabled={busy} onClick={() => void decide(false)}>
                        拒绝
                      </button>
                      <button class="primary" disabled={busy} onClick={() => void decide(true)}>
                        {busy ? "正在处理…" : "授权并连接"}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
            {error && (
              <p role="alert" class="authorization-error">
                {error}
              </p>
            )}
            {!request && error && (
              <button disabled={busy} onClick={() => setRevision((value) => value + 1)}>
                重新读取
              </button>
            )}
            {user && !completed && !expired && (
              <button
                class="text-button authorization-account"
                disabled={busy}
                onClick={() => void changeAccount()}
              >
                更换账户
              </button>
            )}
          </>
        )}
      </section>
    </main>
  );
}
