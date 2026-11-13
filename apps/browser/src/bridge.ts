// Only this fixed protocol is available remotely; CDP and JavaScript stay internal.
import {
  OBSERVATION_SECONDS,
  MAX_IMAGE_BYTES,
  OPERATION_JOURNAL_LIMIT,
  BROWSER_MAX_ELEMENTS,
  BROWSER_MAX_TEXT,
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
    result?: { value?: { text?: unknown; truncated?: boolean; base_uri?: string } };
    exceptionDetails?: unknown;
  };
  "DOM.describeNode": { node?: { attributes?: string[] } };
  "DOM.resolveNode": { object?: { objectId?: string } };
  "Runtime.callFunctionOn": { exceptionDetails?: unknown };
  "Page.captureScreenshot": { data?: unknown };
  "Page.enable": object;
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
      this.ownedTabs.delete(id);
      void this.persistOwnership().catch(() => {});
      for (const [key, session] of this.sessions) if (session.tabId === id) this.sessions.delete(key);
    });
    chrome.debugger.onDetach.addListener((source) => {
      for (const session of this.sessions.values())
        if (source.tabId === session.tabId!) {
          session.attached = false;
          session.observation = null;
          session.revision++;
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
      if (!["open", "observe", "act", "close", "stop"].includes(method || ""))
        throw fail("unsupported_method", "不支持的浏览器方法");
      if (method === "stop") {
        await this.stop();
        return { id, result: { closed: true } };
      }
      if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256)
        throw fail("invalid_session", "缺少有效任务会话");
      const session = this.sessions.get(sessionId);
      if (session?.busy) throw fail("session_busy", "同一会话操作仍在进行");
      if (method === "close") {
        await this.close(sessionId);
        return { id, result: { closed: true } };
      }
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
          method === "observe" ? await this.observe(session, params) : await this.act(session, params);
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
  ): Promise<Result> {
    if (params.observe_after === false) return result;
    try {
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
    const page = visible.result?.value;
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
  async act(session: Session, params: BridgeParams): Promise<Result> {
    options(params, true);
    const observation = session.observation;
    const action = params.action as { type?: string; element_ref?: string; text?: unknown } | undefined;
    if (
      !observation ||
      observation.id !== params.observation_id ||
      observation.expires <= this.now() ||
      observation.revision !== session.revision
    )
      throw fail("stale_observation", "观察已失效，请重新观察");
    if (
      !action ||
      !["click", "fill"].includes(action.type || "") ||
      !observation.refs.has(action.element_ref || "")
    )
      throw fail("invalid_action", "需要当前观察中的精确元素和 click/fill 动作");
    if (action.type === "fill" && (typeof action.text !== "string" || action.text.length > MAX_TEXT))
      throw fail("invalid_action", "填充文本无效或过长");
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
      const functionDeclaration =
        action.type === "click"
          ? `function(){if(!this.isConnected)throw new Error('Element detached');this.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:this.ownerDocument.defaultView}));return true;}`
          : `function(text){if(!this.isConnected)throw new Error('Element detached');const w=this.ownerDocument.defaultView;const p=this instanceof w.HTMLInputElement?w.HTMLInputElement.prototype:this instanceof w.HTMLTextAreaElement?w.HTMLTextAreaElement.prototype:null;if(p){if(this.disabled||this.readOnly||this.type==='file')throw new Error('Field unavailable');Object.getOwnPropertyDescriptor(p,'value').set.call(this,text);}else if(this.isContentEditable){this.textContent=text;}else{throw new Error('Element is not editable');}this.dispatchEvent(new w.Event('input',{bubbles:true}));this.dispatchEvent(new w.Event('change',{bubbles:true}));return true;}`;
      let response;
      // Parameters and read-only target resolution above remain correctable.
      // Once input is dispatched the old reference is consumed even if the
      // outcome is uncertain; post-action reads never replay that input.
      session.observation = null;
      try {
        response = await this.command(session, "Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration,
          arguments: action.type === "fill" ? [{ value: action.text }] : [],
          returnByValue: true,
        });
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
        { executed: true, route: action.type === "click" ? "dom_event" : "replace_value" },
        true,
      );
    } finally {
      try {
        await this.command(session, "Runtime.releaseObjectGroup", { objectGroup: "abridge-action" });
      } catch {}
    }
  }
  async removeOwned(tabId: number) {
    if (!this.ownedTabs.has(tabId)) return;
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
