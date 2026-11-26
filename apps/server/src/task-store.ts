import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ControllerSettings,
  TaskAuditEntry,
  TaskCreate,
  TaskEvent,
  TaskStatus,
  TaskView,
  TaskWorkerFinish,
} from "@abridge/protocol";
import { TaskImages } from "./task-images.js";
import { digest, identifier, secretKey } from "./store.js";
import { BridgeError, nowSeconds } from "./types.js";

export const INSTANCE_ADMIN_ACTOR_ID = "sys_instance_admin";

const active = ["running", "waiting", "stopping"] as const;
const pending = [...active, "queued", "approval"] as const;
const inStates = (status: TaskStatus, states: readonly TaskStatus[]): boolean => states.includes(status);
const LEASE_SECONDS = 30;
const RECEIVER_QUEUE_LIMIT = 100;

interface TaskRow extends Omit<TaskView, "queue_position" | "queue_blocked" | "prompt"> {
  prompt: string;
  request_id: string;
  serial: number | null;
  lease_digest: string | null;
  lease_until: number | null;
  finished_lease_digest: string | null;
  connection_id: string | null;
}

export class TaskStore {
  private readonly images: TaskImages;

  constructor(
    private readonly db: DatabaseSync,
    imageDirectory: string,
  ) {
    this.images = new TaskImages(imageDirectory);
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_receiver_settings(
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        require_task_approval INTEGER NOT NULL CHECK(require_task_approval IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS tasks(
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id),
        recipient_id TEXT NOT NULL REFERENCES users(id), device_id TEXT NOT NULL REFERENCES devices(id),
        request_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, serial INTEGER UNIQUE,
        created_at REAL NOT NULL, updated_at REAL NOT NULL, result TEXT, error TEXT,
        lease_digest TEXT, lease_until REAL, finished_lease_digest TEXT, connection_id TEXT REFERENCES agent_connections(id),
        UNIQUE(actor_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS task_recipient_queue ON tasks(recipient_id, status, serial);
      CREATE UNIQUE INDEX IF NOT EXISTS task_connection ON tasks(connection_id) WHERE connection_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS task_receiver_lock ON tasks(recipient_id) WHERE lease_digest IS NOT NULL;
      CREATE TABLE IF NOT EXISTS task_sessions(
        task_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT PRIMARY KEY REFERENCES control_sessions(id),
        close_confirmed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS task_session_lookup ON task_sessions(task_id,close_confirmed);
      CREATE TABLE IF NOT EXISTS task_events(
        task_id TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL, payload TEXT NOT NULL,
        created_at REAL NOT NULL, PRIMARY KEY(task_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS task_audit(
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), actor_id TEXT REFERENCES users(id),
        action TEXT NOT NULL, outcome TEXT NOT NULL, created_at REAL NOT NULL
      );
    `);
  }

  settings(user: string): ControllerSettings {
    const row = this.db
      .prepare("SELECT require_task_approval FROM task_receiver_settings WHERE user_id=?")
      .get(user) as { require_task_approval: number } | undefined;
    return { require_task_approval: row?.require_task_approval === 1 };
  }

  updateSettings(user: string, settings: ControllerSettings): ControllerSettings {
    this.db
      .prepare(
        "INSERT INTO task_receiver_settings(user_id,require_task_approval) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET require_task_approval=excluded.require_task_approval",
      )
      .run(user, settings.require_task_approval ? 1 : 0);
    return this.settings(user);
  }

  private atomic<T>(action: () => T): T {
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

  private audit(taskId: string, actor: string | null, action: string, status: TaskStatus): void {
    this.db
      .prepare("INSERT INTO task_audit VALUES(?,?,?,?,?,?)")
      .run(identifier("ta"), taskId, actor, action, status, nowSeconds());
  }

  get(id: string): TaskRow {
    const task = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as unknown as TaskRow | undefined;
    if (!task) throw new BridgeError("not_found", "Task not found", 404);
    return task;
  }

  participant(task: TaskRow, user: string): boolean {
    return task.actor_id === user || task.recipient_id === user;
  }

  forUser(id: string, user: string): TaskRow {
    const task = this.get(id);
    if (!this.participant(task, user)) throw new BridgeError("not_found", "Task not found", 404);
    return task;
  }

  view(task: TaskRow, visible: boolean): TaskView {
    const queuePosition =
      task.status === "queued"
        ? (
            this.db
              .prepare(
                "SELECT count(*) AS position FROM tasks WHERE recipient_id=? AND status='queued' AND serial<=?",
              )
              .get(task.recipient_id, task.serial) as { position: number }
          ).position
        : null;
    return {
      id: task.id,
      actor_id: task.actor_id,
      recipient_id: task.recipient_id,
      device_id: task.device_id,
      status: task.status,
      created_at: task.created_at,
      updated_at: task.updated_at,
      queue_position: queuePosition,
      queue_blocked: task.status === "unknown" && task.lease_digest !== null,
      prompt: visible ? task.prompt : null,
      result: visible ? task.result : null,
      error: visible ? task.error : null,
    };
  }

  list(user: string | null, viewer = user): TaskView[] {
    const ordered = `ORDER BY CASE WHEN status IN ('approval','queued','running','waiting','stopping') THEN 0 ELSE 1 END,
      updated_at DESC, id LIMIT 250`;
    const rows =
      user === null
        ? this.db.prepare(`SELECT * FROM tasks ${ordered}`).all()
        : this.db
            .prepare(`SELECT * FROM tasks WHERE actor_id=? OR recipient_id=? ${ordered}`)
            .all(user, user);
    return (rows as unknown as TaskRow[]).map((row) =>
      this.view(row, viewer !== null && this.participant(row, viewer)),
    );
  }

  deviceConversation(actor: string, device: string): TaskView[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE actor_id=? AND device_id=? ORDER BY created_at DESC,rowid DESC LIMIT 250",
      )
      .all(actor, device) as unknown as TaskRow[];
    return rows.reverse().map((row) => this.view(row, true));
  }

  events(id: string): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT payload, created_at FROM task_events WHERE task_id=? ORDER BY sequence")
      .all(id) as { payload: string; created_at: number }[];
    return rows.map((row) => ({
      ...this.eventView(
        id,
        JSON.parse(row.payload) as Omit<TaskEvent, "created_at"> & { image_ref?: string },
      ),
      created_at: row.created_at,
    }));
  }

  private eventView(
    id: string,
    value: Omit<TaskEvent, "created_at"> & { image_ref?: string },
  ): Omit<TaskEvent, "created_at"> {
    const { image_ref, ...event } = value;
    if (image_ref) event.image = `/api/tasks/${id}/images/${image_ref.split("/")[1]}`;
    return event;
  }

  image(id: string, name: string): Buffer {
    const reference = `${id}/${name}`;
    const recorded = this.db
      .prepare("SELECT 1 FROM task_events WHERE task_id=? AND json_extract(payload,'$.image_ref')=?")
      .get(id, reference);
    const data = recorded ? this.images.read(id, reference) : undefined;
    if (!data) throw new BridgeError("not_found", "Task image not found", 404);
    return data;
  }

  auditEntries(): TaskAuditEntry[] {
    return this.db
      .prepare("SELECT * FROM task_audit ORDER BY created_at DESC, rowid DESC LIMIT 250")
      .all() as unknown as TaskAuditEntry[];
  }

  eligible(deviceId: string, recipient: string): boolean {
    const device = this.db
      .prepare(
        "SELECT capabilities FROM devices WHERE id=? AND owner_id=? AND revoked_at IS NULL AND platform='android'",
      )
      .get(deviceId, recipient);
    if (!device || typeof device.capabilities !== "string") return false;
    const capabilities = JSON.parse(device.capabilities) as string[];
    return capabilities.includes("screen") && capabilities.includes("input");
  }

  private sequence(): number {
    return (this.db.prepare("SELECT coalesce(max(serial),0)+1 AS seq FROM tasks").get() as { seq: number })
      .seq;
  }

  create(actor: string, input: TaskCreate): TaskRow {
    return this.atomic(() => {
      const existing = this.db
        .prepare("SELECT * FROM tasks WHERE actor_id=? AND request_id=?")
        .get(actor, input.request_id) as unknown as TaskRow | undefined;
      if (existing) {
        if (
          existing.recipient_id !== input.recipient_id ||
          existing.device_id !== input.device_id ||
          existing.prompt !== input.prompt
        )
          throw new BridgeError("request_conflict", "Request ID already belongs to a different task", 409);
        return existing;
      }
      if (!this.eligible(input.device_id, input.recipient_id))
        throw new BridgeError("not_found", "Eligible Android device not found", 404);
      const count = (
        this.db
          .prepare(
            "SELECT count(*) AS count FROM tasks WHERE recipient_id=? AND status IN ('approval','queued','running','waiting','stopping')",
          )
          .get(input.recipient_id) as { count: number }
      ).count;
      if (count >= RECEIVER_QUEUE_LIMIT)
        throw new BridgeError("queue_full", "The recipient queue is full", 429);

      const id = identifier("tsk"),
        now = nowSeconds();
      const status =
        actor !== input.recipient_id &&
        (actor !== INSTANCE_ADMIN_ACTOR_ID || this.settings(input.recipient_id).require_task_approval)
          ? "approval"
          : "queued";
      this.db
        .prepare(
          "INSERT INTO tasks(id,actor_id,recipient_id,device_id,request_id,prompt,status,serial,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          actor,
          input.recipient_id,
          input.device_id,
          input.request_id,
          input.prompt,
          status,
          status === "queued" ? this.sequence() : null,
          now,
          now,
        );
      this.audit(id, actor, "submit", status);
      return this.get(id);
    });
  }

  decide(id: string, user: string, approve: boolean): TaskRow {
    return this.atomic(() => {
      const task = this.get(id);
      if (task.recipient_id !== user) throw new BridgeError("not_found", "Task not found", 404);
      if (task.status !== "approval")
        throw new BridgeError("task_decided", "The task no longer awaits approval", 409);
      if (approve && !this.eligible(task.device_id, user))
        throw new BridgeError("device_unavailable", "This device is no longer eligible", 409);
      const status = approve ? "queued" : "rejected";
      this.db
        .prepare("UPDATE tasks SET status=?,serial=?,updated_at=? WHERE id=?")
        .run(status, approve ? this.sequence() : null, nowSeconds(), id);
      this.audit(id, user, approve ? "approve" : "reject", status);
      return this.get(id);
    });
  }

  stop(id: string, actor: string | null, administrator = false): TaskRow {
    return this.atomic(() => {
      const task = administrator ? this.get(id) : this.forUser(id, actor!);
      if (!inStates(task.status, pending) || task.status === "stopping") return task;
      const status = inStates(task.status, active) ? "stopping" : "cancelled";
      this.db.prepare("UPDATE tasks SET status=?,updated_at=? WHERE id=?").run(status, nowSeconds(), id);
      this.audit(id, actor, administrator ? "admin_stop" : "stop", status);
      return this.get(id);
    });
  }

  claim(canRun: (deviceId: string) => boolean) {
    return this.atomic(() => {
      const candidates = this.db
        .prepare(
          `
        SELECT q.* FROM tasks q WHERE q.status='queued'
        AND NOT EXISTS(SELECT 1 FROM tasks l WHERE l.recipient_id=q.recipient_id AND l.lease_digest IS NOT NULL)
        ORDER BY q.serial
      `,
        )
        .all() as unknown as TaskRow[];
      const blocked = new Set<string>();
      for (const task of candidates) {
        if (blocked.has(task.recipient_id)) continue;
        if (!this.eligible(task.device_id, task.recipient_id)) {
          this.db
            .prepare("UPDATE tasks SET status='failed',error=?,updated_at=? WHERE id=?")
            .run("Device authorization is no longer available", nowSeconds(), task.id);
          this.audit(task.id, null, "device_unavailable", "failed");
          continue;
        }
        const otherSession = this.db
          .prepare(
            `
          SELECT 1 FROM control_sessions s JOIN devices d ON d.id=s.device_id
          WHERE d.owner_id=? AND d.platform='android' AND s.status='active' AND s.lease_until>? LIMIT 1
        `,
          )
          .get(task.recipient_id, nowSeconds());
        if (otherSession || !canRun(task.device_id)) {
          blocked.add(task.recipient_id);
          continue;
        }
        const leaseToken = randomBytes(32).toString("base64url"),
          connectionId = identifier("agt"),
          agentKey = secretKey("agent"),
          now = nowSeconds();
        const policy = {
          mode: "selected",
          devices: [{ device_id: task.device_id, capabilities: ["screen", "input"] }],
        };
        this.db
          .prepare("INSERT INTO agent_connections VALUES(?,?,?,?,?,?,NULL,?,NULL)")
          .run(
            connectionId,
            task.recipient_id,
            "Task " + task.id,
            JSON.stringify(policy),
            now + LEASE_SECONDS,
            digest(agentKey),
            now,
          );
        this.db
          .prepare(
            "UPDATE tasks SET status='running',lease_digest=?,lease_until=?,connection_id=?,updated_at=? WHERE id=?",
          )
          .run(digest(leaseToken), now + LEASE_SECONDS, connectionId, now, task.id);
        this.audit(task.id, null, "claim", "running");
        return {
          id: task.id,
          device_id: task.device_id,
          prompt: task.prompt,
          lease_token: leaseToken,
          agent_key: agentKey,
        };
      }
      return null;
    });
  }

  lease(id: string, token: string): TaskRow {
    const task = this.get(id);
    if ((task.lease_digest ?? task.finished_lease_digest) !== digest(token))
      throw new BridgeError("invalid_lease", "Task lease is not valid", 409);
    return task;
  }

  heartbeat(id: string, token: string): boolean {
    return this.atomic(() => {
      const task = this.lease(id, token);
      const now = nowSeconds();
      if (!inStates(task.status, active) || !task.lease_until || task.lease_until <= now) return true;
      this.db.prepare("UPDATE tasks SET lease_until=? WHERE id=?").run(now + LEASE_SECONDS, id);
      this.db
        .prepare("UPDATE agent_connections SET expires_at=? WHERE id=? AND revoked_at IS NULL")
        .run(now + LEASE_SECONDS, task.connection_id);
      return task.status === "stopping";
    });
  }

  event(id: string, token: string, value: Omit<TaskEvent, "created_at">): void {
    this.atomic(() => {
      const task = this.lease(id, token);
      if (!inStates(task.status, active))
        throw new BridgeError("invalid_lease", "Task is no longer active", 409);
      if (this.db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND sequence=?").get(id, value.sequence))
        return;
      const { image, ...event } = value;
      const image_ref = image ? this.images.save(id, image) : undefined;
      const now = nowSeconds();
      try {
        this.db
          .prepare("INSERT INTO task_events VALUES(?,?,?,?)")
          .run(id, event.sequence, JSON.stringify({ ...event, ...(image_ref ? { image_ref } : {}) }), now);
      } catch (error) {
        if (image_ref) this.images.remove(image_ref);
        throw error;
      }
      const status =
        task.status === "stopping" ? task.status : event.status === "waiting" ? "waiting" : "running";
      this.db.prepare("UPDATE tasks SET status=?,updated_at=? WHERE id=?").run(status, now, id);
    });
  }

  finish(id: string, token: string, input: TaskWorkerFinish, clean: boolean): void {
    this.atomic(() => {
      const task = this.lease(id, token);
      if (!task.lease_digest) return;
      const status =
        !clean || task.status === "unknown" || input.status === "unknown"
          ? "unknown"
          : task.status === "stopping"
            ? "stopped"
            : input.status;
      const error = clean
        ? (input.error ?? null)
        : "Control-session cleanup is unconfirmed; the recipient queue remains blocked";
      this.db
        .prepare(
          "UPDATE tasks SET status=?,result=?,error=?,updated_at=?,lease_digest=?,finished_lease_digest=?,lease_until=NULL WHERE id=?",
        )
        .run(
          status,
          status === "done" ? (input.result ?? null) : null,
          error,
          nowSeconds(),
          clean ? null : task.lease_digest,
          clean ? task.lease_digest : null,
          id,
        );
      this.audit(id, null, clean ? "finish" : "cleanup_unconfirmed", status);
    });
  }

  recordSession(connectionId: string, sessionId: string): void {
    this.db
      .prepare("INSERT INTO task_sessions(task_id,session_id) SELECT id,? FROM tasks WHERE connection_id=?")
      .run(sessionId, connectionId);
  }

  pendingSession(sessionId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM task_sessions WHERE session_id=? AND close_confirmed=0")
        .get(sessionId) !== undefined
    );
  }

  confirmSessionClosed(sessionId: string): void {
    this.db.prepare("UPDATE task_sessions SET close_confirmed=1 WHERE session_id=?").run(sessionId);
  }

  unconfirmedSessions(taskId: string): string[] {
    return (
      this.db
        .prepare("SELECT session_id FROM task_sessions WHERE task_id=? AND close_confirmed=0")
        .all(taskId) as { session_id: string }[]
    ).map((row) => row.session_id);
  }

  blockedTasks(): TaskRow[] {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE status='unknown' AND lease_digest IS NOT NULL ORDER BY updated_at LIMIT 100",
      )
      .all() as unknown as TaskRow[];
  }

  releaseAfterRecovery(id: string): void {
    this.atomic(() => {
      const task = this.get(id);
      const connection = this.db
        .prepare("SELECT revoked_at FROM agent_connections WHERE id=?")
        .get(task.connection_id);
      if (
        task.status !== "unknown" ||
        !task.lease_digest ||
        connection?.revoked_at == null ||
        this.unconfirmedSessions(id).length
      )
        return;
      this.db
        .prepare(
          "UPDATE tasks SET finished_lease_digest=lease_digest,lease_digest=NULL,updated_at=?,error=? WHERE id=?",
        )
        .run(
          nowSeconds(),
          "Worker did not confirm the outcome. Device cleanup completed and the queue can continue.",
          id,
        );
      this.audit(id, null, "cleanup_recovered", "unknown");
    });
  }

  scopedConnection(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM tasks WHERE connection_id=?").get(id) !== undefined;
  }
  assertRecipientAvailable(recipientId: string, connectionId: string): void {
    const task = this.db
      .prepare("SELECT connection_id FROM tasks WHERE recipient_id=? AND lease_digest IS NOT NULL")
      .get(recipientId);
    if (task && task.connection_id !== connectionId)
      throw new BridgeError("recipient_busy", "The Android device owner has a task in progress", 409);
  }

  assertDispatch(connection: string): void {
    const task = this.db
      .prepare("SELECT status, lease_until FROM tasks WHERE connection_id=?")
      .get(connection);
    if (!task) return;
    if (
      (task.status !== "running" && task.status !== "waiting") ||
      typeof task.lease_until !== "number" ||
      task.lease_until <= nowSeconds()
    )
      throw new BridgeError("task_stopped", "Task no longer permits new device operations", 409);
  }

  expire(restarted = false): string[] {
    return this.atomic(() => {
      const now = nowSeconds();
      const rows = this.db
        .prepare(
          `SELECT * FROM tasks WHERE lease_digest IS NOT NULL AND status IN ('running','waiting','stopping')
        AND (${restarted ? "1" : "lease_until<=?"})`,
        )
        .all(...(restarted ? [] : [now])) as unknown as TaskRow[];
      for (const task of rows) {
        this.db
          .prepare("UPDATE tasks SET status='unknown',lease_until=NULL,updated_at=?,error=? WHERE id=?")
          .run(
            now,
            "Worker disconnected before cleanup was confirmed; the recipient queue remains blocked",
            task.id,
          );
        this.audit(task.id, null, restarted ? "server_restart" : "lease_expired", "unknown");
      }
      return rows.flatMap((task) => (task.connection_id ? [task.connection_id] : []));
    });
  }
}
