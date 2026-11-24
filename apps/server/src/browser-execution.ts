import {
  operationErrorSchema,
  type BrowserStepFailure,
  type DeviceToolArguments,
  type OperationError,
} from "@abridge/protocol";
import { BrowserRuntime, BrowserRuntimeError, BrowserStepError } from "./browser-runtime.js";
import {
  BridgeError,
  object,
  type JsonObject,
  type OperationResponse,
  type OperationState,
} from "./types.js";

const STEP_TOOLS = {
  open: "browser_open",
  observe: "browser_observe",
  read: "browser_read",
  wait: "browser_wait",
  evaluate: "browser_evaluate",
  locate_act: "browser_locate_act",
} as const;
type StepMethod = keyof typeof STEP_TOOLS;
type StepTool = (typeof STEP_TOOLS)[StepMethod];

/** All child steps enter ControlService's normal authorization and operation admission. */
interface ExecutionOperations {
  identifyStep(key: string): string;
  executeStep(tool: StepTool, args: JsonObject, key: string, signal: AbortSignal): Promise<OperationResponse>;
  exists(id: string): boolean;
  receipt(id: string): OperationResponse | undefined;
  complete(status: OperationState, result?: unknown, error?: OperationError): void;
}
interface Execution {
  id: string;
  controller: AbortController;
  completedSteps: number;
  stepIndex: number;
  inFlightStep?: { operation_id: string; method: string };
  operations: ExecutionOperations;
}

/** Owns script scheduling and VM state, but never persists or publishes an operation result. */
export class BrowserExecutions {
  private readonly runtime = new BrowserRuntime();
  private readonly sessions = new Map<string, Execution>();
  private readonly executions = new Map<string, Execution>();

  owner(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.id;
  }
  cancel(operationId: string, reason: string): void {
    this.executions.get(operationId)?.controller.abort(new Error(reason));
  }
  closeSession(sessionId: string): void {
    this.runtime.close(sessionId);
  }
  closeAll(): void {
    this.runtime.closeAll();
  }
  /** Snapshot a confirmed child receipt before aborting; retain the lock until the VM settles. */
  end(operationId: string): JsonObject | undefined {
    const execution = this.executions.get(operationId);
    if (!execution) return undefined;
    const progress = this.progress(execution);
    execution.controller.abort(new Error("Browser execution ended"));
    return progress;
  }
  private pendingStep(execution: Execution): BrowserStepFailure | undefined {
    const step = execution.inFlightStep;
    if (!step) return undefined;
    if (!execution.operations.exists(step.operation_id))
      return {
        ...step,
        status: "refused",
        error: { code: "step_not_dispatched", message: "The step ended before device dispatch" },
      };
    return {
      ...step,
      status: "outcome_unknown",
      error: {
        code: "step_receipt_unconfirmed",
        message: "Execution ended before this step had a confirmed terminal receipt",
      },
    };
  }
  private progress(execution: Execution): JsonObject {
    const step = this.pendingStep(execution);
    const receipt = step ? execution.operations.receipt(step.operation_id) : undefined;
    // A receipt may arrive before the awaiting runtime resumes. Count it once,
    // and never describe an already confirmed step as an unknown side effect.
    return {
      steps_completed: execution.completedSteps + (receipt?.status === "executed" ? 1 : 0),
      ...(step && receipt?.status !== "executed"
        ? {
            failed_step: {
              ...step,
              status:
                receipt && ["refused", "failed", "cancelled"].includes(receipt.status)
                  ? receipt.status
                  : step.status,
              error: receipt?.error ?? step.error,
            },
          }
        : {}),
    };
  }
  start(
    operationId: string,
    sessionId: string,
    args: DeviceToolArguments<"browser_exec">,
    operations: ExecutionOperations,
  ): void {
    const execution: Execution = {
      id: operationId,
      controller: new AbortController(),
      completedSteps: 0,
      stepIndex: 0,
      operations,
    };
    this.sessions.set(sessionId, execution);
    this.executions.set(operationId, execution);
    const timeout = setTimeout(
      () => execution.controller.abort(new Error("Browser execution timed out")),
      args.timeout_ms,
    );
    void this.runtime
      .run(
        sessionId,
        args.code,
        (method, callArgs) => this.step(execution, method, callArgs),
        execution.controller.signal,
        () => this.pendingStep(execution),
      )
      .then(
        (result) => operations.complete("executed", result),
        (error: unknown) =>
          operations.complete(
            error instanceof BrowserRuntimeError ? error.status : "outcome_unknown",
            error instanceof BrowserRuntimeError ? error.result : undefined,
            {
              ...(error instanceof BrowserRuntimeError && object(error.result.failed_step)
                ? operationErrorSchema.parse(error.result.failed_step.error)
                : {}),
              code: error instanceof BrowserRuntimeError ? error.code : "browser_execution_failed",
              message:
                error instanceof Error
                  ? error.message
                  : "Browser execution failed; inspect the page before continuing",
            },
          ),
      )
      .finally(() => {
        clearTimeout(timeout);
        if (this.sessions.get(sessionId) === execution) this.sessions.delete(sessionId);
        if (this.executions.get(operationId) === execution) this.executions.delete(operationId);
      });
  }
  private async step(execution: Execution, method: string, args: JsonObject): Promise<unknown> {
    if (execution.controller.signal.aborted) throw new Error("Browser execution cancelled");
    if (!Object.hasOwn(STEP_TOOLS, method)) throw new Error("Unknown browser runtime method");
    const key = `step_${execution.id}_${++execution.stepIndex}`;
    const id = execution.operations.identifyStep(key);
    execution.inFlightStep = { operation_id: id, method };
    let response: OperationResponse;
    try {
      response = await execution.operations.executeStep(
        STEP_TOOLS[method as StepMethod],
        args,
        key,
        execution.controller.signal,
      );
    } catch (caught) {
      // Admission only creates a record after validation and authorization. An
      // existing record means delivery or a receipt may already be in flight.
      throw new BrowserStepError({
        operation_id: id,
        method,
        status: execution.operations.exists(id) ? "outcome_unknown" : "refused",
        error: {
          code: (caught instanceof BridgeError ? caught.code : "invalid_browser_step").slice(0, 100),
          message: (caught instanceof Error ? caught.message : String(caught)).slice(0, 2000),
        },
      });
    }
    execution.inFlightStep = undefined;
    if (response.status !== "executed")
      throw new BrowserStepError({
        operation_id: id,
        method,
        status: ["refused", "failed", "cancelled"].includes(response.status)
          ? (response.status as "refused" | "failed" | "cancelled")
          : "outcome_unknown",
        error: response.error ?? {
          code: "browser_step_failed",
          message: "Browser step did not complete",
        },
      });
    execution.completedSteps++;
    return response.result;
  }
}
