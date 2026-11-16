import { test } from "node:test";
import assert from "node:assert/strict";
import { Computer } from "../src/computer.js";
import { DesktopError } from "../src/errors.js";
import type { AppInfo, NativeAction, NativeDriver, NativeObservation, WindowInfo } from "../src/native.js";

class FocusNative implements NativeDriver {
  activeApps: AppInfo[] = [{ pid: 10, name: "Fixture", running: true, active: true }];
  windowList: WindowInfo[] = [
    {
      pid: 10,
      window_id: 20,
      app_name: "Fixture",
      title: "Fixture",
      bounds: { x: 0, y: 0, width: 100, height: 80 },
      is_on_screen: true,
      layer: 0,
      z_index: 1,
    },
  ];
  image = Buffer.from("fixture-image").toString("base64");
  frameValid = true;
  actions: NativeAction[] = [];
  captures = 0;
  appsCalls = 0;
  onApps?: () => Promise<void>;
  onWindows?: () => Promise<void>;
  onObserve?: () => Promise<void>;
  async diagnostics() {
    return {};
  }
  async apps() {
    this.appsCalls++;
    await this.onApps?.();
    return this.activeApps;
  }
  async windows() {
    await this.onWindows?.();
    return this.windowList;
  }
  async open() {}
  async observe(_session: string, _target: unknown, screenshot: boolean): Promise<NativeObservation> {
    this.captures++;
    await this.onObserve?.();
    return {
      elements: [{ token: "fixture-button", role: "AXButton", label: "Continue", depth: 0 }],
      ...(screenshot ? { image_base64: this.image, mime_type: "image/png" } : {}),
      width: 100,
      height: 80,
      capture_id: "fixture-capture",
      frame_valid: this.frameValid,
    };
  }
  async act(_session: string, action: NativeAction) {
    this.actions.push(action);
    return { action_executed: true };
  }
  async release() {}
  async shutdown() {}
}

test("desktop capture succeeds without verifiable focus and reports unavailable pixel actions", async (t) => {
  const cases: Record<string, (native: FocusNative) => void> = {
    "no active application": (native) => {
      native.activeApps = [];
    },
    "ambiguous active applications": (native) => {
      native.activeApps.push({ pid: 11, name: "Other fixture", running: true, active: true });
    },
    "no ordinary front window": (native) => {
      native.windowList[0].layer = 1;
    },
    "ambiguous front window": (native) => {
      native.windowList.push({ ...native.windowList[0], window_id: 21 });
    },
    "application query failure": (native) => {
      native.onApps = async () => {
        throw new Error("Fixture app query failed");
      };
    },
    "window query failure": (native) => {
      native.onWindows = async () => {
        throw new Error("Fixture window query failed");
      };
    },
    "front window changes during capture": (native) => {
      native.onObserve = async () => {
        native.windowList[0].window_id = 21;
      };
    },
    "focus becomes unavailable during capture": (native) => {
      native.onObserve = async () => {
        native.activeApps = [];
      };
    },
    "focus query fails after capture": (native) => {
      native.onObserve = async () => {
        native.onApps = async () => {
          throw new Error("Fixture app query failed after capture");
        };
      };
    },
  };
  for (const [name, setup] of Object.entries(cases)) {
    await t.test(name, async () => {
      const native = new FocusNative();
      setup(native);
      const result = await new Computer(native).observe("fixture", { desktop: true });
      assert.equal(result.image_base64, native.image);
      assert.equal(result.focus_status, "unconfirmed");
      assert.equal(result.pixel_actions, false);
      assert.equal(native.captures, 1);
      assert.deepEqual(native.actions, []);
    });
  }
});

test("confirmed desktop focus permits pixel actions only with a valid screenshot", async (t) => {
  for (const capture of ["valid", "omitted", "invalid frame"] as const) {
    await t.test(capture, async () => {
      const native = new FocusNative();
      native.frameValid = capture !== "invalid frame";
      const result = await new Computer(native).observe("fixture", {
        desktop: true,
        screenshot: capture !== "omitted",
      });
      assert.equal(result.focus_status, "confirmed");
      assert.equal(result.pixel_actions, capture === "valid");
    });
  }
});

test("unconfirmed desktop observations reject all input and require a fresh observation after focus recovers", async () => {
  const native = new FocusNative();
  const activeApps = native.activeApps;
  native.activeApps = [];
  const computer = new Computer(native);
  const observed = await computer.observe("fixture", { desktop: true });
  const actions = [
    { type: "click", x: 1, y: 2 },
    { type: "double_click", x: 1, y: 2 },
    { type: "click", element_ref: "e1" },
    { type: "move", x: 1, y: 2 },
    { type: "drag", x: 1, y: 2, to_x: 3, to_y: 4 },
    { type: "scroll", delta_y: 10 },
    { type: "type", text: "fixture" },
    { type: "key", key: "Enter" },
  ];
  for (const action of actions) {
    await assert.rejects(
      computer.act("fixture", { observation_id: observed.observation_id, action, observe_after: false }),
      { code: "focus_unavailable" },
    );
  }
  native.activeApps = activeApps;
  await assert.rejects(
    computer.act("fixture", {
      observation_id: observed.observation_id,
      action: { type: "key", key: "Enter" },
      observe_after: false,
    }),
    { code: "focus_unavailable" },
  );
  assert.deepEqual(native.actions, []);
  const fresh = await computer.observe("fixture", { desktop: true });
  await computer.act("fixture", {
    observation_id: fresh.observation_id,
    action: { type: "click", x: 1, y: 2 },
    observe_after: false,
  });
  assert.equal(native.actions.length, 1);
});

test("confirmed desktop observations revalidate current focus before dispatch", async (t) => {
  for (const state of ["changed", "unavailable"] as const) {
    await t.test(state, async () => {
      const native = new FocusNative();
      const computer = new Computer(native);
      const result = await computer.observe("fixture", { desktop: true });
      if (state === "changed") native.windowList[0].window_id = 21;
      else native.activeApps = [];
      await assert.rejects(
        computer.act("fixture", {
          observation_id: result.observation_id,
          action: { type: "key", key: "Enter" },
          observe_after: false,
        }),
        { code: state === "changed" ? "focus_changed" : "focus_unavailable" },
      );
      assert.deepEqual(native.actions, []);
    });
  }
});

test("unconfirmed desktop input is refused with focus_unavailable even without a screenshot", async () => {
  const native = new FocusNative();
  native.activeApps = [];
  const computer = new Computer(native);
  const result = await computer.observe("fixture", { desktop: true, screenshot: false });
  for (const action of [
    { type: "click", x: 1, y: 2 },
    { type: "scroll", delta_y: 10 },
  ]) {
    await assert.rejects(
      computer.act("fixture", { observation_id: result.observation_id, action, observe_after: false }),
      { code: "focus_unavailable" },
    );
  }
  assert.deepEqual(native.actions, []);
});

test("explicit window observation and input do not require desktop focus", async () => {
  const native = new FocusNative();
  native.onApps = async () => {
    throw new Error("Window targeting must not query desktop focus");
  };
  const computer = new Computer(native);
  const result = await computer.observe("fixture", { pid: 10, window_id: 20 });
  assert.equal(Object.hasOwn(result, "focus_status"), false);
  assert.equal(result.pixel_actions, true);
  await computer.act("fixture", {
    observation_id: result.observation_id,
    action: { type: "click", x: 1, y: 2 },
    observe_after: false,
  });
  assert.equal(native.appsCalls, 0);
  assert.equal(native.actions.length, 1);
});

test("focus fallback preserves cancellation, session closure and capture errors", async (t) => {
  await t.test("cancellation during focus query", async () => {
    const native = new FocusNative();
    const controller = new AbortController();
    native.onApps = async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    };
    await assert.rejects(new Computer(native).observe("fixture", { desktop: true }, controller.signal), {
      name: "AbortError",
    });
    assert.equal(native.captures, 0);
  });
  await t.test("session closes during focus query", async () => {
    const native = new FocusNative();
    const computer = new Computer(native);
    let closing: Promise<void> | undefined;
    native.onApps = async () => {
      closing = computer.closeSession("fixture");
      throw new Error("Fixture query failed while closing");
    };
    await assert.rejects(computer.observe("fixture", { desktop: true }), { code: "session_closed" });
    await closing;
    assert.equal(native.captures, 0);
  });
  await t.test("native capture failure", async () => {
    const native = new FocusNative();
    native.activeApps = [];
    const error = new DesktopError("capture_failed", "Fixture capture failed");
    native.onObserve = async () => {
      throw error;
    };
    await assert.rejects(new Computer(native).observe("fixture", { desktop: true }), (caught) => {
      assert.equal(caught, error);
      return true;
    });
    assert.equal(native.captures, 1);
  });
});
