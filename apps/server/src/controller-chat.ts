import type { DatabaseSync } from "node:sqlite";
import {
  controllerMessageInputSchema,
  controllerTargetSchema,
  type ControllerMessage,
} from "@abridge/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { identifier } from "./store.js";
import type { TaskStore } from "./task-store.js";
import { BridgeError, nowSeconds, type User } from "./types.js";

interface ChatRow extends Omit<ControllerMessage, "status"> {
  cancelled: number;
  request_id: string;
}

const projection = `
  m.id,m.text,m.recipient_id,m.device_id,m.cancelled,m.request_id,m.created_at,
  max(m.updated_at,coalesce(t.created_at,0)) AS updated_at,t.id AS task_id
`;
const from = `FROM controller_messages m LEFT JOIN tasks t ON t.actor_id=m.owner_id AND t.request_id=m.id`;

export class ControllerChat {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tasks: TaskStore,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS controller_messages(
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
        text TEXT NOT NULL, recipient_id TEXT REFERENCES users(id), device_id TEXT REFERENCES devices(id),
        cancelled INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL,
        UNIQUE(owner_id,request_id)
      );
      CREATE INDEX IF NOT EXISTS controller_thread ON controller_messages(owner_id,created_at,id);
    `);
  }

  private view(row: ChatRow): ControllerMessage {
    const { cancelled, request_id: _, ...message } = row;
    return { ...message, status: row.task_id ? "confirmed" : cancelled ? "cancelled" : "draft" };
  }

  private get(userId: string, id: string): ChatRow {
    const row = this.db.prepare(`SELECT ${projection} ${from} WHERE m.owner_id=? AND m.id=?`).get(userId, id);
    if (!row) throw new BridgeError("not_found", "Chat message not found", 404);
    return row as unknown as ChatRow;
  }

  list(userId: string, before: string | undefined) {
    const anchor = before ? this.get(userId, before) : undefined;
    const rows = (anchor
      ? this.db
          .prepare(
            `SELECT ${projection} ${from} WHERE m.owner_id=? AND (m.created_at,m.id)<(?,?) ORDER BY m.created_at DESC,m.id DESC LIMIT 101`,
          )
          .all(userId, anchor.created_at, anchor.id)
      : this.db
          .prepare(
            `SELECT ${projection} ${from} WHERE m.owner_id=? ORDER BY m.created_at DESC,m.id DESC LIMIT 101`,
          )
          .all(userId)) as unknown as ChatRow[];
    return {
      messages: rows
        .slice(0, 100)
        .reverse()
        .map((row) => this.view(row)),
      has_more: rows.length > 100,
    };
  }

  create(userId: string, requestId: string, text: string): ControllerMessage {
    const previous = this.db
      .prepare("SELECT id,text FROM controller_messages WHERE owner_id=? AND request_id=?")
      .get(userId, requestId);
    if (previous) {
      if (previous.text !== text)
        throw new BridgeError("request_conflict", "Request ID already belongs to another message", 409);
      return this.view(this.get(userId, String(previous.id)));
    }
    const id = identifier("msg"),
      now = nowSeconds();
    this.db
      .prepare(
        "INSERT INTO controller_messages(id,owner_id,request_id,text,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, userId, requestId, text, now, now);
    return this.view(this.get(userId, id));
  }

  target(userId: string, id: string, recipient: string, device: string): ControllerMessage {
    const row = this.get(userId, id);
    if (row.cancelled || row.task_id) throw new BridgeError("draft_closed", "This proposal is closed", 409);
    if (!this.tasks.eligible(device, recipient))
      throw new BridgeError("not_found", "Eligible Android device not found", 404);
    this.db
      .prepare("UPDATE controller_messages SET recipient_id=?,device_id=?,updated_at=? WHERE id=?")
      .run(recipient, device, nowSeconds(), id);
    return this.view(this.get(userId, id));
  }

  cancel(userId: string, id: string): ControllerMessage {
    const row = this.get(userId, id);
    if (row.task_id) throw new BridgeError("draft_closed", "A task has already been created", 409);
    if (!row.cancelled)
      this.db
        .prepare("UPDATE controller_messages SET cancelled=1,updated_at=? WHERE id=?")
        .run(nowSeconds(), id);
    return this.view(this.get(userId, id));
  }

  confirm(userId: string, id: string) {
    const row = this.get(userId, id);
    if (row.cancelled) throw new BridgeError("draft_closed", "This proposal was cancelled", 409);
    if (!row.recipient_id || !row.device_id)
      throw new BridgeError(
        "target_required",
        "Confirm the recipient and target device before creating a task",
        422,
      );
    const task = row.task_id
      ? this.tasks.forUser(row.task_id, userId)
      : this.tasks.create(userId, {
          request_id: row.id,
          prompt: row.text,
          recipient_id: row.recipient_id,
          device_id: row.device_id,
        });
    // The proposal's confirmed state is derived from the idempotent task row.
    // A process exit immediately after task creation cannot leave a draft executable twice.
    return { message: this.view(this.get(userId, id)), task: this.tasks.view(task, true) };
  }
}

export function registerControllerChat(
  app: FastifyInstance,
  chat: ControllerChat,
  account: (request: FastifyRequest) => User,
  rateLimit: (request: FastifyRequest, scope: string, limit: number) => void,
): void {
  const prefix = "/api/controller/chat";
  const id = (request: FastifyRequest) => (request.params as { id: string }).id;
  app.get(prefix, async (request) => {
    const user = account(request);
    const query = request.query as { before?: unknown };
    if (query.before !== undefined && (typeof query.before !== "string" || query.before.length > 128))
      throw new BridgeError("invalid_input", "Expected a message ID", 422);
    return chat.list(user.id, query.before);
  });
  app.post(prefix, async (request) => {
    const user = account(request);
    rateLimit(request, "controller-message", 60);
    const body = controllerMessageInputSchema.parse(request.body);
    return { message: chat.create(user.id, body.request_id, body.text) };
  });
  app.patch(prefix + "/:id", async (request) => {
    const user = account(request);
    const body = controllerTargetSchema.parse(request.body);
    return { message: chat.target(user.id, id(request), body.recipient_id, body.device_id) };
  });
  app.post(prefix + "/:id/confirm", async (request) => {
    const user = account(request);
    rateLimit(request, "task-submit", 40);
    return chat.confirm(user.id, id(request));
  });
  app.post(prefix + "/:id/cancel", async (request) => ({
    message: chat.cancel(account(request).id, id(request)),
  }));
}
