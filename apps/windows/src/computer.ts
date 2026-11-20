import {
  DESKTOP_OBSERVATION_SECONDS,
  referenceId,
  MAX_IMAGE_BYTES,
  MAX_ACT_WAIT_AFTER_MS,
  actWaitAfterSchema,
  windowsComputerActionSchema,
} from "@abridge/protocol";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopError, checkAbort, integer, invalid } from "./errors.js";
import type { NativeDriver, Target, NativeAction, NativeObservation } from "./native.js";
type Observation = {
  id: string;
  created: number;
  target: Target;
  refs: Map<string, string>;
  width?: number;
  height?: number;
  capture_id?: string;
  focus?: string;
};
const short = (value: string | undefined, max: number) =>
  value === undefined ? undefined : Array.from(value).slice(0, max).join("");
export class Computer {
  private observations = new Map<string, Observation>();
  private targets = new Map<string, Target>();
  private closed = new Set<string>();
  private sessions = new Set<string>();
  private queues = new Map<string, Promise<unknown>>();
  private followUpControllers = new Map<string, AbortController>();
  constructor(
    readonly native: NativeDriver,
    private readonly now = () => performance.now(),
  ) {}
  async apps(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const query = args.query;
    if (query !== undefined && (typeof query !== "string" || query.length > 200))
      invalid("query must be a string of at most 200 characters");
    const inventory = await this.native.apps(signal);
    const apps = inventory.filter((a) =>
      typeof query === "string"
        ? `${a.name}\n${a.window_title ?? ""}\n${a.bundle_id ?? ""}`
            .toLowerCase()
            .includes(query.toLowerCase())
        : a.running && a.pid > 0,
    );
    apps.sort((a, b) => Number(b.running) - Number(a.running));
    const result: Record<string, unknown> = { apps: [], matches_total: apps.length, truncated: false };
    const rows: unknown[] = [];
    for (const app of apps.slice(0, 200)) {
      rows.push(app);
      if (JSON.stringify(rows).length > 6000) {
        rows.pop();
        result.truncated = true;
        break;
      }
    }
    result.apps = rows;
    if (rows.length < apps.length) result.truncated = true;
    if (this.native.platform === "win32" && typeof query === "string" && !apps.some((a) => a.running)) {
      // A localized launcher name need not equal the running process's name/path.
      // Offer separately identified candidates; never infer identity or launch them.
      const alternatives: typeof inventory = [];
      for (const app of inventory
        .filter((a) => a.running && a.pid > 0)
        .sort((a, b) => Number(b.active) - Number(a.active))) {
        if (alternatives.length >= 20 || JSON.stringify([...alternatives, app]).length > 4000) break;
        alternatives.push(app);
      }
      if (alternatives.length) {
        result.running_alternatives = alternatives;
        result.guidance =
          "No running app matched this text. Localized launcher names can differ from process names. Inspect these running alternatives and their window titles before launching an installed entry; each bundle_id identifies its own process.";
      }
    }
    return result;
  }
  async windows(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const pid = args.pid === undefined ? undefined : integer(args.pid, "pid", 1, 2147483647);
    const windows = await this.native.windows(pid, signal);
    let running: boolean | null = null;
    if (pid !== undefined) {
      try {
        process.kill(pid, 0);
        running = true;
      } catch (error) {
        running = (error as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    return {
      windows: windows.slice(0, 200),
      requested_pid: pid ?? null,
      process_running: running,
      on_screen_only: false,
      truncated: windows.length > 200,
      empty_reason: windows.length ? null : running === false ? "process_not_running" : "no_windows_reported",
      ...(!windows.length
        ? {
            guidance:
              "Refresh computer_apps/windows and observe a returned pid/window_id; off-screen windows are included",
          }
        : {}),
    };
  }
  open(
    session: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.serial(session, () => this.openLocked(session, args, signal));
  }
  private async openLocked(
    session: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const bundle = args.bundle_id;
    if (
      typeof bundle !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(bundle) ||
      bundle.length > 250
    )
      invalid("bundle_id must be an exact application identifier");
    const started = this.now();
    if (!(await this.native.apps(signal)).some((a) => a.bundle_id === bundle))
      throw new DesktopError("app_not_found", "Application is not installed");
    checkAbort(signal);
    this.assertOpen(session);
    await this.native.open(bundle, signal);
    const base = { launch_requested: true, bundle_id: bundle };
    // Windows UIA traversal and capture must not share the old eight-second
    // discovery budget. Leave headroom below the server's 30-second receipt
    // deadline, accounting for inventory and activation already performed.
    const followUpMs = this.native.platform === "win32" ? 25000 - (this.now() - started) : 8000;
    checkAbort(signal);
    if (followUpMs <= 0)
      return {
        ...base,
        observation_error: {
          code: "window_discovery_timeout",
          message: "Application launch requested; inspect its windows before attempting another launch",
        },
      };
    const followUpTimeout = AbortSignal.timeout(Math.ceil(followUpMs));
    const followUp = signal ? AbortSignal.any([signal, followUpTimeout]) : followUpTimeout;
    try {
      for (let i = 0; i < 16; i++) {
        checkAbort(followUp);
        this.assertOpen(session);
        const app = (await this.native.apps(followUp)).find(
          (a) => a.bundle_id === bundle && a.running && a.pid > 0,
        );
        if (app) {
          const windows = (await this.native.windows(app.pid, followUp))
            .filter((w) => w.layer === 0 && w.bounds.width > 0 && w.bounds.height > 0)
            .sort(
              (a, b) =>
                Number(b.is_focused === true) - Number(a.is_focused === true) ||
                Number(b.is_on_screen) - Number(a.is_on_screen) ||
                b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height,
            );
          if (windows[0]) {
            const target = { pid: app.pid, window_id: windows[0].window_id };
            // Activation selected this window even when its first capture is temporarily unavailable.
            // Keep the target, but never reuse a previous frame or its input references.
            this.targets.set(session, target);
            this.observations.delete(session);
            try {
              return {
                ...base,
                observation: await this.observeLocked(
                  session,
                  {
                    ...target,
                    screenshot: args.screenshot ?? false,
                  },
                  followUp,
                ),
              };
            } catch (error) {
              if (signal?.aborted) throw error;
              return {
                ...base,
                window: target,
                observation_error: {
                  code: followUpTimeout.aborted
                    ? "observation_timeout"
                    : error instanceof DesktopError
                      ? error.code
                      : "observation_failed",
                  message: "Application launched; observe the selected window again without reopening it",
                },
              };
            }
          }
        }
        await delay(250, undefined, { signal: followUp });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        ...base,
        observation_error: {
          code: followUpTimeout.aborted
            ? "window_discovery_timeout"
            : error instanceof DesktopError
              ? error.code
              : "window_unavailable",
          message: "Application launch requested; follow-up window observation unavailable",
        },
      };
    }
    return {
      ...base,
      observation_error: {
        code: "window_unavailable",
        message: "Application launched but no ordinary window appeared",
      },
    };
  }
  private assertOpen(session: string): void {
    if (this.closed.has(session)) throw new DesktopError("session_closed", "Desktop session has closed");
  }
  private async focus(signal?: AbortSignal): Promise<string> {
    const active = (await this.native.apps(signal)).filter((a) => a.active && a.running);
    if (active.length !== 1)
      throw new DesktopError("focus_unavailable", "Cannot verify the active application");
    const windows = (await this.native.windows(active[0].pid, signal))
      .filter((w) => w.is_on_screen && w.layer === 0 && w.z_index !== undefined)
      .sort((a, b) => b.z_index! - a.z_index!);
    if (!windows[0] || (windows[1] && windows[0].z_index === windows[1].z_index))
      throw new DesktopError("focus_unavailable", "Cannot verify the front window");
    return `${active[0].pid}:${windows[0].window_id}`;
  }
  observe(
    session: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.serial(session, () => this.observeLocked(session, args, signal));
  }
  private async observeLocked(
    session: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.assertOpen(session);
    checkAbort(signal);
    const previous = this.targets.get(session);
    if (args.desktop !== undefined && typeof args.desktop !== "boolean") invalid("desktop must be a boolean");
    if (args.screenshot !== undefined && typeof args.screenshot !== "boolean")
      invalid("screenshot must be a boolean");
    let target: Target;
    if (args.pid !== undefined || args.window_id !== undefined) {
      if (args.desktop === true) invalid("Select a window or desktop");
      target = {
        pid: integer(args.pid, "pid", 1, 2147483647),
        window_id: integer(args.window_id, "window_id", 1, Number.MAX_SAFE_INTEGER),
      };
    } else if (args.desktop === true) target = { desktop: true };
    else if (previous && "pid" in previous) target = previous;
    else throw new DesktopError("target_required", "Select a window, or explicitly request desktop");
    const query = args.query;
    if (query !== undefined && (typeof query !== "string" || query.length > 200))
      invalid("query must be at most 200 characters");
    const focus = "desktop" in target ? await this.focus(signal) : undefined;
    const raw = await this.native.observe(session, target, args.screenshot !== false, signal);
    checkAbort(signal);
    this.assertOpen(session);
    if (focus && focus !== (await this.focus(signal)))
      throw new DesktopError("focus_changed", "The front window changed during observation");
    const observation: Observation = {
      id: referenceId("obs"),
      created: this.now(),
      target,
      refs: new Map(),
      width: raw.width,
      height: raw.height,
      capture_id: raw.capture_id,
      focus,
    };
    const result = this.compact(raw, observation, typeof query === "string" ? query : undefined);
    this.targets.set(session, target);
    this.observations.set(session, observation);
    return result;
  }
  private compact(raw: NativeObservation, observation: Observation, query?: string): Record<string, unknown> {
    const explicitActions = raw.element_actions === "explicit";
    const image = raw.image_base64;
    const validImage = Boolean(
      image &&
      /^(image\/png|image\/jpeg|image\/webp)$/.test(raw.mime_type ?? "") &&
      image.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(image),
    );
    const pixel = Boolean(validImage && raw.width && raw.height && raw.frame_valid !== false);
    const result: Record<string, unknown> = {
      observation_id: observation.id,
      app_name: short(raw.app_name, 200),
      window_title: short(raw.window_title, 200),
      ...("pid" in observation.target
        ? { window: { pid: observation.target.pid, window_id: observation.target.window_id } }
        : { desktop: true }),
      elements: [],
      ...(raw.is_focused === undefined ? {} : { is_focused: raw.is_focused }),
      ...(raw.accessibility_status === undefined ? {} : { accessibility_status: raw.accessibility_status }),
      ...(raw.accessibility_limit === undefined ? {} : { accessibility_limit: raw.accessibility_limit }),
    };
    const rows: Record<string, unknown>[] = [];
    let matches = 0,
      truncated = raw.truncated ?? false;
    for (const e of raw.elements) {
      const protectedField = /secure|password|protected/i.test(e.role);
      const value = protectedField ? undefined : e.value;
      const label = e.label ?? "";
      if (query && !`${label}\n${value ?? ""}`.toLowerCase().includes(query.toLowerCase())) continue;
      const actionable =
        Boolean(e.token) &&
        (explicitActions
          ? Boolean(e.actions?.length)
          : Boolean(e.actions?.length) || /button|check|text|menu|popup|slider|link/i.test(e.role));
      if (!label && !value && !actionable) continue;
      matches++;
      const ref = actionable ? `e${rows.length + 1}` : undefined;
      const row: Record<string, unknown> = {
        role: e.role,
        label: short(label, query ? 2000 : 240),
        ...(value === undefined ? {} : { value: short(value, query ? 4500 : 384) }),
        ...(ref ? { element_ref: ref } : {}),
        ...(explicitActions && ref ? { actions: e.actions } : {}),
        ...(explicitActions && ref && pixel && e.bounds ? { bounds: e.bounds } : {}),
        ...(e.enabled === false ? { enabled: false } : {}),
        ...(e.selected ? { selected: true } : {}),
        depth: e.depth,
      };
      rows.push(row);
      if (JSON.stringify({ ...result, elements: rows }).length > 7000) {
        rows.pop();
        truncated = true;
        continue;
      }
      if (ref) observation.refs.set(ref, e.token!);
    }
    result.elements = rows;
    result.elements_total = matches;
    result.truncated = truncated;
    if (truncated)
      result.next_step = explicitActions
        ? "UIA results are partial. query only filters this bounded snapshot and does not extend traversal. Use a suitable action already present, or locate the target in a fresh window screenshot."
        : "Use query to narrow the accessibility tree";
    if (explicitActions && query && matches === 0)
      result.next_step =
        raw.accessibility_limit === "time_budget"
          ? "No match in the time-limited UIA snapshot. This does not prove the control is absent. Use the current window screenshot, or request one if missing; another query does not extend traversal."
          : "No literal substring matched. query takes one text substring, not a JSON list or regular expression. For unlabeled controls, omit query, request a screenshot, and identify element_ref using its bounds and the image.";
    if (validImage) {
      result.image_base64 = image;
      result.mime_type = raw.mime_type;
    }
    result.pixel_actions = pixel;
    if (explicitActions && "pid" in observation.target) {
      result.interaction_guidance = pixel
        ? "Prefer an element_ref whose actions include the requested semantic operation. Double/right/middle/modifier clicks require explicit screenshot coordinates. If UIA is unavailable, incomplete, or has no suitable control, use this window screenshot to locate the target and use coordinates with this observation_id. query only filters the current UIA snapshot; repeated queries do not make non-interactive text actionable. After an ineffective or uncertain action, observe and verify the actual result before switching methods; never blindly repeat a send or submission."
        : "Prefer an element_ref whose actions include the requested semantic operation. Double/right/middle/modifier clicks require explicit screenshot coordinates. If UIA has no suitable control, request a fresh window screenshot before using coordinates. query only filters the current UIA snapshot; repeated queries do not make non-interactive text actionable. Verify uncertain or ineffective actions before switching methods; never blindly repeat a send or submission.";
    }
    if (pixel) {
      result.coordinate_space = "screenshot_pixels";
      result.geometry = { width: raw.width, height: raw.height };
      result.supported_coordinate_spaces = ["screenshot_pixels", "normalized_1000"];
      if (explicitActions) result.element_bounds_space = "screenshot_pixels";
    } else {
      observation.width = undefined;
      observation.height = undefined;
    }
    return result;
  }
  act(
    session: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.serial(session, () => this.actLocked(session, args, signal));
  }
  private async actLocked(
    session: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.assertOpen(session);
    const observation = this.observations.get(session);
    if (
      !observation ||
      args.observation_id !== observation.id ||
      this.now() - observation.created > DESKTOP_OBSERVATION_SECONDS * 1000
    )
      throw new DesktopError("stale_observation", "Observe the target again before acting");
    const parsed = windowsComputerActionSchema.safeParse(args.action);
    if (!parsed.success) invalid("action must match the desktop action schema");
    const outer = args;
    args = parsed.data;
    const action = args.type;
    if (
      typeof action !== "string" ||
      !["click", "double_click", "type", "key", "move", "drag", "scroll"].includes(action)
    )
      invalid("Unsupported desktop action");
    if (outer.observe_after !== undefined && typeof outer.observe_after !== "boolean")
      invalid("observe_after must be a boolean");
    if (outer.screenshot !== undefined && typeof outer.screenshot !== "boolean")
      invalid("screenshot must be a boolean");
    if (outer.screenshot === true && outer.observe_after === false)
      invalid("screenshot requires observe_after=true");
    const waiting = actWaitAfterSchema.safeParse(outer.wait_after_ms);
    if (!waiting.success) invalid(`wait_after_ms must be an integer between 0 and ${MAX_ACT_WAIT_AFTER_MS}`);
    const native: NativeAction = {
      action,
      target: observation.target,
      capture_id: observation.capture_id,
    };
    const ref = args.element_ref;
    if (ref !== undefined) {
      if (typeof ref !== "string" || !observation.refs.has(ref))
        throw new DesktopError("invalid_reference", "Element reference is not in this observation");
      native.native_ref = observation.refs.get(ref);
    }
    const point = (x: unknown, y: unknown) => {
      if (!observation.width || !observation.height)
        throw new DesktopError("screenshot_required", "Observe with a screenshot before pixel actions");
      if (args.coordinate_space === "normalized_1000") {
        if (
          typeof x !== "number" ||
          typeof y !== "number" ||
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          x < 0 ||
          y < 0 ||
          x > 1000 ||
          y > 1000
        )
          invalid("Normalized coordinates must be between 0 and 1000");
        return {
          x: Math.min(observation.width - 1, Math.floor((x * observation.width) / 1000)),
          y: Math.min(observation.height - 1, Math.floor((y * observation.height) / 1000)),
        };
      }
      if (
        typeof x !== "number" ||
        typeof y !== "number" ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= observation.width ||
        y >= observation.height
      )
        invalid("Coordinates must be inside the observed screenshot");
      return { x, y };
    };
    if (["click", "double_click"].includes(action)) {
      if (ref !== undefined && (args.x !== undefined || args.y !== undefined))
        invalid("Use an element reference or coordinates");
      if (ref === undefined) Object.assign(native, point(args.x, args.y));
      if (args.button !== undefined && !["left", "right", "middle"].includes(String(args.button)))
        invalid("Invalid mouse button");
      native.button = args.button as string | undefined;
    }
    if (action === "type") {
      if (typeof args.text !== "string" || args.text.length > 10000 || args.text.includes("\0"))
        invalid("text must contain at most 10000 characters");
      native.text = args.text;
    }
    if (action === "key") {
      if (typeof args.key !== "string" || !args.key || args.key.length > 100)
        invalid("key must contain at most 100 characters");
      native.key = args.key;
    }
    if (["move", "drag"].includes(action)) Object.assign(native, point(args.x, args.y));
    if (action === "drag") {
      const to = point(args.to_x, args.to_y);
      native.to_x = to.x;
      native.to_y = to.y;
    }
    if (action === "scroll") {
      if (!observation.width || !observation.height)
        throw new DesktopError("screenshot_required", "Observe with a screenshot before scrolling");
      Object.assign(
        native,
        args.x === undefined
          ? { x: Math.floor(observation.width / 2), y: Math.floor(observation.height / 2) }
          : point(args.x, args.y),
      );
      const dx = args.delta_x ?? 0,
        dy = args.delta_y ?? 0;
      if (
        typeof dx !== "number" ||
        typeof dy !== "number" ||
        !Number.isFinite(dx) ||
        !Number.isFinite(dy) ||
        Math.abs(dx) > 10000 ||
        Math.abs(dy) > 10000 ||
        (!dx && !dy) ||
        (dx && dy)
      )
        invalid("Scroll requires one nonzero axis");
      native.delta_x = dx;
      native.delta_y = dy;
    }
    if (args.modifiers !== undefined) {
      if (
        !Array.isArray(args.modifiers) ||
        args.modifiers.some(
          (m) =>
            typeof m !== "string" ||
            !["cmd", "command", "meta", "win", "ctrl", "control", "alt", "option", "shift", "fn"].includes(m),
        )
      )
        invalid("Invalid modifiers");
      native.modifiers = (args.modifiers as string[]).map(
        (m) => ({ command: "cmd", control: "ctrl", alt: "option" })[m] ?? m,
      );
    }
    checkAbort(signal);
    if (observation.focus && observation.focus !== (await this.focus(signal)))
      throw new DesktopError("focus_changed", "The front window changed; observe again");
    this.assertOpen(session);
    this.observations.delete(session);
    const result = await this.native.act(session, native, signal);
    if (outer.observe_after === false && outer.screenshot !== true) return result;
    const followUp = new AbortController();
    const followUpSignal = signal ? AbortSignal.any([signal, followUp.signal]) : followUp.signal;
    this.followUpControllers.set(session, followUp);
    try {
      this.assertOpen(session);
      if (waiting.data > 0) await delay(waiting.data, undefined, { signal: followUpSignal });
      checkAbort(followUpSignal);
      return {
        ...result,
        observation: await this.observeLocked(
          session,
          {
            ...("pid" in observation.target ? observation.target : { desktop: true }),
            screenshot: outer.screenshot === true,
          },
          followUpSignal,
        ),
      };
    } catch (caught) {
      const error = followUpSignal.aborted ? followUpSignal.reason : caught;
      return {
        ...result,
        observation_error: {
          code: error instanceof DesktopError ? error.code : "observation_failed",
          message: "Action delivered; follow-up observation unavailable",
          ...(this.native.platform === "win32" &&
          error instanceof DesktopError &&
          error.code === "focus_changed"
            ? {
                next_step:
                  "The action was delivered and the original window lost focus. Activate the intended existing application, then observe with screenshot=true and verify the actual result. Do not repeat the delivered action.",
              }
            : {}),
        },
      };
    } finally {
      if (this.followUpControllers.get(session) === followUp) this.followUpControllers.delete(session);
    }
  }
  invalidate(session: string): void {
    this.observations.delete(session);
  }
  private serial<T>(session: string, run: () => Promise<T>): Promise<T> {
    this.sessions.add(session);
    const task = (this.queues.get(session) ?? Promise.resolve()).catch(() => {}).then(run);
    this.queues.set(session, task);
    void task
      .finally(() => {
        if (this.queues.get(session) === task) this.queues.delete(session);
      })
      .catch(() => {});
    return task;
  }
  async closeSession(session: string): Promise<void> {
    this.closed.add(session);
    this.observations.delete(session);
    this.targets.delete(session);
    this.followUpControllers
      .get(session)
      ?.abort(new DesktopError("session_closed", "Session closed before follow-up observation"));
    await this.queues.get(session)?.catch(() => {});
    await this.native.release(session);
    this.sessions.delete(session);
  }
  async stop(): Promise<void> {
    const sessions = [...this.sessions];
    await Promise.allSettled(sessions.map((id) => this.closeSession(id)));
  }
  async shutdown(): Promise<void> {
    await this.stop();
    await this.native.shutdown();
  }
}
