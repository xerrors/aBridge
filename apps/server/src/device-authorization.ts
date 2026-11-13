/** Short-lived browser consent. Device credentials are minted only at successful redemption. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  BROWSER_AUTH_CALLBACK_PATH,
  DESKTOP_AUTH_CALLBACK_PATH,
  type DeviceAuthorizationRequest,
} from "@abridge/protocol";
import { digest, type Store } from "./store.js";
import { BridgeError, type User } from "./types.js";

type AuthorizationStatus = "pending" | "approved" | "denied" | "consumed" | "cancelled";
type Authorization = DeviceAuthorizationRequest & {
  id: string;
  expires_at: number;
  status: AuthorizationStatus;
  owner_id?: string;
  code_digest?: string;
};
const TTL_SECONDS = 300;
const MAX_PENDING = 1000;
const invalidGrant = () => new BridgeError("invalid_grant", "Authorization code is invalid or expired", 400);

function validateRedirect(request: DeviceAuthorizationRequest): void {
  const redirect = new URL(request.redirect_uri);
  const common = !redirect.username && !redirect.password && !redirect.search && !redirect.hash;
  const computer =
    request.kind === "computer" &&
    redirect.protocol === "http:" &&
    ["127.0.0.1", "[::1]"].includes(redirect.hostname) &&
    !!redirect.port &&
    Number(redirect.port) > 0 &&
    redirect.pathname === DESKTOP_AUTH_CALLBACK_PATH;
  const browser =
    request.kind === "browser" &&
    redirect.protocol === "https:" &&
    !redirect.port &&
    /^[a-p]{32}\.chromiumapp\.org$/.test(redirect.hostname) &&
    redirect.pathname === BROWSER_AUTH_CALLBACK_PATH;
  if (!common || !(computer || browser) || redirect.href !== request.redirect_uri)
    throw new BridgeError("invalid_redirect", "This authorization callback is not permitted", 422);
}
function verifyProof(request: Authorization, verifier: string): boolean {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const expected = Buffer.from(request.code_challenge);
  const candidate = Buffer.from(challenge);
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}
function verifyOrigin(request: DeviceAuthorizationRequest, origin: string | undefined): void {
  if (!origin?.startsWith("chrome-extension:")) return;
  const expected = "chrome-extension://" + new URL(request.redirect_uri).hostname.split(".")[0];
  if (request.kind !== "browser" || origin !== expected)
    throw new BridgeError("invalid_origin", "Authorization callback must belong to this extension", 403);
}

export class DeviceAuthorizations {
  private readonly requests = new Map<string, Authorization>();
  private readonly codes = new Map<string, string>();
  constructor(
    private readonly store: Store,
    private readonly now = () => Date.now() / 1000,
  ) {}

  private request(id: string): Authorization {
    const request = this.requests.get(id);
    if (!request) throw new BridgeError("not_found", "Authorization request not found", 404);
    if (request.expires_at <= this.now())
      throw new BridgeError("authorization_expired", "Authorization expired; start again in the client", 410);
    return request;
  }

  start(input: DeviceAuthorizationRequest, origin: string | undefined, serverOrigin: string) {
    validateRedirect(input);
    verifyOrigin(input, origin);
    for (const [id, request] of this.requests) {
      if (request.expires_at > this.now()) continue;
      if (request.code_digest) this.codes.delete(request.code_digest);
      this.requests.delete(id);
    }
    if (this.requests.size >= MAX_PENDING)
      throw new BridgeError("rate_limited", "Authorization capacity reached; retry later", 429);
    const id = randomBytes(24).toString("base64url");
    const request: Authorization = { ...input, id, expires_at: this.now() + TTL_SECONDS, status: "pending" };
    this.requests.set(id, request);
    const authorize = new URL("/", serverOrigin);
    authorize.searchParams.set("authorize", id);
    return { id, authorization_url: authorize.href, expires_at: request.expires_at };
  }

  view(id: string, user: User) {
    const request = this.request(id);
    if (request.owner_id && request.owner_id !== user.id)
      throw new BridgeError("not_found", "Authorization request not found", 404);
    return {
      id: request.id,
      kind: request.kind,
      name: request.name,
      capabilities: request.capabilities,
      expires_at: request.expires_at,
      status: request.status,
    };
  }

  decide(id: string, user: User, approve: boolean) {
    const request = this.request(id);
    if (request.owner_id && request.owner_id !== user.id)
      throw new BridgeError("not_found", "Authorization request not found", 404);
    if (request.status !== "pending")
      throw new BridgeError("authorization_complete", "Authorization request has already been handled", 409);
    request.owner_id = user.id;
    const redirect = new URL(request.redirect_uri);
    redirect.searchParams.set("state", request.state);
    if (approve) {
      const code = randomBytes(32).toString("base64url");
      request.code_digest = digest(code);
      this.codes.set(request.code_digest, id);
      request.status = "approved";
      redirect.searchParams.set("code", code);
    } else {
      request.status = "denied";
      redirect.searchParams.set("error", "access_denied");
    }
    this.store.audit(user.id, null, null, null, "device_authorization", approve ? "approved" : "denied");
    return { redirect_url: redirect.href };
  }

  redeem(input: { code: string; code_verifier: string; redirect_uri: string }, origin: string | undefined) {
    const codeDigest = digest(input.code);
    const id = this.codes.get(codeDigest);
    const request = id && this.requests.get(id);
    if (!request || request.expires_at <= this.now() || request.status !== "approved" || !request.owner_id)
      throw invalidGrant();
    verifyOrigin(request, origin);
    if (request.redirect_uri !== input.redirect_uri || !verifyProof(request, input.code_verifier))
      throw invalidGrant();
    // No await: credential issuance and one-time consumption cannot interleave.
    const { device, key } = this.store.createDevice(
      request.owner_id,
      request.name,
      request.capabilities,
      request.kind,
    );
    request.status = "consumed";
    this.codes.delete(codeDigest);
    return {
      device_id: device.id,
      key,
      name: device.name,
      kind: device.kind,
      capabilities: device.capabilities,
    };
  }

  cancel(id: string, verifier: string, origin: string | undefined) {
    const request = this.request(id);
    verifyOrigin(request, origin);
    if (!verifyProof(request, verifier))
      throw new BridgeError("invalid_grant", "Authorization proof is invalid", 400);
    if (request.status === "consumed")
      throw new BridgeError("authorization_complete", "Device is already bound", 409);
    if (request.code_digest) this.codes.delete(request.code_digest);
    request.status = "cancelled";
    return { ok: true };
  }
}
