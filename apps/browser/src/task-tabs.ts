/** Owns task tabs, debugger connections and cleanup across asynchronous browser events. */
import type { OperationError } from "@abridge/protocol";
import { fail, errorDetails } from "./types.js";
interface AXValue {
  sources?: { attribute?: string; superseded?: boolean; value?: { value?: unknown } }[];
  value?: unknown;
}
interface AXNode {
  nodeId?: string;
  parentId?: string;
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: AXValue;
  name?: AXValue;
  description?: AXValue;
  value?: AXValue;
  properties?: { name: string; value?: AXValue }[];
}
export interface CdpResults {
  "Accessibility.getFullAXTree": { nodes?: AXNode[] };
  "Runtime.getProperties": { result?: { name: string; value?: { value?: unknown; objectId?: string } }[] };
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
interface OpenedTab {
  tab_id: number;
  url_omitted?: boolean;
  title?: string;
  url?: string;
  recovery?: { action: "browser_open" };
}
function captureOpenedTab(
  entry: OpenedTab,
  tab: Pick<chrome.tabs.Tab, "url" | "pendingUrl" | "title" | "status">,
) {
  const url = tab.url && tab.url !== "about:blank" ? tab.url : tab.pendingUrl;
  if (!url || !/^https?:\/\//i.test(url) || (entry.url && url !== entry.url)) return;
  if (url.length > 2000) {
    entry.url_omitted = true;
    return;
  }
  delete entry.url_omitted;
  entry.url = url;
  entry.recovery = { action: "browser_open" };
  if (tab.url === url && tab.status !== "loading" && tab.title) entry.title = tab.title.slice(0, 160);
}
export interface TaskTab {
  openedTabs?: OpenedTab[];
  capturingTabs?: boolean;
  childUrlDeadline?: number;
  invalidatedObservation?: { id: string; reason: string };
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
    selector?: string;
    frameSelector?: string;
  };
  denied?: boolean;
  creation?: Promise<void>;
  closing?: Promise<void>;
  attachAttempt?: AttachAttempt | null;
  waitCancel?: (() => void) | null;
}
export async function readBudget<T>(operation: () => Promise<T>, deadline?: number): Promise<T> {
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
export function missingTaskTab() {
  return Object.assign(fail("task_tab_missing", "当前任务页已不存在；使用 browser_open 创建任务页"), {
    recovery: { action: "browser_open" as const, task_tab: "missing" as const },
  });
}
export function diagnostic(error: ReturnType<typeof errorDetails>) {
  return { code: (error.code || "browser_error").slice(0, 100), message: error.message.slice(0, 2000) };
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
export class TaskTabs {
  readonly chrome: typeof chrome;
  readonly navigationTimeout: number;
  private readonly taskRecords = new Map<string, TaskTab>();
  private generation = 0;
  private disposed = false;
  private readonly releaseListeners: (() => void)[] = [];
  private ownershipWrites = Promise.resolve();
  private readonly ownedTabIds = new Set<number>();
  private readonly closingTasks = new Map<string, TaskTab>();
  private readonly pendingOpens = new Map<string, { cancelled: boolean }>();
  private readonly removingTabs = new Map<number, Promise<void>>();
  private readonly contexts = new Map<number, Map<string, number>>();
  get tasks(): ReadonlyMap<string, TaskTab> {
    return this.taskRecords;
  }
  get ownedTabs(): ReadonlySet<number> {
    return this.ownedTabIds;
  }
  get frameContexts(): ReadonlyMap<number, ReadonlyMap<string, number>> {
    return this.contexts;
  }
  constructor(
    chrome: typeof globalThis.chrome,
    {
      navigationTimeout = 15000,
      ownedTabs = [],
    }: { navigationTimeout?: number; ownedTabs?: readonly number[] } = {},
  ) {
    this.chrome = chrome;
    this.navigationTimeout = navigationTimeout;
    for (const tabId of ownedTabs) this.ownedTabIds.add(tabId);
    // The source navigation event also identifies target=_blank links with implicit noopener.
    const targetCreated = chrome.webNavigation?.onCreatedNavigationTarget;
    const onTargetCreated: Parameters<
      typeof chrome.webNavigation.onCreatedNavigationTarget.addListener
    >[0] = ({ sourceTabId, tabId, url }) => {
      for (const session of this.taskRecords.values()) {
        if (!session.capturingTabs || session.tabId !== sourceTabId) continue;
        const entries = (session.openedTabs ??= []);
        if (entries.length === 3 || entries.some((entry) => entry.tab_id === tabId)) return;
        const entry: OpenedTab = { tab_id: tabId };
        captureOpenedTab(entry, { url });
        entries.push(entry);
      }
    };
    targetCreated?.addListener(onTargetCreated);
    this.releaseListeners.push(() => targetCreated?.removeListener(onTargetCreated));
    const onUpdated: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (id, change, tab) => {
      for (const session of this.taskRecords.values()) {
        const child = session.openedTabs?.find((entry) => entry.tab_id === id);
        if (!child || !tab || child.url_omitted) continue;
        // A new target may still be about:blank when the input receipt returns.
        const awaitingMetadata = performance.now() < (session.childUrlDeadline ?? 0);
        if (session.capturingTabs || awaitingMetadata) captureOpenedTab(child, tab);
      }
      for (const session of this.taskRecords.values())
        if (session.tabId === id && (change.status === "loading" || change.url)) {
          if (session.observation)
            session.invalidatedObservation = {
              id: session.observation.id,
              reason: change.url ? "页面地址已变化" : "页面开始重新加载",
            };
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
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    this.releaseListeners.push(() => chrome.tabs.onUpdated.removeListener(onUpdated));
    const onRemoved: Parameters<typeof chrome.tabs.onRemoved.addListener>[0] = (id) => {
      for (const session of this.taskRecords.values())
        if (session.openedTabs)
          session.openedTabs = session.openedTabs.filter((entry) => entry.tab_id !== id);
      this.contexts.delete(id);
      this.ownedTabIds.delete(id);
      void this.persistOwnership().catch(() => {});
      for (const [key, session] of this.taskRecords)
        if (session.tabId === id) {
          this.taskRecords.delete(key);
          session.waitCancel?.();
        }
    };
    chrome.tabs.onRemoved.addListener(onRemoved);
    this.releaseListeners.push(() => chrome.tabs.onRemoved.removeListener(onRemoved));
    const onDetach: Parameters<typeof chrome.debugger.onDetach.addListener>[0] = (source) => {
      if (source.tabId !== undefined) this.contexts.delete(source.tabId);
      for (const session of this.taskRecords.values())
        if (source.tabId === session.tabId!) {
          session.attached = false;
          session.observation = null;
          session.revision++;
          session.waitCancel?.();
        }
    };
    chrome.debugger.onDetach.addListener(onDetach);
    this.releaseListeners.push(() => chrome.debugger.onDetach.removeListener(onDetach));
    const onEvent: Parameters<typeof chrome.debugger.onEvent.addListener>[0] = (source, method, params) => {
      if (source.tabId === undefined || !this.ownedTabIds.has(source.tabId)) return;
      const data = params as
        | {
            context?: { id?: number; auxData?: { frameId?: string; isDefault?: boolean } };
            executionContextId?: number;
          }
        | undefined;
      if (method === "Runtime.executionContextsCleared") this.contexts.delete(source.tabId);
      else if (method === "Runtime.executionContextCreated") {
        const context = data?.context;
        if (context?.auxData?.isDefault && context.auxData.frameId && typeof context.id === "number") {
          let contexts = this.contexts.get(source.tabId);
          if (!contexts) this.contexts.set(source.tabId, (contexts = new Map()));
          contexts.set(context.auxData.frameId, context.id);
        }
      } else if (method === "Runtime.executionContextDestroyed") {
        const contexts = this.contexts.get(source.tabId);
        for (const [frameId, contextId] of contexts ?? [])
          if (contextId === data?.executionContextId) contexts!.delete(frameId);
      }
    };
    chrome.debugger.onEvent?.addListener(onEvent);
    this.releaseListeners.push(() => chrome.debugger.onEvent?.removeListener(onEvent));
  }
  private async persistOwnership() {
    if (!this.chrome.storage?.session) return;
    const ids = [...this.ownedTabIds];
    this.ownershipWrites = this.ownershipWrites
      .catch(() => {})
      .then(() => this.chrome.storage.session.set({ owned_task_tabs: ids }));
    await this.ownershipWrites;
  }
  async command<M extends keyof CdpResults>(
    session: TaskTab,
    method: M,
    params: Record<string, unknown> = {},
    deadline?: number,
  ): Promise<CdpResults[M]> {
    if (this.taskRecords.get(session.id) !== session) throw fail("session_closed", "任务已结束");
    const result = await readBudget(
      () => this.chrome.debugger.sendCommand({ tabId: session.tabId! }, method, params),
      deadline,
    );
    if (this.taskRecords.get(session.id) !== session) throw fail("session_closed", "任务已结束");
    return result as CdpResults[M];
  }
  async valid(session: TaskTab, deadline?: number) {
    if (!session || this.taskRecords.get(session.id) !== session) throw missingTaskTab();
    let tab: chrome.tabs.Tab;
    try {
      tab = await readBudget(() => this.chrome.tabs.get(session.tabId!), deadline);
    } catch (error) {
      if (errorDetails(error).code === "observation_timeout") throw error;
      throw missingTaskTab();
    }
    if (this.taskRecords.get(session.id) !== session) throw fail("session_closed", "任务已结束");
    if (session.denied) throw fail("invalid_url", "任务重定向到了禁止访问的页面");
    webURL(tab.url);
    return tab;
  }
  private cleanupAttach(session: TaskTab, attempt: AttachAttempt) {
    if (attempt.cleanup) return attempt.cleanup;
    // Keep the attempt reserved through cleanup. A later same-session setup
    // waits for it, so a late detach cannot race a newly established debugger.
    attempt.cleanup = attempt.promise
      .then(
        async () => {
          if (
            session.attachAttempt !== attempt ||
            [...this.taskRecords.values()].some((item) => item !== session && item.tabId === session.tabId!)
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
  async attach(session: TaskTab, deadline?: number): Promise<void> {
    if (session.attached) return;
    let attempt = session.attachAttempt;
    if (attempt?.cleanup) {
      await readBudget(() => attempt!.cleanup!, deadline);
      if (this.taskRecords.get(session.id) !== session)
        throw fail("session_closed", "连接调试器期间任务已结束");
      return this.attach(session, deadline);
    }
    if (!attempt) {
      attempt = {
        promise: Promise.resolve().then(() => {
          if (this.taskRecords.get(session.id) !== session)
            throw fail("session_closed", "连接调试器期间任务已结束");
          return this.chrome.debugger.attach({ tabId: session.tabId! }, "1.3");
        }),
      };
      session.attachAttempt = attempt;
    }
    try {
      await readBudget(() => attempt.promise, deadline);
      if (this.taskRecords.get(session.id) !== session)
        throw fail("session_closed", "连接调试器期间任务已结束");
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
  async waitReady(session: TaskTab, timeoutMilliseconds = this.navigationTimeout): Promise<chrome.tabs.Tab> {
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
          if (this.taskRecords.get(session.id) !== session) return cancel();
          const tab = await this.chrome.tabs.get(session.tabId!);
          if (this.taskRecords.get(session.id) !== session) return cancel();
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
  async open<T>(
    id: string,
    url: string,
    isCancelled: () => boolean,
    onExecutionStart: () => void,
    run: (session: TaskTab, cancelled: () => boolean) => Promise<T>,
  ): Promise<T> {
    if (this.disposed) throw fail("session_closed", "浏览器运行时已关闭");
    const generation = this.generation;
    if (this.taskRecords.get(id)?.busy || this.pendingOpens.has(id))
      throw fail("session_busy", "同一会话操作仍在进行");
    const opening = { cancelled: false };
    this.pendingOpens.set(id, opening);
    const cancelled = () => opening.cancelled || isCancelled();
    try {
      const closing = this.closingTasks.get(id);
      if (closing?.closing) await closing.closing;
      if (!this.taskRecords.has(id)) {
        await Promise.all([...this.closingTasks.values()].map((item) => item.closing));
        if (
          [...this.ownedTabIds].some(
            (tabId) => ![...this.taskRecords.values()].some((item) => item.tabId === tabId),
          )
        )
          throw fail("cleanup_failed", "仍有任务标签待清理，请先停止任务");
      }
      if (generation !== this.generation || cancelled()) throw fail("session_closed", "任务已停止");
      if (this.taskRecords.get(id)?.busy) throw fail("session_busy", "同一会话操作仍在进行");
      onExecutionStart();
      const session = await this.navigate(id, url, cancelled);
      try {
        return await run(session, cancelled);
      } finally {
        session.busy = false;
      }
    } finally {
      if (this.pendingOpens.get(id) === opening) this.pendingOpens.delete(id);
    }
  }
  private async navigate(id: string, url: string, isCancelled: () => boolean): Promise<TaskTab> {
    const generation = this.generation;
    let session = this.taskRecords.get(id);
    if (!session) {
      // Reserve before the await so simultaneous opens cannot create two tabs.
      session = { id, tabId: null, observation: null, attached: false, revision: 0, busy: true };
      this.taskRecords.set(id, session);
      try {
        const reserved = session;
        session.creation = this.chrome.tabs.create({ url, active: false }).then((tab) => {
          if (tab.id === undefined) throw fail("invalid_tab", "浏览器未返回任务标签标识");
          reserved.tabId = tab.id;
          this.ownedTabIds.add(tab.id);
        });
        await session.creation;
        if (generation !== this.generation || this.taskRecords.get(id) !== session || isCancelled()) {
          throw Object.assign(fail("session_closed", "创建期间任务已结束；不要重放"), {
            status: "outcome_unknown" as const,
          });
        }
        await this.persistOwnership();
        if (isCancelled())
          throw Object.assign(fail("operation_cancelled", "创建期间任务已取消；不要重放"), {
            status: "outcome_unknown" as const,
          });
      } catch (caught) {
        const error = errorDetails(caught);
        try {
          await this.close(id, session);
        } catch (cleanup) {
          throw await this.uncertainFailure(
            session,
            Object.assign(error, { cleanup_error: diagnostic(errorDetails(cleanup)) }),
          );
        }
        if (error.status === "outcome_unknown")
          error.recovery = { action: "browser_open", task_tab: "closed" };
        throw error;
      }
    } else {
      session.busy = true;
      session.observation = null;
      session.revision++;
      session.denied = false;
      session.openedTabs = undefined;
      try {
        await this.chrome.tabs.update(session.tabId!, { url });
        if (isCancelled()) throw fail("operation_cancelled", "导航期间任务已取消；不要重放");
      } catch (caught) {
        session.busy = false;
        throw await this.uncertainFailure(session, caught);
      }
    }
    return session;
  }
  async uncertainFailure(session: TaskTab, caught: unknown, definite = false) {
    const cause = diagnostic(errorDetails(caught));
    let cleanupError: OperationError["cleanup_error"];
    try {
      await this.close(session.id, session);
    } catch (error) {
      cleanupError = diagnostic(errorDetails(error));
    }
    return Object.assign(fail(definite ? cause.code : "outcome_unknown", cause.message), {
      status: definite ? ("failed" as const) : ("outcome_unknown" as const),
      cause,
      ...(cleanupError ? { cleanup_error: cleanupError } : {}),
      recovery: {
        action: cleanupError ? ("stop" as const) : ("browser_open" as const),
        task_tab: cleanupError ? ("cleanup_failed" as const) : ("closed" as const),
      },
    });
  }
  private removeOwned(tabId: number): Promise<void> {
    const existing = this.removingTabs.get(tabId);
    if (existing) return existing;
    const removing = Promise.resolve()
      .then(async () => {
        if (!this.ownedTabIds.has(tabId)) return;
        this.contexts.delete(tabId);
        try {
          await this.chrome.tabs.remove(tabId);
        } catch {
          let exists = true;
          try {
            await this.chrome.tabs.get(tabId);
          } catch (caught) {
            exists =
              this.ownedTabIds.has(tabId) &&
              !/No tab with id|Missing tab|Invalid tab ID/i.test(errorDetails(caught).message);
          }
          if (exists) {
            await this.persistOwnership();
            throw fail("cleanup_failed", "任务标签关闭失败，已保留待清理记录");
          }
        }
        this.ownedTabIds.delete(tabId);
        await this.persistOwnership();
      })
      .finally(() => {
        this.removingTabs.delete(tabId);
      });
    this.removingTabs.set(tabId, removing);
    return removing;
  }
  close(id: string, expected?: TaskTab): Promise<void> {
    if (!expected) {
      const opening = this.pendingOpens.get(id);
      if (opening) opening.cancelled = true;
    }
    const session = expected ?? this.taskRecords.get(id) ?? this.closingTasks.get(id);
    if (!session) return Promise.resolve();
    if (session.closing) return session.closing;
    if (expected && this.taskRecords.get(id) !== expected) return Promise.resolve();
    this.taskRecords.delete(id);
    session.observation = null;
    session.waitCancel?.();
    this.closingTasks.set(id, session);
    session.closing = Promise.resolve()
      .then(async () => {
        // Creation may still be in flight when stop/cancel retires the session.
        await session.creation?.catch(() => {});
        if (session.tabId !== null) await this.removeOwned(session.tabId);
      })
      .then(() => {
        if (this.closingTasks.get(id) === session) this.closingTasks.delete(id);
      });
    return session.closing;
  }
  async stop() {
    this.generation++;
    for (const opening of this.pendingOpens.values()) opening.cancelled = true;
    const closing = [...this.taskRecords.values()].map((session) => this.close(session.id, session));
    closing.push(...[...this.closingTasks.values()].map((session) => session.closing!));
    await Promise.allSettled([...closing, ...[...this.ownedTabIds].map((id) => this.removeOwned(id))]);
    // A prior failed close remains observable until stop explicitly retries it.
    await this.persistOwnership();
    if (this.ownedTabIds.size) throw fail("cleanup_failed", "部分任务标签仍待清理，已保留记录");
    this.closingTasks.clear();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    try {
      await this.stop();
    } finally {
      for (const release of this.releaseListeners.splice(0)) release();
    }
  }
}
