import { platformName } from "../../components/icons.js";
import type { Device } from "../../lib/types.js";

export function deviceTypeLabel(device: { kind: "computer" | "browser"; platform?: string | null }): string {
  if (device.kind === "browser") return "浏览器";
  const platform = device.platform?.trim();
  return platform ? platformName(platform) : "本机设备";
}

const systemNames = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
  chromeos: "ChromeOS",
  android: "Android",
  openbsd: "OpenBSD",
  fuchsia: "Fuchsia",
};

export function systemLabel(device: Device): string | undefined {
  const details = device.details;
  if (!details?.os) return undefined;
  const name = details.os === "linux" ? (details.distribution ?? "Linux") : systemNames[details.os];
  return [name, details.os_version].filter(Boolean).join(" ");
}

export function browserLabel(device: Device): string | undefined {
  const details = device.details;
  if (!details?.browser_name) return undefined;
  return [details.browser_name, details.browser_version].filter(Boolean).join(" ");
}

export function deviceSummary(device: Device): string {
  const system = systemLabel(device);
  const identity =
    device.kind === "browser" ? (browserLabel(device) ?? platformName(device.platform)) : undefined;
  return [
    identity,
    system ?? (!identity ? platformName(device.platform) : undefined),
    device.details?.architecture,
  ]
    .filter(Boolean)
    .join(" · ");
}
