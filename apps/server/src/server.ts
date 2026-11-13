import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { z } from "zod";
import {
  VERSION,
  MAX_MESSAGE_BYTES,
  capabilitySchema,
  connectionPolicySchema,
  deviceKindSchema,
  deviceHelloSchema,
  deviceRenameSchema,
  browserHelloSchema,
  deviceAuthorizationRequestSchema,
  deviceAuthorizationDecisionSchema,
  deviceAuthorizationTokenRequestSchema,
  deviceAuthorizationCancelSchema,
  adminCreateUserSchema,
  type AdminOverview,
} from "@abridge/protocol";
import { AdminAuth, ADMIN_SESSION_SECONDS, loadAdminToken } from "./admin.js";
import { Store, acquireInstanceLock } from "./store.js";
import { DeviceAuthorizations } from "./device-authorization.js";
import { ControlService } from "./control.js";
import { createMcpServer } from "./mcp.js";
import { WebSocketTransport } from "./transport.js";
import { BridgeError, object, type AttachedDevice, type Device, type Grant, type User } from "./types.js";

export interface ServerConfig {
  dbPath: string;
  host?: string;
  port?: number;
  staticRoot?: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  publicOrigin?: string;
  adminToken?: string;
  resetAdminToken?: boolean;
}
const browserOrigin = /^chrome-extension:\/\/[a-p]{32}$/;
const loopback = (host: string) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
const accountSchema = z
  .object({ username: z.string().min(1).max(80), password: z.string().min(1).max(1024) })
  .strict();
const capabilities = z
  .array(capabilitySchema)
  .min(1)
  .max(5)
  .refine((a) => new Set(a).size === a.length, "Capabilities must be unique");
const name = z.string().trim().min(1).max(120);
const connectionSchema = z
  .object({ name, policy: connectionPolicySchema, expires_at: z.number().finite().nullable().default(null) })
  .strict();
const deviceSchema = z.object({ name, capabilities, kind: deviceKindSchema.default("computer") }).strict();
const bearer = (request: FastifyRequest): string => {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : "";
};
const cookie = (request: FastifyRequest, name = "abridge_session"): string =>
  request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + "="))
    ?.slice(name.length + 1) ?? "";
const publicGrant = (grant: Grant) => {
  const { token_digest: _, owner_id: __, ...visible } = grant;
  return visible;
};

/** Composition root: domain state is created once and never owned by HTTP request handlers. */
export async function createServer(config: ServerConfig) {
  const host = config.host ?? "127.0.0.1",
    port = config.port ?? 8765;
  let publicOrigin: URL | undefined;
  if (config.publicOrigin !== undefined) {
    try {
      publicOrigin = new URL(config.publicOrigin);
      if (
        !/^https?:$/.test(publicOrigin.protocol) ||
        publicOrigin.username ||
        publicOrigin.password ||
        publicOrigin.pathname !== "/" ||
        publicOrigin.search ||
        publicOrigin.hash ||
        config.publicOrigin !== publicOrigin.origin
      )
        throw new Error("Expected a pure HTTP(S) origin");
    } catch {
      throw new BridgeError(
        "invalid_public_origin",
        "publicOrigin must be a pure HTTP(S) origin without a path, credentials, query or fragment",
        422,
      );
    }
  }
  const release = acquireInstanceLock(config.dbPath);
  let store: Store;
  let admin: AdminAuth;
  try {
    store = new Store(config.dbPath);
    try {
      admin = new AdminAuth(loadAdminToken(store.path, config.adminToken, config.resetAdminToken));
      store.recoverAfterRestart();
    } catch (error) {
      store.close();
      throw error;
    }
  } catch (error) {
    release();
    throw error;
  }
  const authorizations = new DeviceAuthorizations(store);
  const control = new ControlService(store),
    app = Fastify({ bodyLimit: 2 * 1024 * 1024, logger: false, trustProxy: false });
  const attempts = new Map<string, { count: number; expires: number }>();
  const allowedHosts = new Set(config.allowedHosts ?? []),
    allowedOrigins = new Set(config.allowedOrigins ?? []);
  if (publicOrigin) allowedHosts.add(publicOrigin.host);
  function sameOrigin(request: FastifyRequest): string {
    return publicOrigin?.origin ?? request.protocol + "://" + request.headers.host;
  }
  function scopeOrigin(request: FastifyRequest): void {
    const origin = request.headers.origin;
    if (!origin) return;
    const pathname = request.url.split("?")[0]!;
    const extensionAuthorization =
      (pathname === "/api/device-authorizations" && request.method === "POST") ||
      (pathname === "/api/device-authorizations/token" && request.method === "POST") ||
      (pathname === "/api/device" && request.method === "PATCH") ||
      (/^\/api\/device-authorizations\/[^/]+$/.test(pathname) && request.method === "DELETE");
    if (pathname === "/ws/browser" || (extensionAuthorization && browserOrigin.test(origin))) {
      if (!browserOrigin.test(origin))
        throw new BridgeError("invalid_origin", "A Chrome extension origin is required", 403);
      return;
    }
    if (origin === sameOrigin(request)) return;
    if ((pathname === "/mcp" || pathname === "/mcp/") && allowedOrigins.has(origin)) return;
    throw new BridgeError("invalid_origin", "Origin is not permitted for this endpoint", 403);
  }
  function account(request: FastifyRequest): User {
    const user = store.account(cookie(request));
    if (!user) throw new BridgeError("unauthorized", "Sign in to the management console", 401);
    return user;
  }
  function requireAdmin(request: FastifyRequest): void {
    const token = bearer(request);
    if (token ? admin.acceptsToken(token) : admin.acceptsSession(cookie(request, "abridge_admin"))) return;
    rateLimit(request, "admin", 10);
    throw new BridgeError(
      "admin_unauthorized",
      "An instance administrator token or session is required",
      401,
    );
  }
  function owned(request: FastifyRequest): Device {
    const user = account(request),
      device = store.device((request.params as { id: string }).id);
    if (!device || device.owner_id !== user.id) throw new BridgeError("not_found", "Device not found", 404);
    return device;
  }
  function rateLimit(request: FastifyRequest, scope = "signin", limit = 10): void {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.expires <= now) attempts.delete(key);
    const key = scope + ":" + request.ip,
      current = attempts.get(key);
    if (current && current.count >= limit)
      throw new BridgeError("rate_limited", "Too many sign-in attempts; retry later", 429);
    if (current) current.count++;
    else {
      if (attempts.size >= 10000)
        throw new BridgeError("rate_limited", "Sign-in capacity reached; retry later", 429);
      attempts.set(key, { count: 1, expires: now + 60000 });
    }
  }
  function setCookie(
    reply: FastifyReply,
    request: FastifyRequest,
    token: string,
    maxAge = 43200,
    name = "abridge_session",
  ): void {
    reply.header(
      "set-cookie",
      `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${sameOrigin(request).startsWith("https:") ? "; Secure" : ""}`,
    );
  }
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof BridgeError) {
      reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof z.ZodError) {
      reply.code(422).send({
        error: {
          code: "invalid_arguments",
          message: error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; "),
        },
      });
      return;
    }
    const status =
      typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    reply.code(status).send({
      error: {
        code: status === 500 ? "internal_error" : "invalid_request",
        message:
          status === 500
            ? "The request could not be completed"
            : String(error instanceof Error ? error.message : "Invalid request"),
      },
    });
  });
  app.addHook("onRequest", async (request, reply) => {
    const authority = request.headers.host ?? "";
    let hostname = "";
    try {
      hostname = new URL("http://" + authority).hostname;
    } catch {}
    if (!authority || !(loopback(hostname) || allowedHosts.has(authority) || allowedHosts.has(hostname)))
      throw new BridgeError("invalid_host", "Host is not allowed", 421);
    scopeOrigin(request);
    reply
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY")
      .header("referrer-policy", "no-referrer");
    if (request.url.startsWith("/api/") || request.url.startsWith("/mcp"))
      reply.header("cache-control", "no-store");
  });
  await app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });
  app.get("/health", async () => ({ status: "ok", version: VERSION }));
  app.post("/api/admin/session", async (request, reply) => {
    if (!admin.acceptsToken(bearer(request))) {
      rateLimit(request, "admin", 10);
      throw new BridgeError("admin_unauthorized", "Invalid instance administrator token", 401);
    }
    z.object({}).strict().parse(request.body);
    setCookie(reply, request, admin.createSession(), ADMIN_SESSION_SECONDS, "abridge_admin");
    return { admin: true };
  });
  app.get("/api/admin/session", async (request) => {
    requireAdmin(request);
    return { admin: true };
  });
  app.delete("/api/admin/session", async (request, reply) => {
    setCookie(reply, request, "", 0, "abridge_admin");
    return { ok: true };
  });
  app.post("/api/admin/users", async (request, reply) => {
    requireAdmin(request);
    rateLimit(request, "admin-create-user", 30);
    const body = adminCreateUserSchema.parse(request.body);
    const user = await store.createUser(body.username, body.password);
    reply.code(201);
    return user;
  });
  app.get("/api/admin/overview", async (request): Promise<AdminOverview> => {
    requireAdmin(request);
    const devicesByOwner = new Map<string, AdminOverview["users"][number]["devices"]>();
    for (const device of store.activeDevices()) {
      const view = control.deviceView(device);
      const devices = devicesByOwner.get(device.owner_id) ?? [];
      devices.push({
        id: device.id,
        name: device.name,
        kind: device.kind,
        status: view.status === "online" ? "online" : "offline",
        paused: view.paused === true,
        last_seen: device.last_seen,
        created_at: device.created_at,
      });
      devicesByOwner.set(device.owner_id, devices);
    }
    const users = store.users().map((user) => {
      const devices = devicesByOwner.get(user.id) ?? [];
      return {
        ...user,
        devices,
        computer_count: devices.filter((d) => d.kind === "computer").length,
        browser_count: devices.filter((d) => d.kind === "browser").length,
        online_count: devices.filter((d) => d.status === "online").length,
      };
    });
    const totals = users.reduce(
      (sum, user) => ({
        users: sum.users + 1,
        devices: sum.devices + user.devices.length,
        online_devices: sum.online_devices + user.online_count,
        computers: sum.computers + user.computer_count,
        browsers: sum.browsers + user.browser_count,
      }),
      { users: 0, devices: 0, online_devices: 0, computers: 0, browsers: 0 },
    );
    return { totals, users };
  });
  app.post("/api/login", async (request, reply) => {
    rateLimit(request);
    const body = accountSchema.parse(request.body),
      result = await store.login(body.username, body.password);
    if (!result) throw new BridgeError("unauthorized", "Username or password is incorrect", 401);
    setCookie(reply, request, result.token);
    return result.user;
  });
  app.post("/api/logout", async (request, reply) => {
    store.logout(cookie(request));
    setCookie(reply, request, "", 0);
    return { ok: true };
  });
  app.get("/api/me", async (request) => account(request));
  app.get("/api/devices", async (request) => ({
    devices: store.devices(account(request).id).map((device) => control.deviceView(device)),
  }));
  app.post("/api/devices", async (request) => {
    const user = account(request),
      body = deviceSchema.parse(request.body),
      result = store.createDevice(user.id, body.name, body.capabilities, body.kind);
    return { ...control.deviceView(result.device), key: result.key };
  });
  app.patch("/api/devices/:id", async (request) => {
    const device = owned(request),
      body = deviceRenameSchema.parse(request.body);
    if (device.revoked_at !== null) throw new BridgeError("revoked", "Device was revoked", 409);
    store.renameDevice(device.id, body.name);
    return control.deviceView(store.device(device.id)!);
  });
  app.patch("/api/device", async (request) => {
    const device = store.authenticateDevice(bearer(request));
    if (!device) throw new BridgeError("unauthorized", "A valid device key is required", 401);
    const body = deviceRenameSchema.parse(request.body);
    store.renameDevice(device.id, body.name);
    return { id: device.id, name: body.name };
  });
  app.post("/api/devices/:id/stop", async (request) => {
    const device = owned(request);
    await control.stopDevice(device.id);
    store.audit(device.owner_id, device.id, null, null, "device_stop", "stopped");
    return { ok: true };
  });
  app.post("/api/devices/:id/revoke", async (request) => {
    const device = owned(request);
    store.revokeDevice(device.id);
    await control.invalidateDevice(device.id);
    store.audit(device.owner_id, device.id, null, null, "device_revoke", "revoked");
    return { ok: true };
  });
  app.post("/api/devices/:id/credentials", async (request) => {
    const device = owned(request);
    if (device.revoked_at !== null) throw new BridgeError("revoked", "Device was revoked", 409);
    const key = store.rotateDevice(device.id);
    await control.invalidateDevice(device.id);
    store.audit(device.owner_id, device.id, null, null, "device_credentials", "rotated");
    return { id: device.id, key };
  });
  app.get("/api/client-grants", async (request) => ({
    grants: store.grants(account(request).id).map(publicGrant),
  }));
  function ownedGrant(request: FastifyRequest): Grant {
    const user = account(request),
      grant = store.grant((request.params as { id: string }).id);
    if (!grant || grant.owner_id !== user.id) throw new BridgeError("not_found", "Connection not found", 404);
    return grant;
  }
  function connectionBody(value: unknown) {
    const body = connectionSchema.parse(value);
    if (body.expires_at !== null && body.expires_at <= Date.now() / 1000)
      throw new BridgeError("invalid_expiry", "Expiry must be in the future or unset", 422);
    return body;
  }
  app.post("/api/client-grants", async (request) => {
    const user = account(request),
      body = connectionBody(request.body);
    const result = store.createGrant(user.id, body.name, body.policy, body.expires_at);
    return { ...publicGrant(result.grant), key: result.key };
  });
  app.patch("/api/client-grants/:id", async (request) => {
    const grant = ownedGrant(request),
      body = connectionBody(request.body);
    return publicGrant(await control.updateGrant(grant, body.name, body.policy, body.expires_at));
  });
  app.post("/api/client-grants/:id/rotate", async (request) => {
    const result = await control.rotateGrant(ownedGrant(request));
    return { ...publicGrant(result.grant), key: result.key };
  });
  app.get("/api/client-grants/:id/preview", async (request) => control.previewGrant(ownedGrant(request)));
  app.post("/api/client-grants/:id/revoke", async (request) => {
    const user = account(request),
      grant = store.grant((request.params as { id: string }).id);
    if (!grant || grant.owner_id !== user.id) throw new BridgeError("not_found", "Grant not found", 404);
    await control.revokeGrant(grant);
    return { ok: true };
  });
  app.get("/api/activity", async (request) => {
    const user = account(request);
    const filters = z
      .object({
        device_id: z.string().min(1).max(120).optional(),
        grant_id: z.string().min(1).max(120).optional(),
        tool: z.string().min(1).max(120).optional(),
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
      })
      .strict()
      .parse(request.query);
    return {
      operations: store.operations(user.id, filters),
      total: store.operationCount(user.id, filters),
      tools: store.operationTools(user.id, filters.device_id),
      events: store.auditEvents(user.id),
    };
  });
  app.post("/api/device-authorizations", async (request) => {
    rateLimit(request, "device-authorization-start", 30);
    return authorizations.start(
      deviceAuthorizationRequestSchema.parse(request.body),
      request.headers.origin,
      sameOrigin(request),
    );
  });
  app.get("/api/device-authorizations/:id", async (request) =>
    authorizations.view((request.params as { id: string }).id, account(request)),
  );
  app.post("/api/device-authorizations/:id/decision", async (request) => {
    const user = account(request);
    const body = deviceAuthorizationDecisionSchema.parse(request.body);
    if (body.expected_user_id !== user.id)
      throw new BridgeError(
        "account_changed",
        "The signed-in account changed; review authorization again",
        409,
      );
    return authorizations.decide((request.params as { id: string }).id, user, body.approve);
  });
  app.post("/api/device-authorizations/token", async (request) => {
    rateLimit(request, "device-authorization-token", 30);
    return authorizations.redeem(
      deviceAuthorizationTokenRequestSchema.parse(request.body),
      request.headers.origin,
    );
  });
  app.delete("/api/device-authorizations/:id", async (request) => {
    rateLimit(request, "device-authorization-cancel", 30);
    const body = deviceAuthorizationCancelSchema.parse(request.body);
    return authorizations.cancel(
      (request.params as { id: string }).id,
      body.code_verifier,
      request.headers.origin,
    );
  });
  app.all("/mcp", async (request, reply) => {
    const grant = store.authenticateAgent(bearer(request));
    if (!grant) throw new BridgeError("unauthorized", "A valid Agent Bearer key is required", 401);
    const mcp = createMcpServer(control, grant),
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
    await mcp.connect(transport);
    reply.hijack();
    for (const [key, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined) reply.raw.setHeader(key, value);
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      void mcp.close().catch(() => {});
    };
    reply.raw.once("close", cleanup);
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch {
      if (!reply.raw.headersSent) reply.raw.writeHead(500, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({ error: { code: "transport_error", message: "MCP transport failed" } }));
      cleanup();
    }
  });
  function addSocket(path: string, kind: "computer" | "browser"): void {
    app.get(
      path,
      {
        websocket: true,
        preValidation: async (request) => {
          if (kind === "browser") {
            if (!browserOrigin.test(request.headers.origin ?? ""))
              throw new BridgeError("invalid_origin", "A Chrome extension origin is required", 403);
          } else {
            if (request.headers.origin)
              throw new BridgeError("invalid_origin", "Computer sockets do not accept browser origins", 403);
            const device = store.authenticateDevice(bearer(request));
            if (!device || device.kind !== "computer")
              throw new BridgeError("unauthorized", "Computer device key is required", 401);
          }
        },
      },
      (socket, request) => {
        const transport = new WebSocketTransport(socket);
        let ticket: AttachedDevice | undefined,
          closed = false,
          queue = Promise.resolve();
        const timer = setTimeout(() => {
          void transport.close(4408, "Hello deadline exceeded");
        }, 10000);
        socket.on("error", () => {});
        socket.on("close", () => {
          closed = true;
          clearTimeout(timer);
          if (ticket) control.dropConnection(ticket);
        });
        let queuedFrames = 0,
          queuedBytes = 0;
        socket.on("message", (data, isBinary) => {
          if (closed) return;
          const bytes = Array.isArray(data)
            ? data.reduce((sum, part) => sum + part.byteLength, 0)
            : data.byteLength;
          if (++queuedFrames > 64 || (queuedBytes += bytes) > 16 * 1024 * 1024) {
            closed = true;
            clearTimeout(timer);
            if (ticket) control.dropConnection(ticket);
            void transport.close(4408, "Device receive queue exceeded");
            return;
          }
          queue = queue
            .then(async () => {
              if (closed) return;
              if (isBinary) throw new BridgeError("invalid_message", "JSON text is required", 422);
              const message: unknown = JSON.parse(data.toString());
              if (!object(message)) throw new BridgeError("invalid_message", "JSON object is required", 422);
              if (!ticket) {
                const hello = (kind === "browser" ? browserHelloSchema : deviceHelloSchema).parse(message);
                const key = kind === "browser" ? hello.device_key : bearer(request);
                if (typeof key !== "string")
                  throw new BridgeError("unauthorized", "Device key is required", 401);
                ticket = await control.attachConnection(key, kind, hello, transport);
                clearTimeout(timer);
                if (closed) {
                  control.dropConnection(ticket);
                  await transport.close(1001, "Connection already closed");
                }
                return;
              }
              await control.receive(ticket, message);
            })
            .catch(async () => {
              closed = true;
              clearTimeout(timer);
              if (ticket) control.dropConnection(ticket);
              await transport.close(4400, "Invalid or stale device message");
            })
            .finally(() => {
              queuedFrames--;
              queuedBytes -= bytes;
            });
        });
      },
    );
  }
  addSocket("/ws/device", "computer");
  addSocket("/ws/browser", "browser");
  if (config.staticRoot && existsSync(config.staticRoot)) {
    await app.register(staticFiles, {
      root: resolve(config.staticRoot),
      prefix: "/static/",
      decorateReply: true,
    });
    app.get("/", async (_request, reply) => {
      reply.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      );
      return reply.sendFile("index.html");
    });
  }
  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      await control.shutdown();
      await app.close();
    } finally {
      store.close();
      release();
    }
  }
  async function start(): Promise<string> {
    try {
      const address = await app.listen({ host, port });
      control.start();
      return address;
    } catch (error) {
      await close();
      throw error;
    }
  }
  return { app, store, control, adminToken: admin.token, start, close };
}
