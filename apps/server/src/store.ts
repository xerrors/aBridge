import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { promisify } from "node:util";
import {
  deviceCapabilities,
  CAPABILITIES,
  type Capability,
  type DeviceKind,
  type DeviceMetadata,
  type ConnectionPolicy,
  type ManagedBrowserClaims,
} from "@abridge/protocol";
import { validatePolicy } from "./policy.js";
import {
  BridgeError,
  nowSeconds,
  type User,
  type Device,
  type AgentConnection,
  type ControlSession,
  type Operation,
  type OperationState,
  type SessionState,
} from "./types.js";

const derive = promisify(pbkdf2);
export const identifier = (prefix: string): string => prefix + "_" + randomBytes(12).toString("hex");
export const secretKey = (kind: string): string =>
  "abr_" + kind + "_" + randomBytes(32).toString("base64url");
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

const SCHEMA = [
  "CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,salt TEXT,password_hash TEXT,created_at REAL NOT NULL);",
  "CREATE TABLE external_identities(issuer TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(issuer,subject));",
  "CREATE TABLE platform_connections(issuer TEXT NOT NULL,subject TEXT NOT NULL,client_id TEXT NOT NULL,agent_connection_id TEXT NOT NULL REFERENCES agent_connections(id),PRIMARY KEY(issuer,subject,client_id),FOREIGN KEY(issuer,subject) REFERENCES external_identities(issuer,subject));",
  "CREATE TABLE logins(digest TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at REAL NOT NULL);",
  "CREATE TABLE devices(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,capabilities TEXT NOT NULL,token_digest TEXT UNIQUE NOT NULL,credential_version INTEGER NOT NULL,epoch INTEGER NOT NULL,revoked_at REAL,created_at REAL NOT NULL,last_seen REAL,kind TEXT NOT NULL CHECK(kind IN ('computer','browser')),platform TEXT,version TEXT,details TEXT);",
  "CREATE TABLE agent_connections(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,policy TEXT NOT NULL,expires_at REAL,token_digest TEXT UNIQUE,revoked_at REAL,created_at REAL NOT NULL,last_used REAL);",
  "CREATE TABLE control_sessions(id TEXT PRIMARY KEY,agent_connection_id TEXT NOT NULL REFERENCES agent_connections(id),device_id TEXT NOT NULL REFERENCES devices(id),capabilities TEXT NOT NULL,lease_until REAL NOT NULL,status TEXT NOT NULL,created_at REAL NOT NULL);",
  "CREATE TABLE operations(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),agent_connection_id TEXT NOT NULL REFERENCES agent_connections(id),device_id TEXT NOT NULL REFERENCES devices(id),session_id TEXT NOT NULL REFERENCES control_sessions(id),tool TEXT NOT NULL,request_hash TEXT NOT NULL,key_hash TEXT UNIQUE,status TEXT NOT NULL,epoch INTEGER NOT NULL,created_at REAL NOT NULL,finished_at REAL);",
  "CREATE TABLE audit(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),device_id TEXT,agent_connection_id TEXT,operation_id TEXT,action TEXT NOT NULL,outcome TEXT NOT NULL,created_at REAL NOT NULL);",
  "CREATE INDEX operation_owner ON operations(owner_id,created_at); CREATE INDEX audit_owner ON audit(owner_id,created_at); PRAGMA user_version=6;",
].join("\n");

type ManagedBrowserIdentity = ManagedBrowserClaims & {
  issuer: string;
  client_id: string;
  client_name?: string;
};

interface ManagedBrowser {
  device_id: string;
  agent_connection_id: string;
  generation: number;
  bootstrap_nonce: string | null;
  bootstrap_expires_at: number | null;
  stopped_at: number;
}

/** One SQL implementation. Compound state and audit mutations share a transaction. */
export class Store {
  private readonly db: DatabaseSync;
  private readonly bootstrapKey = randomBytes(32);
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    const version = Number(this.one<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0);
    if (version === 0) this.transaction(() => this.db.exec(SCHEMA));
    else if (version !== 6) {
      this.db.close();
      throw new BridgeError("schema_mismatch", "Use a development database matching this version", 500);
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS active_session_device ON control_sessions(device_id) WHERE status='active'; " +
        "CREATE INDEX IF NOT EXISTS active_session_agent_connection ON control_sessions(agent_connection_id) WHERE status='active';",
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS managed_browsers(
      issuer TEXT NOT NULL, subject TEXT NOT NULL, client_id TEXT NOT NULL, sandbox_id TEXT NOT NULL,
      generation INTEGER NOT NULL, device_id TEXT UNIQUE NOT NULL REFERENCES devices(id),
      agent_connection_id TEXT UNIQUE NOT NULL REFERENCES agent_connections(id),
      bootstrap_nonce TEXT, bootstrap_expires_at REAL, stopped_at INTEGER NOT NULL DEFAULT -1,
      PRIMARY KEY(issuer,subject,client_id,sandbox_id),
      FOREIGN KEY(issuer,subject) REFERENCES external_identities(issuer,subject)
    );`);
  }
  close(): void {
    this.db.close();
  }
  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private run(sql: string, ...values: SQLInputValue[]): void {
    this.db.prepare(sql).run(...values);
  }
  private one<T>(sql: string, ...values: SQLInputValue[]): T | undefined {
    const row = this.db.prepare(sql).get(...values);
    return row ? (this.decode(row) as T) : undefined;
  }
  private all<T>(sql: string, ...values: SQLInputValue[]): T[] {
    return this.db
      .prepare(sql)
      .all(...values)
      .map((row) => this.decode(row) as T);
  }
  private decode(row: Record<string, unknown>): Record<string, unknown> {
    const result = { ...row };
    for (const key of ["capabilities", "policy"])
      if (typeof result[key] === "string") result[key] = JSON.parse(result[key]);
    if (typeof result.details === "string") result.details = JSON.parse(result.details);
    else if (result.details === null) delete result.details;
    return result;
  }
  users(): (User & { created_at: number })[] {
    return this.all("SELECT id,username,created_at FROM users ORDER BY created_at DESC,id");
  }
  activeDevices(): Device[] {
    return this.all("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at DESC,id");
  }
  async createUser(username: string, password: string): Promise<User> {
    const normalized = username.trim().toLocaleLowerCase("und");
    if (!normalized || normalized.length > 80 || password.length < 12 || password.length > 1024)
      throw new BridgeError(
        "invalid_account",
        "Username is required and password must contain 12–1024 characters",
        422,
      );
    const user = { id: identifier("usr"), username: normalized },
      salt = randomBytes(16).toString("hex");
    const hash = (await derive(password, Buffer.from(salt, "hex"), 390_000, 32, "sha256")).toString("hex");
    return this.transaction(() => {
      try {
        this.run("INSERT INTO users VALUES(?,?,?,?,?)", user.id, user.username, salt, hash, nowSeconds());
      } catch (error) {
        if ((error as Error).message.includes("UNIQUE"))
          throw new BridgeError("account_exists", "Account already exists", 409);
        throw error;
      }
      return user;
    });
  }
  user(id: string): User | undefined {
    return this.one("SELECT id,username FROM users WHERE id=?", id);
  }
  async verifyUser(username: string, password: string): Promise<User | undefined> {
    const row = this.one<User & { salt: string; password_hash: string }>(
      "SELECT * FROM users WHERE username=?",
      username.trim().toLocaleLowerCase("und"),
    );
    const candidate = await derive(
      password,
      Buffer.from(row?.salt ?? "00".repeat(16), "hex"),
      390_000,
      32,
      "sha256",
    );
    const expected = Buffer.from(row?.password_hash ?? "00".repeat(32), "hex");
    if (!row || expected.length !== candidate.length || !timingSafeEqual(candidate, expected))
      return undefined;
    return { id: row.id, username: row.username };
  }
  async login(username: string, password: string): Promise<{ user: User; token: string } | undefined> {
    const user = await this.verifyUser(username, password);
    if (!user) return undefined;
    const token = this.createLogin(user.id);
    return { user, token };
  }
  /** 为已验证身份签发本地浏览器会话。 */
  createLogin(userId: string): string {
    const token = randomBytes(36).toString("base64url");
    this.run("INSERT INTO logins VALUES(?,?,?)", digest(token), userId, nowSeconds() + 43200);
    return token;
  }
  /** 以签发方和稳定主体首次开户，绝不按显示名称合并。 */
  externalUser(issuer: string, subject: string, label: string, clientId?: string, clientName?: string): User {
    return this.transaction(() => {
      const user = this.ensureExternalUser(issuer, subject, label);
      if (clientId)
        this.ensurePlatformConnection(user.id, issuer, subject, clientId, clientName, {
          mode: "all",
          capabilities: [...CAPABILITIES],
          overrides: [],
        });
      return user;
    });
  }
  private ensurePlatformConnection(
    owner: string,
    issuer: string,
    subject: string,
    clientId: string,
    clientName: string | undefined,
    policy: ConnectionPolicy,
  ): void {
    const linked = this.one(
      "SELECT 1 FROM platform_connections WHERE issuer=? AND subject=? AND client_id=?",
      issuer,
      subject,
      clientId,
    );
    if (linked) return;
    const connection = this.insertPlatformConnection(owner, (clientName ?? clientId) + " 平台连接", policy);
    this.run("INSERT INTO platform_connections VALUES(?,?,?,?)", issuer, subject, clientId, connection);
  }
  private insertPlatformConnection(owner: string, name: string, policy: ConnectionPolicy): string {
    const id = identifier("agt");
    this.run(
      "INSERT INTO agent_connections VALUES(?,?,?,?,NULL,NULL,NULL,?,NULL)",
      id,
      owner,
      name,
      JSON.stringify(policy),
      nowSeconds(),
    );
    return id;
  }
  private ensureExternalUser(issuer: string, subject: string, label: string): User {
    const existing = this.one<{ user_id: string }>(
      "SELECT user_id FROM external_identities WHERE issuer=? AND subject=?",
      issuer,
      subject,
    );
    if (existing) return this.user(existing.user_id)!;
    const id = identifier("usr");
    const username = label.slice(0, 50) + " · " + id.slice(4);
    this.run("INSERT INTO users VALUES(?,?,NULL,NULL,?)", id, username, nowSeconds());
    this.run("INSERT INTO external_identities VALUES(?,?,?)", issuer, subject, id);
    return { id, username };
  }

  private managedBrowser(grant: ManagedBrowserIdentity): ManagedBrowser | undefined {
    return this.one(
      "SELECT * FROM managed_browsers WHERE issuer=? AND subject=? AND client_id=? AND sandbox_id=?",
      grant.issuer,
      grant.sub,
      grant.client_id,
      grant.sandbox_id,
    );
  }

  provisionManagedBrowser(grant: ManagedBrowserIdentity): { device: Device; replaced: boolean } {
    return this.transaction(() => {
      const existing = this.managedBrowser(grant);
      if (existing) {
        const device = this.device(existing.device_id)!;
        const connection = this.agentConnection(existing.agent_connection_id)!;
        if (device.revoked_at !== null || connection.revoked_at !== null || grant.iat <= existing.stopped_at)
          throw new BridgeError(
            "managed_browser_revoked",
            "Managed browser access was revoked or stopped",
            403,
          );
        if (grant.generation < existing.generation)
          throw new BridgeError("stale_sandbox", "The sandbox has been replaced", 409);
        if (grant.generation === existing.generation) return { device, replaced: false };
        this.rotateDevice(device.id);
        this.run(
          "UPDATE managed_browsers SET generation=?,bootstrap_nonce=NULL,bootstrap_expires_at=NULL WHERE device_id=?",
          grant.generation,
          device.id,
        );
        return { device: this.device(device.id)!, replaced: true };
      }

      const user = this.ensureExternalUser(grant.issuer, grant.sub, grant.sub);
      const name = grant.name ?? "沙盒浏览器";
      const device = this.insertDevice(user.id, name, ["browser"], "browser", secretKey("device"));
      const policy: ConnectionPolicy = {
        mode: "selected",
        devices: [{ device_id: device.id, capabilities: ["browser"] }],
      };
      const connectionId = this.insertPlatformConnection(user.id, name, policy);
      // A first-time human can also use the ordinary platform connection, scoped to this device.
      if (grant.user_kind === "human")
        this.ensurePlatformConnection(
          user.id,
          grant.issuer,
          grant.sub,
          grant.client_id,
          grant.client_name,
          policy,
        );
      this.run(
        "INSERT INTO managed_browsers(issuer,subject,client_id,sandbox_id,generation,device_id,agent_connection_id) VALUES(?,?,?,?,?,?,?)",
        grant.issuer,
        grant.sub,
        grant.client_id,
        grant.sandbox_id,
        grant.generation,
        device.id,
        connectionId,
      );
      return { device, replaced: false };
    });
  }

  private bootstrapToken(deviceId: string, nonce: string): string {
    return createHmac("sha256", this.bootstrapKey)
      .update(deviceId + ":" + nonce)
      .digest("base64url");
  }

  issueManagedBrowserBootstrap(grant: ManagedBrowserIdentity): string {
    const row = this.managedBrowser(grant);
    if (!row || row.generation !== grant.generation || grant.iat <= row.stopped_at)
      throw new BridgeError("stale_sandbox", "The sandbox binding changed", 409);
    if (row.bootstrap_nonce && row.bootstrap_expires_at! > nowSeconds())
      return this.bootstrapToken(row.device_id, row.bootstrap_nonce);
    const nonce = randomBytes(24).toString("base64url");
    this.run(
      "UPDATE managed_browsers SET bootstrap_nonce=?,bootstrap_expires_at=? WHERE device_id=?",
      nonce,
      nowSeconds() + 300,
      row.device_id,
    );
    return this.bootstrapToken(row.device_id, nonce);
  }

  redeemManagedBrowser(deviceId: string, token: string): { device: Device; key: string } {
    return this.transaction(() => {
      const row = this.one<ManagedBrowser>("SELECT * FROM managed_browsers WHERE device_id=?", deviceId);
      const device = row && this.device(deviceId);
      const connection = row && this.agentConnection(row.agent_connection_id);
      if (
        !row?.bootstrap_nonce ||
        row.bootstrap_expires_at! <= nowSeconds() ||
        !device ||
        device.revoked_at !== null ||
        !connection ||
        connection.revoked_at !== null ||
        !timingSafeEqual(
          Buffer.from(digest(token)),
          Buffer.from(digest(this.bootstrapToken(deviceId, row.bootstrap_nonce))),
        )
      )
        throw new BridgeError("invalid_grant", "Browser bootstrap credential is invalid or expired", 400);
      this.run(
        "UPDATE managed_browsers SET bootstrap_nonce=NULL,bootstrap_expires_at=NULL WHERE device_id=?",
        deviceId,
      );
      return { device, key: this.rotateDevice(deviceId) };
    });
  }

  managedBrowserConnection(grant: ManagedBrowserIdentity): AgentConnection | undefined {
    const row = this.managedBrowser(grant);
    if (!row || row.generation !== grant.generation || grant.iat <= row.stopped_at) return undefined;
    const connection = this.agentConnection(row.agent_connection_id);
    if (!connection || connection.revoked_at !== null || this.device(row.device_id)?.revoked_at !== null)
      return undefined;
    return connection;
  }

  stopManagedBrowser(grant: ManagedBrowserIdentity): AgentConnection | undefined {
    const row = this.managedBrowser(grant);
    if (!row || row.generation !== grant.generation || grant.iat <= row.stopped_at) return undefined;
    this.run(
      "UPDATE managed_browsers SET stopped_at=?,bootstrap_nonce=NULL,bootstrap_expires_at=NULL WHERE device_id=?",
      Math.floor(nowSeconds()),
      row.device_id,
    );
    return this.agentConnection(row.agent_connection_id);
  }

  isManagedBrowserConnection(id: string): boolean {
    return !!this.one("SELECT 1 FROM managed_browsers WHERE agent_connection_id=?", id);
  }
  /** 仅解析已登录建立且尚有效的外部平台授权。 */
  delegatedAgentConnection(issuer: string, subject: string, clientId: string): AgentConnection | undefined {
    const row = this.one<{ agent_connection_id: string }>(
      "SELECT agent_connection_id FROM platform_connections WHERE issuer=? AND subject=? AND client_id=?",
      issuer,
      subject,
      clientId,
    );
    const agentConnection = row ? this.agentConnection(row.agent_connection_id) : undefined;
    if (
      !agentConnection ||
      agentConnection.revoked_at !== null ||
      (agentConnection.expires_at !== null && agentConnection.expires_at <= nowSeconds())
    )
      return undefined;
    this.run("UPDATE agent_connections SET last_used=? WHERE id=?", nowSeconds(), agentConnection.id);
    return agentConnection;
  }
  /** 只有当前平台授权的撤销记录允许显式重新建立连接。 */
  canReconnectPlatformAgentConnection(agentConnection: AgentConnection): boolean {
    return (
      agentConnection.token_digest === null &&
      agentConnection.revoked_at !== null &&
      !!this.one(
        "SELECT agent_connection_id FROM platform_connections WHERE agent_connection_id=?",
        agentConnection.id,
      )
    );
  }
  /** 保留旧授权墓碑及会话，显式重新授权的新连接默认访问全部设备。 */
  reconnectPlatformAgentConnection(agentConnection: AgentConnection): AgentConnection {
    return this.transaction(() => {
      const current = this.agentConnection(agentConnection.id);
      if (!current || !this.canReconnectPlatformAgentConnection(current))
        throw new BridgeError(
          "invalid_reconnect",
          "Only the current revoked platform connection can be reauthorized",
          409,
        );
      const id = identifier("agt");
      this.run(
        "INSERT INTO agent_connections VALUES(?,?,?,?,NULL,NULL,NULL,?,NULL)",
        id,
        current.owner_id,
        current.name,
        JSON.stringify({ mode: "all", capabilities: [...CAPABILITIES], overrides: [] }),
        nowSeconds(),
      );
      this.run(
        "UPDATE platform_connections SET agent_connection_id=? WHERE agent_connection_id=?",
        id,
        current.id,
      );
      this.audit(current.owner_id, null, id, null, "platform_connection_reconnect", "changed");
      return this.agentConnection(id)!;
    });
  }
  account(token: string): User | undefined {
    return this.one(
      "SELECT u.id,u.username FROM logins l JOIN users u ON u.id=l.user_id WHERE l.digest=? AND l.expires_at>?",
      digest(token),
      nowSeconds(),
    );
  }
  logout(token: string): void {
    this.run("DELETE FROM logins WHERE digest=?", digest(token));
  }
  devices(owner: string): Device[] {
    return this.all("SELECT * FROM devices WHERE owner_id=? ORDER BY created_at DESC", owner);
  }
  device(id: string): Device | undefined {
    return this.one("SELECT * FROM devices WHERE id=?", id);
  }
  createDevice(
    owner: string,
    name: string,
    capabilities: Capability[],
    kind: DeviceKind = "computer",
  ): { device: Device; key: string } {
    const key = secretKey("device");
    return { device: this.transaction(() => this.insertDevice(owner, name, capabilities, kind, key)), key };
  }
  private insertDevice(
    owner: string,
    name: string,
    capabilities: Capability[],
    kind: DeviceKind,
    key: string,
  ): Device {
    if (!capabilities.length || capabilities.some((cap) => !deviceCapabilities(kind).includes(cap)))
      throw new BridgeError("invalid_capabilities", "Capabilities do not match device kind", 422);
    let id: string;
    do {
      id = randomBytes(9).toString("base64url");
    } while (this.device(id));
    this.run(
      "INSERT INTO devices(id,owner_id,name,capabilities,token_digest,credential_version,epoch,created_at,kind) VALUES(?,?,?,?,?,1,0,?,?)",
      id,
      owner,
      name,
      JSON.stringify(capabilities),
      digest(key),
      nowSeconds(),
      kind,
    );
    this.audit(owner, id, null, null, "device_create", "changed");
    return this.device(id)!;
  }
  renameDevice(id: string, name: string): void {
    this.transaction(() => {
      this.run("UPDATE devices SET name=? WHERE id=?", name, id);
      this.audit(this.device(id)!.owner_id, id, null, null, "device_rename", "changed");
    });
  }
  rotateDevice(id: string): string {
    const key = secretKey("device");
    this.run(
      "UPDATE devices SET token_digest=?,credential_version=credential_version+1 WHERE id=?",
      digest(key),
      id,
    );
    return key;
  }
  revokeDevice(id: string): void {
    this.run(
      "UPDATE devices SET revoked_at=?,credential_version=credential_version+1 WHERE id=?",
      nowSeconds(),
      id,
    );
  }
  authenticateDevice(key: string): Device | undefined {
    return key.startsWith("abr_device_")
      ? this.one("SELECT * FROM devices WHERE token_digest=? AND revoked_at IS NULL", digest(key))
      : undefined;
  }
  nextEpoch(id: string): number {
    this.run("UPDATE devices SET epoch=epoch+1,last_seen=? WHERE id=?", nowSeconds(), id);
    return this.device(id)!.epoch;
  }
  updateDeviceMetadata(id: string, credentialVersion: number, epoch: number, metadata: DeviceMetadata): void {
    this.run(
      "UPDATE devices SET platform=?,version=?,details=? WHERE id=? AND credential_version=? AND epoch=? AND revoked_at IS NULL",
      metadata.platform,
      metadata.version,
      metadata.details ? JSON.stringify(metadata.details) : null,
      id,
      credentialVersion,
      epoch,
    );
  }
  touchDevice(id: string): void {
    this.run("UPDATE devices SET last_seen=? WHERE id=?", nowSeconds(), id);
  }
  agentConnections(owner: string): AgentConnection[] {
    return this.all("SELECT * FROM agent_connections WHERE owner_id=? ORDER BY created_at DESC", owner);
  }
  agentConnection(id: string): AgentConnection | undefined {
    return this.one("SELECT * FROM agent_connections WHERE id=?", id);
  }
  createAgentConnection(
    owner: string,
    name: string,
    policy: ConnectionPolicy,
    expiresAt: number | null = null,
  ): { agentConnection: AgentConnection; key: string } {
    const validated = validatePolicy(owner, policy, (id) => this.device(id));
    const id = identifier("agt"),
      key = secretKey("agent");
    this.transaction(() => {
      this.run(
        "INSERT INTO agent_connections VALUES(?,?,?,?,?,?,NULL,?,NULL)",
        id,
        owner,
        name,
        JSON.stringify(validated),
        expiresAt,
        digest(key),
        nowSeconds(),
      );
      this.audit(owner, null, id, null, "agent_connection_create", "changed");
    });
    return { agentConnection: this.agentConnection(id)!, key };
  }
  updateAgentConnection(
    id: string,
    name: string,
    policy: ConnectionPolicy,
    expiresAt: number | null,
  ): AgentConnection {
    const agentConnection = this.agentConnection(id);
    if (!agentConnection || agentConnection.revoked_at !== null)
      throw new BridgeError("not_found", "Connection not found", 404);
    if (this.isManagedBrowserConnection(id))
      throw new BridgeError(
        "managed_connection",
        "Managed browser connections have a fixed device policy",
        409,
      );
    const validated = validatePolicy(agentConnection.owner_id, policy, (deviceId) => this.device(deviceId));
    this.transaction(() => {
      this.run(
        "UPDATE agent_connections SET name=?,policy=?,expires_at=? WHERE id=?",
        name,
        JSON.stringify(validated),
        expiresAt,
        id,
      );
      this.audit(agentConnection.owner_id, null, id, null, "agent_connection_update", "changed");
    });
    return this.agentConnection(id)!;
  }
  rotateAgentConnection(id: string): { agentConnection: AgentConnection; key: string } {
    const agentConnection = this.agentConnection(id);
    if (!agentConnection || agentConnection.revoked_at !== null)
      throw new BridgeError("not_found", "Connection not found", 404);
    if (agentConnection.token_digest === null)
      throw new BridgeError("external_connection", "External platform connections do not have keys", 409);
    const key = secretKey("agent");
    this.transaction(() => {
      this.run("UPDATE agent_connections SET token_digest=? WHERE id=?", digest(key), id);
      this.audit(agentConnection.owner_id, null, id, null, "agent_connection_rotate", "changed");
    });
    return { agentConnection: this.agentConnection(id)!, key };
  }
  agentConnectionSessions(id: string): ControlSession[] {
    return this.all("SELECT * FROM control_sessions WHERE agent_connection_id=? AND status='active'", id);
  }
  revokeAgentConnection(id: string): void {
    this.run("UPDATE agent_connections SET revoked_at=? WHERE id=?", nowSeconds(), id);
  }
  authenticateAgent(key: string): AgentConnection | undefined {
    if (!key.startsWith("abr_agent_")) return undefined;
    const agentConnection = this.one<AgentConnection>(
      "SELECT * FROM agent_connections WHERE token_digest=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)",
      digest(key),
      nowSeconds(),
    );
    if (agentConnection)
      this.run("UPDATE agent_connections SET last_used=? WHERE id=?", nowSeconds(), agentConnection.id);
    return agentConnection;
  }
  session(id: string): ControlSession | undefined {
    return this.one("SELECT * FROM control_sessions WHERE id=?", id);
  }
  sessions(deviceId: string): ControlSession[] {
    return this.all("SELECT * FROM control_sessions WHERE device_id=? AND status='active'", deviceId);
  }
  createSession(
    agentConnection: AgentConnection,
    deviceId: string,
    capabilities: Capability[],
    leaseUntil: number,
  ): ControlSession {
    let id: string;
    do id = "ses_" + randomBytes(6).toString("base64url");
    while (this.session(id));
    this.transaction(() => {
      this.run(
        "INSERT INTO control_sessions VALUES(?,?,?,?,?,'active',?)",
        id,
        agentConnection.id,
        deviceId,
        JSON.stringify(capabilities),
        leaseUntil,
        nowSeconds(),
      );
      this.audit(agentConnection.owner_id, deviceId, agentConnection.id, null, "session_open", "active");
    });
    return this.session(id)!;
  }
  closeSession(id: string, status: SessionState = "stopped"): void {
    const session = this.session(id);
    if (!session || session.status !== "active") return;
    this.transaction(() => {
      this.run("UPDATE control_sessions SET status=? WHERE id=?", status, id);
      const agentConnection = this.agentConnection(session.agent_connection_id);
      if (agentConnection)
        this.audit(
          agentConnection.owner_id,
          session.device_id,
          agentConnection.id,
          null,
          "session_close",
          status,
        );
    });
  }
  renewSession(id: string, leaseUntil: number): void {
    this.run("UPDATE control_sessions SET lease_until=? WHERE id=? AND status='active'", leaseUntil, id);
  }
  operation(id: string): Operation | undefined {
    return this.one("SELECT * FROM operations WHERE id=?", id);
  }
  operationForKey(keyHash: string): Operation | undefined {
    return this.one("SELECT * FROM operations WHERE key_hash=?", keyHash);
  }
  operations(
    owner: string,
    filters: { device_id?: string; agent_connection_id?: string; tool?: string; offset?: number } = {},
  ): Operation[] {
    const { where, values } = this.operationFilters(owner, filters);
    return this.all(
      `SELECT * FROM operations WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?`,
      ...values,
      filters.offset ?? 0,
    );
  }
  operationCount(
    owner: string,
    filters: { device_id?: string; agent_connection_id?: string; tool?: string },
  ): number {
    const { where, values } = this.operationFilters(owner, filters);
    return this.one<{ count: number }>(`SELECT count(*) AS count FROM operations WHERE ${where}`, ...values)!
      .count;
  }
  operationTools(owner: string, deviceId?: string): string[] {
    const { where, values } = this.operationFilters(owner, { device_id: deviceId });
    return this.all<{ tool: string }>(
      `SELECT DISTINCT tool FROM operations WHERE ${where} ORDER BY tool`,
      ...values,
    ).map((row) => row.tool);
  }
  private operationFilters(
    owner: string,
    filters: { device_id?: string; agent_connection_id?: string; tool?: string },
  ) {
    const clauses = ["owner_id=?"];
    const values: SQLInputValue[] = [owner];
    for (const column of ["device_id", "agent_connection_id", "tool"] as const) {
      if (filters[column] !== undefined) {
        clauses.push(`${column}=?`);
        values.push(filters[column]!);
      }
    }
    return { where: clauses.join(" AND "), values };
  }
  createOperation(operation: Omit<Operation, "status" | "created_at" | "finished_at">): void {
    const o = operation;
    this.transaction(() => {
      this.run(
        "INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,'dispatched',?,?,NULL)",
        o.id,
        o.owner_id,
        o.agent_connection_id,
        o.device_id,
        o.session_id,
        o.tool,
        o.request_hash,
        o.key_hash,
        o.epoch,
        nowSeconds(),
      );
      this.audit(o.owner_id, o.device_id, o.agent_connection_id, o.id, o.tool, "dispatched");
    });
  }
  finishOperation(id: string, status: OperationState): void {
    const operation = this.operation(id);
    if (!operation) return;
    this.transaction(() => {
      this.run("UPDATE operations SET status=?,finished_at=? WHERE id=?", status, nowSeconds(), id);
      this.audit(
        operation.owner_id,
        operation.device_id,
        operation.agent_connection_id,
        id,
        operation.tool,
        status,
      );
    });
  }
  audit(
    owner: string,
    device: string | null,
    agentConnection: string | null,
    operation: string | null,
    action: string,
    outcome: string,
  ): void {
    this.run(
      "INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)",
      identifier("evt"),
      owner,
      device,
      agentConnection,
      operation,
      action,
      outcome,
      nowSeconds(),
    );
  }
  auditEvents(owner: string): Record<string, unknown>[] {
    return this.all("SELECT * FROM audit WHERE owner_id=? ORDER BY created_at DESC LIMIT 200", owner);
  }
  recoverAfterRestart(): void {
    this.transaction(() => {
      this.run(
        "UPDATE operations SET status='outcome_unknown',finished_at=? WHERE status IN ('accepted','dispatched')",
        nowSeconds(),
      );
      this.run("UPDATE control_sessions SET status='server_restarted' WHERE status='active'");
      this.run("DELETE FROM logins WHERE expires_at<=?", nowSeconds());
    });
  }
}

/** Only a running server takes this guard; an administration command must not recover live state. */
export function acquireInstanceLock(dbPath: string): () => void {
  const path = resolve(dbPath) + ".instance";
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const guard = new DatabaseSync(path);
  chmodSync(path, 0o600);
  try {
    guard.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    guard.close();
    throw new BridgeError("instance_running", "Another server already owns this data directory", 409);
  }
  return () => {
    guard.exec("ROLLBACK");
    guard.close();
  };
}
