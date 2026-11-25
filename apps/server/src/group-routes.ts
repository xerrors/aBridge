import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  adminGroupInputSchema,
  groupInputSchema,
  groupInviteIssueSchema,
  groupJoinSchema,
} from "@abridge/protocol";
import type { Store } from "./store.js";
import { BridgeError, type User } from "./types.js";

interface GroupRouteContext {
  store: Store;
  account(request: FastifyRequest): User;
  requireAdmin(request: FastifyRequest): void;
  rateLimit(request: FastifyRequest, scope?: string, limit?: number): void;
}

export function registerGroupRoutes(app: FastifyInstance, context: GroupRouteContext): void {
  const { store, account, requireAdmin, rateLimit } = context;
  app.get("/api/admin/users", async (request) => {
    requireAdmin(request);
    return { users: store.users() };
  });
  app.post("/api/groups/join", async (request) => {
    const user = account(request);
    rateLimit(request, "group-join", 30);
    return store.groups.join(user.id, groupJoinSchema.parse(request.body).code);
  });
  for (const admin of [false, true]) {
    const prefix = admin ? "/api/admin/groups" : "/api/groups";
    const actor = (request: FastifyRequest): string | undefined => {
      if (admin) {
        requireAdmin(request);
        return undefined;
      }
      return account(request).id;
    };
    const requireGroup = (request: FastifyRequest, ownerOnly = false) => {
      const userId = actor(request);
      const { id } = request.params as { id: string };
      return store.groups.require(id, userId, ownerOnly);
    };
    app.get(prefix, async (request) => ({ groups: store.groups.list(actor(request)) }));
    app.post(prefix, async (request, reply) => {
      const userId = actor(request);
      rateLimit(request, "group-create", 30);
      const group = admin
        ? (() => {
            const body = adminGroupInputSchema.parse(request.body);
            return store.groups.create(body.owner_id, body.name);
          })()
        : store.groups.create(userId!, groupInputSchema.parse(request.body).name);
      reply.code(201);
      return group;
    });
    app.get(prefix + "/:id", async (request) => requireGroup(request));
    app.patch(prefix + "/:id", async (request) => {
      const group = requireGroup(request, true);
      return store.groups.rename(group.id, groupInputSchema.parse(request.body).name);
    });
    app.delete(prefix + "/:id", async (request) => {
      store.groups.remove(requireGroup(request, true).id);
      return { ok: true };
    });
    app.get(prefix + "/:id/invites", async (request) => ({
      invites: store.groups.invites(requireGroup(request, true).id),
    }));
    app.post(prefix + "/:id/invites", async (request, reply) => {
      const group = requireGroup(request, true);
      rateLimit(request, "group-invite", 30);
      const body = groupInviteIssueSchema.parse(request.body ?? {});
      reply.code(201);
      return store.groups.issue(group.id, body.expires_in_seconds);
    });
    app.delete(prefix + "/:id/invites/:inviteId", async (request) => {
      const group = requireGroup(request, true);
      const { inviteId } = request.params as { inviteId: string };
      store.groups.revoke(group.id, inviteId);
      return { ok: true };
    });
    app.delete(prefix + "/:id/members/:userId", async (request) => {
      const group = requireGroup(request);
      const userId = actor(request);
      const target = (request.params as { userId: string }).userId;
      if (userId && userId !== target && group.owner_id !== userId)
        throw new BridgeError("group_owner_required", "Only the owner can remove another member", 403);
      store.groups.removeMember(group.id, target);
      return { ok: true };
    });
  }
}
