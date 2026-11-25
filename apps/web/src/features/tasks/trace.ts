import type { TaskEvent } from "@abridge/protocol";
export interface ExecutionStep {
  sequence: number;
  tool?: string;
  status: string;
  summary?: string;
  arguments?: string;
  receipt?: string;
  image?: string;
  created_at: number;
}
/** Fold the worker's decision/start/receipt/progress events into one visible tool call. */
export function executionSteps(events: readonly TaskEvent[]): ExecutionStep[] {
  const steps: ExecutionStep[] = [];
  let current: ExecutionStep | undefined;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const decision = event.status === "decision";
    const starts = event.status === "started";
    const attachesDecision = current?.status === "decision" && !current.tool && !!event.tool;
    const continues = current && event.tool === current.tool && !starts && !decision;
    if (attachesDecision || continues) {
      current!.tool = event.tool ?? current!.tool;
      current!.status = event.status;
      if (event.summary) current!.summary = [current!.summary, event.summary].filter(Boolean).join("\n");
      if (event.receipt) {
        if (starts) current!.arguments = event.receipt;
        else current!.receipt = event.receipt;
      }
      if (event.image) current!.image = event.image;
    } else {
      current = {
        sequence: event.sequence,
        tool: event.tool,
        status: event.status,
        summary: event.summary,
        created_at: event.created_at,
        ...(starts ? { arguments: event.receipt } : { receipt: event.receipt }),
        image: event.image,
      };
      steps.push(current);
    }
  }
  return steps;
}
