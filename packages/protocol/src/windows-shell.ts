import { z } from "zod";

// Native UI messages carry UI intent only; device authorization stays in the TS runtime.
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const empty = z.object({}).strict();
const capability = z.enum(["screen", "input", "shell", "files"]);
export const windowsShellRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      id,
      action: z.literal("rename"),
      args: z.object({ name: z.string().trim().min(1).max(120) }).strict(),
    })
    .strict(),
  z
    .object({
      id,
      action: z.literal("capability"),
      args: z.object({ capability, enabled: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      id,
      action: z.literal("bind"),
      args: z
        .object({
          url: z.string().min(1).max(8192),
          device_key: z.string().min(1).max(8192).optional(),
          http_confirmed_origin: z.string().max(8192).optional(),
          capabilities: z.partialRecord(capability, z.boolean()),
        })
        .strict(),
    })
    .strict(),
  ...(["status", "connect", "pause", "resume", "stop", "unbind", "cancel", "quit"] as const).map((action) =>
    z.object({ id, action: z.literal(action), args: empty }).strict(),
  ),
]);
export type WindowsShellRequest = z.infer<typeof windowsShellRequestSchema>;
