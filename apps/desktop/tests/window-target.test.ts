import { test } from "node:test";
import assert from "node:assert/strict";
import { Computer } from "../src/computer.js";
import { DesktopError } from "../src/errors.js";
import type { NativeDriver, NativeObservation, Target, WindowInfo } from "../src/native.js";

const window = (pid: number, window_id: number): WindowInfo => ({
  pid,
  window_id,
  app_name: "Window fixture",
  title: "Window fixture",
  bounds: { x: 0, y: 0, width: 100, height: 80 },
  is_on_screen: false,
  layer: 3,
});

class WindowNative implements NativeDriver {
  windowList = [window(10, 20)];
  requestedPids: (number | undefined)[] = [];
  captured: Target[] = [];
  onWindows?: () => Promise<void>;
  async diagnostics() {
    return {};
  }
  async apps() {
    return [];
  }
  async windows(pid?: number) {
    this.requestedPids.push(pid);
    await this.onWindows?.();
    return this.windowList;
  }
  async open() {}
  async observe(_session: string, target: Target): Promise<NativeObservation> {
    this.captured.push(target);
    return { elements: [] };
  }
  async act(): Promise<Record<string, unknown>> {
    throw new Error("Window observation fixture must not send input");
  }
  async release() {}
  async shutdown() {}
}

test("PID-only observation selects the sole valid owned window, including off-screen nonordinary windows", async () => {
  const native = new WindowNative();
  native.windowList.push(
    window(11, 21),
    window(10, 0),
    window(10, -1),
    window(10, 1.5),
    window(10, Number.MAX_SAFE_INTEGER + 1),
  );
  const computer = new Computer(native);
  const observed = await computer.observe("fixture", { pid: 10 });
  assert.deepEqual(observed.window, { pid: 10, window_id: 20 });
  assert.deepEqual(native.requestedPids, [10]);
  native.windowList = [];
  assert.deepEqual((await computer.observe("fixture", {})).window, observed.window);
  assert.deepEqual(native.requestedPids, [10], "Reusing the selected window must not enumerate again");
  assert.deepEqual(native.captured, [observed.window, observed.window]);
});

test("PID-only observation refuses ambiguous or unavailable windows with a window-list recovery path", async (t) => {
  for (const state of ["multiple", "none"] as const) {
    await t.test(state, async () => {
      const native = new WindowNative();
      native.windowList = state === "multiple" ? [window(10, 20), window(10, 21)] : [window(11, 20)];
      const computer = new Computer(native);
      await assert.rejects(computer.observe("fixture", { pid: 10 }), (error: unknown) => {
        assert.ok(error instanceof DesktopError);
        assert.equal(error.code, state === "multiple" ? "window_selection_required" : "window_unavailable");
        assert.match(error.message, /computer_windows/);
        assert.match(error.message, /pid/);
        return true;
      });
      assert.deepEqual(native.captured, []);
    });
  }
});

test("an explicit PID and window ID bypass enumeration", async () => {
  const native = new WindowNative();
  native.onWindows = async () => {
    throw new Error("An explicit target must not enumerate windows");
  };
  const target = { pid: 10, window_id: Number.MAX_SAFE_INTEGER };
  assert.deepEqual((await new Computer(native).observe("fixture", target)).window, target);
  assert.deepEqual(native.requestedPids, []);
  assert.deepEqual(native.captured, [target]);
});

test("invalid window IDs report a readable field error without enumerating or capturing", async (t) => {
  for (const window_id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "20", null]) {
    await t.test(String(window_id), async () => {
      const native = new WindowNative();
      await assert.rejects(
        new Computer(native).observe("fixture", { pid: 10, window_id }),
        (error: unknown) => {
          assert.ok(error instanceof DesktopError);
          assert.equal(error.code, "invalid_arguments");
          assert.match(error.message, /valid.*window_id|window_id.*valid/i);
          assert.doesNotMatch(error.message, /between|9007199254740991/);
          return true;
        },
      );
      assert.deepEqual(native.requestedPids, []);
      assert.deepEqual(native.captured, []);
    });
  }
});

test("a window ID without a PID fails explicitly and never borrows the previous target PID", async () => {
  const native = new WindowNative();
  const computer = new Computer(native);
  const target = { pid: 10, window_id: 20 };
  await computer.observe("fixture", target);
  await assert.rejects(computer.observe("fixture", { window_id: 21 }), (error: unknown) => {
    assert.ok(error instanceof DesktopError);
    assert.equal(error.code, "invalid_arguments");
    assert.match(error.message, /pid/i);
    assert.match(error.message, /required|provide|specify|without|missing/i);
    return true;
  });
  assert.deepEqual(native.captured, [target]);
  assert.deepEqual((await computer.observe("fixture", {})).window, target);
});

test("failed PID-only selection preserves the previously selected complete target", async (t) => {
  for (const failure of ["multiple", "none", "query error"] as const) {
    await t.test(failure, async () => {
      const native = new WindowNative();
      const computer = new Computer(native);
      const target = { pid: 10, window_id: 20 };
      await computer.observe("fixture", target);
      native.windowList = failure === "multiple" ? [window(11, 21), window(11, 22)] : [];
      if (failure === "query error") {
        native.onWindows = async () => {
          throw new Error("Fixture window query failed");
        };
      }
      await assert.rejects(
        computer.observe("fixture", { pid: 11 }),
        failure === "query error"
          ? /Fixture window query failed/
          : { code: failure === "multiple" ? "window_selection_required" : "window_unavailable" },
      );
      native.onWindows = undefined;
      assert.deepEqual((await computer.observe("fixture", {})).window, target);
      assert.deepEqual(native.captured, [target, target]);
    });
  }
});

test("cancellation and session closure during PID enumeration prevent capture", async (t) => {
  await t.test("cancellation", async () => {
    const native = new WindowNative();
    native.windowList = [];
    const controller = new AbortController();
    native.onWindows = async () => {
      controller.abort();
    };
    await assert.rejects(new Computer(native).observe("fixture", { pid: 10 }, controller.signal), {
      name: "AbortError",
    });
    assert.deepEqual(native.captured, []);
  });
  await t.test("session closure", async () => {
    const native = new WindowNative();
    native.windowList = [];
    const computer = new Computer(native);
    let closing: Promise<void> | undefined;
    native.onWindows = async () => {
      closing = computer.closeSession("fixture");
    };
    await assert.rejects(computer.observe("fixture", { pid: 10 }), { code: "session_closed" });
    await closing;
    assert.deepEqual(native.captured, []);
  });
  await t.test("cancellation takes priority over a concurrent window query error", async () => {
    const native = new WindowNative();
    const controller = new AbortController();
    native.onWindows = async () => {
      controller.abort();
      throw new Error("Fixture query failed during cancellation");
    };
    await assert.rejects(new Computer(native).observe("fixture", { pid: 10 }, controller.signal), {
      name: "AbortError",
    });
    assert.deepEqual(native.captured, []);
  });
  await t.test("session closure takes priority over a concurrent window query error", async () => {
    const native = new WindowNative();
    const computer = new Computer(native);
    let closing: Promise<void> | undefined;
    native.onWindows = async () => {
      closing = computer.closeSession("fixture");
      throw new Error("Fixture query failed while closing");
    };
    await assert.rejects(computer.observe("fixture", { pid: 10 }), { code: "session_closed" });
    await closing;
    assert.deepEqual(native.captured, []);
  });
});
