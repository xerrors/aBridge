import { z } from "zod";

const id = z.string().min(1).max(128);
export const taskStatusSchema = z.enum([
  "approval",
  "queued",
  "running",
  "waiting",
  "stopping",
  "done",
  "rejected",
  "cancelled",
  "stopped",
  "failed",
  "unknown",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export const taskViewSchema = z.object({
  id,
  actor_id: id,
  recipient_id: id,
  device_id: id,
  prompt: z.string().nullable(),
  status: taskStatusSchema,
  created_at: z.number(),
  updated_at: z.number(),
  queue_blocked: z.boolean(),
  queue_position: z.number().int().positive().nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
});
export type TaskView = z.infer<typeof taskViewSchema>;
export const taskEventSchema = z.object({
  sequence: z.number().int().min(1).max(2500),
  tool: z.string().max(120).optional(),
  status: z.string().min(1).max(80),
  summary: z.string().max(3000).optional(),
  receipt: z.string().max(6000).optional(),
  image: z
    .string()
    .max(750_000)
    .regex(
      /^(?:data:image\/(?:png|jpeg|webp);base64,[\w+/]+={0,2}|\/api\/tasks\/[a-zA-Z0-9_-]+\/images\/[a-f0-9]{32}\.jpg)$/,
    )
    .optional(),
  created_at: z.number(),
});
export type TaskEvent = z.infer<typeof taskEventSchema>;
export const taskAuditEntrySchema = z.object({
  id,
  task_id: id,
  actor_id: id.nullable(),
  action: z.string(),
  outcome: taskStatusSchema,
  created_at: z.number(),
});
export type TaskAuditEntry = z.infer<typeof taskAuditEntrySchema>;
export const taskListSchema = z.object({ tasks: z.array(taskViewSchema) });
export const taskDetailSchema = z.object({
  task: taskViewSchema,
  events: z.array(taskEventSchema),
  details_visible: z.boolean(),
});
export const taskAuditListSchema = z.object({ entries: z.array(taskAuditEntrySchema) });
export const taskCreateSchema = z
  .object({
    request_id: id,
    recipient_id: id,
    device_id: id,
    prompt: z.string().trim().min(1).max(4000),
  })
  .strict();
export const adminDeviceChatInputSchema = taskCreateSchema.pick({ request_id: true, prompt: true });
export const taskDecisionSchema = z.object({ approve: z.boolean() }).strict();
export const taskWorkerLeaseSchema = z.object({ lease_token: z.string().min(32).max(128) }).strict();
export const taskWorkerEventSchema = taskEventSchema
  .omit({ created_at: true })
  .extend({
    ...taskWorkerLeaseSchema.shape,
    image: z
      .string()
      .max(750_000)
      .regex(/^data:image\/(png|jpeg|webp);base64,[\w+/]+={0,2}$/)
      .optional(),
  })
  .strict();
export const taskWorkerFinishSchema = taskWorkerLeaseSchema
  .extend({
    status: z.enum(["done", "failed", "stopped", "unknown"]),
    result: z.string().max(6000).optional(),
    error: z.string().max(3000).optional(),
    cleanup_confirmed: z.boolean(),
  })
  .strict();
export type TaskCreate = z.infer<typeof taskCreateSchema>;
export type TaskWorkerFinish = z.infer<typeof taskWorkerFinishSchema>;

export const taskSessionClosedSchema = z
  .object({
    type: z.literal("session_closed"),
    session_id: z.string().regex(/^ses_[A-Za-z0-9_-]{8}$/),
    connection_epoch: z.number().int().positive(),
  })
  .strict();

export const controllerMessageSchema = z.object({
  id,
  text: z.string(),
  recipient_id: id.nullable(),
  device_id: id.nullable(),
  status: z.enum(["draft", "confirmed", "cancelled"]),
  task_id: id.nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type ControllerMessage = z.infer<typeof controllerMessageSchema>;
export const controllerChatSchema = z.object({
  messages: z.array(controllerMessageSchema),
  has_more: z.boolean(),
});
export const controllerMessageInputSchema = z
  .object({
    request_id: id,
    text: z.string().trim().min(1).max(4000),
  })
  .strict();
export const controllerTargetSchema = z.object({ recipient_id: id, device_id: id }).strict();

export const controllerSettingsSchema = z.object({ require_task_approval: z.boolean() }).strict();
export type ControllerSettings = z.infer<typeof controllerSettingsSchema>;
