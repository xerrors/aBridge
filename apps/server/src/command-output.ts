import { BridgeError, object, type JsonObject, type OperationResponse } from "./types.js";

/** Offsets and budgets count Unicode code points, matching the existing wire contract. */
export const characterLength = (value: string): number => Array.from(value).length;
const jsonLength = (value: unknown): number => characterLength(JSON.stringify(value));
function prefix(value: string, fits: (value: string) => boolean): string {
  const points = Array.from(value);
  let low = 0,
    high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (fits(points.slice(0, middle).join(""))) low = middle;
    else high = middle - 1;
  }
  return points.slice(0, low).join("");
}
function within(value: unknown, limit: number): void {
  if (jsonLength(value) > limit)
    throw new BridgeError(
      "output_budget",
      "Output metadata exceeds the budget; increase output_limit_chars and read command_status",
      422,
    );
}

export function commandOutputPage(
  response: OperationResponse,
  limit = 6000,
  stdoutOffset = 0,
  stderrOffset = 0,
): JsonObject {
  if (
    !Number.isInteger(limit) ||
    limit < 1024 ||
    limit > 12000 ||
    ![stdoutOffset, stderrOffset].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    throw new BridgeError("invalid_arguments", "Invalid output budget or offset", 422);
  const key = ["result", "output"].find(
    (key) =>
      object(response[key]) &&
      ["stdout", "stderr"].some((stream) => typeof (response[key] as JsonObject)[stream] === "string"),
  );
  if (!key) {
    within(response, limit);
    return { ...response };
  }
  const source = response[key] as JsonObject;
  const base = key === "output" && object(response.output_start_offsets) ? response.output_start_offsets : {};
  const streams = ["stdout", "stderr"] as const;
  const starts = {
    stdout: Math.max(stdoutOffset, Number(base.stdout ?? 0)),
    stderr: Math.max(stderrOffset, Number(base.stderr ?? 0)),
  };
  const remaining = Object.fromEntries(
    streams.map((name) => [
      name,
      Array.from(typeof source[name] === "string" ? source[name] : "")
        .slice(starts[name] - Number(base[name] ?? 0))
        .join(""),
    ]),
  ) as Record<(typeof streams)[number], string>;
  const common = { ...response };
  delete common.output_start_offsets;
  const captureTruncated = key === "result" ? !!source.truncated : null;
  if (key === "result" && stdoutOffset === 0 && stderrOffset === 0) {
    const complete = { ...common, output_truncated: false, capture_truncated: captureTruncated };
    if (jsonLength(complete) <= limit) return complete;
  }
  const page = (stdout: string, stderr: string): JsonObject => {
    const chunks = { stdout, stderr };
    const result: JsonObject = {
      ...common,
      [key]: { ...source, ...chunks },
      output_offsets: { stdout_offset: starts.stdout, stderr_offset: starts.stderr },
      next_output_offsets: {
        stdout_offset: starts.stdout + characterLength(stdout),
        stderr_offset: starts.stderr + characterLength(stderr),
      },
      output_truncated: streams.some(
        (name) => characterLength(chunks[name]) < characterLength(remaining[name]),
      ),
      capture_truncated: captureTruncated,
    };
    if (Object.values(base).some((value) => typeof value === "number" && value > 0))
      result.output_unavailable_before = Object.fromEntries(
        streams.filter((name) => Number(base[name] ?? 0) > 0).map((name) => [name + "_offset", base[name]]),
      );
    return result;
  };
  const empty = page("", "");
  within(empty, limit);
  const available = limit - jsonLength(empty);
  let stderr = prefix(remaining.stderr, (text) => jsonLength(text) - 2 <= Math.floor(available / 3));
  const stdout = prefix(remaining.stdout, (text) => jsonLength(page(text, stderr)) <= limit);
  stderr = prefix(remaining.stderr, (text) => jsonLength(page(stdout, text)) <= limit);
  const result = page(stdout, stderr);
  within(result, limit);
  if (result.output_truncated && !stdout && !stderr)
    throw new BridgeError("output_budget", "Increase output_limit_chars to leave space for output", 422);
  return result;
}
