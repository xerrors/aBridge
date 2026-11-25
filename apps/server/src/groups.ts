import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { GroupInvite, GroupInviteIssued, GroupView } from "@abridge/protocol";
import { BridgeError, nowSeconds } from "./types.js";

const id = (prefix: string) => prefix + "_" + randomBytes(12).toString("hex");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Membership is deliberately separate from device ownership and connection policy. */
export class GroupStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS groups(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), created_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members(
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), joined_at REAL NOT NULL,
      PRIMARY KEY(group_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS group_invites(
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      code_digest TEXT UNIQUE NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL, revoked_at REAL
    );`);
  }
  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private rows<T>(sql: string, ...values: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...values) as T[];
  }
  get(groupId: string): GroupView | undefined {
    const group = this.rows<Omit<GroupView, "members">>("SELECT * FROM groups WHERE id=?", groupId)[0];
    if (!group) return undefined;
    const members = this.rows<GroupView["members"][number]>(
      `SELECT u.id,u.username,m.joined_at,CASE WHEN u.id=g.owner_id THEN 'owner' ELSE 'member' END AS role
       FROM group_members m JOIN users u ON u.id=m.user_id JOIN groups g ON g.id=m.group_id
       WHERE m.group_id=? ORDER BY m.joined_at,u.id`,
      groupId,
    );
    return { ...group, members };
  }
  list(userId?: string): GroupView[] {
    const rows = userId
      ? this.rows<{ id: string }>(
          "SELECT g.id FROM groups g JOIN group_members m ON m.group_id=g.id WHERE m.user_id=? ORDER BY g.created_at DESC,g.id",
          userId,
        )
      : this.rows<{ id: string }>("SELECT id FROM groups ORDER BY created_at DESC,id");
    return rows.map(({ id }) => this.get(id)!);
  }
  require(groupId: string, userId?: string, ownerOnly = false): GroupView {
    const group = this.get(groupId);
    if (!group || (userId && !group.members.some((member) => member.id === userId)))
      throw new BridgeError("not_found", "Group not found", 404);
    if (ownerOnly && userId && group.owner_id !== userId)
      throw new BridgeError("group_owner_required", "Only the group owner can manage this group", 403);
    return group;
  }
  create(ownerId: string, name: string): GroupView {
    if (!this.db.prepare("SELECT id FROM users WHERE id=?").get(ownerId))
      throw new BridgeError("not_found", "User not found", 404);
    return this.transaction(() => {
      const groupId = id("grp"),
        created = nowSeconds();
      this.db.prepare("INSERT INTO groups VALUES(?,?,?,?)").run(groupId, name, ownerId, created);
      this.db.prepare("INSERT INTO group_members VALUES(?,?,?)").run(groupId, ownerId, created);
      return this.get(groupId)!;
    });
  }
  rename(groupId: string, name: string): GroupView {
    this.require(groupId);
    this.db.prepare("UPDATE groups SET name=? WHERE id=?").run(name, groupId);
    return this.get(groupId)!;
  }
  remove(groupId: string): void {
    this.require(groupId);
    this.db.prepare("DELETE FROM groups WHERE id=?").run(groupId);
  }
  removeMember(groupId: string, userId: string): void {
    const group = this.require(groupId);
    if (group.owner_id === userId)
      throw new BridgeError("group_owner_required", "The owner cannot leave; delete the group instead", 409);
    this.db.prepare("DELETE FROM group_members WHERE group_id=? AND user_id=?").run(groupId, userId);
  }
  invites(groupId: string): GroupInvite[] {
    this.require(groupId);
    return this.rows(
      "SELECT id,group_id,created_at,expires_at,revoked_at FROM group_invites WHERE group_id=? ORDER BY created_at DESC,id",
      groupId,
    );
  }
  issue(groupId: string, expiresInSeconds: number): GroupInviteIssued {
    this.require(groupId);
    const created = nowSeconds(),
      code = randomBytes(24).toString("base64url");
    const invite: GroupInvite = {
      id: id("ginv"),
      group_id: groupId,
      created_at: created,
      expires_at: created + expiresInSeconds,
      revoked_at: null,
    };
    this.db
      .prepare("INSERT INTO group_invites VALUES(?,?,?,?,?,NULL)")
      .run(invite.id, groupId, digest(code), created, invite.expires_at);
    return { invite, code };
  }
  revoke(groupId: string, inviteId: string): void {
    const result = this.db
      .prepare("UPDATE group_invites SET revoked_at=COALESCE(revoked_at,?) WHERE group_id=? AND id=?")
      .run(nowSeconds(), groupId, inviteId);
    if (!result.changes) throw new BridgeError("not_found", "Invite not found", 404);
  }
  join(userId: string, code: string): GroupView {
    return this.transaction(() => {
      const invite = this.rows<{ group_id: string }>(
        "SELECT group_id FROM group_invites WHERE code_digest=? AND revoked_at IS NULL AND expires_at>?",
        digest(code),
        nowSeconds(),
      )[0];
      if (!invite) throw new BridgeError("invalid_invite", "Invite is invalid, expired or revoked", 404);
      this.db
        .prepare("INSERT OR IGNORE INTO group_members VALUES(?,?,?)")
        .run(invite.group_id, userId, nowSeconds());
      return this.get(invite.group_id)!;
    });
  }
}
