import {
  TaskTabs,
  readBudget,
  missingTaskTab,
  diagnostic,
  webURL,
  type TaskTab,
  type CdpResults,
} from "./task-tabs.js";
import {
  composedMembership,
  describeLocatorMatches,
  capturePointerTargets,
  pointerTargetDetails,
  scrollElement,
  hitsInputTarget,
  validateInput,
  validateSelect,
  prepareInput,
  prepareFill,
  selectValues,
  captureContent,
  checkCondition,
} from "./page-tools.js";
// Browser execution is restricted to task-owned tabs; raw CDP stays internal.
import {
  OBSERVATION_SECONDS,
  MAX_IMAGE_BYTES,
  OPERATION_JOURNAL_LIMIT,
  BROWSER_MAX_ELEMENTS,
  browserActSchema,
  browserObserveSchema,
  browserReadSchema,
  browserWaitSchema,
  browserEvaluateSchema,
  browserLocateActSchema,
  browserOpenSchema,
  operationErrorSchema,
  referenceId,
  type OperationError,
  type BrowserStepFailure,
  type DeviceToolArguments,
} from "@abridge/protocol";
import { z } from "zod";
import { fail, errorDetails } from "./types.js";
// Page functions are serialized without module scope. Pass the shared hit test explicitly.
const validateInputDeclaration = `function(action){return (${validateInput.toString()}).call(this,action,(${hitsInputTarget.toString()}))}`;
const prepareInputDeclaration = `function(action){return (${prepareInput.toString()}).call(this,action,(${hitsInputTarget.toString()}))}`;
type PointerTarget = NonNullable<ReturnType<typeof pointerTargetDetails>>;
function pointerTarget(value: unknown): PointerTarget | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("bounds" in value)
  )
    return;
  if (!value.bounds || typeof value.bounds !== "object") return;
  const bounds = value.bounds as Record<string, unknown>;
  const { x, y, width, height } = bounds;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width < 2 ||
    height < 2 ||
    [x, y, width, height].some((n) => n > 1e6)
  )
    return;
  return { name: value.name.slice(0, 240), bounds: { x, y, width, height } };
}
interface ElementResult {
  bounds?: PointerTarget["bounds"];
  element_ref: string;
  role: string;
  name: string;
  description?: string;
  accessible_name?: string;
  value?: string;
  read_only?: boolean;
  input_type?: string;
  url?: string;
  target?: string;
  url_truncated?: boolean;
  checked?: boolean | "mixed";
  expanded?: boolean | "mixed";
  selected?: boolean | "mixed";
  disabled?: boolean | "mixed";
}
interface BridgeParams extends Record<string, unknown> {
  url?: unknown;
  screenshot?: unknown;
  observe_after?: unknown;
  query?: unknown;
  observation_id?: unknown;
  action?: unknown;
}
type InputAction = DeviceToolArguments<"browser_locate_act">["action"];
interface InputTarget {
  backendNodeId: number;
  revision: number;
  url: string;
}
type FollowUpOptions = Pick<
  DeviceToolArguments<"browser_act">,
  "observe_after" | "screenshot" | "wait_after_ms" | "verify"
>;
interface Result {
  [key: string]: unknown;
  observation_id?: string;
  navigation_state?: string;
  observation_error?: OperationError;
  observation?: Result;
  elements?: ElementResult[];
}
interface DispatchRequest {
  id?: string;
  method?: string;
  session_id?: string;
  params?: BridgeParams;
  isCancelled?: () => boolean;
  onExecutionStart?: () => void;
}
export interface DispatchResponse {
  id?: string;
  status: "executed" | BrowserStepFailure["status"];
  result?: Result;
  error?: OperationError;
}

const MAX_ELEMENTS = BROWSER_MAX_ELEMENTS,
  MAX_PAGE_SCAN = 120000,
  MAX_SCREENSHOT = MAX_IMAGE_BYTES;
const OBSERVATION_BUDGET = 7000,
  PAGE_TEXT_BUDGET = 4000,
  LINK_CONCURRENCY = 4;
const READ_RETRY_MILLISECONDS = 2000,
  MAX_READ_RETRIES = 2;
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
  "option",
  "disclosuretriangle",
  "listbox",
  "scrollbar",
  "gridcell",
]);
function parseArguments<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw fail(
      issue?.path[0] === "action" ? "invalid_action" : "invalid_params",
      issue?.message ?? "参数无效",
    );
  }
  return parsed.data;
}
function excerpt(text: string, terms: string[]) {
  if (!terms.length)
    return { text: text.slice(0, PAGE_TEXT_BUDGET), truncated: text.length > PAGE_TEXT_BUDGET };
  const lower = text.toLowerCase(),
    snippets: string[] = [];
  let from = 0,
    lastEnd = 0;
  while (snippets.length < 12) {
    const hits = terms
      .map((term) => ({ index: lower.indexOf(term, from), length: term.length }))
      .filter((hit) => hit.index >= 0)
      .sort((a, b) => a.index - b.index);
    const hit = hits[0];
    if (!hit) break;
    const start = Math.max(lastEnd, hit.index - 160),
      end = Math.min(text.length, hit.index + hit.length + 320);
    if (start < end) snippets.push(text.slice(start, end));
    lastEnd = end;
    from = end;
  }
  const selected = snippets.join("\n…\n");
  return {
    text: selected.slice(0, PAGE_TEXT_BUDGET),
    truncated: selected.length > PAGE_TEXT_BUDGET || terms.some((term) => lower.indexOf(term, from) >= 0),
  };
}
// Use encoded lengths: one character in a DOM label can occupy six JSON characters.
function fitObservationPreviews(result: Result, budget: number, item?: ElementResult) {
  if (JSON.stringify(result).length <= budget) return;
  result.truncated = true;
  let excess = JSON.stringify(result).length - budget;
  function shorten(value: string) {
    if (excess <= 0) return value;
    const original = JSON.stringify(value).length;
    const target = original - excess;
    let low = 0,
      high = value.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (JSON.stringify(value.slice(0, mid)).length <= target) low = mid;
      else high = mid - 1;
    }
    const preview = value.slice(0, low);
    excess -= original - JSON.stringify(preview).length;
    return preview;
  }
  if (typeof result.text === "string") result.text = shorten(result.text);
  if (item) {
    for (const key of ["value", "description", "input_type", "target", "name", "role"] as const) {
      const value = item[key];
      if (typeof value === "string") item[key] = shorten(value);
    }
  }
  for (const key of ["title", "page_summary", "url_preview"]) {
    const value = result[key];
    if (typeof value === "string") result[key] = shorten(value);
  }
  if (excess > 0 && typeof result.url === "string") {
    result.url_preview = result.url;
    delete result.url;
    result.url_truncated = true;
    excess = JSON.stringify(result).length - budget;
    result.url_preview = shorten(result.url_preview as string);
  }
}
// Serialized into the task's main document to resolve the frame boundary once.
function resolveFrameElement(selector: string) {
  let matches: NodeListOf<Element>;
  try {
    matches = document.querySelectorAll(selector);
  } catch (error) {
    if (error instanceof DOMException && error.name === "SyntaxError") return "invalid_selector";
    throw error;
  }
  if (matches.length !== 1) return matches.length;
  const frame = matches[0];
  return frame instanceof HTMLIFrameElement && frame.contentDocument ? frame : "unsupported_frame";
}
function appendOpenedTabs(result: Result, tabs: NonNullable<TaskTab["openedTabs"]>) {
  // Keep the IDs and mark omitted URLs explicitly. Never expose a partial navigation target.
  const entries: typeof tabs = tabs.map((tab) => ({
    tab_id: tab.tab_id,
    ...(tab.url || tab.url_omitted ? { url_omitted: true } : {}),
  }));
  result.opened_tabs = entries;
  let remaining =
    OBSERVATION_BUDGET -
    JSON.stringify(result, (key, value) => (key === "image_base64" ? undefined : value)).length;
  for (const [index, tab] of tabs.entries()) {
    const cost = JSON.stringify(tab).length - JSON.stringify(entries[index]).length;
    if (cost <= remaining) {
      entries[index] = { ...tab };
      remaining -= cost;
    }
  }
}
function pageException(value: unknown, fallback: string) {
  if (!value || typeof value !== "object") return fallback;
  const details = value as { text?: unknown; exception?: { description?: unknown; value?: unknown } };
  const message = details.exception?.description ?? details.exception?.value ?? details.text;
  return typeof message === "string" ? message.slice(0, 2000) : fallback;
}
export class BrowserBridge {
  readonly tabs: TaskTabs;
  private readonly seen = new Set<string>();
  readonly now: () => number;
  constructor(
    readonly chrome: typeof globalThis.chrome,
    {
      now = () => Date.now(),
      navigationTimeout = 15000,
      ownedTabs = [],
    }: { now?: () => number; navigationTimeout?: number; ownedTabs?: readonly number[] } = {},
  ) {
    this.now = now;
    this.tabs = new TaskTabs(chrome, { navigationTimeout, ownedTabs });
  }
  get sessionIds(): IterableIterator<string> {
    return this.tabs.tasks.keys();
  }
  get sessionCount(): number {
    return this.tabs.tasks.size;
  }
  resetRequests(): void {
    this.seen.clear();
  }
  close(id: string): Promise<void> {
    return this.tabs.close(id);
  }
  stop(): Promise<void> {
    return this.tabs.stop();
  }
  dispose(): Promise<void> {
    return this.tabs.dispose();
  }
  async dispatch(request: DispatchRequest): Promise<DispatchResponse> {
    const { id, method, session_id: sessionId, params = {} } = request || {};
    try {
      if (typeof id !== "string" || !id || this.seen.has(id))
        throw fail("duplicate_request", "请求标识缺失或已经处理；不会重放");
      this.seen.add(id);
      // A transport lifetime is bounded by the native connection. Reject excess IDs, never evict and replay.
      if (this.seen.size > OPERATION_JOURNAL_LIMIT)
        throw fail("request_limit", "连接请求数量达到上限，请重新连接");
      if (
        !["open", "observe", "act", "read", "wait", "evaluate", "locate_act", "close", "stop"].includes(
          method || "",
        )
      )
        throw fail("unsupported_method", "不支持的浏览器方法");
      if (method === "stop") {
        await this.stop();
        return { id, status: "executed", result: { closed: true } };
      }
      if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256)
        throw fail("invalid_session", "缺少有效任务会话");
      const session = this.tabs.tasks.get(sessionId);
      if (method === "close") {
        await this.close(sessionId);
        return { id, status: "executed", result: { closed: true } };
      }
      if (session?.busy) throw fail("session_busy", "同一会话操作仍在进行");
      if (method === "open") {
        return {
          id,
          status: "executed",
          result: await this.open(sessionId, params, request.isCancelled, request.onExecutionStart),
        };
      }
      if (!session) throw missingTaskTab();
      request.onExecutionStart?.();
      session.busy = true;
      try {
        const result =
          method === "observe"
            ? await this.observe(session, params)
            : method === "read"
              ? await this.read(session, params)
              : method === "wait"
                ? await this.wait(session, params)
                : method === "evaluate"
                  ? await this.evaluate(session, params)
                  : method === "locate_act"
                    ? await this.locateAct(session, params)
                    : await this.act(session, params);
        if (["observe", "act", "locate_act"].includes(method!) && session.openedTabs?.length)
          appendOpenedTabs(result, session.openedTabs);
        return { id, status: "executed", result };
      } finally {
        session.busy = false;
      }
    } catch (caught) {
      const error = errorDetails(caught);
      return {
        id,
        status:
          error.status ??
          (error.code === "outcome_unknown"
            ? "outcome_unknown"
            : [
                  "invalid_params",
                  "invalid_url",
                  "invalid_session",
                  "session_closed",
                  "task_tab_missing",
                  "session_busy",
                  "stale_observation",
                  "invalid_action",
                  "duplicate_request",
                  "request_limit",
                  "unsupported_method",
                  "unsupported_frame",
                  "cleanup_failed",
                  "target_missing",
                  "invalid_selector",
                  "target_not_unique",
                ].includes(error.code || "")
              ? "refused"
              : "failed"),
        error: {
          ...diagnostic(error),
          ...(operationErrorSchema.shape.cause.safeParse(error.cause).success && error.cause
            ? { cause: operationErrorSchema.shape.cause.parse(error.cause) }
            : {}),
          ...(error.cleanup_error ? { cleanup_error: error.cleanup_error } : {}),
          ...(error.recovery ? { recovery: error.recovery } : {}),
        },
      };
    }
  }
  async open(
    id: string,
    input: BridgeParams,
    isCancelled: () => boolean = () => false,
    onExecutionStart: () => void = () => {},
  ): Promise<Result> {
    const params = parseArguments(browserOpenSchema, input);
    const url = webURL(params.url);
    return this.tabs.open(id, url, isCancelled, onExecutionStart, async (session, isCancelled) => {
      try {
        const deadline = performance.now() + this.tabs.navigationTimeout;
        const tab = await this.tabs.waitReady(session);
        const result = await this.afterObservation(
          session,
          params,
          { executed: true, url: tab.url, title: tab.title || "", tab_id: tab.id, navigation_state: "ready" },
          false,
          deadline,
        );
        if (isCancelled()) {
          const interrupted = await this.tabs.uncertainFailure(
            session,
            fail("operation_cancelled", "导航已完成，后观察期间任务已取消；不要重放"),
          );
          result.observation_error = {
            ...(result.observation_error ?? { code: "operation_cancelled", message: interrupted.message }),
            ...(interrupted.cleanup_error ? { cleanup_error: interrupted.cleanup_error } : {}),
            recovery: interrupted.recovery,
          };
        }
        return result;
      } catch (caught) {
        const error = errorDetails(caught);
        if (error.code === "navigation_pending" && !isCancelled()) {
          const result = await this.loading(session, url);
          if (!isCancelled()) return result;
        }
        throw await this.tabs.uncertainFailure(session, error, error.code === "invalid_url");
      }
    });
  }
  async loading(session: TaskTab, requestedURL?: string): Promise<Result> {
    if (this.tabs.tasks.get(session.id) !== session) throw fail("session_closed", "任务已结束");
    const tab = await this.chrome.tabs.get(session.tabId!);
    if (this.tabs.tasks.get(session.id) !== session) throw fail("session_closed", "任务已结束");
    return {
      navigation_state: "loading",
      url: tab.url,
      tab_id: tab.id,
      pending_url: tab.pendingUrl || requestedURL || null,
      observation_error: {
        code: "navigation_pending",
        message: "页面仍在加载；继续 browser_observe 检查同一任务页，不要重新打开",
      },
    };
  }
  async afterObservation(
    session: TaskTab,
    params: BridgeParams,
    result: Result,
    waitForNavigation = false,
    deadline = performance.now() + this.tabs.navigationTimeout,
    waitAfterMilliseconds = 0,
  ): Promise<Result> {
    if (params.observe_after === false) return result;
    try {
      await this.waitAfterAction(session, waitAfterMilliseconds, deadline);
      if (waitForNavigation) await this.tabs.waitReady(session, deadline - performance.now());
      const observed = await this.stableObservation(
        session,
        { screenshot: params.screenshot === true },
        deadline,
      );
      if (observed.observation_id) result.observation = observed;
      else {
        result.navigation_state = observed.navigation_state;
        result.observation_error = observed.observation_error;
      }
    } catch (caught) {
      const error = errorDetails(caught);
      session.observation = null;
      result.observation_error = {
        code: error.code || "browser_error",
        message: error.message || "后续观察失败；只重新观察，不要重复动作",
      };
      if (error.code === "navigation_pending") result.navigation_state = "loading";
    }
    return result;
  }
  private async waitAfterAction(session: TaskTab, milliseconds: number, deadline: number): Promise<void> {
    if (milliseconds === 0) return;
    if (this.tabs.tasks.get(session.id) !== session) throw fail("session_closed", "任务已结束");
    if (!session.attached) throw fail("debugger_detached", "动作已执行，调试连接已断开；请重新观察");
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw fail("observation_timeout", "后续观察等待已超时；不要重复动作");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (session.waitCancel === cancel) session.waitCancel = null;
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => finish(fail("session_closed", "动作已执行；等待期间任务或调试连接已结束"));
      const timer = setTimeout(
        () =>
          finish(
            milliseconds >= remaining
              ? fail("observation_timeout", "后续观察等待已超时；不要重复动作")
              : undefined,
          ),
        Math.min(milliseconds, remaining),
      );
      session.waitCancel = cancel;
    });
  }
  async stableObservation(session: TaskTab, params: BridgeParams, deadline: number): Promise<Result> {
    let retryDeadline: number | undefined;
    for (let attempt = 0; attempt <= MAX_READ_RETRIES; attempt++) {
      try {
        if (attempt) await this.tabs.waitReady(session, retryDeadline! - performance.now());
        return await this.observe(session, params, attempt ? retryDeadline! : deadline);
      } catch (caught) {
        const error = errorDetails(caught);
        if (error.code !== "stale_observation" || attempt === MAX_READ_RETRIES || !session.attached)
          throw error;
        retryDeadline ??= Math.min(deadline, performance.now() + READ_RETRY_MILLISECONDS);
        if (performance.now() >= retryDeadline) throw error;
      }
    }
    throw fail("observation_failed", "无法稳定读取页面");
  }
  async observe(
    session: TaskTab,
    input: BridgeParams,
    deadline = performance.now() + this.tabs.navigationTimeout,
  ): Promise<Result> {
    const params = parseArguments(browserObserveSchema, input);
    const query = params.query;
    const elementOffset = params.element_offset ?? 0;
    const terms = [
      ...new Set(
        (query === undefined ? [] : typeof query === "string" ? [query] : query).map((term) =>
          term.toLowerCase(),
        ),
      ),
    ];
    const initial = await readBudget(() => this.chrome.tabs.get(session.tabId!), deadline).catch(
      (caught: unknown) => {
        if (errorDetails(caught).code === "observation_timeout") throw caught;
        throw missingTaskTab();
      },
    );
    if (initial.status === "loading" || initial.pendingUrl) {
      session.observation = null;
      try {
        await this.tabs.waitReady(
          session,
          deadline === undefined ? this.tabs.navigationTimeout : deadline - performance.now(),
        );
      } catch (caught) {
        const error = errorDetails(caught);
        if (error.code === "navigation_pending") return this.loading(session);
        throw error;
      }
    }
    session.observation = null;
    await this.tabs.valid(session, deadline);
    await this.tabs.attach(session, deadline);
    const revision = session.revision;
    const { nodes = [] } = await this.tabs.command(session, "Accessibility.getFullAXTree", {}, deadline);
    // Visible page text supplies context once. AX labels alone repeat every
    // StaticText/InlineTextBox and may exhaust the limit before real controls.
    const visible = await this.tabs.command(
      session,
      "Runtime.evaluate",
      {
        expression: `(()=>{const text=document.body?.innerText||'';return {text:text.slice(0,${MAX_PAGE_SCAN}),truncated:text.length>${MAX_PAGE_SCAN},base_uri:document.baseURI};})()`,
        returnByValue: true,
      },
      deadline,
    );
    const page = visible.result?.value as
      { text?: unknown; truncated?: boolean; base_uri?: string } | undefined;
    if (visible.exceptionDetails || !page || typeof page.text !== "string")
      throw fail("observation_failed", "无法读取页面可见内容，请重新观察");
    const candidates: { item: ElementResult; backendNodeId: number }[] = [];
    const seenNodes = new Set<number>();
    const controlNames = new Map<string, string>();
    let matches = 0,
      truncated = page.truncated === true || page.text.length > MAX_PAGE_SCAN;
    // Controls stay ahead of textual fallbacks, so long documents cannot hide real buttons.
    // StaticText supplies targets for non-semantic, event-bound spans/divs; inline boxes are redundant.
    const orderedNodes = [
      ...nodes.filter((n) => String(n.role?.value).toLowerCase() !== "statictext"),
      ...nodes.filter((n) => String(n.role?.value).toLowerCase() === "statictext"),
    ];
    for (const node of orderedNodes) {
      if (node.ignored || !node.backendDOMNodeId || seenNodes.has(node.backendDOMNodeId)) continue;
      const role = String(node.role?.value || "").toLowerCase();
      const properties = Object.fromEntries(
        (node.properties || []).map((item) => [item.name, item.value?.value]),
      );
      const explicitlyLabelled =
        role === "generic" &&
        (Boolean(node.description?.value) ||
          node.name?.sources?.some(
            (source) =>
              !source.superseded &&
              ["title", "aria-label", "aria-labelledby"].includes(source.attribute || "") &&
              source.value?.value,
          ));
      if (
        role !== "statictext" &&
        !INTERACTIVE_ROLES.has(role) &&
        properties.focusable !== true &&
        !properties.editable &&
        !explicitlyLabelled
      )
        continue;
      const description = String(node.description?.value || "");
      const name = String(node.name?.value || description),
        value = properties.protected === true ? "" : String(node.value?.value || "");
      if (
        terms.length &&
        !terms.some((term) => `${name}\n${description}\n${value}`.toLowerCase().includes(term))
      )
        continue;
      if (role === "statictext" && node.parentId && controlNames.get(node.parentId) === name) continue;
      if (node.nodeId && INTERACTIVE_ROLES.has(role)) controlNames.set(node.nodeId, name);
      seenNodes.add(node.backendDOMNodeId);
      matches++;
      if (candidates.length >= elementOffset + MAX_ELEMENTS) continue;
      const element_ref = `e${candidates.length + 1}`;
      const item: ElementResult = { element_ref, role, name: name.slice(0, 240) };
      if (!node.name?.value && description) item.accessible_name = "";
      if (description && description !== name) item.description = description.slice(0, 240);
      if (value) item.value = value.slice(0, 240);
      if (name.length > 240 || description.length > 240 || value.length > 240) truncated = true;
      for (const key of ["checked", "expanded", "selected", "disabled"] as const) {
        let state = properties[key];
        if (state === "true" || state === "false") state = state === "true";
        if (
          state === true ||
          ((key === "checked" || key === "expanded") && (state === false || state === "mixed"))
        )
          item[key] = state;
      }
      candidates.push({ item, backendNodeId: node.backendDOMNodeId });
    }
    let visualIndex = candidates.findIndex((c) => c.item.role === "statictext");
    if (visualIndex < 0) visualIndex = candidates.length;
    const pointerGroup = `abridge-pointer-${referenceId("obs")}`;
    // Keep real DOM handles throughout discovery: coordinate re-hit-testing could silently
    // bind an old screenshot target to an unrelated replacement in a dynamic document.
    try {
      const discovery = await this.tabs.command(
        session,
        "Runtime.evaluate",
        {
          expression: `(${capturePointerTargets.toString()})()`,
          returnByValue: false,
          objectGroup: pointerGroup,
        },
        deadline,
      );
      if (discovery.exceptionDetails) truncated = true;
      if (discovery.result?.objectId) {
        const root = await this.tabs.command(
          session,
          "Runtime.getProperties",
          { objectId: discovery.result.objectId, ownProperties: true },
          deadline,
        );
        if (root.result?.find((p) => p.name === "truncated")?.value?.value === true) truncated = true;
        const arrayId = root.result?.find((p) => p.name === "targets")?.value?.objectId;
        if (arrayId) {
          const array = await this.tabs.command(
            session,
            "Runtime.getProperties",
            { objectId: arrayId, ownProperties: true },
            deadline,
          );
          const elements = (array.result || []).filter((p) => /^\d+$/.test(p.name) && p.value?.objectId);
          if (elements.length > 16) truncated = true;
          for (const property of elements.slice(0, 16)) {
            const objectId = property.value!.objectId!;
            const details = await this.tabs.command(
              session,
              "Runtime.callFunctionOn",
              { objectId, functionDeclaration: pointerTargetDetails.toString(), returnByValue: true },
              deadline,
            );
            const target = pointerTarget(details.result?.value);
            if (!target) continue;
            if (terms.length && !terms.some((term) => target.name.toLowerCase().includes(term))) continue;
            const { node } = await this.tabs.command(
              session,
              "DOM.describeNode",
              { objectId, depth: 0 },
              deadline,
            );
            if (!node?.backendNodeId || seenNodes.has(node.backendNodeId)) continue;
            seenNodes.add(node.backendNodeId);
            matches++;
            candidates.splice(visualIndex++, 0, {
              backendNodeId: node.backendNodeId,
              item: { element_ref: "", role: "visualtarget", name: target.name, bounds: target.bounds },
            });
          }
        }
      }
    } finally {
      await this.tabs
        .command(session, "Runtime.releaseObjectGroup", {
          objectGroup: pointerGroup,
        })
        .catch(() => {});
    }
    candidates.splice(0, elementOffset);
    candidates.length = Math.min(candidates.length, MAX_ELEMENTS);
    candidates.forEach((candidate, i) => {
      candidate.item.element_ref = `e${i + 1}`;
    });
    const tab = await this.tabs.valid(session, deadline);
    const selectedText = excerpt(page.text.slice(0, MAX_PAGE_SCAN), terms);
    const result: Result & { elements: ElementResult[] } = {
      observation_id: referenceId("obs"),
      expires_in: OBSERVATION_SECONDS,
      url: tab.url,
      title: (tab.title || "").slice(0, 200),
      text: selectedText.text,
      elements: [],
      elements_total: matches,
      elements_returned: 0,
      element_offset: elementOffset,
      scan: {
        text_chars: Math.min(page.text.length, MAX_PAGE_SCAN),
        text_limited: page.truncated === true || page.text.length > MAX_PAGE_SCAN,
        ax_nodes: nodes.length,
      },
      truncated: truncated || selectedText.truncated,
    };
    if (tab.url!.length > 2000) {
      delete result.url;
      result.url_preview = tab.url!.slice(0, 2000);
      result.url_truncated = true;
      result.truncated = true;
    }
    if (query !== undefined) {
      result.page_summary = page.text.slice(0, 240);
      result.query = query;
      if (!selectedText.text && !matches)
        result.query_note =
          "No matches in this observation's scanned loaded text and controls; this does not establish that the page has no content.";
    }
    // Reserve IDs and omission flags in the outer action receipt before assigning refs.
    const budget = OBSERVATION_BUDGET - (session.openedTabs?.length ? 400 : 0);
    // Reserve space before enriching links, so a bounded response does not
    // incur one CDP round trip for every link in a large document.
    if (JSON.stringify(result).length > budget - 300) {
      delete result.query;
      fitObservationPreviews(result, budget - 300);
    }
    const selected: typeof candidates = [];
    let planned = JSON.stringify(result).length;
    for (const candidate of candidates) {
      const cost = JSON.stringify(candidate.item).length + 2 + (candidate.item.role === "link" ? 128 : 0);
      if (selected.length && planned + cost > budget - 300) {
        result.truncated = true;
        break;
      }
      selected.push(candidate);
      planned += cost;
    }
    for (let offset = 0; offset < selected.length; offset += LINK_CONCURRENCY) {
      await Promise.all(
        selected.slice(offset, offset + LINK_CONCURRENCY).map(async (candidate) => {
          if (!["link", "textbox", "searchbox", "combobox", "spinbutton"].includes(candidate.item.role))
            return;
          const { node: domNode } = await this.tabs.command(
            session,
            "DOM.describeNode",
            { backendNodeId: candidate.backendNodeId },
            deadline,
          );
          const attributes = domNode?.attributes || [];
          if (candidate.item.role !== "link") {
            candidate.item.read_only = attributes.some((name, i) => i % 2 === 0 && name === "readonly");
            const typeIndex = attributes.findIndex((name, i) => i % 2 === 0 && name === "type");
            if (typeIndex >= 0) candidate.item.input_type = attributes[typeIndex + 1].slice(0, 240);
            return;
          }
          const targetIndex = attributes.findIndex((name, i) => i % 2 === 0 && name === "target");
          if (targetIndex >= 0) candidate.item.target = attributes[targetIndex + 1].slice(0, 200);
          const index = attributes.findIndex((name, i) => i % 2 === 0 && name === "href");
          if (index >= 0) {
            try {
              const url = webURL(new URL(attributes[index + 1], page.base_uri).href);
              if (url.length <= 2000) candidate.item.url = url;
              else {
                candidate.item.url_truncated = true;
                result.truncated = true;
              }
            } catch {}
          }
        }),
      );
    }
    const refs = new Map();
    for (const candidate of selected) {
      result.elements.push(candidate.item);
      if (result.elements.length === 1 && JSON.stringify(result).length > budget - 300) {
        if (candidate.item.url) {
          delete candidate.item.url;
          candidate.item.url_truncated = true;
        }
        fitObservationPreviews(result, budget - 300, candidate.item);
        result.truncated = true;
      }
      if (result.elements.length > 1 && JSON.stringify(result).length > budget - 300) {
        result.elements.pop();
        result.truncated = true;
        break;
      }
      refs.set(candidate.item.element_ref, candidate.backendNodeId);
    }
    result.elements_returned = result.elements.length;
    const nextOffset = elementOffset + result.elements.length;
    if (nextOffset < matches) {
      result.truncated = true;
      if (result.elements.length) result.next_element_offset = nextOffset;
    }
    if (result.truncated)
      result.next_step =
        result.next_element_offset !== undefined
          ? "Repeat browser_observe with the same query and element_offset=next_element_offset. Each call scans the current page."
          : "Use browser_read for paged text or browser_observe with a narrower query.";
    if (params.screenshot) {
      const screenshot = await this.tabs.command(
        session,
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false },
        deadline,
      );
      const data = screenshot.data;
      if (typeof data !== "string" || !data.length || data.length % 4 !== 0)
        throw fail("invalid_screenshot", "截图不是有效 base64");
      const bytes = (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
      if (bytes > MAX_SCREENSHOT) throw fail("screenshot_too_large", "截图原始数据超过 4 MiB 上限");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw fail("invalid_screenshot", "截图不是有效 base64");
      result.image_base64 = data;
      result.mime_type = "image/png";
    }
    const current = await this.tabs.valid(session, deadline);
    if (
      revision !== session.revision ||
      current.url !== tab.url ||
      current.status === "loading" ||
      current.pendingUrl
    )
      throw fail("stale_observation", "观察期间页面已导航");
    session.observation = {
      id: result.observation_id!,
      refs,
      revision,
      expires: this.now() + OBSERVATION_SECONDS * 1000,
      url: tab.url!,
    };
    return result;
  }
  async locateAct(session: TaskTab, input: BridgeParams): Promise<Result> {
    const params = parseArguments(browserLocateActSchema, input);
    const tab = await this.tabs.valid(session);
    const revision = session.revision;
    await this.tabs.attach(session);
    const semantic = typeof params.selector === "object" ? params.selector : undefined;
    const selector =
      typeof params.selector === "string" ? params.selector : (params.selector.within ?? ":root");
    const invalidSelector = () =>
      fail(
        "invalid_selector",
        "locator 的字符串参数和 within 都使用 CSS 选择器。按可访问名称定位可用 page.locator({within, role, name})。",
      );
    const matchCountError = async (count: number) => {
      if (!count)
        return fail(
          "target_missing",
          "CSS 选择器匹配 0 个元素。请重新观察目标、检查容器，或用 page.wait 等待其出现。",
        );
      const details = await this.pageValue(
        session,
        `(${describeLocatorMatches.toString()})(${JSON.stringify(selector)})`,
        1500,
        params.frame_selector,
      ).catch(() => null);
      return fail(
        "target_not_unique",
        `CSS 匹配 ${count} 个元素；请使用更精确的 CSS，或 page.locator({within, role, name})。${details ? "候选 " + JSON.stringify(details).slice(0, 1500) : ""}`,
      );
    };
    let backendNodeId: number | undefined;
    let frameId: string | undefined;
    if (params.frame_selector !== undefined) {
      const frame = await this.frameTarget(session, params.frame_selector);
      frameId = frame.frameId;
      try {
        const resolved = await this.tabs.command(session, "Runtime.callFunctionOn", {
          objectId: frame.objectId,
          functionDeclaration:
            "function(selector){try{const nodes=this.contentDocument.querySelectorAll(selector);return nodes.length===1?nodes[0]:nodes.length}catch(error){if(error.name==='SyntaxError')return 'invalid_selector';throw error}}",
          arguments: [{ value: selector }],
          returnByValue: false,
        });
        if (resolved.result?.value === "invalid_selector") throw invalidSelector();
        if (typeof resolved.result?.value === "number") throw await matchCountError(resolved.result.value);
        if (resolved.exceptionDetails)
          throw fail("locator_failed", pageException(resolved.exceptionDetails, "无法读取 iframe 中的目标"));
        if (!resolved.result?.objectId) throw fail("target_missing", "iframe 中的定位目标已不可用");
        const { node } = await this.tabs.command(session, "DOM.describeNode", {
          objectId: resolved.result.objectId,
        });
        backendNodeId = node?.backendNodeId;
      } finally {
        await this.tabs
          .command(session, "Runtime.releaseObjectGroup", { objectGroup: "abridge-frame" })
          .catch(() => {});
      }
    } else {
      const { root } = await this.tabs.command(session, "DOM.getDocument", {});
      const { nodeIds } = await this.tabs
        .command(session, "DOM.querySelectorAll", { nodeId: root.nodeId, selector })
        .catch(async (caught) => {
          // CDP can report a generic DOM error for malformed CSS. Confirm syntax
          // separately so a debugger or transport failure keeps its original status.
          if (!errorDetails(caught).code) {
            const invalid = await this.pageValue(
              session,
              `(()=>{try{document.querySelector(${JSON.stringify(selector)});return false}catch(error){return error.name==='SyntaxError'}})()`,
              1000,
            ).catch(() => false);
            if (invalid === true) throw invalidSelector();
          }
          throw caught;
        });
      if (nodeIds.length !== 1) throw await matchCountError(nodeIds.length);
      const { node } = await this.tabs.command(session, "DOM.describeNode", { nodeId: nodeIds[0] });
      backendNodeId = node?.backendNodeId;
    }
    if (!backendNodeId) throw fail("target_missing", "目标元素不存在");
    if (semantic) {
      // queryAXTree may wait indefinitely for an animation frame in a background tab.
      // getFullAXTree is also used by observe and returns Chrome's computed roles and names.
      const deadline = performance.now() + 5000;
      const { nodes = [] } = await this.tabs.command(
        session,
        "Accessibility.getFullAXTree",
        frameId ? { frameId } : {},
        deadline,
      );
      let targets = [
        ...new Set(
          nodes.flatMap((node) =>
            !node.ignored &&
            node.backendDOMNodeId &&
            String(node.role?.value ?? "").toLowerCase() === semantic.role.toLowerCase() &&
            String(node.name?.value ?? "") === semantic.name
              ? [node.backendDOMNodeId]
              : [],
          ),
        ),
      ];
      if (semantic.within && targets.length)
        targets = await this.targetsInContainer(session, backendNodeId, targets, deadline);
      if (!targets.length)
        throw fail(
          "target_missing",
          "容器内没有匹配此 role 和精确可访问名称 name 的目标。请调用 page.observe 检查当前角色、名称及容器。",
        );
      if (targets.length !== 1)
        throw fail(
          "target_not_unique",
          `容器内有 ${targets.length} 个可访问目标匹配该角色与名称；请缩小 within 容器。`,
        );
      backendNodeId = targets[0];
    }
    return this.executeInput(session, { backendNodeId, revision, url: tab.url! }, params.action, {
      verify: params.verify && { frame_selector: params.frame_selector, ...params.verify },
      observe_after: false,
      screenshot: false,
      wait_after_ms: 0,
    });
  }

  private async targetsInContainer(session: TaskTab, container: number, targets: number[], deadline: number) {
    const inside: number[] = [];
    const objectGroup = "abridge-locator-scope";
    // Bound concurrent CDP requests and live remote handles, even on large catalogs.
    for (let offset = 0; offset < targets.length; offset += 16) {
      const batch = targets.slice(offset, offset + 16);
      try {
        const resolved = await Promise.allSettled(
          [container, ...batch].map((backendNodeId) =>
            this.tabs.command(session, "DOM.resolveNode", { backendNodeId, objectGroup }, deadline),
          ),
        );
        const handles = resolved.map((result) => {
          if (result.status === "rejected") throw result.reason;
          const { object } = result.value;
          if (!object?.objectId) throw fail("target_missing", "定位期间元素已从页面移除，请重新观察");
          return { objectId: object.objectId };
        });
        const lookup = await this.tabs.command(
          session,
          "Runtime.callFunctionOn",
          {
            ...handles[0],
            functionDeclaration: composedMembership.toString(),
            arguments: handles.slice(1),
            returnByValue: true,
          },
          deadline,
        );
        const matched = lookup.result?.value;
        if (
          lookup.exceptionDetails ||
          !Array.isArray(matched) ||
          matched.length !== batch.length ||
          matched.some((value) => typeof value !== "boolean")
        )
          throw fail(
            "locator_failed",
            pageException(lookup.exceptionDetails, "无法核对目标所属容器，请重新观察"),
          );
        inside.push(...batch.filter((_, index) => matched[index]));
      } finally {
        await this.tabs
          .command(session, "Runtime.releaseObjectGroup", { objectGroup }, performance.now() + 500)
          .catch(() => {});
      }
    }
    return inside;
  }

  async frameTarget(
    session: TaskTab,
    selector: unknown,
    deadline?: number,
  ): Promise<{ objectId: string; frameId: string }> {
    if (typeof selector !== "string" || !selector || selector.length > 2000)
      throw fail("invalid_params", "frame_selector 无效");
    await this.tabs.valid(session, deadline);
    await this.tabs.attach(session, deadline);
    const frame = await this.tabs.command(
      session,
      "Runtime.evaluate",
      {
        expression: `(${resolveFrameElement.toString()})(${JSON.stringify(selector)})`,
        returnByValue: false,
        objectGroup: "abridge-frame",
      },
      deadline,
    );
    try {
      if (frame.exceptionDetails)
        throw fail("locator_failed", pageException(frame.exceptionDetails, "读取 frame_selector 时发生错误"));
      const match = frame.result?.value;
      if (match === "invalid_selector")
        throw fail("invalid_selector", "frame_selector 需要有效的 CSS 选择器");
      if (match === 0)
        throw fail("target_missing", "frame_selector 匹配 0 个元素，请检查选择器或等待 iframe 加载");
      if (typeof match === "number")
        throw fail("target_not_unique", `frame_selector 匹配 ${match} 个元素，请指定唯一 iframe`);
      if (match === "unsupported_frame")
        throw fail("unsupported_frame", "frame_selector 的目标必须为已加载的同源 iframe");
      if (!frame.result?.objectId) throw fail("locator_failed", "无法读取 frame_selector 的目标");
      const { node } = await this.tabs.command(
        session,
        "DOM.describeNode",
        { objectId: frame.result.objectId },
        deadline,
      );
      if (!node?.frameId) throw fail("unsupported_frame", "无法确定 iframe 文档；不会转投主文档");
      return { objectId: frame.result.objectId, frameId: node.frameId };
    } catch (error) {
      await this.tabs
        .command(session, "Runtime.releaseObjectGroup", { objectGroup: "abridge-frame" })
        .catch(() => {});
      throw error;
    }
  }
  async pageValue(
    session: TaskTab,
    expression: string,
    timeout = 10000,
    frameSelector?: unknown,
    submitted?: () => void,
  ): Promise<unknown> {
    const deadline = performance.now() + timeout;
    await this.tabs.valid(session, deadline);
    await this.tabs.attach(session, deadline);
    const frame =
      frameSelector === undefined ? undefined : await this.frameTarget(session, frameSelector, deadline);
    let result: CdpResults["Runtime.evaluate"];
    try {
      const contextId = frame && this.tabs.frameContexts.get(session.tabId!)?.get(frame.frameId);
      if (frame && contextId === undefined)
        throw fail("unsupported_frame", "iframe 执行上下文不可用；不会转投主文档");
      submitted?.();
      result = await this.tabs.command(
        session,
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true, timeout, ...(frame ? { contextId } : {}) },
        deadline,
      );
    } finally {
      if (frame)
        await this.tabs
          .command(session, "Runtime.releaseObjectGroup", { objectGroup: "abridge-frame" })
          .catch(() => {});
    }
    if (result.exceptionDetails)
      throw fail("page_script_failed", pageException(result.exceptionDetails, "页面脚本执行失败"));
    return result.result?.value ?? null;
  }
  async evaluate(session: TaskTab, input: BridgeParams): Promise<Result> {
    const params = parseArguments(browserEvaluateSchema, input);
    const timeout = params.timeout_ms;
    session.observation = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let submitted = false,
      timedOut = false;
    try {
      const value = await Promise.race([
        this.pageValue(session, params.expression, timeout, params.frame_selector, () => {
          if (timedOut) throw fail("evaluation_timeout", "页面脚本提交前已超时");
          submitted = true;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(fail("evaluation_timeout", "页面脚本超时；不要重放"));
          }, timeout);
        }),
      ]);
      if (JSON.stringify(value).length > 24000)
        throw fail("result_too_large", "脚本结果超过24000字符，请在代码中分页或汇总");
      return { value, executed: true };
    } catch (caught) {
      if (submitted) throw await this.tabs.uncertainFailure(session, caught);
      throw caught;
    } finally {
      clearTimeout(timer);
    }
  }
  async read(session: TaskTab, input: BridgeParams): Promise<Result> {
    const params = parseArguments(browserReadSchema, input);
    const { offset, limit } = params;
    const mode = params.mode ?? (params.snapshot_id ? session.snapshot?.format : undefined) ?? "text";
    const initial = await this.tabs.valid(session);
    if (params.snapshot_id !== undefined) {
      if (!session.snapshot || session.snapshot.id !== params.snapshot_id || session.snapshot.format !== mode)
        throw fail("snapshot_missing", "快照不存在或格式不同");
      if (
        (params.selector !== undefined && params.selector !== session.snapshot.selector) ||
        (params.frame_selector !== undefined && params.frame_selector !== session.snapshot.frameSelector)
      )
        throw fail(
          "invalid_params",
          "快照的容器和 frame 已固定。续读使用 snapshot_id 和 offset；读取其他目标请创建新快照。",
        );
    } else {
      const revision = session.revision;
      const sourceURL = initial.url;
      const value = await this.pageValue(
        session,
        `(${captureContent.toString()})(${JSON.stringify(params.selector)},${JSON.stringify(mode === "tables" ? "table" : "text")})`,
        10000,
        params.frame_selector,
      );
      if (typeof value !== "string" && !Array.isArray(value)) throw fail("read_failed", "页面内容无效");
      const current = await this.tabs.valid(session);
      if (
        session.revision !== revision ||
        current.url !== sourceURL ||
        current.status === "loading" ||
        current.pendingUrl
      )
        throw fail("stale_observation", "读取期间页面已导航；请重新读取");
      let truncated = false;
      let saved = value;
      if (typeof saved === "string" && saved.length > 1000000) {
        saved = saved.slice(0, 1000000);
        truncated = true;
      }
      if (Array.isArray(saved)) {
        const rows: unknown[] = [];
        let size = 0;
        for (const row of saved) {
          size += JSON.stringify(row).length;
          if (size > 1000000) {
            truncated = true;
            break;
          }
          rows.push(row);
        }
        saved = rows;
      }
      session.snapshot = {
        id: referenceId("snap"),
        format: mode,
        value: saved,
        url: sourceURL!,
        truncated,
        coverage: params.frame_selector ? "loaded_same_origin_frame" : "loaded_main_document",
        selector: params.selector,
        frameSelector: params.frame_selector,
      };
    }
    const snapshot = session.snapshot!;
    const start = Math.min(offset, snapshot.value.length);
    let end = Math.min(snapshot.value.length, start + Math.min(limit, mode === "text" ? 24000 : 200));
    let page = snapshot.value.slice(start, end);
    if (JSON.stringify(page).length > 24000) {
      let low = start;
      let high = end;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (JSON.stringify(snapshot.value.slice(start, middle)).length <= 24000) low = middle;
        else high = middle;
      }
      if (low === start) throw fail("result_too_large", "单行数据超过返回预算，请用脚本提取较小字段");
      end = low;
      page = snapshot.value.slice(start, end);
    }
    return {
      snapshot_id: snapshot.id,
      mode,
      ...(mode === "text" ? { text: page } : { rows: page }),
      offset: start,
      total: snapshot.value.length,
      next_offset: end < snapshot.value.length ? end : null,
      truncated: snapshot.truncated,
      source_url: snapshot.url,
      coverage: snapshot.coverage,
      cached: params.snapshot_id !== undefined,
    };
  }
  async wait(session: TaskTab, input: BridgeParams, verify = false): Promise<Result> {
    const params = parseArguments(browserWaitSchema, input);
    const state = params.state;
    const timeout = params.timeout_ms;
    const deadline = performance.now() + timeout;
    const expression = `(${checkCondition.toString()})(${JSON.stringify(params.selector)},${JSON.stringify(params.text)},${JSON.stringify(state)},${JSON.stringify(params.value)},${verify})`;
    do {
      try {
        const matched = await this.pageValue(
          session,
          expression,
          Math.max(1, Math.ceil(deadline - performance.now())),
          params.frame_selector,
        );
        if (typeof matched === "number")
          throw fail("target_not_unique", `核验条件命中 ${matched} 个元素；请将选择器限定到目标容器`);
        if (matched === true) return { matched: true, state };
      } catch (caught) {
        const code = errorDetails(caught).code;
        if (code === "observation_timeout") break;
        // The action may create the verification frame asynchronously.
        if (params.frame_selector === undefined || code !== "target_missing") throw caught;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await this.waitAfterAction(session, Math.min(100, Math.max(1, remaining - 1)), deadline + 1);
    } while (performance.now() < deadline);
    throw fail("wait_timeout", "等待条件未在期限内满足");
  }
  async act(session: TaskTab, input: BridgeParams): Promise<Result> {
    const params = parseArguments(browserActSchema, input);
    const observation = session.observation;
    const action = params.action;
    if (session.invalidatedObservation?.id === params.observation_id)
      throw fail(
        "stale_observation",
        `未投递输入：${session.invalidatedObservation.reason}；待页面稳定后使用 browser_observe`,
      );
    if (!observation || observation.id !== params.observation_id)
      throw fail(
        "stale_observation",
        "未投递输入：引用不属于当前观察或已失效；请用 browser_observe 重新定位",
      );
    if (observation.expires <= this.now())
      throw fail("stale_observation", "未投递输入：观察已过期；请用 browser_observe 重新定位");
    if (observation.revision !== session.revision)
      throw fail("stale_observation", "未投递输入：文档版本已变化；请用 browser_observe 重新定位");
    if (!observation.refs.has(action.element_ref))
      throw fail("invalid_action", "需要当前观察中的精确元素和支持的动作");
    return this.executeInput(
      session,
      {
        backendNodeId: observation.refs.get(action.element_ref)!,
        revision: observation.revision,
        url: observation.url,
      },
      action,
      params,
    );
  }
  private async executeInput(
    session: TaskTab,
    target: InputTarget,
    action: InputAction,
    params: FollowUpOptions,
  ): Promise<Result> {
    const tab = await this.tabs.valid(session);
    if (tab.status === "loading" || tab.pendingUrl)
      throw fail("stale_observation", "未投递输入：页面正在加载；待加载完成后使用 browser_observe");
    if (tab.url !== target.url)
      throw fail("stale_observation", "未投递输入：页面地址已变化；请使用 browser_observe 检查新页面");
    if (session.revision !== target.revision)
      throw fail("stale_observation", "未投递输入：文档版本已变化；请用 browser_observe 重新定位");
    const { object } = await this.tabs.command(session, "DOM.resolveNode", {
      backendNodeId: target.backendNodeId,
      objectGroup: "abridge-action",
    });
    if (!object?.objectId)
      throw fail("stale_observation", "未投递输入：元素已不存在；请用 browser_observe 重新定位");
    try {
      if (session.revision !== target.revision)
        throw fail("stale_observation", "未投递输入：页面已导航；请使用 browser_observe 检查新页面");
      let response: CdpResults["Runtime.callFunctionOn"] = {};
      const native = ["click", "fill", "hover", "press"].includes(action.type!);
      let point: { x: number; y: number } | undefined;
      let preparedSideEffects = false;
      if (action.type === "select") {
        const validation = await this.tabs.command(session, "Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: validateSelect.toString(),
          arguments: [{ value: action.values }],
          returnByValue: true,
        });
        if (validation.exceptionDetails) throw fail("invalid_action", "无法验证下拉控件，请重新观察");
        if (typeof validation.result?.value === "string")
          throw fail("invalid_action", validation.result.value);
      }
      // A pure preflight can reject a readonly/wrong-kind target without losing the task.
      const validation = await this.tabs.command(session, "Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: validateInputDeclaration,
        arguments: [{ value: action.type }],
        returnByValue: true,
      });
      if (validation.exceptionDetails) throw fail("invalid_action", "无法验证目标，请重新观察");
      if (typeof validation.result?.value === "string") throw fail("invalid_action", validation.result.value);
      try {
        if (native) {
          preparedSideEffects = true;
          const prepared = await this.tabs.command(session, "Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: prepareInputDeclaration,
            arguments: [{ value: action.type }],
            returnByValue: true,
          });
          if (prepared.exceptionDetails)
            throw fail(
              "action_failed",
              pageException(prepared.exceptionDetails, "元素不可见、被遮挡或不可用"),
            );
          point = prepared.result?.value as { x: number; y: number } | undefined;
          if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
            throw fail("action_failed", "无法确定输入位置");
          // Hidden task tabs can have fresh DOM geometry but a stale compositor
          // hit-test surface. A discarded one-pixel capture prepares a frame
          // without activating the tab or moving the user's system pointer.
          await this.tabs.command(
            session,
            "Page.captureScreenshot",
            {
              format: "jpeg",
              quality: 1,
              clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
              captureBeyondViewport: false,
            },
            performance.now() + 2000,
          );
          const refreshed = await this.tabs.command(session, "Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: prepareInputDeclaration,
            arguments: [{ value: action.type }],
            returnByValue: true,
          });
          point = refreshed.result?.value as { x: number; y: number } | undefined;
          if (refreshed.exceptionDetails || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
            throw fail("action_failed", "渲染后目标不可用");
        }
        const assertCurrentDocument = async (stage = "目标输入尚未投递") => {
          const currentTab = await this.tabs.valid(session);
          if (
            session.revision !== target.revision ||
            currentTab.url !== target.url ||
            currentTab.status === "loading" ||
            currentTab.pendingUrl
          )
            throw fail("stale_observation", `页面正在加载或文档已变化（${stage}）；请检查状态，避免重复操作`);
        };
        await assertCurrentDocument();
        session.observation = null;
        session.openedTabs = undefined;
        session.capturingTabs = true;
        preparedSideEffects = true;
        if (action.type === "scroll") {
          response = await this.tabs.command(session, "Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: scrollElement.toString(),
            arguments: [{ value: action.delta_x || 0 }, { value: action.delta_y || 0 }],
            returnByValue: true,
          });
        } else if (action.type === "click" || action.type === "hover") {
          await this.tabs.command(session, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
          await assertCurrentDocument("已投递指针移动");
          if (action.type === "click") {
            try {
              await this.tabs.command(session, "Input.dispatchMouseEvent", {
                type: "mousePressed",
                ...point,
                button: "left",
                clickCount: 1,
              });
              if (action.hold_ms) {
                await this.waitAfterAction(
                  session,
                  action.hold_ms,
                  performance.now() + action.hold_ms + 1000,
                );
                await assertCurrentDocument("已投递鼠标按下");
              }
            } finally {
              await this.tabs.command(session, "Input.dispatchMouseEvent", {
                type: "mouseReleased",
                ...point,
                button: "left",
                clickCount: 1,
              });
            }
          }
        } else if (action.type === "press") {
          const key = action.key || "";
          const keys: Record<string, number> = {
            Enter: 13,
            Tab: 9,
            Escape: 27,
            Backspace: 8,
            Delete: 46,
            ArrowLeft: 37,
            ArrowUp: 38,
            ArrowRight: 39,
            ArrowDown: 40,
            Home: 36,
            End: 35,
            PageUp: 33,
            PageDown: 34,
            Space: 32,
          };
          if (!keys[key] && key.length !== 1) throw fail("invalid_action", "不支持的按键");
          const payload = {
            key: key === "Space" ? " " : key,
            windowsVirtualKeyCode: keys[key] || key.toUpperCase().charCodeAt(0),
          };
          try {
            await this.tabs.command(session, "Input.dispatchKeyEvent", {
              type: "keyDown",
              ...payload,
              ...(key.length === 1 || key === "Space" ? { text: payload.key } : {}),
            });
          } finally {
            await this.tabs.command(session, "Input.dispatchKeyEvent", { type: "keyUp", ...payload });
          }
        } else if (action.type === "fill") {
          const prepared = await this.tabs.command(session, "Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: prepareFill.toString(),
            returnByValue: true,
          });
          if (prepared.exceptionDetails) throw fail("action_failed", "字段不可编辑");
          await assertCurrentDocument();
          if ((prepared.result?.value as { select_all?: boolean } | undefined)?.select_all) {
            try {
              await this.tabs.command(session, "Input.dispatchKeyEvent", {
                type: "rawKeyDown",
                key: "a",
                code: "KeyA",
                windowsVirtualKeyCode: 65,
                modifiers: 2,
                commands: ["selectAll"],
              });
            } finally {
              await this.tabs.command(session, "Input.dispatchKeyEvent", {
                type: "keyUp",
                key: "a",
                code: "KeyA",
                windowsVirtualKeyCode: 65,
                modifiers: 2,
              });
            }
          }
          await assertCurrentDocument("已完成字段准备");
          if (action.text === "") {
            try {
              await this.tabs.command(session, "Input.dispatchKeyEvent", {
                type: "rawKeyDown",
                key: "Backspace",
                windowsVirtualKeyCode: 8,
              });
            } finally {
              await this.tabs.command(session, "Input.dispatchKeyEvent", {
                type: "keyUp",
                key: "Backspace",
                windowsVirtualKeyCode: 8,
              });
            }
          } else await this.tabs.command(session, "Input.insertText", { text: action.text });
        } else {
          response = await this.tabs.command(session, "Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: `function(values){const validateSelect=${validateSelect.toString()};return (${selectValues.toString()}).call(this,values)}`,
            arguments: [{ value: action.values }],
            returnByValue: true,
          });
        }
        if (
          action.type === "select" &&
          !response.exceptionDetails &&
          typeof response.result?.value === "string"
        ) {
          // The final shared validation rejected before mutation or events.
          preparedSideEffects = false;
          throw fail("invalid_action", response.result.value);
        }
        if (response.exceptionDetails)
          throw fail(
            "action_failed",
            pageException(response.exceptionDetails, "网页拒绝了 DOM 操作，请重新观察"),
          );
      } catch (caught) {
        if (preparedSideEffects) throw await this.tabs.uncertainFailure(session, caught);
        throw caught;
      } finally {
        if (session.capturingTabs) session.childUrlDeadline = performance.now() + 5000;
        session.capturingTabs = false;
      }
      let verification: Result | undefined;
      if (params.verify) {
        try {
          verification = await this.wait(session, params.verify, true);
        } catch (caught) {
          verification = { matched: false, error: diagnostic(errorDetails(caught)) };
        }
      }
      return await this.afterObservation(
        session,
        params,
        {
          executed: true,
          ...(native ? { input_dispatched: true } : {}),
          ...(verification ? { verification } : {}),
          route:
            action.type === "scroll"
              ? "dom_scroll"
              : native
                ? "cdp_input"
                : action.type === "select"
                  ? "select_value"
                  : "replace_value",
          ...(action.type === "scroll" ? { scroll: response.result?.value } : {}),
        },
        true,
        performance.now() + this.tabs.navigationTimeout,
        params.wait_after_ms,
      );
    } finally {
      try {
        await this.tabs.command(session, "Runtime.releaseObjectGroup", { objectGroup: "abridge-action" });
      } catch {}
    }
  }
}
