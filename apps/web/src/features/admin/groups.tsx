import { useCallback, useEffect, useState } from "preact/hooks";
import QRCode from "qrcode";
import {
  groupsListSchema,
  groupViewSchema,
  groupInvitesListSchema,
  groupInviteIssuedSchema,
  type GroupView,
  type GroupInvite,
  type GroupInviteIssued,
} from "@abridge/protocol";
import { api, objectResultSchema } from "../../lib/api.js";
import { Field, Form, Modal } from "../../components/forms.js";

export function GroupsPage({ notify }: { notify: (message: string) => void }) {
  const base = "/api/admin/groups";
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<GroupView | null>(null);
  const refresh = useCallback(async () => {
    const result = await api(base, groupsListSchema);
    setGroups(result.groups);
  }, [base]);
  useEffect(() => {
    let alive = true;
    void api(base, groupsListSchema)
      .then((r) => {
        if (alive) setGroups(r.groups);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : "读取小组失败");
      });
    return () => {
      alive = false;
    };
  }, [base]);
  return (
    <>
      <div class="section-heading">
        <h2>全部小组</h2>
        <div class="actions">
          <button class="primary" onClick={() => setCreating(true)}>
            创建小组
          </button>
        </div>
      </div>
      <p class="muted small">小组仅用于组织成员。入组不会授予设备或 Agent 访问权限。</p>
      {error && (
        <p class="error" role="alert">
          {error}
          <button
            onClick={() =>
              void refresh()
                .then(() => setError(""))
                .catch((e) => setError(String(e)))
            }
          >
            重试
          </button>
        </p>
      )}
      <div class="admin-group-list">
        {groups.map((g) => (
          <section key={g.id} class="surface admin-group">
            <h2>{g.name}</h2>
            <p class="muted small">
              {g.members.length} 位成员 · {g.id}
            </p>
            <div class="actions">
              <button onClick={() => setSelected(g)}>成员与邀请</button>
            </div>
          </section>
        ))}
        {!groups.length && !error && <p class="admin-empty">暂无小组</p>}
      </div>
      {creating && (
        <Modal title="创建小组" close={() => setCreating(false)}>
          <Form
            label="创建"
            onSubmit={async (form) => {
              await api(base, groupViewSchema, {
                name: form.get("name"),
                owner_id: form.get("owner_id"),
              });
              setCreating(false);
              await refresh();
              notify("小组已创建");
            }}
          >
            <Field name="name" label="小组名称" />
            <Field name="owner_id" label="组长账号 ID" />
          </Form>
        </Modal>
      )}
      {selected && (
        <GroupDetail
          key={selected.id}
          group={selected}
          base={base}
          close={() => setSelected(null)}
          changed={refresh}
          notify={notify}
        />
      )}
    </>
  );
}
function GroupDetail({
  group,
  base,
  close,
  changed,
  notify,
}: {
  group: GroupView;
  base: string;
  close: () => void;
  changed: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [invites, setInvites] = useState<GroupInvite[]>([]);
  const [issued, setIssued] = useState<GroupInviteIssued | null>(null);
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: "member" | "invite" | "delete"; id: string } | null>(null);
  const path = `${base}/${encodeURIComponent(group.id)}`;
  const refresh = useCallback(async () => {
    const response = await api(`${path}/invites`, groupInvitesListSchema);
    setInvites(response.invites);
  }, [path]);
  useEffect(() => {
    let alive = true;
    void api(`${path}/invites`, groupInvitesListSchema)
      .then((r) => {
        if (alive) setInvites(r.invites);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : "无法读取邀请；需要组长权限");
      });
    return () => {
      alive = false;
    };
  }, [path]);
  useEffect(() => {
    let alive = true;
    setImage("");
    if (issued)
      void QRCode.toDataURL(issued.code, { width: 200, margin: 2 })
        .then((url) => {
          if (alive) setImage(url);
        })
        .catch(() => {
          if (alive) setError("二维码生成失败，请复制邀请码");
        });
    return () => {
      alive = false;
    };
  }, [issued]);
  const issue = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api(`${path}/invites`, groupInviteIssuedSchema, {});
      setIssued(r);
      await refresh();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建邀请失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={group.name} close={close} className="admin-detail" dismissible={!busy}>
      <p class="muted small">小组 ID：{group.id}</p>
      <h3>成员</h3>
      {group.members.map((m) => (
        <div class="admin-queue-row" key={m.id}>
          <span>
            {m.username}
            <small class="muted"> · {m.role === "owner" ? "组长" : "成员"}</small>
            <br />
            <code>{m.id}</code>
          </span>
          {m.role !== "owner" && (
            <button disabled={busy} onClick={() => setConfirm({ kind: "member", id: m.id })}>
              移出成员
            </button>
          )}
        </div>
      ))}
      <>
        <h3>入组邀请</h3>
        <p class="muted small">
          邀请有效期24小时；邀请码仅在生成时展示，请妥善保存。二维码包含邀请码，可用于接收方入组。
        </p>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <button disabled={busy} onClick={() => void issue()}>
          {busy ? "生成中…" : "生成邀请和二维码"}
        </button>
        {issued && (
          <div class="admin-invite">
            {image && <img class="admin-qr" src={image} alt="小组入组邀请码二维码" />}
            <code>{issued.code}</code>
            <small>有效至 {new Date(issued.invite.expires_at * 1000).toLocaleString("zh-CN")}</small>
          </div>
        )}
        {invites.map((i) => (
          <div class="admin-queue-row" key={i.id}>
            <span>
              {i.id}
              <br />
              <small class="muted">
                {i.revoked_at
                  ? "已撤销"
                  : i.expires_at < Date.now() / 1000
                    ? "已过期"
                    : `有效至 ${new Date(i.expires_at * 1000).toLocaleString("zh-CN")}`}
              </small>
            </span>
            {!i.revoked_at && i.expires_at > Date.now() / 1000 && (
              <button disabled={busy} onClick={() => setConfirm({ kind: "invite", id: i.id })}>
                撤销邀请
              </button>
            )}
          </div>
        ))}
        <h3>小组设置</h3>
        <Form
          label="保存名称"
          onSubmit={async (form) => {
            await api(path, groupViewSchema, { name: form.get("name") }, "PATCH");
            await changed();
            notify("小组名称已更新");
            close();
          }}
        >
          <Field name="name" label="小组名称" value={group.name} />
        </Form>
        <button class="danger" disabled={busy} onClick={() => setConfirm({ kind: "delete", id: group.id })}>
          删除小组
        </button>
      </>
      {confirm && (
        <Form
          label="确认操作"
          tone="danger"
          cancel={() => setConfirm(null)}
          onSubmit={async () => {
            await api(
              confirm.kind === "delete"
                ? path
                : `${path}/${confirm.kind === "member" ? "members" : "invites"}/${encodeURIComponent(confirm.id)}`,
              objectResultSchema,
              {},
              "DELETE",
            );
            if (confirm.kind === "invite") {
              if (issued?.invite.id === confirm.id) setIssued(null);
              setConfirm(null);
              await refresh();
            } else {
              await changed();
              close();
            }
            notify("操作已完成");
          }}
        >
          <p>
            {confirm.kind === "delete"
              ? "删除整个小组及其邀请？"
              : confirm.kind === "member"
                ? "确认移出此成员？"
                : "撤销后，此邀请码将无法继续入组。"}
          </p>
        </Form>
      )}
    </Modal>
  );
}
