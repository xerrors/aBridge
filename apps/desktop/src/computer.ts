import {
  DESKTOP_OBSERVATION_SECONDS,
  MAX_IMAGE_BYTES,
  MAX_ACT_WAIT_AFTER_MS,
  actWaitAfterSchema,
  computerActionSchema,
} from "@abridge/protocol";
import { randomUUID } from "node:crypto";
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
    const apps = (await this.native.apps(signal)).filter((a) =>
      typeof query === "string"
        ? `${a.name}\n${a.bundle_id ?? ""}`.toLowerCase().includes(query.toLowerCase())
        : a.running && a.pid > 0,
    );
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
    if (!(await this.native.apps(signal)).some((a) => a.bundle_id === bundle))
      throw new DesktopError("app_not_found", "Application is not installed");
    checkAbort(signal);
    this.assertOpen(session);
    await this.native.open(bundle, signal);
    const base = { launch_requested: true, bundle_id: bundle };
    const followUp = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000);
    try {
      for (let i = 0; i < 16; i++) {
        checkAbort(signal);
        this.assertOpen(session);
        const app = (await this.native.apps(followUp)).find(
          (a) => a.bundle_id === bundle && a.running && a.pid > 0,
        );
        if (app) {
          const windows = (await this.native.windows(app.pid, followUp))
            .filter((w) => w.layer === 0 && w.bounds.width > 0 && w.bounds.height > 0)
            .sort(
              (a, b) =>
                Number(b.is_on_screen) - Number(a.is_on_screen) ||
                b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height,
            );
          if (windows[0]) {
            try {
              return {
                ...base,
                observation: await this.observeLocked(
                  session,
                  {
                    pid: app.pid,
                    window_id: windows[0].window_id,
                    screenshot: args.screenshot ?? false,
                  },
                  followUp,
                ),
              };
            } catch (error) {
              if (signal?.aborted) throw error;
              return {
                ...base,
                observation_error: {
                  code: error instanceof DesktopError ? error.code : "observation_failed",
                  message: "Application launched; observation unavailable",
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
          code: error instanceof DesktopError ? error.code : "window_unavailable",
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
      id: `obs_${randomUUID().replaceAll("-", "")}`,
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
    const result: Record<string, unknown> = {
      observation_id: observation.id,
      app_name: short(raw.app_name, 200),
      window_title: short(raw.window_title, 200),
      ...("pid" in observation.target
        ? { window: { pid: observation.target.pid, window_id: observation.target.window_id } }
        : { desktop: true }),
      elements: [],
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
        (Boolean(e.actions?.length) || /button|check|text|menu|popup|slider|link/i.test(e.role));
      if (!label && !value && !actionable) continue;
      matches++;
      const ref = actionable ? `e${rows.length + 1}` : undefined;
      const row: Record<string, unknown> = {
        role: e.role,
        label: short(label, query ? 2000 : 240),
        ...(value === undefined ? {} : { value: short(value, query ? 4500 : 384) }),
        ...(ref ? { element_ref: ref } : {}),
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
    if (truncated) result.next_step = "Use query to narrow the accessibility tree";
    const image = raw.image_base64;
    if (
      image &&
      /^(image\/png|image\/jpeg|image\/webp)$/.test(raw.mime_type ?? "") &&
      image.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(image)
    ) {
      result.image_base64 = image;
      result.mime_type = raw.mime_type;
    }
    const pixel = Boolean(result.image_base64 && raw.width && raw.height && raw.frame_valid !== false);
    result.pixel_actions = pixel;
    if (pixel) {
      result.coordinate_space = "screenshot_pixels";
      result.geometry = { width: raw.width, height: raw.height };
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
    const parsed = computerActionSchema.safeParse(args.action);
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
      native.x = Math.floor(observation.width / 2);
      native.y = Math.floor(observation.height / 2);
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
            !["cmd", "command", "meta", "ctrl", "control", "alt", "option", "shift", "fn"].includes(m),
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
