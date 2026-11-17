/** Opt-in native-browser regressions. Uses only an isolated fixture/profile, never personal pages. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import manifest from "./bench/miniwob-agent-source.json" with { type: "json" };
import { createBenchmarkEnvironment } from "./bench/environment.js";

const baseline = process.argv.includes("--baseline");
const focusBaseline = process.argv.includes("--focus-baseline");
const visualBaseline = process.argv.includes("--visual-baseline");
const blueIcon = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="11" fill="blue"/></svg>`,
).toString("base64");
const orangeIcon = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><path d="M13 2L25 24H1Z" fill="orange"/></svg>`,
).toString("base64");
const fixture = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><meta charset="utf-8"><title>Native input regression</title>
  <style>body{font:18px sans-serif;padding:32px}input,button,span{margin:12px}#plain{cursor:pointer}</style>
  <span id="plain" onclick="document.querySelector('#result').innerText='Native click confirmed'">Open detail</span>
  <div id="mixed" style="position:relative;width:800px;height:60px" onclick="if(event.target===this)document.querySelector('#result').innerText='Exact text confirmed'">Exact text target<button style="position:absolute;left:45%;top:0" onclick="document.querySelector('#result').innerText='Wrong action'">Other action</button></div>
  <style>.icon{display:inline-block;content:url(data:image/svg+xml;base64,${blueIcon});width:26px;height:26px;cursor:pointer}.orange{content:url(data:image/svg+xml;base64,${orangeIcon})}</style>
  <span id="icon-one" class="icon" onclick="document.querySelector('#result').innerText='Icon one confirmed'"></span>
  <span id="icon-two" class="icon orange" onclick="document.querySelector('#result').innerText='Icon two confirmed'"></span>
  <span class="icon" style="cursor:auto"></span><span class="icon" style="display:none"></span>
  <span style="position:relative;display:inline-block"><span class="icon"></span><span style="position:absolute;inset:0;background:white;z-index:1"></span></span>
  <button onclick="document.querySelector('#cover').style.display='block'">Show overlay</button>
  <div id="cover" style="display:none;position:fixed;inset:0;z-index:100;background:rgba(255,255,255,.9)"><button onclick="document.querySelector('#cover').style.display='none'">Dismiss overlay</button></div>
  <input id="readonly" aria-label="Choose date" readonly value="unchanged">
  <input id="editable" aria-label="Editable name"><button>Continue</button><p id="result">Waiting</p>
  <input aria-label="Picker trigger" onfocus="document.querySelector('#popup').style.display='block'" onblur="document.querySelector('#popup').style.display='none'">
  <div id="popup" style="display:none" onmousedown="event.preventDefault()"><a href="#" tabindex="-1" onclick="event.preventDefault();document.querySelector('#result').innerText='Choice confirmed'">Choice Alpha</a></div>`);
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address();
if (!address || typeof address === "string") throw Error("Fixture did not start");
const env = await createBenchmarkEnvironment({ manifest }).catch(async (error) => {
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  throw error;
});
console.log(`Native regression evidence: ${env.runDirectory}`);
let passed = 0;
async function session() {
  const opened = await env.call("session_open", { device_id: env.deviceId, capabilities: ["browser"] });
  const id = String(opened.id);
  await env.call("browser_open", {
    session_id: id,
    url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`,
  });
  return id;
}
async function observe(id: string, query?: string) {
  const response = await env.call("browser_observe", { session_id: id, ...(query ? { query } : {}) });
  return response.result as {
    observation_id: string;
    elements: {
      element_ref: string;
      role: string;
      name: string;
      read_only?: boolean;
      bounds?: { x: number; y: number; width: number; height: number };
    }[];
  };
}
async function callAct(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return await env.call("browser_act", args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = "MCP browser_act: ";
    if (!message.startsWith(prefix)) throw error;
    const detail = JSON.parse(message.slice(prefix.length)) as { code: string };
    return { status: detail.code, error: detail };
  }
}
try {
  let id = await session();
  let obs = await observe(id, "Open detail");
  const plain = obs.elements.find((e) => e.name === "Open detail");
  if (baseline) assert.equal(plain, undefined);
  else {
    assert.ok(plain);
    const act = await callAct({
      session_id: id,
      observation_id: obs.observation_id,
      action: { type: "click", element_ref: plain.element_ref },
      wait_after_ms: 0,
    });
    assert.equal(act.status, "executed");
    assert.equal(
      (
        await env.runCode(
          id,
          "return await page.evaluate(() => document.querySelector('#result').innerText);",
        )
      ).value,
      "Native click confirmed",
    );
  }
  if (!baseline) {
    obs = await observe(id, "Exact text target");
    const exact = obs.elements.find((e) => e.name === "Exact text target");
    assert.ok(exact);
    const clicked = await callAct({
      session_id: id,
      observation_id: obs.observation_id,
      action: { type: "click", element_ref: exact.element_ref },
      wait_after_ms: 0,
    });
    assert.equal(clicked.status, "executed");
    assert.equal(
      (
        await env.runCode(
          id,
          "return await page.evaluate(() => document.querySelector('#result').innerText);",
        )
      ).value,
      "Exact text confirmed",
    );
  }
  console.log(`PASS non-semantic text ${baseline ? "missing reference reproduced" : "native click"}`);
  passed++;
  await env.call("session_close", { session_id: id });

  id = await session();
  obs = await observe(id);
  const root = obs.elements.find((e) => e.role === "rootwebarea");
  assert.ok(root);
  const key = await callAct({
    session_id: id,
    observation_id: obs.observation_id,
    action: { type: "press", element_ref: root.element_ref, key: "Tab" },
    wait_after_ms: 0,
  });
  if (baseline) assert.equal(key.status, "outcome_unknown");
  else {
    assert.equal(key.status, "executed");
    assert.ok((await observe(id)).observation_id);
    assert.equal(
      (await env.runCode(id, "return await page.evaluate(() => document.activeElement.innerText);")).value,
      "Other action",
    );
  }
  console.log(`PASS root Tab ${baseline ? "Document failure reproduced" : "native keyboard"}`);
  passed++;
  await env.call("session_close", { session_id: id });

  id = await session();
  obs = await observe(id);
  const readonly = obs.elements.find((e) => e.name === "Choose date");
  assert.ok(readonly);
  const refused = await callAct({
    session_id: id,
    observation_id: obs.observation_id,
    action: { type: "fill", element_ref: readonly.element_ref, text: "bad" },
    wait_after_ms: 0,
  });
  if (baseline) assert.equal(refused.status, "outcome_unknown");
  else {
    assert.equal((refused.error as { code: string }).code, "invalid_action");
    assert.equal(readonly.read_only, true);
    assert.equal(
      (await env.runCode(id, "return await page.evaluate(() => document.querySelector('#readonly').value);"))
        .value,
      "unchanged",
    );
    obs = await observe(id);
    const editable = obs.elements.find((e) => e.name === "Editable name");
    assert.ok(editable);
    const filled = await callAct({
      session_id: id,
      observation_id: obs.observation_id,
      action: { type: "fill", element_ref: editable.element_ref, text: "Recovered" },
      wait_after_ms: 0,
    });
    assert.equal(filled.status, "executed");
    assert.equal(
      (await env.runCode(id, "return await page.evaluate(() => document.querySelector('#editable').value);"))
        .value,
      "Recovered",
    );
  }
  console.log(
    `PASS readonly fill ${baseline ? "destructive refusal reproduced" : "non-destructive refusal and recovery"}`,
  );
  passed++;
  await env.call("session_close", { session_id: id });
  if (!baseline) {
    id = await session();
    obs = await observe(id);
    const trigger = obs.elements.find((e) => e.name === "Picker trigger");
    assert.ok(trigger);
    assert.equal(
      (
        await callAct({
          session_id: id,
          observation_id: obs.observation_id,
          action: { type: "click", element_ref: trigger.element_ref },
          wait_after_ms: 0,
        })
      ).status,
      "executed",
    );
    obs = await observe(id, "Choice Alpha");
    const choice = obs.elements.find((e) => e.name === "Choice Alpha");
    assert.ok(choice);
    const selected = await callAct({
      session_id: id,
      observation_id: obs.observation_id,
      action: { type: "click", element_ref: choice.element_ref },
      wait_after_ms: 0,
    });
    if (focusBaseline) assert.equal(selected.status, "outcome_unknown");
    else {
      assert.equal(selected.status, "executed");
      assert.equal(
        (
          await env.runCode(
            id,
            "return await page.evaluate(() => document.querySelector('#result').innerText);",
          )
        ).value,
        "Choice confirmed",
      );
    }
    console.log(
      `PASS popup selection ${focusBaseline ? "pre-focus closes popup reproduced" : "native mouse event order"}`,
    );
    passed++;
    await env.call("session_close", { session_id: id });
  }
  if (!baseline && !focusBaseline) {
    id = await session();
    obs = await observe(id);
    let icons = obs.elements.filter((e) => e.role === "visualtarget");
    if (visualBaseline) assert.equal(icons.length, 0);
    else {
      assert.equal(icons.length, 2);
      assert.ok(icons.every((e) => e.name === "Unlabelled clickable target"));
      for (const [selector, expected] of [
        ["#icon-one", "Icon one confirmed"],
        ["#icon-two", "Icon two confirmed"],
      ]) {
        const bounds = (
          await env.runCode(
            id,
            `return await page.evaluate(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y};});`,
          )
        ).value as { x: number; y: number };
        obs = await observe(id);
        const icon = obs.elements.find(
          (e) =>
            e.role === "visualtarget" &&
            e.bounds &&
            Math.abs(e.bounds.x - bounds.x) < 1 &&
            Math.abs(e.bounds.y - bounds.y) < 1,
        );
        assert.ok(icon);
        assert.equal(
          (
            await callAct({
              session_id: id,
              observation_id: obs.observation_id,
              action: { type: "click", element_ref: icon.element_ref },
              wait_after_ms: 0,
            })
          ).status,
          "executed",
        );
        assert.equal(
          (
            await env.runCode(
              id,
              "return await page.evaluate(() => document.querySelector('#result').innerText);",
            )
          ).value,
          expected,
        );
      }
    }
    console.log(
      `PASS icon-only pointer targets ${visualBaseline ? "missing references reproduced" : "bounded neutral references and native clicks"}`,
    );
    passed++;
    await env.call("session_close", { session_id: id });

    id = await session();
    obs = await observe(id);
    const show = obs.elements.find((e) => e.name === "Show overlay");
    assert.ok(show);
    assert.equal(
      (
        await callAct({
          session_id: id,
          observation_id: obs.observation_id,
          action: { type: "click", element_ref: show.element_ref },
          wait_after_ms: 0,
        })
      ).status,
      "executed",
    );
    obs = await observe(id);
    const covered = obs.elements.find((e) => e.name === "Editable name");
    assert.ok(covered);
    const refused = await callAct({
      session_id: id,
      observation_id: obs.observation_id,
      action: { type: "fill", element_ref: covered.element_ref, text: "Must not type" },
      wait_after_ms: 0,
    });
    if (visualBaseline) assert.equal(refused.status, "outcome_unknown");
    else {
      assert.equal((refused.error as { code: string }).code, "invalid_action");
      assert.equal(
        (
          await env.runCode(
            id,
            "return await page.evaluate(() => document.querySelector('#editable').value);",
          )
        ).value,
        "",
      );
      obs = await observe(id);
      const dismiss = obs.elements.find((e) => e.name === "Dismiss overlay");
      assert.ok(dismiss);
      assert.equal(
        (
          await callAct({
            session_id: id,
            observation_id: obs.observation_id,
            action: { type: "click", element_ref: dismiss.element_ref },
            wait_after_ms: 0,
          })
        ).status,
        "executed",
      );
      obs = await observe(id);
      const editable = obs.elements.find((e) => e.name === "Editable name");
      assert.ok(editable);
      assert.equal(
        (
          await callAct({
            session_id: id,
            observation_id: obs.observation_id,
            action: { type: "fill", element_ref: editable.element_ref, text: "After overlay" },
            wait_after_ms: 0,
          })
        ).status,
        "executed",
      );
      assert.equal(
        (
          await env.runCode(
            id,
            "return await page.evaluate(() => document.querySelector('#editable').value);",
          )
        ).value,
        "After overlay",
      );
    }
    console.log(
      `PASS occlusion preflight ${visualBaseline ? "destructive refusal reproduced" : "refusal preserves page and recovery"}`,
    );
    passed++;
    await env.call("session_close", { session_id: id });
  }
  console.log(
    `${passed}/${baseline ? 3 : focusBaseline ? 4 : 6} native regression checks passed (${baseline ? "baseline reproduction" : "fixed"})`,
  );
} finally {
  await env.close();
  await new Promise<void>((resolve, reject) => fixture.close((error) => (error ? reject(error) : resolve())));
}
