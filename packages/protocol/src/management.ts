/** Public management responses shared by the Server and its management console. */
import { z } from "zod";
import {
  capabilitySchema,
  connectionPolicySchema,
  deviceKindSchema,
  deviceMetadataSchema,
  sessionInfoSchema,
  connectionLossSchema,
  deviceInteractionStateSchema,
  operationStateSchema,
} from "./common.js";

export const managementUserSchema = z.object({ id: z.string(), username: z.string() });
export type UserView = z.infer<typeof managementUserSchema>;

export const managedBrowserClaimsSchema = z.object({
  sub: z.string().min(1).max(160),
  iat: z.number().int().nonnegative(),
});
export const managedBrowserBindingSchema = z.object({
  installation_id: z.string().min(1).max(160),
  revision: z.number().int().positive(),
});
export const managedBrowserProvisionSchema = managedBrowserBindingSchema.extend({
  revision: z.number().int().nonnegative(),
  replace: z.boolean().default(false),
});
export const personalBrowserProvisionSchema = managedBrowserProvisionSchema.extend({
  name: z.string().trim().min(1).max(120).optional(),
});
export type BrowserEnrollmentScope = "managed" | "personal";
export type ManagedBrowserClaims = z.infer<typeof managedBrowserClaimsSchema>;
export type ManagedBrowserBinding = z.infer<typeof managedBrowserBindingSchema>;
export type ManagedBrowserProvision = z.infer<typeof managedBrowserProvisionSchema>;
export type PersonalBrowserProvision = z.infer<typeof personalBrowserProvisionSchema>;
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
  interaction_state: deviceInteractionStateSchema.optional(),
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

/** Groups organize people only; membership never authorizes a device or Agent connection. */
export const groupInputSchema = z.strictObject({ name: z.string().trim().min(1).max(120) });
export const adminGroupInputSchema = groupInputSchema.extend({ owner_id: z.string().min(1).max(160) });
export const groupMemberSchema = managementUserSchema.extend({
  role: z.enum(["owner", "member"]),
  joined_at: z.number(),
});
export const groupInviteSchema = z.object({
  id: z.string(),
  group_id: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  revoked_at: z.number().nullable(),
});
export const groupViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner_id: z.string(),
  created_at: z.number(),
  members: z.array(groupMemberSchema),
});
export const groupsListSchema = z.object({ groups: z.array(groupViewSchema) });
export const groupInvitesListSchema = z.object({ invites: z.array(groupInviteSchema) });
export const groupInviteIssueSchema = z.strictObject({
  expires_in_seconds: z.number().int().min(60).max(604800).default(86400),
});
export const groupInviteIssuedSchema = z.object({ invite: groupInviteSchema, code: z.string() });
export const groupJoinSchema = z.strictObject({ code: z.string().trim().min(1).max(128) });
export const usersListSchema = z.object({
  users: z.array(managementUserSchema.extend({ created_at: z.number() })),
});
export type GroupView = z.infer<typeof groupViewSchema>;
export type GroupMember = z.infer<typeof groupMemberSchema>;
export type GroupInvite = z.infer<typeof groupInviteSchema>;
export type GroupInviteIssued = z.infer<typeof groupInviteIssuedSchema>;
