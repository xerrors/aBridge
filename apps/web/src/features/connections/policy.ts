import type { Capability } from "@abridge/protocol";
import type { Device, Grant } from "../../lib/api.js";

export function connectionCapabilities(grant: Grant, device: Device): Capability[] {
  const policy = grant.policy;
  const configured =
    policy.mode === "selected"
      ? (policy.devices.find((entry) => entry.device_id === device.id)?.capabilities ?? [])
      : (policy.overrides.find((entry) => entry.device_id === device.id)?.capabilities ??
        policy.capabilities);
  return device.capabilities.filter((cap) => configured.includes(cap));
}
