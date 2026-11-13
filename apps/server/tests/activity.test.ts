import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import type { Operation } from "../src/types.js";

test("activity filters query all history, combine dimensions, paginate, and isolate accounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-activity-"));
  const server = await createServer({ dbPath: join(dir, "server.db"), port: 0 });
  try {
    const owner = await server.store.createUser("history-owner", "fixture-password-long");
    const other = await server.store.createUser("history-other", "fixture-password-long");
    const first = server.store.createDevice(owner.id, "Laptop", ["shell"]).device;
    const second = server.store.createDevice(owner.id, "Browser", ["browser"], "browser").device;
    const agent = server.store.createGrant(owner.id, "Agent A", {
      mode: "all",
      capabilities: ["shell", "browser"],
      overrides: [],
    }).grant;
    const another = server.store.createGrant(owner.id, "Agent B", {
      mode: "all",
      capabilities: ["shell", "browser"],
      overrides: [],
    }).grant;
    const session = server.store.createSession(agent, first.id, ["shell"], Date.now() / 1000 + 300);
    const insert = (
      id: string,
      device = first,
      grant = agent,
      tool = "command_execute",
      ownerId = owner.id,
    ) => {
      server.store.createOperation({
        id,
        owner_id: ownerId,
        device_id: device.id,
        grant_id: grant.id,
        session_id: session.id,
        tool,
        request_hash: "fixture",
        epoch: 0,
      });
      server.store.finishOperation(id, "executed");
    };
    insert("old-target");
    for (let index = 0; index < 110; index++) insert(`recent-${index}`, second, another, "browser_observe");
    insert("other-agent", first, another);
    insert("other-tool", first, agent, "file_read");
    const foreign = server.store.createDevice(other.id, "Private", ["shell"]).device;
    const foreignAgent = server.store.createGrant(other.id, "Private Agent", {
      mode: "all",
      capabilities: ["shell"],
      overrides: [],
    }).grant;
    insert("private", foreign, foreignAgent, "private_tool", other.id);
    const login = await server.app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "history-owner", password: "fixture-password-long" },
    });
    const cookie = login.headers["set-cookie"]!.toString().split(";")[0]!;
    const activity = async (query = "") => {
      const response = await server.app.inject({
        method: "GET",
        url: `/api/activity${query}`,
        headers: { cookie },
      });
      assert.equal(response.statusCode, 200);
      return response.json<{ operations: Operation[]; total: number; tools: string[] }>();
    };
    const all = await activity();
    assert.equal(all.total, 113);
    assert.equal(all.operations.length, 50);
    assert.deepEqual(all.tools, ["browser_observe", "command_execute", "file_read"]);
    const page2 = await activity("?offset=50");
    assert.equal(page2.operations.length, 50);
    assert.equal(
      page2.operations.some((operation) => all.operations.some((entry) => entry.id === operation.id)),
      false,
    );
    assert.equal((await activity("?offset=100")).operations.length, 13);
    const combined = `?device_id=${first.id}&grant_id=${agent.id}&tool=command_execute`;
    assert.deepEqual(
      (await activity(combined)).operations.map((entry) => entry.id),
      ["old-target"],
    );
    const device = await activity(`?device_id=${first.id}`);
    assert.equal(device.total, 3);
    assert.deepEqual(device.tools, ["command_execute", "file_read"]);
    server.store.revokeDevice(first.id);
    await server.control.revokeGrant(agent);
    assert.equal((await activity(combined)).total, 1, "revocation preserves execution history");
    assert.equal((await activity(`?device_id=${foreign.id}`)).total, 0);
    assert.deepEqual((await activity(`?device_id=${foreign.id}`)).tools, []);
    assert.equal((await activity(`?grant_id=${foreignAgent.id}`)).total, 0);
    assert.equal((await activity("?tool=' OR 1=1 --")).total, 0);
    for (const query of ["?offset=-1", "?offset=1.5", "?offset=NaN", "?offset=1000001", "?device_id="]) {
      const response = await server.app.inject({
        method: "GET",
        url: `/api/activity${query}`,
        headers: { cookie },
      });
      assert.equal(response.statusCode, 422);
    }
    assert.equal((await server.app.inject({ method: "GET", url: "/api/activity" })).statusCode, 401);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
