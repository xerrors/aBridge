import { prepareInput, prepareFill, selectValues, captureContent, checkCondition } from "./page-tools.js";
// Browser execution is restricted to task-owned tabs; raw CDP stays internal.
import {
  OBSERVATION_SECONDS,
  MAX_IMAGE_BYTES,
  OPERATION_JOURNAL_LIMIT,
  BROWSER_MAX_ELEMENTS,
  BROWSER_MAX_TEXT,
  actWaitAfterSchema,
} from "@abridge/protocol";
import { fail, errorDetails } from "./types.js";
interface AXValue {
  value?: unknown;
}
interface AXNode {
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value?: AXValue }[];
}
interface CdpResults {
  "Accessibility.getFullAXTree": { nodes?: AXNode[] };
  "Runtime.evaluate": {
    result?: { value?: unknown; objectId?: string };
    exceptionDetails?: unknown;
  };
  "DOM.describeNode": { node?: { attributes?: string[]; backendNodeId?: number; frameId?: string } };
  "DOM.getDocument": { root: { nodeId: number } };
  "DOM.querySelectorAll": { nodeIds: number[] };
  "DOM.resolveNode": { object?: { objectId?: string } };
  "Runtime.callFunctionOn": { result?: { value?: unknown; objectId?: string }; exceptionDetails?: unknown };
  "Input.dispatchMouseEvent": object;
  "Input.dispatchKeyEvent": object;
  "Input.insertText": object;
  "Runtime.terminateExecution": object;
  "Page.captureScreenshot": { data?: unknown };
  "Page.enable": object;
  "Runtime.enable": object;
  "Runtime.releaseObjectGroup": object;
}
interface ElementResult {
  element_ref: string;
  role: string;
  name: string;
  value?: string;
  url?: string;
  url_truncated?: boolean;
  checked?: boolean | "mixed";
  expanded?: boolean | "mixed";
  selected?: boolean | "mixed";
  disabled?: boolean | "mixed";
}
interface Observation {
  id: string;
  refs: Map<string, number>;
  revision: number;
  expires: number;
  url: string;
}
interface AttachAttempt {
  promise: Promise<void>;
  cleanup?: Promise<void>;
}
interface Session {
  id: string;
  tabId: number | null;
  observation: Observation | null;
  attached: boolean;
  revision: number;
  busy: boolean;
  snapshot?: {
    id: string;
    format: string;
    value: string | unknown[];
    url: string;
    truncated: boolean;
    coverage: string;
  };
  denied?: boolean;
  attachAttempt?: AttachAttempt | null;
  waitCancel?: (() => void) | null;
}
interface BridgeParams extends Record<string, unknown> {
  url?: unknown;
  screenshot?: unknown;
  observe_after?: unknown;
  query?: unknown;
  observation_id?: unknown;
  action?: unknown;
}
interface Result {
  [key: string]: unknown;
  observation_id?: string;
  navigation_state?: string;
  observation_error?: { code: string; message: string };
  observation?: Result;
  elements?: ElementResult[];
}
interface DispatchRequest {
  id?: string;
  method?: string;
  session_id?: string;
  params?: BridgeParams;
}
export interface DispatchResponse {
  id?: string;
  result?: Result;
  error?: { code: string; message: string };
}

const MAX_ELEMENTS = BROWSER_MAX_ELEMENTS,
  MAX_TEXT = BROWSER_MAX_TEXT,
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
async function readBudget<T>(operation: () => Promise<T>, deadline?: number): Promise<T> {
  if (deadline === undefined) return operation();
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw fail("observation_timeout", "观察未在时间预算内稳定；请再次观察，不要重复动作");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(fail("observation_timeout", "观察未在时间预算内稳定；请再次观察，不要重复动作")),
          remaining,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function options(params: BridgeParams, compound = false) {
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw fail("invalid_params", "参数必须是对象");
  if (params.screenshot !== undefined && typeof params.screenshot !== "boolean")
    throw fail("invalid_params", "screenshot 必须是布尔值");
  if (
    params.query !== undefined &&
    params.query !== null &&
    (typeof params.query !== "string" || params.query.length > 200)
  )
    throw fail("invalid_params", "query 必须是最多200字符的文本");
  if (compound && params.observe_after !== undefined && typeof params.observe_after !== "boolean")
    throw fail("invalid_params", "observe_after 必须是布尔值");
  if (compound && params.observe_after === false && params.screenshot === true)
    throw fail("invalid_params", "screenshot 需要 observe_after=true");
}
function excerpt(text: string, query: string) {
  if (!query) return { text: text.slice(0, PAGE_TEXT_BUDGET), truncated: text.length > PAGE_TEXT_BUDGET };
  const needle = query.toLowerCase(),
    lower = text.toLowerCase(),
    snippets: string[] = [];
  let from = 0,
    lastEnd = 0;
  while (snippets.length < 12) {
    const index = lower.indexOf(needle, from);
    if (index < 0) break;
    const start = Math.max(lastEnd, index - 160),
      end = Math.min(text.length, index + needle.length + 320);
    if (start < end) snippets.push(text.slice(start, end));
    lastEnd = end;
    from = end;
  }
  const selected = snippets.join("\n…\n");
  return {
    text: selected.slice(0, PAGE_TEXT_BUDGET),
    truncated: selected.length > PAGE_TEXT_BUDGET || lower.indexOf(needle, from) >= 0,
  };
}
export function webURL(value: unknown) {
  let url;
  try {
    url = new URL(value as string);
  } catch {
    throw fail("invalid_url", "需要完整的 HTTP 或 HTTPS 地址");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw fail("invalid_url", "仅支持 HTTP 和 HTTPS 页面");
  return url.href;
}
export class BrowserBridge {
  readonly chrome: typeof chrome;
  readonly now: () => number;
  readonly uuid: () => string;
  readonly navigationTimeout: number;
  readonly sessions = new Map<string, Session>();
  readonly seen = new Set<string>();
  generation = 0;
  ownershipWrites = Promise.resolve();
  readonly ownedTabs = new Set<number>();
  readonly frameContexts = new Map<number, Map<string, number>>();
  constructor(
    chrome: typeof globalThis.chrome,
    { now = () => Date.now(), uuid = () => crypto.randomUUID(), navigationTimeout = 15000 } = {},
  ) {
    this.chrome = chrome;
    this.now = now;
    this.uuid = uuid;
    this.navigationTimeout = navigationTimeout;
    chrome.tabs.onUpdated.addListener((id, change) => {
      for (const session of this.sessions.values())
        if (session.tabId === id && (change.status === "loading" || change.url)) {
          session.observation = null;
          session.revision++;
          if (change.url && change.url !== "about:blank") {
            try {
              webURL(change.url);
            } catch {
              session.denied = true;
            }
          }
        }
    });
    chrome.tabs.onRemoved.addListener((id) => {
      this.frameContexts.delete(id);
      this.ownedTabs.delete(id);
      void this.persistOwnership().catch(() => {});
      for (const [key, session] of this.sessions)
        if (session.tabId === id) {
          this.sessions.delete(key);
          session.waitCancel?.();
        }
    });
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) this.frameContexts.delete(source.tabId);
      for (const session of this.sessions.values())
        if (source.tabId === session.tabId!) {
          session.attached = false;
          session.observation = null;
          session.revision++;
          session.waitCancel?.();
        }
    });
    chrome.debugger.onEvent?.addListener((source, method, params) => {
      if (source.tabId === undefined || !this.ownedTabs.has(source.tabId)) return;
      const data = params as
        | {
            context?: { id?: number; auxData?: { frameId?: string; isDefault?: boolean } };
            executionContextId?: number;
          }
        | undefined;
      if (method === "Runtime.executionContextsCleared") this.frameContexts.delete(source.tabId);
      else if (method === "Runtime.executionContextCreated") {
        const context = data?.context;
        if (context?.auxData?.isDefault && context.auxData.frameId && typeof context.id === "number") {
          let contexts = this.frameContexts.get(source.tabId);
          if (!contexts) this.frameContexts.set(source.tabId, (contexts = new Map()));
          contexts.set(context.auxData.frameId, context.id);
        }
      } else if (method === "Runtime.executionContextDestroyed") {
        const contexts = this.frameContexts.get(source.tabId);
        for (const [frameId, contextId] of contexts ?? [])
          if (contextId === data?.executionContextId) contexts!.delete(frameId);
      }
    });
  }
  async persistOwnership() {
    if (!this.chrome.storage?.session) return;
    const ids = [...this.ownedTabs];
    this.ownershipWrites = this.ownershipWrites
      .catch(() => {})
      .then(() => this.chrome.storage.session.set({ owned_task_tabs: ids }));
    await this.ownershipWrites;
  }
  async command<M extends keyof CdpResults>(
    session: Session,
    method: M,
    params: Record<string, unknown> = {},
    deadline?: number,
  ): Promise<CdpResults[M]> {
    if (this.sessions.get(session.id) !== session) throw fail("session_closed", "任务已结束");
    const result = await readBudget(
      () => this.chrome.debugger.sendCommand({ tabId: session.tabId! }, method, params),
      deadline,
    );
    if (this.sessions.get(session.id) !== session) throw fail("session_closed", "任务已结束");
    return result as CdpResults[M];
  }
  async valid(session: Session, deadline?: number) {
    if (!session || this.sessions.get(session.id) !== session) throw fail("session_closed", "任务标签不可用");
    const tab = await readBudget(() => this.chrome.tabs.get(session.tabId!), deadline);
    if (this.sessions.get(session.id) !== session) throw fail("session_closed", "任务已结束");
    if (session.denied) throw fail("invalid_url", "任务重定向到了禁止访问的页面");
    webURL(tab.url);
    return tab;
  }
  cleanupAttach(session: Session, attempt: AttachAttempt) {
    if (attempt.cleanup) return attempt.cleanup;
    // Keep the attempt reserved through cleanup. A later same-session setup
    // waits for it, so a late detach cannot race a newly established debugger.
    attempt.cleanup = attempt.promise
      .then(
        async () => {
          if (
            session.attachAttempt !== attempt ||
            [...this.sessions.values()].some((item) => item !== session && item.tabId === session.tabId!)
          )
            return;
          try {
            await this.chrome.debugger.detach?.({ tabId: session.tabId! });
          } catch {}
        },
        () => {},
      )
      .finally(() => {
        if (session.attachAttempt === attempt) session.attachAttempt = null;
      });
    return attempt.cleanup;
  }
  async attach(session: Session, deadline?: number): Promise<void> {
    if (session.attached) return;
    let attempt = session.attachAttempt;
    if (attempt?.cleanup) {
      await readBudget(() => attempt!.cleanup!, deadline);
      if (this.sessions.get(session.id) !== session) throw fail("session_closed", "连接调试器期间任务已结束");
      return this.attach(session, deadline);
    }
    if (!attempt) {
      attempt = {
        promise: Promise.resolve().then(() => {
          if (this.sessions.get(session.id) !== session)
            throw fail("session_closed", "连接调试器期间任务已结束");
          return this.chrome.debugger.attach({ tabId: session.tabId! }, "1.3");
        }),
      };
      session.attachAttempt = attempt;
    }
    try {
      await readBudget(() => attempt.promise, deadline);
      if (this.sessions.get(session.id) !== session) throw fail("session_closed", "连接调试器期间任务已结束");
      await this.command(session, "Page.enable", {}, deadline);
      await this.command(session, "Runtime.enable", {}, deadline);
      session.attached = true;
      if (session.attachAttempt === attempt) session.attachAttempt = null;
    } catch (caught) {
      const error = errorDetails(caught);
      void this.cleanupAttach(session, attempt);
      throw error;
    }
  }
  async waitReady(session: Session, timeoutMilliseconds = this.navigationTimeout): Promise<chrome.tabs.Tab> {
    return new Promise<chrome.tabs.Tab>((resolve, reject) => {
      let settled = false,
        checking = false;
      const finish = (error?: unknown, tab?: chrome.tabs.Tab) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(poll);
        this.chrome.tabs.onUpdated.removeListener(updated);
        if (session.waitCancel === cancel) session.waitCancel = null;
        if (error) reject(error);
        else resolve(tab!);
      };
      const cancel = () => finish(fail("session_closed", "导航期间任务已结束"));
      const check = async () => {
        if (checking || settled) return;
        checking = true;
        try {
          if (this.sessions.get(session.id) !== session) return cancel();
          const tab = await this.chrome.tabs.get(session.tabId!);
          if (this.sessions.get(session.id) !== session) return cancel();
          if (session.denied) throw fail("invalid_url", "任务重定向到了禁止访问的页面");
          if (tab.pendingUrl) {
            webURL(tab.pendingUrl);
            return;
          }
          if (tab.status === "loading") return;
          webURL(tab.url);
          finish(null, tab);
        } catch (caught) {
          const error = errorDetails(caught);
          finish(error);
        } finally {
          checking = false;
        }
      };
      const updated = (tabId: number) => {
        if (tabId === session.tabId!) void check();
      };
      const timeout = setTimeout(
        () =>
          finish(
            fail("navigation_pending", "页面仍在加载；继续 browser_observe 检查同一任务页，不要重新打开"),
          ),
        Math.max(1, Math.min(this.navigationTimeout, timeoutMilliseconds)),
      );
      const poll = setInterval(() => {
        void check();
      }, 100);
      session.waitCancel = cancel;
      this.chrome.tabs.onUpdated.addListener(updated);
      void check(); // Read after subscribing to cover completion before listener registration.
    });
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
        return { id, result: { closed: true } };
      }
      if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256)
        throw fail("invalid_session", "缺少有效任务会话");
      const session = this.sessions.get(sessionId);
      if (method === "close") {
        await this.close(sessionId);
        return { id, result: { closed: true } };
      }
      if (session?.busy) throw fail("session_busy", "同一会话操作仍在进行");
      if (
        method === "open" &&
        [...this.ownedTabs].some((tabId) => ![...this.sessions.values()].some((item) => item.tabId === tabId))
      )
        throw fail("cleanup_failed", "仍有任务标签待清理，请先停止任务");
      if (method === "open") return { id, result: await this.open(sessionId, params) };
      if (!session) throw fail("session_closed", "请先创建任务标签");
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
        return { id, result };
      } finally {
        session.busy = false;
      }
    } catch (caught) {
      const error = errorDetails(caught);
      return {
        id,
        error: { code: error.code || "browser_error", message: error.message || "浏览器操作失败" },
      };
    }
  }
  async open(id: string, params: BridgeParams): Promise<Result> {
    options(params, true);
    const url = webURL(params.url),
      generation = this.generation;
    let session = this.sessions.get(id);
    if (!session) {
      // Reserve before the await so simultaneous opens cannot create two tabs.
      session = { id, tabId: null, observation: null, attached: false, revision: 0, busy: true };
      this.sessions.set(id, session);
      try {
        const tab = await this.chrome.tabs.create({ url, active: false });
        if (tab.id === undefined) throw fail("invalid_tab", "浏览器未返回任务标签标识");
        session.tabId = tab.id;
        this.ownedTabs.add(tab.id);
        if (generation !== this.generation || this.sessions.get(id) !== session) {
          await this.removeOwned(tab.id);
          throw fail("session_closed", "创建期间任务已结束");
        }
        await this.persistOwnership();
      } catch (caught) {
        const error = errorDetails(caught);
        if (this.sessions.get(id) === session) this.sessions.delete(id);
        if (session.tabId !== null) await this.removeOwned(session.tabId!);
        throw error;
      }
    } else {
      session.busy = true;
      session.observation = null;
      session.revision++;
      session.denied = false;
      try {
        await this.chrome.tabs.update(session.tabId!, { url });
      } catch (caught) {
        const error = errorDetails(caught);
        session.busy = false;
        throw error;
      }
    }
    try {
      const deadline = performance.now() + this.navigationTimeout;
      const tab = await this.waitReady(session);
      return await this.afterObservation(
        session,
        params,
        { url: tab.url, title: tab.title || "", tab_id: tab.id, navigation_state: "ready" },
        false,
        deadline,
      );
    } catch (caught) {
      const error = errorDetails(caught);
      if (error.code === "navigation_pending") return await this.loading(session, url);
      await this.close(id, session);
      throw error;
    } finally {
      session.busy = false;
    }
  }
  async loading(session: Session, requestedURL?: string): Promise<Result> {
    if (this.sessions.get(session.id) !== session) throw fail("session_closed", "任务已结束");
    const tab = await this.chrome.tabs.get(session.tabId!);
    if (this.sessions.get(session.id) !== session) throw fail("session_closed", "任务已结束");
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
    session: Session,
    params: BridgeParams,
    result: Result,
    waitForNavigation = false,
    deadline = performance.now() + this.navigationTimeout,
    waitAfterMilliseconds = 0,
  ): Promise<Result> {
    if (params.observe_after === false) return result;
    try {
      await this.waitAfterAction(session, waitAfterMilliseconds, deadline);
      if (waitForNavigation) await this.waitReady(session, deadline - performance.now());
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
  private async waitAfterAction(session: Session, milliseconds: number, deadline: number): Promise<void> {
    if (milliseconds === 0) return;
    if (this.sessions.get(session.id) !== session) throw fail("session_closed", "任务已结束");
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
  async stableObservation(session: Session, params: BridgeParams, deadline: number): Promise<Result> {
    let retryDeadline: number | undefined;
    for (let attempt = 0; attempt <= MAX_READ_RETRIES; attempt++) {
      try {
        if (attempt) await this.waitReady(session, retryDeadline! - performance.now());
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
    session: Session,
    params: BridgeParams,
    deadline = performance.now() + this.navigationTimeout,
  ): Promise<Result> {
    options(params);
    const query = typeof params.query === "string" ? params.query.trim() : "";
    const initial = await readBudget(() => this.chrome.tabs.get(session.tabId!), deadline);
    if (initial.status === "loading" || initial.pendingUrl) {
      session.observation = null;
      try {
        await this.waitReady(
          session,
          deadline === undefined ? this.navigationTimeout : deadline - performance.now(),
        );
      } catch (caught) {
        const error = errorDetails(caught);
        if (error.code === "navigation_pending") return this.loading(session);
        throw error;
      }
    }
    session.observation = null;
    await this.valid(session, deadline);
    await this.attach(session, deadline);
    const revision = session.revision;
    const { nodes = [] } = await this.command(session, "Accessibility.getFullAXTree", {}, deadline);
    // Visible page text supplies context once. AX labels alone repeat every
    // StaticText/InlineTextBox and may exhaust the limit before real controls.
    const visible = await this.command(
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
    const needle = query.toLowerCase();
    let matches = 0,
      truncated = page.truncated === true || page.text.length > MAX_PAGE_SCAN;
    for (const node of nodes) {
      if (node.ignored || !node.backendDOMNodeId) continue;
      const role = String(node.role?.value || "").toLowerCase();
      const properties = Object.fromEntries(
        (node.properties || []).map((item) => [item.name, item.value?.value]),
      );
      if (!INTERACTIVE_ROLES.has(role) && properties.focusable !== true && !properties.editable) continue;
      const name = String(node.name?.value || ""),
        value = properties.protected === true ? "" : String(node.value?.value || "");
      if (needle && !`${name}\n${value}`.toLowerCase().includes(needle)) continue;
      matches++;
      if (candidates.length >= MAX_ELEMENTS) {
        truncated = true;
        continue;
      }
      const element_ref = `e${candidates.length + 1}`;
      const item: ElementResult = { element_ref, role, name: name.slice(0, 240) };
      if (value) item.value = value.slice(0, 240);
      if (name.length > 240 || value.length > 240) truncated = true;
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
    const tab = await this.valid(session, deadline);
    const selectedText = excerpt(page.text.slice(0, MAX_PAGE_SCAN), query);
    const result: Result & { elements: ElementResult[] } = {
      observation_id: this.uuid(),
      expires_in: OBSERVATION_SECONDS,
      url: tab.url,
      title: (tab.title || "").slice(0, 200),
      text: selectedText.text,
      elements: [],
      elements_total: matches,
      truncated: truncated || selectedText.truncated,
    };
    if (tab.url!.length > 2000) {
      delete result.url;
      result.url_preview = tab.url!.slice(0, 2000);
      result.url_truncated = true;
      result.truncated = true;
    }
    if (query) result.query = query;
    // Reserve space before enriching links, so a bounded response does not
    // incur one CDP round trip for every link in a large document.
    const selected: typeof candidates = [];
    let planned = JSON.stringify(result).length;
    for (const candidate of candidates) {
      const cost = JSON.stringify(candidate.item).length + 2 + (candidate.item.role === "link" ? 128 : 0);
      if (planned + cost > OBSERVATION_BUDGET - 200) {
        result.truncated = true;
        break;
      }
      selected.push(candidate);
      planned += cost;
    }
    for (let offset = 0; offset < selected.length; offset += LINK_CONCURRENCY) {
      await Promise.all(
        selected.slice(offset, offset + LINK_CONCURRENCY).map(async (candidate) => {
          if (candidate.item.role !== "link") return;
          const { node: domNode } = await this.command(
            session,
            "DOM.describeNode",
            { backendNodeId: candidate.backendNodeId },
            deadline,
          );
          const attributes = domNode?.attributes || [];
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
      if (JSON.stringify(result).length > OBSERVATION_BUDGET - 200) {
        result.elements.pop();
        result.truncated = true;
        break;
      }
      refs.set(candidate.item.element_ref, candidate.backendNodeId);
    }
    if (result.elements.length < matches) result.truncated = true;
    if (result.truncated)
      result.next_step = "Use browser_observe with query to focus on omitted page text or controls";
    if (params.screenshot) {
      const screenshot = await this.command(
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
    const current = await this.valid(session, deadline);
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
  async locateAct(session: Session, params: BridgeParams): Promise<Result> {
    if (typeof params.selector !== "string" || !params.selector || params.selector.length > 2000)
      throw fail("invalid_params", "需要 CSS selector");
    const tab = await this.valid(session);
    await this.attach(session);
    let backendNodeId: number | undefined;
    if (params.frame_selector !== undefined) {
      const frame = await this.frameTarget(session, params.frame_selector);
      try {
        const resolved = await this.command(session, "Runtime.callFunctionOn", {
          objectId: frame.objectId,
          functionDeclaration:
            "function(selector){const nodes=this.contentDocument.querySelectorAll(selector);if(nodes.length!==1)throw new Error('Target must match exactly once');return nodes[0]}",
          arguments: [{ value: params.selector }],
          returnByValue: false,
        });
        if (resolved.exceptionDetails || !resolved.result?.objectId)
          throw fail("target_not_unique", "frame selector 必须恰好匹配一个元素");
        const { node } = await this.command(session, "DOM.describeNode", {
          objectId: resolved.result.objectId,
        });
        backendNodeId = node?.backendNodeId;
      } finally {
        await this.command(session, "Runtime.releaseObjectGroup", { objectGroup: "abridge-frame" }).catch(
          () => {},
        );
      }
    } else {
      const { root } = await this.command(session, "DOM.getDocument", {});
      const { nodeIds } = await this.command(session, "DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: params.selector,
      });
      if (nodeIds.length !== 1) throw fail("target_not_unique", "selector 必须恰好匹配一个元素");
      const { node } = await this.command(session, "DOM.describeNode", { nodeId: nodeIds[0] });
      backendNodeId = node?.backendNodeId;
    }
    if (!backendNodeId) throw fail("target_missing", "目标元素不存在");
    const id = this.uuid();
    session.observation = {
      id,
      refs: new Map([["target", backendNodeId]]),
      revision: session.revision,
      expires: this.now() + OBSERVATION_SECONDS * 1000,
      url: tab.url!,
    };
    return this.act(session, {
      ...params,
      observation_id: id,
      action: { ...(params.action as Record<string, unknown>), element_ref: "target" },
      observe_after: false,
      wait_after_ms: 0,
    });
  }
  async frameTarget(
    session: Session,
    selector: unknown,
    deadline?: number,
  ): Promise<{ objectId: string; frameId: string }> {
    if (typeof selector !== "string" || !selector || selector.length > 2000)
      throw fail("invalid_params", "frame_selector 无效");
    await this.valid(session, deadline);
    await this.attach(session, deadline);
    const frame = await this.command(
      session,
      "Runtime.evaluate",
      {
        expression: `(()=>{const frames=document.querySelectorAll(${JSON.stringify(selector)});if(frames.length!==1)return 'frame_not_unique';const frame=frames[0];if(frame.tagName!=='IFRAME'||!frame.contentDocument)return 'unsupported_frame';return frame})()`,
        returnByValue: false,
        objectGroup: "abridge-frame",
      },
      deadline,
    );
    if (frame.exceptionDetails || !frame.result?.objectId)
      throw fail("unsupported_frame", "frame 必须唯一且为已加载的同源 iframe；不会转投主文档");
    try {
      const { node } = await this.command(
        session,
        "DOM.describeNode",
        { objectId: frame.result.objectId },
        deadline,
      );
      if (!node?.frameId) throw fail("unsupported_frame", "无法确定 iframe 文档；不会转投主文档");
      return { objectId: frame.result.objectId, frameId: node.frameId };
    } catch (error) {
      await this.command(session, "Runtime.releaseObjectGroup", { objectGroup: "abridge-frame" }).catch(
        () => {},
      );
      throw error;
    }
  }
  async pageValue(
    session: Session,
    expression: string,
    timeout = 10000,
    frameSelector?: unknown,
  ): Promise<unknown> {
    const deadline = performance.now() + timeout;
    await this.valid(session, deadline);
    await this.attach(session, deadline);
    const frame =
      frameSelector === undefined ? undefined : await this.frameTarget(session, frameSelector, deadline);
    let result: CdpResults["Runtime.evaluate"];
    try {
      const contextId = frame && this.frameContexts.get(session.tabId!)?.get(frame.frameId);
      if (frame && contextId === undefined)
        throw fail("unsupported_frame", "iframe 执行上下文不可用；不会转投主文档");
      result = await this.command(
        session,
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true, timeout, ...(frame ? { contextId } : {}) },
        deadline,
      );
    } finally {
      if (frame)
        await this.command(session, "Runtime.releaseObjectGroup", { objectGroup: "abridge-frame" }).catch(
          () => {},
        );
    }
    if (result.exceptionDetails) throw fail("page_script_failed", "页面脚本执行失败");
    return result.result?.value ?? null;
  }
  async evaluate(session: Session, params: BridgeParams): Promise<Result> {
    if (typeof params.expression !== "string" || params.expression.length > 65536)
      throw fail("invalid_params", "expression 过长或无效");
    const timeout = typeof params.timeout_ms === "number" ? params.timeout_ms : 10000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 20000)
      throw fail("invalid_params", "timeout_ms 无效");
    session.observation = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        this.pageValue(session, params.expression, timeout, params.frame_selector),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // A timed-out script may already have written: terminate and release its tab.
            void this.close(session.id, session);
            reject(fail("outcome_unknown", "脚本超时，任务已释放；不要重放"));
          }, timeout);
        }),
      ]);
      if (JSON.stringify(value).length > 24000)
        throw fail("result_too_large", "脚本结果超过24000字符，请在代码中分页或汇总");
      return { value, executed: true };
    } catch (caught) {
      const error = errorDetails(caught);
      if (!["invalid_params", "unsupported_frame", "result_too_large"].includes(error.code || "")) {
        await this.close(session.id, session);
        throw fail("outcome_unknown", "脚本可能已有副作用，任务已释放；不要重放");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async read(session: Session, params: BridgeParams): Promise<Result> {
    const mode = params.mode === undefined ? "text" : params.mode;
    if (mode !== "text" && mode !== "tables") throw fail("invalid_params", "mode 必须为 text/tables");
    const offset = params.offset === undefined ? 0 : params.offset;
    const limit = params.limit === undefined ? (mode === "text" ? 12000 : 100) : params.limit;
    if (
      !Number.isInteger(offset) ||
      (offset as number) < 0 ||
      !Number.isInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > 24000
    )
      throw fail("invalid_params", "分页参数无效");
    if (
      params.selector !== undefined &&
      (typeof params.selector !== "string" || params.selector.length > 2000)
    )
      throw fail("invalid_params", "selector 无效");
    const initial = await this.valid(session);
    if (params.snapshot_id !== undefined) {
      if (!session.snapshot || session.snapshot.id !== params.snapshot_id || session.snapshot.format !== mode)
        throw fail("snapshot_missing", "快照不存在或格式不同");
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
      const current = await this.valid(session);
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
        id: this.uuid(),
        format: mode,
        value: saved,
        url: sourceURL!,
        truncated,
        coverage: params.frame_selector ? "loaded_same_origin_frame" : "loaded_main_document",
      };
    }
    const snapshot = session.snapshot!;
    const start = offset as number;
    let end = Math.min(
      snapshot.value.length,
      start + Math.min(limit as number, mode === "text" ? 24000 : 200),
    );
    let page = snapshot.value.slice(start, end);
    while (JSON.stringify(page).length > 24000 && end > start + 1) {
      end--;
      page = snapshot.value.slice(start, end);
    }
    if (JSON.stringify(page).length > 24000)
      throw fail("result_too_large", "单行数据超过返回预算，请用脚本提取较小字段");
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
  async wait(session: Session, params: BridgeParams): Promise<Result> {
    const state = typeof params.state === "string" ? params.state : "visible";
    const timeout = typeof params.timeout_ms === "number" ? params.timeout_ms : 10000;
    if (
      !["visible", "hidden", "attached", "detached", "value"].includes(state) ||
      !Number.isInteger(timeout) ||
      timeout < 0 ||
      timeout > 20000 ||
      (params.selector === undefined && params.text === undefined)
    )
      throw fail("invalid_params", "等待条件无效");
    if (
      (params.selector !== undefined && typeof params.selector !== "string") ||
      (params.text !== undefined && typeof params.text !== "string")
    )
      throw fail("invalid_params", "等待目标无效");
    const deadline = performance.now() + timeout;
    const expression = `(${checkCondition.toString()})(${JSON.stringify(params.selector)},${JSON.stringify(params.text)},${JSON.stringify(state)},${JSON.stringify(params.value)})`;
    do {
      try {
        if (
          await this.pageValue(
            session,
            expression,
            Math.max(1, Math.ceil(deadline - performance.now())),
            params.frame_selector,
          )
        )
          return { matched: true, state };
      } catch (caught) {
        if (errorDetails(caught).code === "observation_timeout") break;
        throw caught;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await this.waitAfterAction(session, Math.min(100, Math.max(1, remaining - 1)), deadline + 1);
    } while (performance.now() < deadline);
    throw fail("wait_timeout", "等待条件未在期限内满足");
  }
  async act(session: Session, params: BridgeParams): Promise<Result> {
    options(params, true);
    const parsedWait = actWaitAfterSchema.safeParse(params.wait_after_ms);
    if (!parsedWait.success) throw fail("invalid_params", "wait_after_ms 必须是 0–10000 的整数毫秒");
    const observation = session.observation;
    const action = params.action as
      | {
          type?: string;
          element_ref?: string;
          text?: unknown;
          key?: string;
          values?: string[];
          delta_x?: number;
          delta_y?: number;
        }
      | undefined;
    if (
      !observation ||
      observation.id !== params.observation_id ||
      observation.expires <= this.now() ||
      observation.revision !== session.revision
    )
      throw fail("stale_observation", "观察已失效，请重新观察");
    if (
      !action ||
      !["click", "fill", "press", "select", "scroll", "hover"].includes(action.type || "") ||
      !observation.refs.has(action.element_ref || "")
    )
      throw fail("invalid_action", "需要当前观察中的精确元素和支持的动作");
    if (action.type === "fill" && (typeof action.text !== "string" || action.text.length > MAX_TEXT))
      throw fail("invalid_action", "填充文本无效或过长");
    if (action.type === "press" && (typeof action.key !== "string" || !action.key || action.key.length > 32))
      throw fail("invalid_action", "key 无效");
    if (
      action.type === "select" &&
      (!Array.isArray(action.values) ||
        !action.values.length ||
        !action.values.every((value) => typeof value === "string"))
    )
      throw fail("invalid_action", "values 无效");
    if (
      action.type === "scroll" &&
      ![action.delta_x ?? 0, action.delta_y ?? 0].every(
        (value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10000,
      )
    )
      throw fail("invalid_action", "滚动距离无效");
    const tab = await this.valid(session);
    if (tab.url !== observation.url || tab.status === "loading" || tab.pendingUrl)
      throw fail("stale_observation", "页面已变化，请重新观察");
    const { object } = await this.command(session, "DOM.resolveNode", {
      backendNodeId: observation.refs.get(action.element_ref!),
      objectGroup: "abridge-action",
    });
    if (!object?.objectId) throw fail("stale_observation", "元素已不存在");
    try {
      if (session.revision !== observation.revision) throw fail("stale_observation", "页面已导航");
      let response: CdpResults["Runtime.callFunctionOn"] = {};
      const native = ["click", "fill", "hover", "press", "scroll"].includes(action.type!);
      let point: { x: number; y: number } | undefined;
      if (native) {
        const prepared = await this.command(session, "Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: prepareInput.toString(),
          returnByValue: true,
        });
        if (prepared.exceptionDetails) throw fail("action_failed", "元素不可见、被遮挡或不可用");
        point = prepared.result?.value as { x: number; y: number } | undefined;
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
          throw fail("action_failed", "无法确定输入位置");
      }
      const assertCurrentDocument = async () => {
        const currentTab = await this.valid(session);
        if (
          session.revision !== observation.revision ||
          currentTab.url !== observation.url ||
          currentTab.status === "loading" ||
          currentTab.pendingUrl
        )
          throw fail("stale_observation", "准备输入期间页面已导航，请重新观察");
      };
      await assertCurrentDocument();
      session.observation = null;
      try {
        if (action.type === "click" || action.type === "hover" || action.type === "scroll") {
          await this.command(session, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
          await assertCurrentDocument();
          if (action.type === "click") {
            try {
              await this.command(session, "Input.dispatchMouseEvent", {
                type: "mousePressed",
                ...point,
                button: "left",
                clickCount: 1,
              });
            } finally {
              await this.command(session, "Input.dispatchMouseEvent", {
                type: "mouseReleased",
                ...point,
                button: "left",
                clickCount: 1,
              });
            }
          } else if (action.type === "scroll") {
            await this.command(session, "Input.dispatchMouseEvent", {
              type: "mouseWheel",
              ...point,
              deltaX: action.delta_x || 0,
              deltaY: action.delta_y || 0,
            });
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
            await this.command(session, "Input.dispatchKeyEvent", {
              type: "keyDown",
              ...payload,
              ...(key.length === 1 || key === "Space" ? { text: payload.key } : {}),
            });
          } finally {
            await this.command(session, "Input.dispatchKeyEvent", { type: "keyUp", ...payload });
          }
        } else if (action.type === "fill") {
          const prepared = await this.command(session, "Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: prepareFill.toString(),
            returnByValue: true,
          });
          if (prepared.exceptionDetails) throw fail("action_failed", "字段不可编辑");
          await assertCurrentDocument();
          if ((prepared.result?.value as { select_all?: boolean } | undefined)?.select_all) {
            try {
              await this.command(session, "Input.dispatchKeyEvent", {
                type: "rawKeyDown",
                key: "a",
                code: "KeyA",
                windowsVirtualKeyCode: 65,
                modifiers: 2,
                commands: ["selectAll"],
              });
            } finally {
              await this.command(session, "Input.dispatchKeyEvent", {
                type: "keyUp",
                key: "a",
                code: "KeyA",
                windowsVirtualKeyCode: 65,
                modifiers: 2,
              });
            }
          }
          await assertCurrentDocument();
          if (action.text === "") {
            try {
              await this.command(session, "Input.dispatchKeyEvent", {
                type: "rawKeyDown",
                key: "Backspace",
                windowsVirtualKeyCode: 8,
              });
            } finally {
              await this.command(session, "Input.dispatchKeyEvent", {
                type: "keyUp",
                key: "Backspace",
                windowsVirtualKeyCode: 8,
              });
            }
          } else await this.command(session, "Input.insertText", { text: action.text });
        } else {
          response = await this.command(session, "Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: selectValues.toString(),
            arguments: [{ value: action.values }],
            returnByValue: true,
          });
        }
      } catch {
        let cleanupFailed = false;
        try {
          await this.close(session.id, session);
        } catch {
          cleanupFailed = true;
        }
        throw fail(
          "outcome_unknown",
          cleanupFailed
            ? "动作结果未知且任务标签清理失败，已保留清理记录；不会重放"
            : "动作结果未知，任务已释放；不会重放",
        );
      }
      if (response.exceptionDetails) throw fail("action_failed", "网页拒绝了 DOM 操作，请重新观察");
      return await this.afterObservation(
        session,
        params,
        {
          executed: true,
          route: native ? "cdp_input" : action.type === "select" ? "select_value" : "replace_value",
        },
        true,
        performance.now() + this.navigationTimeout,
        parsedWait.data,
      );
    } finally {
      try {
        await this.command(session, "Runtime.releaseObjectGroup", { objectGroup: "abridge-action" });
      } catch {}
    }
  }
  async removeOwned(tabId: number) {
    if (!this.ownedTabs.has(tabId)) return;
    this.frameContexts.delete(tabId);
    try {
      await this.chrome.tabs.remove(tabId);
    } catch {
      let exists = true;
      try {
        await this.chrome.tabs.get(tabId);
      } catch {
        exists = false;
      }
      if (exists) {
        await this.persistOwnership();
        throw fail("cleanup_failed", "任务标签关闭失败，已保留待清理记录");
      }
    }
    this.ownedTabs.delete(tabId);
    await this.persistOwnership();
  }
  async close(id: string, expected?: Session) {
    const session = this.sessions.get(id);
    if (expected && session !== expected) return;
    this.sessions.delete(id);
    if (session) {
      session.observation = null;
      session.waitCancel?.();
      if (session.tabId !== null) await this.removeOwned(session.tabId!);
    }
  }
  async stop() {
    this.generation++;
    for (const session of this.sessions.values()) {
      session.observation = null;
      session.waitCancel?.();
    }
    this.sessions.clear();
    const results = await Promise.allSettled([...this.ownedTabs].map((id) => this.removeOwned(id)));
    if (results.some((result) => result.status === "rejected"))
      throw fail("cleanup_failed", "部分任务标签仍待清理，已保留记录");
  }
}
