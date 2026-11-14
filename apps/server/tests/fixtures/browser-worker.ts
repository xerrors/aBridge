/** Actual extension modules and actual WS traffic; only Chrome's fixed page APIs are synthetic. */
import assert from "node:assert/strict";
import { WebSocket as NodeWebSocket } from "ws";
import { VERSION } from "@abridge/protocol";
import type { JsonObject } from "../../src/types.js";

export const EXTENSION_ID = "a".repeat(32);
export const SCREENSHOT =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5X8AAAAASUVORK5CYII=";
type Listener = (...args: unknown[]) => void;
const event = () => ({
  listeners: [] as Listener[],
  addListener(listener: Listener) {
    this.listeners.push(listener);
  },
  removeListener(listener: Listener) {
    this.listeners = this.listeners.filter((item) => item !== listener);
  },
  emit(...args: unknown[]) {
    for (const listener of [...this.listeners]) listener(...args);
  },
});
function storage(data: JsonObject) {
  return {
    async get(keys: string | string[]) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, data[key]]));
    },
    async set(values: JsonObject) {
      Object.assign(data, values);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}
export type FixtureTab = {
  id: number;
  url: string;
  title: string;
  status: "complete";
  text: string;
  clicks: number;
};
export function browserWorkerFixture(
  url: string,
  deviceId: string,
  deviceKey: string,
  authorize?: (url: string) => Promise<string>,
) {
  const local: JsonObject = {
    device: {
      server: url,
      key: deviceKey,
      device_id: deviceId,
      instance_id: "wire-fixture",
      label: "Fixed page browser",
    },
  };
  const session: JsonObject = {};
  const tabs = new Map<number, FixtureTab>([
    [
      1,
      {
        id: 1,
        url: "https://personal.fixture/",
        title: "Untouched personal tab",
        status: "complete",
        text: "personal fixture",
        clicks: 0,
      },
    ],
  ]);
  const removed: number[] = [],
    attached: number[] = [],
    detached: number[] = [];
  const commands: { tabId: number; method: string; params: JsonObject }[] = [];
  const outgoing: JsonObject[] = [],
    incoming: JsonObject[] = [];
  const sockets: BrowserSocket[] = [];
  let nextTab = 2;
  class BrowserSocket extends EventTarget {
    static OPEN = NodeWebSocket.OPEN;
    readonly peer: NodeWebSocket;
    constructor(endpoint: string) {
      super();
      this.peer = new NodeWebSocket(endpoint, { origin: `chrome-extension://${EXTENSION_ID}` });
      sockets.push(this);
      this.peer.on("open", () => this.dispatchEvent(new Event("open")));
      this.peer.on("message", (data) => {
        const raw = data.toString();
        incoming.push(JSON.parse(raw));
        this.dispatchEvent(new MessageEvent("message", { data: raw }));
      });
      this.peer.on("error", () => this.dispatchEvent(new Event("error")));
      this.peer.on("close", (code, reason) => {
        const closed = Object.assign(new Event("close"), { code, reason: reason.toString() });
        this.dispatchEvent(closed);
      });
    }
    get readyState() {
      return this.peer.readyState;
    }
    send(raw: string) {
      outgoing.push(JSON.parse(raw));
      this.peer.send(raw);
    }
    close() {
      this.peer.close();
    }
  }
  const alarms = new Map<string, object>();
  const chrome = {
    alarms: {
      onAlarm: event(),
      async get(name: string) {
        return alarms.get(name);
      },
      async create(name: string, value: object) {
        alarms.set(name, value);
      },
      async clear(name: string) {
        return alarms.delete(name);
      },
    },
    storage: { local: storage(local), session: storage(session) },
    runtime: {
      id: EXTENSION_ID,
      onStartup: event(),
      onMessage: event(),
      getManifest: () => ({ version: VERSION }),
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
      async sendMessage() {},
    },
    identity: {
      getRedirectURL: (path: string) => `https://${EXTENSION_ID}.chromiumapp.org/${path}`,
      launchWebAuthFlow: async ({ url }: { url: string }) => {
        if (!authorize) throw Error("Unexpected authorization flow");
        return authorize(url);
      },
    },
    action: { onClicked: event() },
    tabs: {
      onUpdated: event(),
      onRemoved: event(),
      async create({ url, active }: { url: string; active: boolean }) {
        assert.equal(active, false, "Task tabs must not take over the personal tab");
        const tab: FixtureTab = {
          id: nextTab++,
          url,
          title: "Fixed fixture page",
          status: "complete",
          text: "",
          clicks: 0,
        };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async get(id: number) {
        const tab = tabs.get(id);
        if (!tab) throw Error("No fixture tab");
        return { ...tab };
      },
      async update(id: number, { url }: { url: string }) {
        const tab = tabs.get(id);
        if (!tab) throw Error("No fixture tab");
        tab.url = url;
        return { ...tab };
      },
      async remove(id: number) {
        assert.notEqual(id, 1, "Personal tab must never be removed");
        removed.push(id);
        tabs.delete(id);
        chrome.tabs.onRemoved.emit(id);
      },
    },
    debugger: {
      onDetach: event(),
      async attach(target: { tabId: number }) {
        assert.notEqual(target.tabId, 1);
        attached.push(target.tabId);
      },
      async detach(target: { tabId: number }) {
        detached.push(target.tabId);
      },
      async sendCommand(target: { tabId: number }, method: string, params: JsonObject = {}) {
        const tab = tabs.get(target.tabId);
        if (!tab) throw Error("Missing task fixture");
        assert.notEqual(target.tabId, 1, "Personal tab must never be inspected");
        commands.push({ tabId: target.tabId, method, params });
        if (method === "Runtime.evaluate")
          return {
            result: {
              value: {
                text: `Message\nSubmit\n${tab.text}\nClicks: ${tab.clicks}`,
                truncated: false,
                base_uri: tab.url,
              },
            },
          };
        if (method === "Accessibility.getFullAXTree")
          return {
            nodes: [
              {
                backendDOMNodeId: 7,
                role: { value: "textbox" },
                name: { value: "Message" },
                value: { value: tab.text },
              },
              { backendDOMNodeId: 8, role: { value: "button" }, name: { value: "Submit" } },
            ],
          };
        if (method === "DOM.resolveNode")
          return { object: { objectId: `${target.tabId}:${params.backendNodeId}` } };
        if (method === "Runtime.callFunctionOn") {
          return {
            result: {
              value: String(params.functionDeclaration).includes("function prepareInput")
                ? { x: 10, y: 10 }
                : true,
            },
          };
        }
        if (method === "Input.insertText") {
          tab.text = String(params.text);
          return {};
        }
        if (method === "Input.dispatchKeyEvent") {
          if (params.type === "keyDown" && params.key === "Backspace") tab.text = "";
          return {};
        }
        if (method === "Input.dispatchMouseEvent") {
          if (params.type === "mouseReleased") tab.clicks++;
          return {};
        }
        if (method === "Page.captureScreenshot") return { data: SCREENSHOT };
        if (method === "DOM.describeNode") return { node: { attributes: [] } };
        if (["Page.enable", "Runtime.enable", "Runtime.releaseObjectGroup"].includes(method)) return {};
        throw Error(`Unexpected CDP fixture command: ${method}`);
      },
    },
  };
  const originalSocket = globalThis.WebSocket;
  const originalChrome = (globalThis as unknown as { chrome?: unknown }).chrome;
  globalThis.WebSocket = BrowserSocket as unknown as typeof WebSocket;
  (globalThis as unknown as { chrome: unknown }).chrome = chrome;
  const options = (message: JsonObject) =>
    new Promise<JsonObject>((resolve, reject) => {
      const listener = chrome.runtime.onMessage.listeners[0];
      if (!listener) {
        reject(Error("Worker has not installed UI listener"));
        return;
      }
      listener(message, { id: EXTENSION_ID, url: chrome.runtime.getURL("popup.html") }, resolve);
    });
  return {
    local,
    session,
    tabs,
    removed,
    attached,
    detached,
    commands,
    outgoing,
    incoming,
    sockets,
    options,
    async load() {
      await import("../../../browser/src/worker.js");
    },
    async dispose() {
      let locallyRevoked = false;
      if (chrome.runtime.onMessage.listeners.length)
        locallyRevoked = (await options({ type: "unbind" })).ok === true;
      await Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolve) => {
              if (socket.peer.readyState === NodeWebSocket.CLOSED) {
                resolve();
                return;
              }
              socket.peer.once("close", () => resolve());
              // Only a failed/offline setup needs this local cleanup fallback.
              if (!locallyRevoked)
                socket.dispatchEvent(
                  new MessageEvent("message", { data: JSON.stringify({ type: "revoke" }) }),
                );
              socket.peer.terminate();
            }),
        ),
      );
      await new Promise((resolve) => setImmediate(resolve));
      globalThis.WebSocket = originalSocket;
      if (originalChrome === undefined) delete (globalThis as unknown as { chrome?: unknown }).chrome;
      else (globalThis as unknown as { chrome: unknown }).chrome = originalChrome;
    },
  };
}
