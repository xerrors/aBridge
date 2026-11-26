import { createHash, timingSafeEqual } from "node:crypto";
import {
  taskCreateSchema,
  controllerSettingsSchema,
  adminDeviceChatInputSchema,
  taskDecisionSchema,
  taskWorkerEventSchema,
  taskWorkerFinishSchema,
  taskWorkerLeaseSchema,
} from "@abridge/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ControlService } from "./control.js";
import type { Store } from "./store.js";
import { BridgeError, type User } from "./types.js";

interface TaskRouteContext {
  store: Store;
  control: ControlService;
  account: (request: FastifyRequest) => User;
  viewer: (request: FastifyRequest) => User | undefined;
  requireAdmin: (request: FastifyRequest) => void;
  rateLimit: (request: FastifyRequest, scope?: string, limit?: number) => void;
  workerKey: string | undefined;
}

export function registerTaskRoutes(app: FastifyInstance, context: TaskRouteContext): void {
  const { store, control, account, viewer, requireAdmin, rateLimit, workerKey } = context;
  const tasks = store.tasks;
  const taskId = (request: FastifyRequest) => (request.params as { id: string }).id;

  app.get("/api/controller/settings", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return tasks.settings(account(request).id);
  });
  app.put("/api/controller/settings", async (request, reply) => {
    const user = account(request);
    reply.header("Cache-Control", "no-store");
    return tasks.updateSettings(user.id, controllerSettingsSchema.parse(request.body));
  });

  app.get("/api/tasks", async (request) => ({ tasks: tasks.list(account(request).id) }));
  app.post("/api/tasks", async (request, reply) => {
    const user = account(request);
    rateLimit(request, "task-submit", 40);
    const input = taskCreateSchema.parse(request.body);
    if (input.request_id.startsWith("msg_"))
      throw new BridgeError("invalid_input", "Task request ID uses a reserved prefix", 422);
    const task = tasks.create(user.id, input);
    return reply.code(201).send({ task: tasks.view(task, true) });
  });
  app.get("/api/tasks/:id", async (request) => {
    const task = tasks.forUser(taskId(request), account(request).id);
    return { task: tasks.view(task, true), events: tasks.events(task.id), details_visible: true };
  });
  app.get("/api/tasks/:id/images/:name", async (request, reply) => {
    const task = tasks.get(taskId(request));
    const user = viewer(request);
    if (!user || !tasks.participant(task, user.id)) {
      requireAdmin(request);
      if (task.actor_id !== store.instanceAdminActor())
        throw new BridgeError("not_found", "Task image not found", 404);
    }
    const name = (request.params as { name: string }).name;
    return reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .type("image/jpeg")
      .send(tasks.image(task.id, name));
  });
  app.post("/api/tasks/:id/decision", async (request) => {
    const user = account(request);
    const task = tasks.decide(taskId(request), user.id, taskDecisionSchema.parse(request.body).approve);
    return { task: tasks.view(task, true) };
  });
  app.post("/api/tasks/:id/stop", async (request) => ({
    task: tasks.view(tasks.stop(taskId(request), account(request).id), true),
  }));

  const adminActor = () => store.instanceAdminActor();
  const chatDevice = (request: FastifyRequest) => {
    requireAdmin(request);
    const device = store.device(taskId(request));
    if (!device || !tasks.eligible(device.id, device.owner_id))
      throw new BridgeError("not_found", "Eligible Android device not found", 404);
    return device;
  };
  app.get("/api/admin/devices/:id/chat", async (request) => {
    const device = chatDevice(request);
    return { tasks: tasks.deviceConversation(adminActor(), device.id) };
  });
  app.post("/api/admin/devices/:id/chat", async (request, reply) => {
    const device = chatDevice(request);
    rateLimit(request, "task-submit", 40);
    const input = adminDeviceChatInputSchema.parse(request.body);
    const task = tasks.create(adminActor(), {
      ...input,
      device_id: device.id,
      recipient_id: device.owner_id,
    });
    return reply.code(201).send({ task: tasks.view(task, true) });
  });
  app.get("/api/admin/tasks", async (request) => {
    requireAdmin(request);
    const actor = adminActor();
    return {
      tasks: tasks
        .list(null, viewer(request)?.id ?? null)
        .map((task) => (task.actor_id === actor ? tasks.view(tasks.get(task.id), true) : task)),
    };
  });
  app.get("/api/admin/tasks/:id", async (request) => {
    requireAdmin(request);
    const task = tasks.get(taskId(request)),
      user = viewer(request);
    const visible = task.actor_id === adminActor() || (!!user && tasks.participant(task, user.id));
    return {
      task: tasks.view(task, visible),
      events: visible ? tasks.events(task.id) : [],
      details_visible: visible,
    };
  });
  app.post("/api/admin/tasks/:id/stop", async (request) => {
    requireAdmin(request);
    const user = viewer(request),
      task = tasks.stop(taskId(request), user?.id ?? null, true);
    return {
      task: tasks.view(task, task.actor_id === adminActor() || (!!user && tasks.participant(task, user.id))),
    };
  });
  app.get("/api/admin/task-audit", async (request) => {
    requireAdmin(request);
    return { entries: tasks.auditEntries() };
  });

  if (!workerKey) return;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  const expected = hash(workerKey);
  function worker(request: FastifyRequest): void {
    const value = request.headers.authorization ?? "";
    if (!value.startsWith("Bearer ") || !timingSafeEqual(hash(value.slice(7)), expected)) {
      rateLimit(request, "task-worker", 10);
      throw new BridgeError("worker_unauthorized", "Worker credential required", 401);
    }
  }
  async function revoke(id: string): Promise<void> {
    const connection = store.agentConnection(id);
    if (connection && connection.revoked_at === null) await control.revokeAgentConnection(connection);
  }

  const prefix = "/api/task-worker";
  app.post(prefix + "/claim", async (request) => {
    worker(request);
    return {
      task: tasks.claim((id) => {
        const device = store.device(id);
        return !!device && control.taskDeviceReady(device);
      }),
    };
  });
  app.post(prefix + "/:id/heartbeat", async (request) => {
    worker(request);
    return { stop: tasks.heartbeat(taskId(request), taskWorkerLeaseSchema.parse(request.body).lease_token) };
  });
  app.post(prefix + "/:id/events", async (request) => {
    worker(request);
    const { lease_token, ...event } = taskWorkerEventSchema.parse(request.body);
    tasks.event(taskId(request), lease_token, event);
    return { ok: true };
  });
  app.post(prefix + "/:id/finish", async (request) => {
    worker(request);
    const input = taskWorkerFinishSchema.parse(request.body);
    const id = taskId(request);
    const task = tasks.lease(id, input.lease_token);
    if (!task.lease_digest) return { ok: true };
    const clean =
      input.cleanup_confirmed &&
      (!task.connection_id ||
        (store.agentConnectionSessions(task.connection_id).length === 0 &&
          tasks.unconfirmedSessions(id).length === 0));
    if (task.connection_id) await revoke(task.connection_id);
    tasks.finish(id, input.lease_token, input, clean);
    return { ok: true };
  });

  let timer: ReturnType<typeof setInterval> | undefined;
  let recovery: Promise<void> | undefined;
  async function recover(): Promise<void> {
    await Promise.allSettled(tasks.expire().map(revoke));
    await Promise.allSettled(
      tasks.blockedTasks().map(async (task) => {
        if (task.connection_id) await revoke(task.connection_id);
        await Promise.all(
          tasks
            .unconfirmedSessions(task.id)
            .map((session) => control.confirmTaskSessionClosed(task.device_id, session)),
        );
        tasks.releaseAfterRecovery(task.id);
      }),
    );
  }
  app.addHook("onReady", async () => {
    timer = setInterval(() => {
      recovery ??= recover()
        .catch((error) => console.error("Task lease recovery failed", error))
        .finally(() => {
          recovery = undefined;
        });
    }, 2000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await recovery;
  });
}
