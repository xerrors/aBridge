import { browserStepFailureSchema, type BrowserStepFailure } from "@abridge/protocol";
import { setTimeout as sleep } from "node:timers/promises";
import { getQuickJS, type QuickJSDeferredPromise } from "quickjs-emscripten";

type BrowserCall = (method: string, args: Record<string, unknown>) => Promise<unknown>;
type JsonObject = Record<string, unknown>;
const MAX_BYTES = 1024 * 1024;
const MAX_STEPS = 1000;
const METHODS = new Set(["open", "observe", "read", "wait", "evaluate", "locate_act", "sleep"]);

export class BrowserStepError extends Error {
  readonly failure: BrowserStepFailure;
  constructor(failure: BrowserStepFailure) {
    super(failure.error.message);
    this.failure = browserStepFailureSchema.parse(failure);
  }
}

export class BrowserRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly result: JsonObject,
    readonly status: "refused" | "failed" | "outcome_unknown" | "cancelled" = "failed",
  ) {
    super(message.slice(0, 2000));
  }
}

/** QuickJS exposes only JSON RPC to the session's browser, never Node globals. */
export class BrowserRuntime {
  private readonly states = new Map<string, string>();
  private readonly active = new Map<string, AbortController>();

  close(sessionId: string): void {
    this.active.get(sessionId)?.abort();
    this.states.delete(sessionId);
  }

  closeAll(): void {
    for (const controller of this.active.values()) controller.abort();
    this.states.clear();
  }

  async run(
    sessionId: string,
    code: string,
    call: BrowserCall,
    signal: AbortSignal,
    currentStep?: () => BrowserStepFailure | undefined,
  ): Promise<JsonObject> {
    if (this.active.has(sessionId))
      throw new BrowserRuntimeError("session_busy", "Browser code is already running", {}, "refused");
    if (Buffer.byteLength(code, "utf8") > 65536)
      throw new BrowserRuntimeError("invalid_code", "Code exceeds 65536 bytes", {}, "refused");
    if (signal.aborted)
      throw new BrowserRuntimeError("operation_cancelled", "Browser code cancelled", {}, "cancelled");
    if (!this.states.has(sessionId) && this.states.size >= 64)
      throw new BrowserRuntimeError(
        "runtime_full",
        "Close an idle browser session before starting another",
        {},
        "refused",
      );
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let QuickJS;
    try {
      QuickJS = await getQuickJS();
      if (controller.signal.aborted)
        throw new BrowserRuntimeError(
          "operation_cancelled",
          "Browser code cancelled during initialization",
          {},
          "cancelled",
        );
    } catch (error) {
      signal.removeEventListener("abort", abort);
      this.active.delete(sessionId);
      throw error;
    }
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(16 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    let cpuDeadline = Date.now() + 250;
    runtime.setInterruptHandler(() => controller.signal.aborted || Date.now() >= cpuDeadline);
    const vm = runtime.newContext();
    const deferred = new Set<QuickJSDeferredPromise>();
    let steps = 0;
    let pendingCalls = 0;
    let inFlight = false;
    let uncertain = false;
    let failedStep: BrowserStepFailure | undefined;
    let stopped = false;
    let fatal: Error | undefined;
    let queue = Promise.resolve();
    const rpc = vm.newFunction("__rpc", (requestHandle) => {
      const promise = vm.newPromise();
      deferred.add(promise);
      let request: { method: string; args: JsonObject };
      try {
        const text = vm.getString(requestHandle);
        if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("Browser request exceeds one MiB");
        request = JSON.parse(text) as typeof request;
        if (!METHODS.has(request.method) || !request.args || typeof request.args !== "object")
          throw new Error("Unsupported browser method");
      } catch (error) {
        const handle = vm.newError(String(error));
        promise.reject(handle);
        handle.dispose();
        return promise.handle;
      }
      pendingCalls++;
      queue = queue.then(async () => {
        if (stopped || controller.signal.aborted || fatal) return;
        try {
          if (steps >= MAX_STEPS) throw new Error("Browser execution exceeds 1000 steps");
          let value: unknown;
          if (request.method === "sleep") {
            const ms = request.args.ms;
            if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0 || ms > 10000)
              throw new Error("page.sleep requires an integer from 0 to 10000 milliseconds");
            await sleep(ms, undefined, { signal: controller.signal });
          } else {
            inFlight = true;
            try {
              value = await call(request.method, request.args);
              steps++;
            } catch (error) {
              if (error instanceof BrowserStepError) {
                failedStep = error.failure;
                uncertain = failedStep.status === "outcome_unknown";
              } else uncertain = true;
              throw error;
            } finally {
              inFlight = false;
            }
          }
          if (stopped || controller.signal.aborted) return;
          const json = JSON.stringify(value ?? null);
          if (Buffer.byteLength(json, "utf8") > MAX_BYTES) throw new Error("Browser result exceeds one MiB");
          const handle = vm.newString(json);
          promise.resolve(handle);
          handle.dispose();
          pendingCalls--;
        } catch (error) {
          fatal = error instanceof Error ? error : new Error(String(error));
          if (!stopped && !controller.signal.aborted) {
            const handle = vm.newError(fatal.message);
            promise.reject(handle);
            handle.dispose();
          }
        }
      });
      return promise.handle;
    });
    vm.setProp(vm.global, "__rpc", rpc);
    rpc.dispose();
    const source = `
      (async () => {
        const invoke = async (method, args = {}) => JSON.parse(await __rpc(JSON.stringify({method,args})));
        const state = JSON.parse(${JSON.stringify(this.states.get(sessionId) ?? "{}")});
        const output = [];
        let outputChars = 0;
        const log = (...items) => {
          if (output.length >= 100 || outputChars >= 12000) return;
          const text = items.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ').slice(0, 12000-outputChars);
          outputChars += text.length; output.push(text);
        };
        const console = Object.freeze({log, info:log, warn:log, error:log});
        const scope = frame_selector => {
          const scoped = args => frame_selector === undefined ? args : {...args,frame_selector};
          const locator = selector => {
            const act = (action, {verify, ...options} = {}) => invoke('locate_act', scoped({
              selector, action:{...options,...action}, ...(verify === undefined ? {} : {verify:verify?.frame_selector === undefined ? scoped(verify) : verify})
            }));
            const actions = {
              click: options => act({type:'click'},options),
              fill: (text, options) => act({type:'fill',text},options),
              press: (key, options) => act({type:'press',key},options),
              select: (values, options) => act({type:'select',values:Array.isArray(values)?values:[values]},options),
              hover: options => act({type:'hover'},options),
              scroll: (delta_y, delta_x = 0, options) => act({type:'scroll',delta_x,delta_y},options)
            };
            if (typeof selector !== 'string') return Object.freeze(actions);
            return Object.freeze({...actions,
              read: (options = {}) => invoke('read',scoped({...options,selector})),
              waitFor: (options = {}) => invoke('wait',scoped({...options,selector}))
            });
          };
          return Object.freeze({
            read: (options = {}) => invoke('read',scoped(options)),
            wait: (options = {}) => invoke('wait',scoped(options)),
            evaluate: async (expression, arg) => {
              const source = typeof expression === 'function' ? '('+expression.toString()+')('+JSON.stringify(arg ?? null)+')' : expression;
              return (await invoke('evaluate',scoped({expression:source}))).value;
            },
            locator
          });
        };
        const page = Object.freeze({
          ...scope(undefined),
          sleep: ms => invoke('sleep',{ms}),
          goto: url => invoke('open',{url}),
          observe: (options = {}) => invoke('observe',options),
          frameLocator: selector => scope(selector)
        });
        try {
          const value = await (async () => {${code}\n})();
          return JSON.stringify({ok:true,value:value ?? null,state,output});
        } catch (error) {
          return JSON.stringify({ok:false,error:String(error && error.message || error),state,output});
        }
      })()
    `;
    let promiseHandle;
    let output: unknown[] = [];
    const deadline = Date.now() + 120000;
    try {
      cpuDeadline = Date.now() + 250;
      promiseHandle = vm.unwrapResult(vm.evalCode(source, "browser-exec.js"));
      for (;;) {
        if (fatal && (!controller.signal.aborted || fatal instanceof BrowserStepError)) throw fatal;
        if (controller.signal.aborted) {
          failedStep ??= currentStep?.();
          throw new BrowserRuntimeError(
            "operation_cancelled",
            controller.signal.reason instanceof Error && controller.signal.reason.name !== "AbortError"
              ? controller.signal.reason.message
              : "Browser code cancelled; inspect completed steps",
            {
              steps_completed: steps,
              output,
              ...(failedStep ? { failed_step: failedStep } : {}),
            },
            inFlight || uncertain ? "outcome_unknown" : "cancelled",
          );
        }
        if (Date.now() > deadline) throw new Error("Browser execution exceeded 120 seconds");
        cpuDeadline = Date.now() + 250;
        const jobs = runtime.executePendingJobs(100);
        if (jobs.error) {
          const message = vm.dump(jobs.error) as { message?: string };
          jobs.error.dispose();
          throw new Error(message?.message ?? "Browser code interrupted");
        }
        const settled = vm.getPromiseState(promiseHandle);
        if (settled.type === "rejected") {
          const message = vm.dump(settled.error) as { message?: string };
          settled.error.dispose();
          throw new Error(message?.message ?? "Browser code failed");
        }
        if (settled.type === "fulfilled") {
          const json = vm.getString(settled.value);
          settled.value.dispose();
          if (Buffer.byteLength(json, "utf8") > MAX_BYTES)
            throw new Error("Code result/state exceeds one MiB");
          const result = JSON.parse(json) as {
            ok: boolean;
            value?: unknown;
            state: unknown;
            output: unknown[];
            error?: string;
          };
          output = result.output;
          const state = JSON.stringify(result.state);
          if (!state || Buffer.byteLength(state, "utf8") > MAX_BYTES)
            throw new Error("State exceeds one MiB");
          if (!controller.signal.aborted) this.states.set(sessionId, state);
          if (fatal) throw fatal;
          if (!result.ok) throw new Error(result.error ?? "Browser code failed");
          if (pendingCalls) throw new Error("Await every browser operation before returning");
          const valueText = JSON.stringify(result.value ?? null);
          return {
            ...(valueText.length <= 24000
              ? { value: result.value ?? null }
              : { value: null, value_truncated: true, value_preview: valueText.slice(0, 24000) }),
            output,
            steps_completed: steps,
          };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    } catch (error) {
      if (error instanceof BrowserRuntimeError) throw error;
      const code = failedStep?.error.code ?? "browser_code_failed";
      const message = failedStep?.error.message ?? (error instanceof Error ? error.message : String(error));
      if (inFlight) failedStep ??= currentStep?.();
      throw new BrowserRuntimeError(
        code,
        message,
        {
          steps_completed: steps,
          output,
          ...(failedStep ? { failed_step: failedStep } : {}),
        },
        inFlight || uncertain ? "outcome_unknown" : failedStep && steps === 0 ? failedStep.status : "failed",
      );
    } finally {
      stopped = true;
      controller.abort();
      // Late browser replies only see stopped=true; no subsequent RPC or VM
      // access is allowed. The control layer cancels any already dispatched work.
      promiseHandle?.dispose();
      for (const promise of deferred) if (promise.alive) promise.dispose();
      vm.dispose();
      runtime.dispose();
      signal.removeEventListener("abort", abort);
      this.active.delete(sessionId);
    }
  }
}
