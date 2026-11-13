import * as oidc from "openid-client";
import { createRemoteJWKSet, jwtVerify, customFetch as jwksFetch, errors as joseErrors } from "jose";
import { digest, Store } from "./store.js";
import { BridgeError, type Grant } from "./types.js";

export interface IdentityConfig {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  delegationEnabled?: boolean;
  backchannelOrigin?: string;
}
interface PendingLogin {
  binding: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  expires: number;
}

/** 认证元数据与令牌响应有界读取；不跟随重定向泄漏客户端凭证。 */
const identityFetch = async (
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  config: IdentityConfig,
): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Identity endpoint requires HTTPS");
  // 只改传输目标；issuer、浏览器授权链接及 JWT 校验仍使用公开地址。
  let transportUrl = url;
  if (config.backchannelOrigin && url.origin === new URL(config.issuer!).origin) {
    transportUrl = new URL(config.backchannelOrigin);
    transportUrl.pathname = url.pathname;
    transportUrl.search = url.search;
  }
  const response = await fetch(transportUrl, {
    ...init,
    redirect: "error",
    signal: init?.signal ?? AbortSignal.timeout(5000),
  });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 256 * 1024) throw new Error("Identity response exceeds size limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
  }
  return new Response(Buffer.concat(chunks), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/** 在打开数据库前校验可选认证配置。 */
export function validateIdentityConfig(config: IdentityConfig, origin: string | undefined): void {
  const enabled = !!config.issuer;
  if (
    !enabled &&
    (config.clientId || config.clientSecret || config.delegationEnabled || config.backchannelOrigin)
  )
    throw new Error("OIDC issuer is required");
  if (config.backchannelOrigin) {
    const backchannel = new URL(config.backchannelOrigin);
    if (!/^https?:$/.test(backchannel.protocol) || backchannel.origin !== config.backchannelOrigin)
      throw new Error(
        "OIDC backchannel must be a pure HTTP(S) origin without credentials, path, query or fragment",
      );
  }
  if (enabled) {
    if (!config.clientId || !config.clientSecret || !origin)
      throw new Error("OIDC requires client ID, client secret and public origin");
    const issuer = new URL(config.issuer!);
    if (
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      (issuer.protocol !== "https:" &&
        !(issuer.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname)))
    )
      throw new Error("OIDC issuer requires HTTPS (HTTP allowed only on loopback)");
    const publicOrigin = new URL(origin);
    if (
      publicOrigin.origin !== origin ||
      (publicOrigin.protocol !== "https:" &&
        !(
          publicOrigin.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(publicOrigin.hostname)
        ))
    )
      throw new Error("OIDC public origin requires HTTPS (HTTP allowed only on loopback) and a pure origin");
  }
}

/** 标准 OIDC 登录和显式启用的平台访问委托；业务权限仍归 Store/Control。 */
export class Identity {
  private readonly pending = new Map<string, PendingLogin>();
  private configuration?: Promise<oidc.Configuration>;
  private keys?: ReturnType<typeof createRemoteJWKSet>;
  readonly enabled: boolean;
  constructor(
    private readonly config: IdentityConfig,
    private readonly origin: string | undefined,
    private readonly store: Store,
  ) {
    validateIdentityConfig(config, origin);
    this.enabled = !!config.issuer;
  }
  /** 登录事务绑定浏览器，限时且一次性消费。 */
  async start(returnTo: string) {
    if (
      !returnTo.startsWith("/#") &&
      returnTo !== "/" &&
      !/^\/\?authorize=[A-Za-z0-9_-]{1,160}$/.test(returnTo)
    )
      throw new BridgeError("invalid_return", "Return path must be a local application route", 422);
    const config = await this.getConfiguration();
    for (const [state, pending] of this.pending)
      if (pending.expires <= Date.now()) this.pending.delete(state);
    if (this.pending.size >= 1000) throw new BridgeError("rate_limited", "Login capacity reached", 429);
    const state = oidc.randomState(),
      binding = oidc.randomState(),
      verifier = oidc.randomPKCECodeVerifier(),
      nonce = oidc.randomNonce();
    this.pending.set(state, {
      binding: digest(binding),
      verifier,
      nonce,
      returnTo,
      expires: Date.now() + 300000,
    });
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.origin + "/api/auth/oidc/callback",
      scope: "openid profile",
      response_type: "code",
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    });
    return { url: url.href, binding };
  }
  /** 校验提供方响应后映射身份，创建本地会话。 */
  async finish(url: URL, binding: string) {
    const state = url.searchParams.get("state") ?? "",
      pending = this.pending.get(state);
    if (!pending || pending.expires <= Date.now() || digest(binding) !== pending.binding)
      throw new BridgeError("invalid_login", "Login expired or browser binding does not match", 400);
    this.pending.delete(state);
    const config = await this.getConfiguration();
    let result: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      result = await oidc.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: pending.verifier,
        expectedState: state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
    } catch (error) {
      if (
        error instanceof oidc.AuthorizationResponseError ||
        (error instanceof oidc.ResponseBodyError &&
          !["server_error", "temporarily_unavailable"].includes(error.error)) ||
        (error instanceof oidc.ClientError &&
          [
            "OAUTH_INVALID_RESPONSE",
            "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
            "OAUTH_JWT_TIMESTAMP_CHECK_FAILED",
            "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED",
            "OAUTH_KEY_SELECTION_FAILED",
          ].includes(error.code ?? ""))
      )
        throw new BridgeError("invalid_login", "Identity provider login could not be verified", 401);
      throw new BridgeError("identity_unavailable", "Identity provider is unavailable", 503);
    }
    const claims = result.claims()!;
    const user = this.store.externalUser(
      this.config.issuer!,
      claims.sub,
      typeof claims.name === "string" ? claims.name : "外部用户",
      this.config.delegationEnabled ? this.config.clientId : undefined,
    );
    return { token: this.store.createLogin(user.id), returnTo: pending.returnTo };
  }
  /** 委托只接受特定受众、用途和客户端的短期签名令牌。 */
  async authenticate(token: string): Promise<Grant | undefined> {
    if (!this.config.delegationEnabled || !token || token.length > 16384) return undefined;
    const config = await this.getConfiguration();
    if (!this.keys)
      this.keys = createRemoteJWKSet(new URL(config.serverMetadata().jwks_uri!), {
        timeoutDuration: 5000,
        [jwksFetch]: (input, options) => identityFetch(input, options, this.config),
      });
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.issuer!,
        audience: this.origin + "/mcp",
        algorithms: ["RS256"],
        requiredClaims: ["sub", "iat", "exp"],
        maxTokenAge: 60,
      }));
    } catch (error) {
      if (
        error instanceof joseErrors.JWTClaimValidationFailed ||
        error instanceof joseErrors.JWTExpired ||
        error instanceof joseErrors.JWTInvalid ||
        error instanceof joseErrors.JWSInvalid ||
        error instanceof joseErrors.JWSSignatureVerificationFailed ||
        error instanceof joseErrors.JOSEAlgNotAllowed ||
        error instanceof joseErrors.JWKSNoMatchingKey
      )
        return undefined;
      throw new BridgeError("identity_unavailable", "Identity provider keys are unavailable", 503);
    }
    const now = Date.now() / 1000;
    if (
      payload.purpose !== "abridge-delegation" ||
      payload.client_id !== this.config.clientId ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.exp - payload.iat > 60 ||
      payload.iat > now ||
      !payload.sub
    )
      return undefined;
    return this.store.delegatedGrant(this.config.issuer!, payload.sub, this.config.clientId!);
  }
  private getConfiguration(): Promise<oidc.Configuration> {
    if (!this.enabled) throw new BridgeError("oidc_disabled", "External login is not configured", 404);
    if (!this.configuration)
      this.configuration = oidc
        .discovery(
          new URL(this.config.issuer!),
          this.config.clientId!,
          { client_secret: this.config.clientSecret!, id_token_signed_response_alg: "RS256" },
          oidc.ClientSecretPost(this.config.clientSecret!),
          {
            timeout: 5,
            [oidc.customFetch]: (input, options) =>
              identityFetch(
                input,
                {
                  ...options,
                  body:
                    options.body instanceof Uint8Array ? new Uint8Array(options.body).buffer : options.body,
                },
                this.config,
              ),
            execute: [
              oidc.enableNonRepudiationChecks,
              ...(this.config.issuer!.startsWith("http:") ? [oidc.allowInsecureRequests] : []),
            ],
          },
        )
        .catch(() => {
          this.configuration = undefined;
          throw new BridgeError("identity_unavailable", "Identity provider is unavailable", 503);
        });
    return this.configuration;
  }
}
