import {
  connectionPolicySchema,
  deviceCapabilities,
  type Capability,
  type ConnectionPolicy,
} from "@abridge/protocol";
import { BridgeError, type Device, type Grant } from "./types.js";

/** Resolve account, device selection, type and capability limits in one place. */
export function deviceAccess(
  grant: Grant,
  device: Device,
): { access: "allowed" | "not_granted" | "no_capabilities"; capabilities: Capability[] } {
  if (device.owner_id !== grant.owner_id || device.revoked_at !== null)
    return { access: "not_granted", capabilities: [] };
  const policy = grant.policy;
  const entry = (policy.mode === "selected" ? policy.devices : policy.overrides).find(
    (item) => item.device_id === device.id,
  );
  if (policy.mode === "selected" && !entry) return { access: "not_granted", capabilities: [] };
  const requested = entry?.capabilities ?? (policy.mode === "all" ? policy.capabilities : []);
  const capabilities = requested
    .filter((cap) => device.capabilities.includes(cap) && deviceCapabilities(device.kind).includes(cap))
    .sort();
  return { access: capabilities.length ? "allowed" : "no_capabilities", capabilities };
}

export function validatePolicy(
  owner: string,
  input: ConnectionPolicy,
  lookup: (id: string) => Device | undefined,
): ConnectionPolicy {
  const policy = connectionPolicySchema.parse(input);
  for (const entry of policy.mode === "selected" ? policy.devices : policy.overrides) {
    const device = lookup(entry.device_id);
    if (!device || device.owner_id !== owner || device.revoked_at !== null)
      throw new BridgeError("not_found", "Selected device does not exist", 404);
    if (entry.capabilities.some((cap) => !deviceCapabilities(device.kind).includes(cap)))
      throw new BridgeError(
        "invalid_capabilities",
        "Capabilities do not match the selected device kind",
        422,
      );
  }
  return policy;
}
export function grantExpired(grant: Pick<Grant, "expires_at">, now: number): boolean {
  return grant.expires_at !== null && grant.expires_at <= now;
}
export function sessionDeadline(grant: Pick<Grant, "expires_at">, deadline: number): number {
  return grant.expires_at === null ? deadline : Math.min(deadline, grant.expires_at);
}
