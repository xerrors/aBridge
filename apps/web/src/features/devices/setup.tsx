import { ArrowLeft, ArrowRight, ArrowUpRight, ExternalLink, KeyRound, RefreshCw } from "lucide-preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Capability, DeviceKind } from "@abridge/protocol";
import { z } from "zod";
import { ActionButton, CopyButton } from "../../components/actions.js";
import { Field, Form } from "../../components/forms.js";
import { DeviceIcon, platformLabels } from "../../components/icons.js";
import { api } from "../../lib/api.js";
import { useCredentialGuard } from "../../lib/credential-guard.js";
import { capabilityLabels } from "../../lib/labels.js";
import type { Device, RunAction } from "../../lib/types.js";

const platforms = ["macos", "windows", "linux", "android", "browser"] as const;
type Platform = (typeof platforms)[number];
const release = "https://github.com/xerrors/aBridge/releases/latest";
const clients: Record<
  Platform,
  {
    kind: DeviceKind;
    requirements: string;
    download: { href: string; label: string };
    installGuide?: string;
    capabilities: Capability[];
    browserAuthorization?: string;
    tokenInstructions: ComponentChildren;
  }
> = {
  macos: {
    kind: "computer",
    requirements: "macOS 14+，Apple Silicon",
    download: { href: release, label: "下载 macOS 客户端" },
    capabilities: ["screen", "input", "shell", "files"],
    browserAuthorization: "在 macOS 客户端设置中填写服务地址，点击「在浏览器授权」，并用当前账户确认。",
    tokenInstructions:
      "在 macOS 客户端设置的「绑定方式」中选择 Device Token，填入服务地址和凭证，再点击「验证并连接」。",
  },
  windows: {
    kind: "computer",
    requirements: "Windows 10/11 x64，未签名便携 ZIP",
    download: {
      href: "https://xerrors.github.io/aBridge/windows-client.html#下载与安装",
      label: "查看 Windows 下载与安装",
    },
    capabilities: ["screen", "input", "shell", "files"],
    browserAuthorization:
      "完整解压后启动 aBridge.exe，在「连接」中填写服务端网址，点击「连接并授权」，并在浏览器中确认。",
    tokenInstructions:
      "在 Windows 客户端填写服务端网址，展开「使用 Device Token」并粘贴凭证，再点击「连接并授权」。",
  },
  linux: {
    kind: "computer",
    requirements: "Linux CLI，amd64 / arm64",
    download: { href: release, label: "下载 Linux CLI" },
    installGuide: "https://github.com/xerrors/aBridge/blob/main/apps/linux-client/README.md#安装与绑定",
    capabilities: ["shell", "files"],
    tokenInstructions: (
      <>
        在解压目录运行 <code>./abridge-client setup --url &lt;服务地址&gt;</code>，按提示粘贴 Device Token。
        绑定后运行 <code>./abridge-client service install</code> 启动用户服务，或用{" "}
        <code>./abridge-client run</code> 前台运行。
      </>
    ),
  },
  android: {
    kind: "computer",
    requirements: "Android 11+，开发预览",
    download: {
      href: "https://github.com/xerrors/aBridge/blob/main/apps/android/README.md",
      label: "查看 APK 下载与构建说明",
    },
    capabilities: ["screen", "input", "files"],
    tokenInstructions:
      "在 Android App 中填写 HTTPS 服务地址和 Device Key，点击「绑定设备」。开启 aBridge 无障碍服务后，回到 App 点击「允许 Agent 操作」。",
  },
  browser: {
    kind: "browser",
    requirements: "Chrome 116+，每个浏览器个人资料单独绑定",
    download: {
      href: "https://chromewebstore.google.com/detail/abridge-for-browser/jbkhngckehhhhkbgpjlifbbchhbeodjc",
      label: "安装浏览器扩展",
    },
    capabilities: ["browser"],
    browserAuthorization: "打开扩展面板，填写服务地址，点击「在浏览器授权」，并用当前账户确认。",
    tokenInstructions:
      "在扩展面板的「绑定方式」中选择 Device Token，填入服务地址和凭证，再点击「验证并连接」。",
  },
};

export function DeviceSetupPage({
  devices,
  refresh,
  run,
  notify,
  initialPlatform,
}: {
  devices: Device[];
  refresh: () => Promise<void>;
  run: RunAction;
  notify: (message: string) => void;
  initialPlatform?: string;
}) {
  const platform = platforms.find((value) => value === initialPlatform) ?? "macos";
  const client = clients[platform];
  const [method, setMethod] = useState(client.browserAuthorization ? "browser" : "token");
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [credential, setCredential] = useState<{ id: string; key: string }>();
  const device = credential && devices.find(({ id }) => id === credential.id);
  const revoked = device?.status === "revoked";
  const unsaved = Boolean(credential && !saved && !revoked);
  const connectionStatus = {
    online: `${device?.name} 已连接${device?.paused ? "（已暂停）" : ""}`,
    offline: "等待客户端连接…",
    revoked: "设备已解绑，凭证已失效。",
    unknown: "设备连接状态未知。",
  };
  const tokenField = useRef<HTMLInputElement>(null);
  const androidNeedsAddress =
    platform === "android" &&
    (location.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname));

  useCredentialGuard(
    submitting || unsaved,
    submitting
      ? "正在生成设备凭证。现在离开可能无法查看凭证，仍要离开吗？"
      : "设备凭证尚未保存。离开后无法再次查看，仍要离开吗？",
  );
  useLayoutEffect(() => {
    if (credential && method === "token") tokenField.current?.focus();
  }, [credential, method]);

  return (
    <div class="task-page">
      <a class="device-back" href="#devices">
        <ArrowLeft aria-hidden="true" />
        我的设备
      </a>
      <div class="page-title">
        <h1>添加设备</h1>
      </div>
      <div class="type-options" role="group" aria-label="设备平台">
        {platforms.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={platform === value}
            disabled={submitting}
            onClick={() => {
              if (value !== platform) location.hash = `devices/new/${value}`;
            }}
          >
            <DeviceIcon
              kind={value === "browser" ? "browser" : "computer"}
              platform={value === "browser" ? "chrome" : value}
            />
            <span>{value === "browser" ? "浏览器扩展" : platformLabels[value]}</span>
          </button>
        ))}
      </div>
      <ol class="setup-journey" aria-label="设备连接步骤">
        <li>
          <div class="setup-step">
            <div class="setup-install">
              <div>
                <h2>安装客户端</h2>
                <p class="small muted">{client.requirements}</p>
                {client.installGuide && (
                  <a class="small" href={client.installGuide} target="_blank" rel="noreferrer">
                    安装与校验说明
                  </a>
                )}
              </div>
              <a class="button" href={client.download.href} target="_blank" rel="noreferrer">
                {client.download.label}
                <ArrowUpRight aria-hidden="true" />
              </a>
            </div>
          </div>
        </li>
        <li>
          <div class="setup-step setup-binding">
            <h2>绑定设备</h2>
            {client.browserAuthorization && (
              <div class="setup-methods" role="group" aria-label="绑定方式">
                <button
                  type="button"
                  aria-pressed={method === "browser"}
                  disabled={submitting || unsaved}
                  onClick={() => setMethod("browser")}
                >
                  <ExternalLink aria-hidden="true" />
                  浏览器授权
                </button>
                <button type="button" aria-pressed={method === "token"} onClick={() => setMethod("token")}>
                  <KeyRound aria-hidden="true" />
                  设备凭证
                </button>
              </div>
            )}
            <div class="setup-address">
              {androidNeedsAddress ? (
                <>
                  <span>服务地址</span>
                  <p class="small muted">Android 真机请填写设备能访问的 HTTPS 服务地址。</p>
                </>
              ) : (
                <>
                  <label for="setup-server-address">服务地址</label>
                  <div class="copy-field">
                    <input id="setup-server-address" readOnly value={location.origin} />
                    <CopyButton value={location.origin} run={run} className="secondary">
                      复制地址
                    </CopyButton>
                  </div>
                </>
              )}
            </div>
            {method === "browser" ? (
              <div class="setup-authorization">
                <p>{client.browserAuthorization}</p>
                <a href="#devices">
                  授权后到设备列表确认上线 <ArrowRight aria-hidden="true" />
                </a>
              </div>
            ) : (
              <section class="setup-token" aria-labelledby="setup-token-title">
                <h3 id="setup-token-title">设备凭证</h3>
                <p class="setup-token-instructions">{client.tokenInstructions}</p>
                {credential ? (
                  <>
                    {!revoked && (
                      <>
                        <p class="small muted">凭证仅在这里显示一次。请复制到客户端。</p>
                        <div class="copy-field">
                          <input aria-label="设备凭证" ref={tokenField} readOnly value={credential.key} />
                          <CopyButton value={credential.key} run={run}>
                            复制设备凭证
                          </CopyButton>
                        </div>
                        <label class="inline-check">
                          <input
                            type="checkbox"
                            checked={saved}
                            onChange={(event) => setSaved(event.currentTarget.checked)}
                          />
                          我已保存设备凭证
                        </label>
                      </>
                    )}
                    <div class="setup-device-state">
                      <p class="waiting-status" role="status">
                        <span
                          class={`dot ${device?.paused ? "paused" : (device?.status ?? "")}`}
                          aria-hidden="true"
                        />
                        {connectionStatus[device?.status ?? "unknown"]}
                      </p>
                      {device?.status === "online" ? (
                        <div class="actions">
                          <a class="button" href={`#devices/${encodeURIComponent(device.id)}`}>
                            查看设备
                          </a>
                          <a class="button primary" href="#connections/new">
                            连接 Agent
                          </a>
                        </div>
                      ) : revoked ? (
                        <button
                          type="button"
                          onClick={() => {
                            setCredential(undefined);
                            setSaved(false);
                          }}
                        >
                          重新添加设备
                        </button>
                      ) : (
                        <ActionButton
                          action={refresh}
                          icon={<RefreshCw aria-hidden="true" />}
                          run={run}
                          className="text-button"
                          busyLabel="检查中…"
                          successLabel="已检查"
                        >
                          检查连接
                        </ActionButton>
                      )}
                    </div>
                  </>
                ) : (
                  <Form
                    label="生成设备凭证"
                    onSubmit={async (form) => {
                      setSubmitting(true);
                      try {
                        const result = await api(
                          "/api/devices",
                          z.object({ id: z.string(), key: z.string() }),
                          {
                            name: form.get("name"),
                            kind: client.kind,
                            capabilities: client.capabilities,
                          },
                        );
                        setCredential(result);
                      } finally {
                        setSubmitting(false);
                      }
                      void refresh().catch(() => notify("设备凭证已生成，暂时无法刷新连接状态。"));
                    }}
                  >
                    <Field name="name" label="设备名称" />
                    <p class="small muted">
                      设备能力：
                      {client.capabilities
                        .map((value) =>
                          platform === "android" && value === "input" ? "触摸输入" : capabilityLabels[value],
                        )
                        .join("、")}
                    </p>
                  </Form>
                )}
              </section>
            )}
          </div>
        </li>
      </ol>
    </div>
  );
}
