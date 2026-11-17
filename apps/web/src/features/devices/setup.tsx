import { ArrowLeft, ArrowUpRight, Check, ChevronDown, RefreshCw } from "lucide-preact";
import { useCredentialGuard } from "../../lib/credential-guard.js";
import { useRef, useState } from "preact/hooks";
import { z } from "zod";
import { api, type Device } from "../../lib/api.js";
import { ActionButton, CopyButton } from "../../components/actions.js";
import { DeviceIcon } from "../../components/icons.js";
import { Field, Form } from "../../components/forms.js";
import type { RunAction } from "../../lib/types.js";

export function DeviceSetupPage({
  devices,
  refresh,
  run,
  notify,
  initialKind,
}: {
  devices: Device[];
  refresh: () => Promise<void>;
  run: RunAction;
  notify: (message: string) => void;
  initialKind?: string;
}) {
  const [kind, setKind] = useState<"computer" | "browser">(
    initialKind === "browser" ? "browser" : "computer",
  );
  const initial = useRef(new Set(devices.map((device) => device.id)));
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [credential, setCredential] = useState<{ id: string; key: string }>();
  const added = devices.filter(
    (device) => !initial.current.has(device.id) && device.status !== "revoked" && device.kind === kind,
  );
  const connected = added.find(
    (device) => device.status === "online" && (!credential || device.id === credential.id),
  );
  useCredentialGuard(
    submitting || Boolean(credential && !saved && !connected),
    "设备凭据尚未保存。离开后无法再次查看，仍要离开吗？",
  );
  return (
    <div class="task-page">
      <a class="device-back" href="#devices">
        <ArrowLeft aria-hidden="true" />
        我的设备
      </a>
      <div class="page-title">
        <div>
          <h1>添加设备</h1>
        </div>
      </div>
      <div class="device-setup-layout">
        <div class="device-type-selector">
          <div class="type-options">
            {(["computer", "browser"] as const).map((value) => (
              <button
                key={value}
                aria-pressed={kind === value}
                disabled={Boolean(credential) || submitting}
                onClick={() => setKind(value)}
              >
                <DeviceIcon kind={value} platform={value === "computer" ? "macos" : "chrome"} />
                <span>{value === "computer" ? "Mac 电脑" : "浏览器"}</span>
              </button>
            ))}
          </div>
        </div>
        <section class="device-install" aria-label="设备连接步骤">
          {connected ? (
            <div class="setup-success">
              <span class="success-mark">
                <Check aria-hidden="true" />
              </span>
              <h2>设备已连接</h2>
              <p>{connected.name} 已添加到你的账户。</p>
              <div class="actions">
                <a class="button" href={`#devices/${encodeURIComponent(connected.id)}`}>
                  查看设备
                </a>
                <a class="button primary" href="#grants/new">
                  连接 Agent
                </a>
              </div>
            </div>
          ) : (
            <>
              <ol class="setup-journey">
                <li>
                  <div>
                    <h2>安装客户端</h2>
                    <p>{kind === "computer" ? "macOS 14+ · Apple Silicon" : "Chrome 及兼容浏览器"}</p>
                    <a
                      class="button"
                      href={
                        kind === "computer"
                          ? "https://github.com/xerrors/aBridge/releases"
                          : "https://chromewebstore.google.com/detail/abridge-for-browser/jbkhngckehhhhkbgpjlifbbchhbeodjc"
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      {kind === "computer" ? "下载 Mac 客户端" : "安装浏览器扩展"}{" "}
                      <ArrowUpRight aria-hidden="true" />
                    </a>
                  </div>
                </li>
                <li>
                  <div>
                    <h2>服务地址</h2>
                    <p>{kind === "computer" ? "Mac 客户端设置" : "浏览器扩展面板"}</p>
                    <div class="copy-field">
                      <input aria-label="服务地址" readOnly value={location.origin} />
                      <CopyButton value={location.origin} run={run} className="secondary">
                        复制地址
                      </CopyButton>
                    </div>
                  </div>
                </li>
                <li>
                  <div>
                    <h2>授权连接</h2>
                    <p>在客户端点击“在浏览器授权”。</p>
                    <div class="waiting-status" role="status">
                      <span class="dot" />
                      {added.length ? "设备已添加，等待客户端连接…" : "等待设备连接…"}
                    </div>
                    <ActionButton
                      action={refresh}
                      icon={<RefreshCw aria-hidden="true" />}
                      run={run}
                      className="text-button"
                      busyLabel="检查中…"
                      successLabel="已检查"
                    >
                      刷新
                    </ActionButton>
                  </div>
                </li>
              </ol>
              <details class="manual-setup">
                <summary>
                  使用设备凭据手动绑定
                  <ChevronDown aria-hidden="true" />
                </summary>
                <p class="small muted">设备凭据仅用于客户端绑定。</p>
                {credential ? (
                  <>
                    <p class="secret-notice">仅显示一次，请保存到客户端。</p>
                    <textarea class="key-area" aria-label="Device Token" readOnly value={credential.key} />
                    <CopyButton value={credential.key} run={run}>
                      复制设备凭据
                    </CopyButton>
                    <label class="inline-check credential-saved">
                      <input
                        type="checkbox"
                        checked={saved}
                        onChange={(event) => setSaved(event.currentTarget.checked)}
                      />
                      我已保存设备凭据
                    </label>
                  </>
                ) : (
                  <Form
                    label="生成设备凭据"
                    onSubmit={async (form) => {
                      setSubmitting(true);
                      try {
                        const result = await api(
                          "/api/devices",
                          z.object({ id: z.string(), key: z.string() }),
                          {
                            name: form.get("name"),
                            kind,
                            capabilities:
                              kind === "computer" ? ["screen", "input", "shell", "files"] : ["browser"],
                          },
                        );
                        setCredential(result);
                        await refresh().catch(() => notify("设备已创建，列表刷新失败；请先保存凭据。"));
                      } finally {
                        setSubmitting(false);
                      }
                    }}
                  >
                    <Field name="name" label="设备名称" />
                    <dl class="manual-capabilities">
                      <dt>授权能力</dt>
                      <dd>{kind === "computer" ? "屏幕、键鼠、Shell、文件" : "浏览器"}</dd>
                    </dl>
                  </Form>
                )}
              </details>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
