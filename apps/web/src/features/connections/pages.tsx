import { ArrowLeft } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { useCredentialGuard } from "../../lib/credential-guard.js";
import { z } from "zod";
import { api, grantSchema, type Device, type Grant } from "../../lib/api.js";
import { CopyButton } from "../../components/actions.js";
import { ConnectionEditor } from "./editor.js";
import { ConnectionPreview } from "./preview.js";
import type { RunAction } from "../../lib/types.js";

export function connectionParameters(origin: string, key = "<AGENT_KEY>"): string {
  return JSON.stringify({ url: `${origin}/mcp`, headers: { Authorization: `Bearer ${key}` } }, null, 2);
}

function ConnectionConfiguration({ secret, run }: { secret?: string; run: RunAction }) {
  const [format, setFormat] = useState<"fields" | "json">("fields");
  return (
    <section class="configuration-panel">
      <div class="section-heading">
        <div>
          <h2>MCP</h2>
        </div>
        <div class="segmented" aria-label="配置格式">
          <button aria-pressed={format === "fields"} onClick={() => setFormat("fields")}>
            连接参数
          </button>
          <button aria-pressed={format === "json"} onClick={() => setFormat("json")}>
            JSON
          </button>
        </div>
      </div>
      {format === "fields" ? (
        <div class="configuration-fields">
          <div class="copy-field">
            <label for="mcp-address">MCP 服务地址</label>
            <div>
              <input id="mcp-address" readOnly value={`${location.origin}/mcp`} />
              <CopyButton value={`${location.origin}/mcp`} run={run} className="secondary">
                复制地址
              </CopyButton>
            </div>
          </div>
          <div class="copy-field">
            <label for="agent-key">Agent Key</label>
            {secret ? (
              <div>
                <input id="agent-key" readOnly value={secret} spellcheck={false} />
                <CopyButton value={secret} run={run} className="secondary">
                  复制 Key
                </CopyButton>
              </div>
            ) : (
              <p class="muted">使用已保存的 Key，或在设置中重新生成。</p>
            )}
          </div>
          <dl class="auth-method">
            <dt>鉴权</dt>
            <dd>Bearer Token</dd>
            <dt>请求头</dt>
            <dd>
              <code>Authorization: Bearer &lt;Agent Key&gt;</code>
            </dd>
          </dl>
        </div>
      ) : (
        <div class="configuration-json">
          {!secret && <p class="small muted">将 &lt;AGENT_KEY&gt; 替换为已保存的 Key 后再使用。</p>}
          <textarea
            class="key-area"
            aria-label="MCP 接入参数"
            readOnly
            value={connectionParameters(location.origin, secret)}
            spellcheck={false}
          />
          <div class="dialog-actions">
            <CopyButton value={connectionParameters(location.origin, secret)} run={run}>
              复制接入参数
            </CopyButton>
          </div>
        </div>
      )}
    </section>
  );
}

export function ConnectionCreatePage({
  devices,
  refresh,
  run,
  notify,
}: {
  devices: Device[];
  refresh: () => Promise<void>;
  run: RunAction;
  notify: (message: string) => void;
}) {
  const [created, setCreated] = useState<Grant | null>(null);
  const [secret, setSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const [creating, setCreating] = useState(false);
  useCredentialGuard(
    creating || Boolean(secret && !saved),
    creating ? "连接正在创建。离开后可能无法取得 Agent Key，仍要离开吗？" : undefined,
  );
  const available = devices.filter((device) => device.status !== "revoked");
  return (
    <div class="task-page">
      <a class="device-back" href="#grants">
        <ArrowLeft aria-hidden="true" />
        Agent 连接
      </a>
      <div class="page-title">
        <div>
          <h1>{created ? "将连接添加到 Agent" : "创建 Agent 连接"}</h1>
        </div>
      </div>
      <div class="connection-setup-layout">
        <div class="connection-progress">
          <ol class="workflow-steps" aria-label="创建连接进度">
            <li class={!created ? "current" : "complete"} aria-current={!created ? "step" : undefined}>
              <span>1</span>
              <div>
                <strong>设置访问权限</strong>
              </div>
            </li>
            <li class={created ? "current" : ""} aria-current={created ? "step" : undefined}>
              <span>2</span>
              <div>
                <strong>配置 Agent</strong>
              </div>
            </li>
          </ol>
        </div>
        <div class="workflow-main">
          {created ? (
            <div class="setup-panel">
              <div class="secret-notice">Key 仅显示一次，请保存到 Agent。</div>
              <ConnectionConfiguration secret={secret} run={run} />
              <div class="setup-completion">
                <label class="inline-check">
                  <input
                    type="checkbox"
                    checked={saved}
                    onChange={(event) => setSaved(event.currentTarget.checked)}
                  />
                  我已保存 Key
                </label>
                <button
                  class="primary"
                  disabled={!saved}
                  onClick={() => {
                    location.hash = `grants/${encodeURIComponent(created.id)}`;
                  }}
                >
                  查看连接
                </button>
              </div>
            </div>
          ) : !available.length ? (
            <section class="surface empty">
              <h2>先连接一台设备</h2>
              <a class="button-link primary" href="#devices/new">
                添加设备
              </a>
            </section>
          ) : (
            <section class="setup-panel">
              <ConnectionEditor
                inline
                devices={devices}
                close={() => {
                  location.hash = "grants";
                }}
                submit={async (input) => {
                  setCreating(true);
                  try {
                    const result = await api(
                      "/api/client-grants",
                      grantSchema.extend({ key: z.string() }),
                      input,
                    );
                    setCreated(result);
                    setSecret(result.key);
                    await refresh().catch((error: unknown) =>
                      notify(error instanceof Error ? error.message : "连接已创建，列表刷新失败"),
                    );
                  } finally {
                    setCreating(false);
                  }
                }}
              />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

export function ConnectionPage({
  grant,
  section,
  run,
  edit,
  rotate,
  revoke,
  reconnect,
  activity,
}: {
  grant: Grant | undefined;
  section?: string;
  run: RunAction;
  edit: (grant: Grant) => void;
  rotate: (grant: Grant) => void;
  revoke: (grant: Grant) => void;
  reconnect: (grant: Grant) => void;
  activity?: ComponentChildren;
}) {
  if (!grant)
    return (
      <>
        <a class="device-back" href="#grants">
          <ArrowLeft aria-hidden="true" />
          Agent 连接
        </a>
        <section class="surface empty">
          <h1>找不到此连接</h1>
          <a href="#grants">返回连接列表</a>
        </section>
      </>
    );
  const revoked = grant.revoked_at !== null;
  const expired = grant.expires_at !== null && grant.expires_at <= Date.now() / 1000;
  const activeSection = ["config", "activity", "settings"].includes(section ?? "") ? section : "permissions";
  const status = revoked ? "已撤销" : expired ? "已到期" : "已授权";
  const sections = [
    ["permissions", "设备权限"],
    ["config", "接入配置"],
    ...(activity ? [["activity", "操作记录"]] : []),
    ["settings", "设置"],
  ];
  return (
    <>
      <a class="device-back" href="#grants">
        <ArrowLeft aria-hidden="true" />
        Agent 连接
      </a>
      <div class="page-title">
        <div>
          <div class="device-title">
            <h1>{grant.name}</h1>
            <span class={`status-badge ${!revoked && !expired ? "active" : ""}`}>{status}</span>
          </div>
          <p class="muted">
            {grant.authentication === "platform" ? "平台授权连接" : "Agent Key 连接"}
            {revoked
              ? ""
              : grant.expires_at !== null
                ? ` · 有效至 ${new Date(grant.expires_at * 1000).toLocaleDateString("zh-CN")}`
                : ""}
          </p>
        </div>
        {grant.can_reconnect && (
          <button class="primary" onClick={() => reconnect(grant)}>
            重新授权
          </button>
        )}
      </div>
      {expired && !revoked && (
        <div class="connection-expired-notice" role="status">
          <p>连接已到期</p>
          <button onClick={() => edit(grant)}>修改有效期</button>
        </div>
      )}
      <nav class="subnav" aria-label="连接详情">
        {sections.map(([key, label]) => (
          <a
            key={key}
            href={`#grants/${encodeURIComponent(grant.id)}/${key}`}
            aria-current={activeSection === key ? "page" : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
      {activeSection === "permissions" ? (
        <section class="setup-panel">
          <ConnectionPreview key={grant.id} grant={grant} edit={() => edit(grant)} />
        </section>
      ) : activeSection === "config" ? (
        <section class="setup-panel">
          {grant.authentication === "platform" ? (
            <div class="empty">
              <h2>由平台管理接入</h2>
              {grant.can_reconnect && (
                <button class="primary" onClick={() => reconnect(grant)}>
                  重新授权
                </button>
              )}
            </div>
          ) : revoked ? (
            <div class="empty">
              <h2>此连接已撤销</h2>
              <a class="button-link primary" href="#grants/new">
                创建连接
              </a>
            </div>
          ) : (
            <ConnectionConfiguration run={run} />
          )}
        </section>
      ) : activeSection === "activity" ? (
        activity
      ) : (
        <div class="settings-panel">
          <section class="settings-section">
            <div>
              <h2>连接信息</h2>
              <code class="small muted">{grant.id}</code>
            </div>
            {!revoked && <button onClick={() => edit(grant)}>编辑连接</button>}
          </section>
          {grant.authentication === "key" && !revoked && (
            <section class="settings-section">
              <div>
                <h2>重新生成 Agent Key</h2>
                <p class="muted">旧 Key 立即失效。请将新 Key 更新到 Agent 中。</p>
              </div>
              <button onClick={() => rotate(grant)}>重新生成 Key</button>
            </section>
          )}
          {!revoked && (
            <section class="settings-section">
              <div>
                <h2>撤销连接</h2>
                <p class="muted">停止当前会话，并移除此 Agent 对设备的访问权限。</p>
              </div>
              <button class="danger" onClick={() => revoke(grant)}>
                撤销连接
              </button>
            </section>
          )}
          {revoked && (
            <section class="settings-section">
              <div>
                <h2>连接已撤销</h2>
              </div>
              {grant.can_reconnect && <button onClick={() => reconnect(grant)}>重新授权</button>}
            </section>
          )}
        </div>
      )}
    </>
  );
}
