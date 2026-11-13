import { createHash, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { promisify } from "node:util";
import {
  deviceCapabilities,
  type Capability,
  type DeviceKind,
  type ConnectionPolicy,
} from "@abridge/protocol";
import { validatePolicy } from "./policy.js";
import {
  BridgeError,
  nowSeconds,
  type User,
  type Device,
  type Grant,
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
  "CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at REAL NOT NULL);",
  "CREATE TABLE logins(digest TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at REAL NOT NULL);",
  "CREATE TABLE devices(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,capabilities TEXT NOT NULL,token_digest TEXT UNIQUE NOT NULL,credential_version INTEGER NOT NULL,epoch INTEGER NOT NULL,revoked_at REAL,created_at REAL NOT NULL,last_seen REAL,kind TEXT NOT NULL CHECK(kind IN ('computer','browser')));",
  "CREATE TABLE client_grants(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,policy TEXT NOT NULL,expires_at REAL,token_digest TEXT UNIQUE NOT NULL,revoked_at REAL,created_at REAL NOT NULL,last_used REAL);",
  "CREATE TABLE control_sessions(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES client_grants(id),device_id TEXT NOT NULL REFERENCES devices(id),capabilities TEXT NOT NULL,lease_until REAL NOT NULL,status TEXT NOT NULL,created_at REAL NOT NULL);",
  "CREATE TABLE operations(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),grant_id TEXT NOT NULL REFERENCES client_grants(id),device_id TEXT NOT NULL REFERENCES devices(id),session_id TEXT NOT NULL REFERENCES control_sessions(id),tool TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,epoch INTEGER NOT NULL,created_at REAL NOT NULL,finished_at REAL);",
  "CREATE TABLE audit(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),device_id TEXT,grant_id TEXT,operation_id TEXT,action TEXT NOT NULL,outcome TEXT NOT NULL,created_at REAL NOT NULL);",
  "CREATE INDEX operation_owner ON operations(owner_id,created_at); CREATE INDEX audit_owner ON audit(owner_id,created_at); PRAGMA user_version=2;",
].join("\n");

/** One SQL implementation. Compound state and audit mutations share a transaction. */
export class Store {
  private readonly db: DatabaseSync;
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    const version = Number(this.one<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0);
    if (version === 0) this.transaction(() => this.db.exec(SCHEMA));
    else if (version !== 2) {
      this.db.close();
      throw new BridgeError("schema_mismatch", "Use a development database matching this version", 500);
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS active_session_device ON control_sessions(device_id) WHERE status='active'; " +
        "CREATE INDEX IF NOT EXISTS active_session_grant ON control_sessions(grant_id) WHERE status='active';",
    );
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
    const token = randomBytes(36).toString("base64url");
    this.run("INSERT INTO logins VALUES(?,?,?)", digest(token), user.id, nowSeconds() + 43200);
    return { user, token };
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
    if (!capabilities.length || capabilities.some((cap) => !deviceCapabilities(kind).includes(cap)))
      throw new BridgeError("invalid_capabilities", "Capabilities do not match device kind", 422);
    const id = identifier("dev"),
      key = secretKey("device");
    this.transaction(() => {
      this.run(
        "INSERT INTO devices VALUES(?,?,?,?,?,1,0,NULL,?,NULL,?)",
        id,
        owner,
        name,
        JSON.stringify(capabilities),
        digest(key),
        nowSeconds(),
        kind,
      );
      this.audit(owner, id, null, null, "device_create", "changed");
    });
    return { device: this.device(id)!, key };
  }
  updateDevice(id: string, name: string, capabilities: Capability[]): void {
    this.run("UPDATE devices SET name=?,capabilities=? WHERE id=?", name, JSON.stringify(capabilities), id);
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
  touchDevice(id: string): void {
    this.run("UPDATE devices SET last_seen=? WHERE id=?", nowSeconds(), id);
  }
  grants(owner: string): Grant[] {
    return this.all("SELECT * FROM client_grants WHERE owner_id=? ORDER BY created_at DESC", owner);
  }
  grant(id: string): Grant | undefined {
    return this.one("SELECT * FROM client_grants WHERE id=?", id);
  }
  createGrant(
    owner: string,
    name: string,
    policy: ConnectionPolicy,
    expiresAt: number | null = null,
  ): { grant: Grant; key: string } {
    const validated = validatePolicy(owner, policy, (id) => this.device(id));
    const id = identifier("agt"),
      key = secretKey("agent");
    this.transaction(() => {
      this.run(
        "INSERT INTO client_grants VALUES(?,?,?,?,?,?,NULL,?,NULL)",
        id,
        owner,
        name,
        JSON.stringify(validated),
        expiresAt,
        digest(key),
        nowSeconds(),
      );
      this.audit(owner, null, id, null, "client_grant_create", "changed");
    });
    return { grant: this.grant(id)!, key };
  }
  updateGrant(id: string, name: string, policy: ConnectionPolicy, expiresAt: number | null): Grant {
    const grant = this.grant(id);
    if (!grant || grant.revoked_at !== null) throw new BridgeError("not_found", "Connection not found", 404);
    const validated = validatePolicy(grant.owner_id, policy, (deviceId) => this.device(deviceId));
    this.transaction(() => {
      this.run(
        "UPDATE client_grants SET name=?,policy=?,expires_at=? WHERE id=?",
        name,
        JSON.stringify(validated),
        expiresAt,
        id,
      );
      this.audit(grant.owner_id, null, id, null, "client_grant_update", "changed");
    });
    return this.grant(id)!;
  }
  rotateGrant(id: string): { grant: Grant; key: string } {
    const grant = this.grant(id);
    if (!grant || grant.revoked_at !== null) throw new BridgeError("not_found", "Connection not found", 404);
    const key = secretKey("agent");
    this.transaction(() => {
      this.run("UPDATE client_grants SET token_digest=? WHERE id=?", digest(key), id);
      this.audit(grant.owner_id, null, id, null, "client_grant_rotate", "changed");
    });
    return { grant: this.grant(id)!, key };
  }
  grantSessions(id: string): ControlSession[] {
    return this.all("SELECT * FROM control_sessions WHERE grant_id=? AND status='active'", id);
  }
  revokeGrant(id: string): void {
    this.run("UPDATE client_grants SET revoked_at=? WHERE id=?", nowSeconds(), id);
  }
  authenticateAgent(key: string): Grant | undefined {
    if (!key.startsWith("abr_agent_")) return undefined;
    const grant = this.one<Grant>(
      "SELECT * FROM client_grants WHERE token_digest=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)",
      digest(key),
      nowSeconds(),
    );
    if (grant) this.run("UPDATE client_grants SET last_used=? WHERE id=?", nowSeconds(), grant.id);
    return grant;
  }
  session(id: string): ControlSession | undefined {
    return this.one("SELECT * FROM control_sessions WHERE id=?", id);
  }
  sessions(deviceId: string): ControlSession[] {
    return this.all("SELECT * FROM control_sessions WHERE device_id=? AND status='active'", deviceId);
  }
  createSession(
    grant: Grant,
    deviceId: string,
    capabilities: Capability[],
    leaseUntil: number,
  ): ControlSession {
    const id = identifier("ses");
    this.transaction(() => {
      this.run(
        "INSERT INTO control_sessions VALUES(?,?,?,?,?,'active',?)",
        id,
        grant.id,
        deviceId,
        JSON.stringify(capabilities),
        leaseUntil,
        nowSeconds(),
      );
      this.audit(grant.owner_id, deviceId, grant.id, null, "session_open", "active");
    });
    return this.session(id)!;
  }
  closeSession(id: string, status: SessionState = "stopped"): void {
    const session = this.session(id);
    if (!session || session.status !== "active") return;
    this.transaction(() => {
      this.run("UPDATE control_sessions SET status=? WHERE id=?", status, id);
      const grant = this.grant(session.grant_id);
      if (grant) this.audit(grant.owner_id, session.device_id, grant.id, null, "session_close", status);
    });
  }
  renewSession(id: string, leaseUntil: number): void {
    this.run("UPDATE control_sessions SET lease_until=? WHERE id=? AND status='active'", leaseUntil, id);
  }
  operation(id: string): Operation | undefined {
    return this.one("SELECT * FROM operations WHERE id=?", id);
  }
  operations(
    owner: string,
    filters: { device_id?: string; grant_id?: string; tool?: string; offset?: number } = {},
  ): Operation[] {
    const { where, values } = this.operationFilters(owner, filters);
    return this.all(
      `SELECT * FROM operations WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?`,
      ...values,
      filters.offset ?? 0,
    );
  }
  operationCount(owner: string, filters: { device_id?: string; grant_id?: string; tool?: string }): number {
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
  private operationFilters(owner: string, filters: { device_id?: string; grant_id?: string; tool?: string }) {
    const clauses = ["owner_id=?"];
    const values: SQLInputValue[] = [owner];
    for (const column of ["device_id", "grant_id", "tool"] as const) {
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
        "INSERT INTO operations VALUES(?,?,?,?,?,?,?,'dispatched',?,?,NULL)",
        o.id,
        o.owner_id,
        o.grant_id,
        o.device_id,
        o.session_id,
        o.tool,
        o.request_hash,
        o.epoch,
        nowSeconds(),
      );
      this.audit(o.owner_id, o.device_id, o.grant_id, o.id, o.tool, "dispatched");
    });
  }
  finishOperation(id: string, status: OperationState): void {
    const operation = this.operation(id);
    if (!operation) return;
    this.transaction(() => {
      this.run("UPDATE operations SET status=?,finished_at=? WHERE id=?", status, nowSeconds(), id);
      this.audit(operation.owner_id, operation.device_id, operation.grant_id, id, operation.tool, status);
    });
  }
  audit(
    owner: string,
    device: string | null,
    grant: string | null,
    operation: string | null,
    action: string,
    outcome: string,
  ): void {
    this.run(
      "INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)",
      identifier("evt"),
      owner,
      device,
      grant,
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
