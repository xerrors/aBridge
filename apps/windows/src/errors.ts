export class DesktopError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: "refused" | "failed" | "outcome_unknown" = "refused",
  ) {
    super(message);
    this.name = "DesktopError";
  }
}
export function invalid(message: string): never {
  throw new DesktopError("invalid_arguments", message);
}
export function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value || value.includes("\0"))
    invalid(`${name} must be a non-empty string`);
  return value;
}
export function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    invalid(`${name} must be between ${min} and ${max}`);
  return value;
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
