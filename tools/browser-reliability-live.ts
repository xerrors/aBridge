/** Opt-in native-browser regressions. Uses only an isolated fixture/profile, never personal pages. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import manifest from "./bench/miniwob-agent-source.json" with { type: "json" };
import { createBenchmarkEnvironment } from "./bench/environment.js";

const baseline = process.argv.includes("--baseline");
const fixture = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><meta charset="utf-8"><title>Native input regression</title>
  <style>body{font:18px sans-serif;padding:32px}input,button,span{margin:12px}#plain{cursor:pointer}</style>
  <span id="plain" onclick="document.querySelector('#result').innerText='Native click confirmed'">Open detail</span>
  <div id="mixed" style="position:relative;width:800px;height:60px" onclick="if(event.target===this)document.querySelector('#result').innerText='Exact text confirmed'">Exact text target<button style="position:absolute;left:45%;top:0" onclick="document.querySelector('#result').innerText='Wrong action'">Other action</button></div>
  <input id="readonly" aria-label="Choose date" readonly value="unchanged">
  <input id="editable" aria-label="Editable name"><button>Continue</button><p id="result">Waiting</p>`);
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
    elements: { element_ref: string; role: string; name: string; read_only?: boolean }[];
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
  console.log(
    `${passed}/3 native regression checks passed (${baseline ? "baseline reproduction" : "fixed"})`,
  );
} finally {
  await env.close();
  await new Promise<void>((resolve, reject) => fixture.close((error) => (error ? reject(error) : resolve())));
}
