import { Files, Monitor, MousePointer2, PanelsTopLeft, ScanEye, SquareTerminal } from "lucide-preact";
import type { Capability } from "@abridge/protocol";

const capabilityIcons = {
  screen: ScanEye,
  input: MousePointer2,
  shell: SquareTerminal,
  files: Files,
  browser: PanelsTopLeft,
};
export function CapabilityIcon({ capability }: { capability: Capability }) {
  const Icon = capabilityIcons[capability];
  return <Icon aria-hidden="true" />;
}

export const platformLabels = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  android: "Android",
  chrome: "Chrome",
} as const;
export function platformIcon(platform: string): keyof typeof platformLabels | undefined {
  switch (platform.trim().toLowerCase()) {
    case "darwin":
    case "macos":
    case "mac os":
    case "mac os x":
      return "macos";
    case "win32":
    case "windows":
      return "windows";
    case "linux":
      return "linux";
    case "android":
      return "android";
    case "chrome":
    case "google chrome":
      return "chrome";
    default:
      return undefined;
  }
}

export function DeviceIcon({
  kind,
  platform = "",
  describePlatform = false,
}: {
  kind: "computer" | "browser";
  platform?: string;
  describePlatform?: boolean;
}) {
  const brand = platformIcon(platform);
  return (
    <span
      class="device-icon"
      role={brand && describePlatform ? "img" : undefined}
      aria-label={brand && describePlatform ? platformLabels[brand] : undefined}
      aria-hidden={brand && describePlatform ? undefined : true}
    >
      {brand ? (
        <img src={`/static/icons/platforms/${brand}.svg`} alt="" />
      ) : kind === "browser" ? (
        <PanelsTopLeft />
      ) : (
        <Monitor />
      )}
    </span>
  );
}

export function platformName(value: string): string {
  return { darwin: "macOS", win32: "Windows", "Browser extension": "Chromium" }[value] ?? (value || "—");
}
