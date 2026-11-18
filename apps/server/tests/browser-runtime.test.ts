import assert from "node:assert/strict";
import test from "node:test";
import { BrowserRuntime, BrowserRuntimeError, BrowserStepError } from "../src/browser-runtime.js";

const signal = () => new AbortController().signal;

test("browser code batches locator operations and keeps explicit state between runs", async () => {
  const runtime = new BrowserRuntime();
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const call = async (method: string, args: Record<string, unknown>) => {
    calls.push({ method, args });
    return method === "evaluate" ? { value: ["A", "B"] } : { executed: true };
  };
  const first = await runtime.run(
    "task",
    `state.rows = await page.evaluate(() => ['A','B']);
     state.done = [];
     for (const row of state.rows) {
       await page.locator('#name').fill(row);
       await page.locator('#save').click();
       await page.locator('#saved').waitFor({state:'visible'});
       state.done.push(row);
     }
     console.log('finished', state.done.length);
     return state.done;`,
    call,
    signal(),
  );
  assert.deepEqual(first, { value: ["A", "B"], output: ["finished 2"], steps_completed: 7 });
  assert.equal(calls[1]!.method, "locate_act");
  assert.deepEqual(calls[1]!.args, { selector: "#name", action: { type: "fill", text: "A" } });
  assert.deepEqual((await runtime.run("task", "return state.done;", call, signal())).value, ["A", "B"]);
  assert.equal((await runtime.run("other", "return state.done;", call, signal())).value, null);
  runtime.close("task");
  assert.equal((await runtime.run("task", "return state.done;", call, signal())).value, null);
  runtime.closeAll();
});

test("frame locator click returns its verification receipt in one step", async () => {
  const runtime = new BrowserRuntime();
  const verify = { selector: "#status", text: "Saved" };
  const result = await runtime.run(
    "task",
    `return await page.frameLocator("#editor").locator("button").click({verify: ${JSON.stringify(verify)}})`,
    async (method, args) => {
      assert.equal(method, "locate_act");
      assert.deepEqual(args, {
        frame_selector: "#editor",
        selector: "button",
        action: { type: "click" },
        verify: { ...verify, frame_selector: "#editor" },
      });
      return { input_dispatched: true, verification: { matched: false } };
    },
    signal(),
  );
  assert.deepEqual(result.value, { input_dispatched: true, verification: { matched: false } });
  assert.equal(result.steps_completed, 1);
  runtime.closeAll();
});

test("locator actions carry verification options and only CSS locators expose CSS reads", async () => {
  const runtime = new BrowserRuntime();
  const verify = { selector: "#summary", text: "Saved", frame_selector: "#preview" };
  const result = await runtime.run(
    "task",
    `
    const loc = page.frameLocator("#editor").locator({role:"textbox",name:"Title"});
    const options = {verify:${JSON.stringify(verify)}};
    await loc.fill("New title",options);
    await loc.press("Enter",options);
    await loc.select("a",options);
    await loc.hover(options);
    await loc.scroll(20,0,options);
    return [typeof loc.read, typeof loc.waitFor, typeof page.locator("#field").read];`,
    async (method, args) => {
      assert.equal(method, "locate_act");
      assert.deepEqual(args.verify, verify);
      assert.equal(args.frame_selector, "#editor");
      return { executed: true, verification: { matched: true } };
    },
    signal(),
  );
  assert.equal(result.steps_completed, 5);
  assert.deepEqual(result.value, ["undefined", "undefined", "function"]);
  runtime.closeAll();
});

test("browser code cannot access Node, host network, or other run globals", async () => {
  const runtime = new BrowserRuntime();
  const call = async () => ({});
  const result = await runtime.run(
    "task",
    `globalThis.secret = 42;
     return [typeof process,typeof require,typeof fetch,typeof WebSocket];`,
    call,
    signal(),
  );
  assert.deepEqual(result.value, ["undefined", "undefined", "undefined", "undefined"]);
  assert.equal((await runtime.run("task", "return typeof secret;", call, signal())).value, "undefined");
  await assert.rejects(runtime.run("task", "return await import('node:fs');", call, signal()), /module/i);
  runtime.closeAll();
});

test("failures return completed-step progress and do not execute subsequent queued actions", async () => {
  const runtime = new BrowserRuntime();
  let calls = 0;
  await assert.rejects(
    runtime.run(
      "task",
      `state.done = 0;
       await page.locator('#one').click(); state.done++;
       try { await page.locator('#two').click(); } catch {}
       await page.locator('#three').click();`,
      async () => {
        if (++calls === 2) throw new Error("outcome unknown");
        return { executed: true };
      },
      signal(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof BrowserRuntimeError);
      assert.equal(error.result.steps_completed, 1);
      assert.match(error.message, /outcome unknown/);
      return true;
    },
  );
  assert.equal(calls, 2);
  runtime.closeAll();
});

test("cancellation releases a run even when its browser RPC has not replied", async () => {
  const runtime = new BrowserRuntime();
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let reply!: (value: unknown) => void;
  const task = runtime.run(
    "task",
    "await page.goto('https://example.com');",
    async () => {
      entered();
      return new Promise((resolve) => {
        reply = resolve;
      });
    },
    controller.signal,
  );
  await started;
  controller.abort();
  await assert.rejects(task, (error: unknown) => {
    assert.ok(error instanceof BrowserRuntimeError);
    assert.equal(error.code, "operation_cancelled");
    assert.equal(error.status, "outcome_unknown");
    assert.equal(error.result.steps_completed, 0);
    return true;
  });
  reply({ executed: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await runtime.run("task", "return 3;", async () => ({}), signal())).value, 3);
});

test("unawaited browser actions do not begin after returning and CPU loops are interrupted", async () => {
  const runtime = new BrowserRuntime();
  let calls = 0;
  await assert.rejects(
    runtime.run(
      "task",
      "page.locator('#save').click(); return 2;",
      async () => {
        calls++;
      },
      signal(),
    ),
    /Await every browser operation/,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
  const before = Date.now();
  await assert.rejects(
    runtime.run("task", "while(true){}", async () => ({}), signal()),
    /interrupted/,
  );
  assert.ok(Date.now() - before < 2000);
  assert.equal((await runtime.run("task", "return 4;", async () => ({}), signal())).value, 4);
});

test("script errors retain unawaited in-flight step IDs without replacing the original error", async () => {
  const step = {
    operation_id: "unawaited-step-1",
    method: "open",
    status: "outcome_unknown" as const,
    error: { code: "step_receipt_unconfirmed", message: "Step receipt is still pending" },
  };
  for (const [ending, message] of [
    ['throw Error("original script error");', "original script error"],
    ["return 2;", "Await every browser operation before returning"],
  ]) {
    const runtime = new BrowserRuntime();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    let calls = 0;
    let reply: ((value: unknown) => void) | undefined;
    try {
      await assert.rejects(
        runtime.run(
          "task",
          `page.goto('https://example.com'); page.observe();
           for (let i = 0; i < 300; i++) await Promise.resolve(); ${ending}`,
          async () => {
            calls++;
            return new Promise((resolve) => {
              reply = resolve;
            });
          },
          controller.signal,
          () => step,
        ),
        (error: unknown) => {
          assert.ok(error instanceof BrowserRuntimeError);
          assert.equal(calls, 1, "The first step must already be dispatched");
          assert.equal(error.code, "browser_code_failed");
          assert.equal(error.message, message);
          assert.equal(error.status, "outcome_unknown");
          assert.equal(error.result.steps_completed, 0);
          assert.deepEqual(error.result.failed_step, step);
          return true;
        },
      );
      reply?.({ executed: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(calls, 1, "Queued steps must not run after the script ends");
      assert.equal((await runtime.run("task", "return 3;", async () => ({}), signal())).value, 3);
    } finally {
      clearTimeout(timer);
      reply?.({ executed: true });
      runtime.closeAll();
    }
  }
});

test("session concurrency is refused and log output stays bounded", async () => {
  const runtime = new BrowserRuntime();
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const task = runtime.run(
    "task",
    "await page.read();",
    async () => {
      entered();
      return new Promise(() => {});
    },
    controller.signal,
  );
  await started;
  await assert.rejects(
    runtime.run("task", "return 1;", async () => ({}), signal()),
    /already running/,
  );
  runtime.close("task");
  await assert.rejects(task, /cancelled/);
  const result = await runtime.run(
    "task",
    `for(let i=0;i<1000;i++) console.log('x'.repeat(1000));`,
    async () => ({}),
    signal(),
  );
  assert.ok(JSON.stringify(result.output).length < 13000);
  runtime.closeAll();
});

test("large return values are explicitly truncated while persistent state remains available", async () => {
  const runtime = new BrowserRuntime();
  const call = async () => ({});
  const result = await runtime.run(
    "task",
    "state.text='x'.repeat(30000); return state.text;",
    call,
    signal(),
  );
  assert.equal(result.value, null);
  assert.equal(result.value_truncated, true);
  assert.equal(String(result.value_preview).length, 24000);
  assert.equal((await runtime.run("task", "return state.text.length;", call, signal())).value, 30000);
  runtime.closeAll();
});

test("frame locators scope every action, wait and read to the selected iframe", async () => {
  const runtime = new BrowserRuntime();
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const result = await runtime.run(
    "task",
    `const frame = page.frameLocator('#editor');
     await frame.locator('#name').fill('Example');
     await frame.locator('#name').waitFor({state:'value',value:'Example'});
     await frame.read({mode:'tables'});
     return await frame.evaluate(() => document.title);`,
    async (method, args) => {
      calls.push({ method, args });
      return { value: "Frame" };
    },
    signal(),
  );
  assert.equal(result.value, "Frame");
  assert.equal(calls.length, 4);
  for (const entry of calls) assert.equal(entry.args.frame_selector, "#editor");
  runtime.closeAll();
});

test("explicit sleep preserves browser step counts and is cancellable", async () => {
  const runtime = new BrowserRuntime();
  const calls: string[] = [];
  const call = async (method: string) => {
    calls.push(method);
    return { value: true };
  };
  const result = await runtime.run(
    "sleep",
    `await page.locator('#like').click({hold_ms:40}); await page.sleep(10); return await page.evaluate(() => true);`,
    call,
    signal(),
  );
  assert.equal(result.steps_completed, 2);
  assert.deepEqual(calls, ["locate_act", "evaluate"]);
  for (const value of ["-1", "10001", "1.5", '"10"']) {
    await assert.rejects(runtime.run("invalid", `await page.sleep(${value});`, call, signal()), /sleep/);
  }
  const controller = new AbortController();
  const pending = runtime.run(
    "cancel-sleep",
    'await page.sleep(10000); await page.locator("#never").click();',
    call,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /cancel/i);
  assert.equal(calls.length, 2);
  runtime.closeAll();
});

test("browser script preserves the failed step receipt and classifies partial execution", async () => {
  const receipt = {
    operation_id: "script-step-2",
    method: "locate_act",
    status: "refused" as const,
    error: { code: "target_not_unique", message: "Multiple targets" },
  };
  for (const completed of [0, 1]) {
    const runtime = new BrowserRuntime();
    let calls = 0;
    await assert.rejects(
      runtime.run(
        "task",
        `${completed ? "await page.observe();" : ""} await page.locator('#save').click();`,
        async () => {
          if (calls++ < completed) return { observed: true };
          throw new BrowserStepError(receipt);
        },
        signal(),
      ),
      (error: unknown) => {
        assert.ok(error instanceof BrowserRuntimeError);
        assert.equal(error.status, completed ? "failed" : "refused");
        assert.equal(error.result.steps_completed, completed);
        assert.deepEqual(error.result.failed_step, receipt);
        return true;
      },
    );
    runtime.closeAll();
  }
  const runtime = new BrowserRuntime();
  const unknown = {
    ...receipt,
    status: "outcome_unknown" as const,
    error: { code: "outcome_unknown", message: "Connection lost" },
  };
  await assert.rejects(
    runtime.run(
      "task",
      "await page.locator('#save').click();",
      async () => {
        throw new BrowserStepError(unknown);
      },
      signal(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof BrowserRuntimeError);
      assert.equal(error.status, "outcome_unknown");
      assert.equal(error.result.steps_completed, 0);
      assert.deepEqual(error.result.failed_step, unknown);
      return true;
    },
  );
  runtime.closeAll();
});
