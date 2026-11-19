/** Public management responses shared by the Server and its management console. */
import { z } from "zod";
import {
  capabilitySchema,
  connectionPolicySchema,
  deviceKindSchema,
  deviceMetadataSchema,
  sessionInfoSchema,
  connectionLossSchema,
  operationStateSchema,
} from "./common.js";

export const managementUserSchema = z.object({ id: z.string(), username: z.string() });
export type UserView = z.infer<typeof managementUserSchema>;

export const managedBrowserClaimsSchema = z.object({
  sub: z.string().min(1).max(160),
  sandbox_id: z.string().min(1).max(160),
  generation: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(100).optional(),
  user_kind: z.enum(["human", "end_user"]).optional(),
  iat: z.number().int().nonnegative(),
});
export type ManagedBrowserClaims = z.infer<typeof managedBrowserClaimsSchema>;
export const managedBrowserRedeemSchema = z.strictObject({
  device_id: z.string().min(1).max(160),
  bootstrap_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const deviceViewSchema = deviceMetadataSchema.extend({
  id: z.string(),
  name: z.string(),
  owner_name: z.string().optional(),
  kind: deviceKindSchema,
  capabilities: z.array(capabilitySchema),
  status: z.enum(["online", "offline", "revoked"]),
  paused: z.boolean(),
  available: z.record(z.string(), z.boolean()),
  available_tools: z.array(z.string()).optional(),
  active_operations: z.array(z.string()),
  last_seen: z.number().nullable(),
  created_at: z.number(),
  sessions: z.array(sessionInfoSchema).optional(),
  last_disconnect: connectionLossSchema.optional(),
});
export type DeviceView = z.infer<typeof deviceViewSchema>;

export const agentConnectionViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  policy: connectionPolicySchema,
  authentication: z.enum(["key", "platform"]),
  can_reconnect: z.boolean().default(false),
  expires_at: z.number().nullable(),
  revoked_at: z.number().nullable(),
  created_at: z.number(),
  last_used: z.number().nullable(),
});
export type AgentConnectionView = z.infer<typeof agentConnectionViewSchema>;

export const connectionPreviewSchema = z.object({
  connection: z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(["active", "expired", "revoked"]),
    expires_at: z.number().nullable(),
  }),
  devices: z.array(
    deviceViewSchema.extend({
      access: z.enum(["allowed", "not_granted", "no_capabilities"]),
      granted_capabilities: z.array(capabilitySchema),
    }),
  ),
});
export type ConnectionPreview = z.infer<typeof connectionPreviewSchema>;

export const operationSummarySchema = z.object({
  id: z.string(),
  device_id: z.string(),
  agent_connection_id: z.string(),
  tool: z.string(),
  status: operationStateSchema,
  created_at: z.number(),
});
export type OperationSummary = z.infer<typeof operationSummarySchema>;

export const activitySchema = z.object({
  operations: z.array(operationSummarySchema),
  total: z.number().int().nonnegative(),
  tools: z.array(z.string()),
});
export type Activity = z.infer<typeof activitySchema>;

export const devicesListSchema = z.object({ devices: z.array(deviceViewSchema) });
export const agentConnectionsListSchema = z.object({ connections: z.array(agentConnectionViewSchema) });

export const agentConnectionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    policy: connectionPolicySchema,
    expires_at: z.number().finite().nullable().default(null),
  })
  .strict();
export type AgentConnectionInput = z.infer<typeof agentConnectionInputSchema>;

export const activityFilterSchema = z
  .object({
    device_id: z.string().min(1).max(120).optional(),
    agent_connection_id: z.string().min(1).max(120).optional(),
    tool: z.string().min(1).max(120).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();
export type ActivityFilter = z.infer<typeof activityFilterSchema>;
