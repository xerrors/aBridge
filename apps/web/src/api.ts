import { z } from "zod";
import { capabilitySchema, connectionPolicySchema } from "@abridge/protocol";
export const userSchema = z.object({ id: z.string(), username: z.string() });
export const deviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["computer", "browser"]),
  capabilities: z.array(capabilitySchema),
  status: z.string(),
  paused: z.boolean().optional(),
  platform: z.string().default(""),
  available: z.record(z.string(), z.boolean()).optional(),
  active_operations: z.array(z.string()).default([]),
});
export const grantSchema = z.object({
  authentication: z.enum(["key", "platform"]).default("key"),
  can_reconnect: z.boolean().default(false),
  id: z.string(),
  name: z.string(),
  policy: connectionPolicySchema,
  expires_at: z.number().nullable(),
  revoked_at: z.number().nullable(),
});
export const connectionPreviewSchema = z.object({
  connection: z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(["active", "expired", "revoked"]),
    expires_at: z.number().nullable(),
  }),
  devices: z.array(
    deviceSchema.extend({
      access: z.enum(["allowed", "not_granted", "no_capabilities"]),
      granted_capabilities: z.array(capabilitySchema),
    }),
  ),
});
export type ConnectionPreview = z.infer<typeof connectionPreviewSchema>;
export const operationSchema = z.object({
  id: z.string(),
  device_id: z.string(),
  grant_id: z.string(),
  tool: z.string(),
  status: z.string(),
  created_at: z.number(),
});
export type User = z.infer<typeof userSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type Grant = z.infer<typeof grantSchema>;
export type Operation = z.infer<typeof operationSchema>;
export const activitySchema = z.object({
  operations: z.array(operationSchema),
  total: z.number(),
  tools: z.array(z.string()),
});
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  data?: unknown,
  method = data === undefined ? "GET" : "POST",
  token?: string,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const parsed = z
      .object({ error: z.object({ message: z.string(), code: z.string().optional() }) })
      .safeParse(result);
    throw new ApiError(
      parsed.success ? parsed.data.error.message : `请求失败 (${response.status})`,
      response.status,
      parsed.success ? parsed.data.error.code : undefined,
    );
  }
  return schema.parse(result);
}
export const objectResultSchema = z.record(z.string(), z.unknown());
export async function loadData() {
  const [d, g] = await Promise.all([
    api("/api/devices", z.object({ devices: z.array(deviceSchema) })),
    api("/api/client-grants", z.object({ grants: z.array(grantSchema) })),
  ]);
  return { devices: d.devices, grants: g.grants };
}
