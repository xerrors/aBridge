import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { groupViewSchema, groupInviteIssuedSchema } from "@abridge/protocol";
import { createServer } from "../src/server.js";

const password = "fixture-password-1234";
test("groups persist stable users, enforce ownership, and never grant device access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-groups-"));
  const config = { dbPath: join(dir, "server.db"), port: 0 };
  let server = await createServer(config);
  try {
    const owner = await server.store.createUser("Owner", password);
    const member = await server.store.createUser("Member", password);
    const stranger = await server.store.createUser("Stranger", password);
    const headers = (userId: string) => ({
      host: "localhost",
      cookie: "abridge_session=" + server.store.createLogin(userId),
    });
    const ownerHeaders = headers(owner.id),
      memberHeaders = headers(member.id),
      strangerHeaders = headers(stranger.id);
    const adminHeaders = { host: "localhost", authorization: "Bearer " + server.adminToken };
    assert.equal(
      (await server.app.inject({ url: "/api/groups", headers: { host: "localhost" } })).statusCode,
      401,
    );
    assert.equal(
      (await server.app.inject({ url: "/api/admin/groups", headers: memberHeaders })).statusCode,
      401,
    );
    const created = await server.app.inject({
      method: "POST",
      url: "/api/groups",
      headers: ownerHeaders,
      payload: { name: "Fixture team" },
    });
    assert.equal(created.statusCode, 201, created.body);
    const group = groupViewSchema.parse(created.json());
    assert.equal(group.owner_id, owner.id);
    assert.equal(group.members[0]?.role, "owner");
    assert.equal(
      (await server.app.inject({ url: "/api/groups/" + group.id, headers: strangerHeaders })).statusCode,
      404,
    );
    const issued = await server.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/invites`,
      headers: ownerHeaders,
      payload: {},
    });
    assert.equal(issued.statusCode, 201, issued.body);
    const { invite, code } = groupInviteIssuedSchema.parse(issued.json());
    const joinGroup = () =>
      server.app.inject({
        method: "POST",
        url: "/api/groups/join",
        headers: memberHeaders,
        payload: { code },
      });
    assert.equal((await joinGroup()).statusCode, 200);
    assert.equal((await joinGroup()).json().members.length, 2);
    assert.equal(
      (
        await server.app.inject({
          method: "PATCH",
          url: `/api/groups/${group.id}`,
          headers: memberHeaders,
          payload: { name: "Hijack" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await server.app.inject({
          method: "POST",
          url: `/api/groups/${group.id}/invites`,
          headers: memberHeaders,
          payload: {},
        })
      ).statusCode,
      403,
    );
    const device = server.store.createDevice(owner.id, "Owner fixture", ["shell"]).device;
    assert.deepEqual((await server.app.inject({ url: "/api/devices", headers: memberHeaders })).json(), {
      devices: [],
    });
    assert.equal(
      (
        await server.app.inject({
          method: "PATCH",
          url: "/api/devices/" + device.id,
          headers: memberHeaders,
          payload: { name: "Hijack" },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await server.app.inject({
          method: "DELETE",
          url: `/api/groups/${group.id}/members/${owner.id}`,
          headers: ownerHeaders,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await server.app.inject({
          method: "DELETE",
          url: `/api/groups/${group.id}/invites/${invite.id}`,
          headers: ownerHeaders,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/groups/join",
          headers: strangerHeaders,
          payload: { code },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await server.app.inject({ url: "/api/admin/groups", headers: adminHeaders })).json().groups.length,
      1,
    );
    const users = (await server.app.inject({ url: "/api/admin/users", headers: adminHeaders })).json().users;
    assert.equal(users.length, 3);
    assert.equal("password_hash" in users[0], false);
    await server.close();
    server = await createServer(config);
    assert.equal((await server.store.verifyUser("OWNER", password))?.id, owner.id);
    assert.equal(server.store.groups.get(group.id)?.members.length, 2);
    const renewedAdmin = { host: "localhost", authorization: "Bearer " + server.adminToken };
    const adminInvite = await server.app.inject({
      method: "POST",
      url: `/api/admin/groups/${group.id}/invites`,
      headers: renewedAdmin,
      payload: { expires_in_seconds: 60 },
    });
    assert.equal(adminInvite.statusCode, 201);
    const db = new DatabaseSync(config.dbPath);
    try {
      const persisted = db
        .prepare("SELECT * FROM group_invites WHERE id=?")
        .get(adminInvite.json().invite.id)!;
      assert.equal(Object.values(persisted).includes(adminInvite.json().code), false);
      db.prepare("UPDATE group_invites SET expires_at=0 WHERE id=?").run(adminInvite.json().invite.id);
    } finally {
      db.close();
    }
    assert.throws(() => server.store.groups.join(stranger.id, adminInvite.json().code), /expired/);
    assert.equal(
      (
        await server.app.inject({
          method: "DELETE",
          url: `/api/admin/groups/${group.id}`,
          headers: renewedAdmin,
        })
      ).statusCode,
      200,
    );
    assert.equal(server.store.groups.get(group.id), undefined);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
