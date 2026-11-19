import "./webview-compat";
import React, { useEffect, useState } from "react";
import "./styles.css";
import { createRoot } from "react-dom/client";
import type { defaultConfig } from "@tamagui/config/v6";
import { selectionStyles } from "@tamagui/config/v6-base";
import {
  Button,
  Dialog,
  Input,
  ListItem,
  Separator,
  Switch,
  TamaguiProvider,
  Text,
  XStack,
  YStack,
  createTamagui,
} from "tamagui";

// Vite embeds the upstream tokens and light theme family used by the app.
declare const __ANDROID_TAMAGUI_CONFIG__: typeof defaultConfig;
const config = createTamagui({
  ...__ANDROID_TAMAGUI_CONFIG__,
  settings: { ...__ANDROID_TAMAGUI_CONFIG__.settings, selectionStyles },
});
const ink = "#171A20";
const secondary = "#535E6C";
const line = "#E1E6EC";
const blue = "#0066DD";
const sky = "#EDF4FF";
const white = "#FFFFFF";
const surface = "#FAFAFA";
const neutral = "#F1F3F6";

function Dot({ color = blue }) {
  return <YStack aria-hidden width={6} height={6} borderRadius={6} backgroundColor={color} />;
}

const capabilities = [
  { key: "screen", name: "屏幕观察", description: "允许查看当前屏幕" },
  { key: "input", name: "触控与文本输入", description: "允许点按、滑动和输入" },
  { key: "files", name: "文件读写", description: "仅限已授权的工作目录" },
] as const;

function CapabilityRow({
  name,
  description,
  checked,
  onChange,
}: {
  name: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <ListItem
      title={
        <Text color={ink} fontSize={15} fontWeight="600">
          {name}
        </Text>
      }
      subTitle={
        <Text color={secondary} fontSize={12}>
          {description}
        </Text>
      }
      iconAfter={
        <Switch
          aria-label={name}
          checked={checked}
          onCheckedChange={onChange}
          width={46}
          height={28}
          padding={3}
          justifyContent="center"
          flexShrink={0}
          backgroundColor={checked ? blue : "#E1E7EF"}
          borderWidth={0}
          borderRadius={99}
        >
          <Switch.Thumb width={22} height={22} borderRadius={11} backgroundColor={white} borderWidth={0} />
        </Switch>
      }
      minHeight={62}
      paddingVertical={12}
      paddingHorizontal={14}
      backgroundColor={white}
    />
  );
}

type Capability = (typeof capabilities)[number]["key"];
type Connection = "Online" | "Connecting" | "Offline" | "ServiceUnavailable" | "Revoked" | "Unbound";
type DeviceState = {
  type: "state";
  bound: boolean;
  server: string;
  connection: Connection;
  agentAllowed: boolean;
  enabledCapabilities: Capability[];
  directoryAuthorized: boolean;
  accessibilityActive: boolean;
  model: string;
  androidVersion: string;
  appVersion: string;
};
type UpdateState = {
  type: "update";
  status: "idle" | "checking" | "latest" | "available" | "error";
  version?: string;
  message?: string;
};

type Request =
  | {
      type:
        | "ready"
        | "accessibility"
        | "directory"
        | "revokeDirectory"
        | "unbind"
        | "exit"
        | "checkUpdate"
        | "updateNotes"
        | "downloadUpdate";
    }
  | { type: "bind"; address: string; key: string }
  | { type: "access"; allowed: boolean }
  | { type: "capability"; name: Capability; enabled: boolean };
type Reply =
  | DeviceState
  | UpdateState
  | { type: "bound" | "back" | "bindingCancelled" }
  | { type: "error"; message: string };

declare global {
  interface Window {
    aBridgeNative?: {
      postMessage: (message: string) => void;
      onmessage: ((event: MessageEvent<string>) => void) | null;
    };
  }
}

function send(request: Request) {
  window.aBridgeNative?.postMessage(JSON.stringify(request));
}

const connectionLabel: Record<Connection, string> = {
  Online: "已连接",
  Connecting: "连接中",
  Offline: "离线",
  ServiceUnavailable: "无障碍未连接",
  Revoked: "凭据已撤销",
  Unbound: "尚未绑定",
};

type Panel = "permissions" | "unbind";

function DeviceDialog({
  panel,
  close,
  state,
}: {
  panel: Panel | null;
  close: () => void;
  state: DeviceState;
}) {
  const permissions = panel === "permissions";
  const confirming = panel === "unbind";
  function run(request: Request) {
    close();
    send(request);
  }
  return (
    <Dialog modal open={panel !== null} onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay backgroundColor="#17274455" />
        <Dialog.Content
          width="calc(100vw - 32px)"
          maxWidth={440}
          style={{
            position: "fixed",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            overflowY: "auto",
            maxHeight: "calc(100vh - 32px)",
          }}
          backgroundColor={white}
          borderColor={line}
          borderWidth={1}
          borderRadius={18}
          padding={17}
          gap={12}
        >
          <Dialog.Title color={ink} fontWeight="700" fontSize={20}>
            {permissions ? "能力设置" : "解除本机绑定？"}
          </Dialog.Title>
          <Dialog.Description color={secondary} fontSize={13}>
            {permissions
              ? state.agentAllowed
                ? "关闭开关可随时收回对应能力"
                : "所选能力在允许 Agent 访问后生效"
              : "此设备将停止接收 aBridge 操作。"}
          </Dialog.Description>
          {permissions ? (
            <YStack borderWidth={1} borderColor={line} borderRadius={12} overflow="hidden">
              {capabilities.map(({ key, name, description }, index) => (
                <React.Fragment key={key}>
                  {index > 0 && <Separator borderColor={line} marginHorizontal={14} />}
                  <CapabilityRow
                    name={name}
                    description={description}
                    checked={state.enabledCapabilities.includes(key)}
                    onChange={(enabled) => send({ type: "capability", name: key, enabled })}
                  />
                </React.Fragment>
              ))}
            </YStack>
          ) : (
            <Button
              height={44}
              color="#A5262B"
              backgroundColor="#FFF1F1"
              onPress={() => run({ type: "unbind" })}
            >
              解除绑定
            </Button>
          )}
          <Dialog.Close asChild>
            <Button height={44} borderWidth={0} backgroundColor={neutral} color={ink} fontSize={14}>
              {confirming ? "取消" : "完成"}
            </Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}

function BindingForm({
  state,
  editing,
  cancel,
  pending,
  bind,
}: {
  state: DeviceState;
  editing: boolean;
  cancel: () => void;
  pending: boolean;
  bind: (address: string, key: string) => void;
}) {
  const [address, setAddress] = useState(state.server);
  const [key, setKey] = useState("");
  const [validation, setValidation] = useState("");
  const cleartext = /^http:\/\//i.test(address.trim());
  function submit() {
    const cleanAddress = address.trim();
    const cleanKey = key.trim();
    if (!cleanAddress || !cleanKey) {
      setValidation("请填写 Server 地址和 Device Key");
      return;
    }
    setValidation("");
    (document.activeElement as HTMLElement | null)?.blur();
    bind(cleanAddress, cleanKey);
  }
  return (
    <YStack gap={12}>
      {!editing && (
        <Text color={ink} fontSize={27} fontWeight="750">
          连接设备
        </Text>
      )}
      <Text color={ink} fontSize={14}>
        服务器地址
      </Text>
      <Input
        id="server"
        aria-label="服务器地址"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={address}
        onChangeText={setAddress}
        placeholder="https://bridge.example.com"
        minHeight={48}
      />
      {cleartext && (
        <YStack gap={2}>
          <Text color="#A5262B" fontSize={13} aria-live="polite">
            HTTP 连接未加密。建议使用 HTTPS。
          </Text>
          <Button
            height={44}
            alignSelf="flex-start"
            backgroundColor="transparent"
            borderWidth={0}
            color={blue}
            onPress={() => setAddress(address.trim().replace(/^http:\/\//i, "https://"))}
          >
            改为 HTTPS
          </Button>
        </YStack>
      )}
      <Text color={ink} fontSize={14}>
        Device Key
      </Text>
      <Input
        id="device-key"
        aria-label="Device Key"
        value={key}
        onChangeText={setKey}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        minHeight={48}
      />
      {validation && (
        <Text color="#A5262B" aria-live="polite">
          {validation}
        </Text>
      )}
      <Button
        height={48}
        backgroundColor={pending ? neutral : blue}
        borderWidth={0}
        color={pending ? secondary : white}
        disabled={pending}
        onPress={submit}
      >
        {pending ? "绑定中" : "绑定设备"}
      </Button>
      {editing && (
        <Button height={44} onPress={cancel}>
          取消
        </Button>
      )}
    </YStack>
  );
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <YStack gap={7}>
      <Text color={secondary} fontSize={13} fontWeight="600" marginHorizontal={4}>
        {title}
      </Text>
      <YStack backgroundColor={white} borderWidth={1} borderColor={line} borderRadius={12}>
        {children}
      </YStack>
    </YStack>
  );
}

function SettingsRow({
  title,
  detail,
  onPress,
  disabled,
}: {
  title: string;
  detail?: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <ListItem
      title={title}
      subTitle={detail}
      minHeight={46}
      borderRadius={12}
      backgroundColor={white}
      iconAfter={onPress && !disabled ? <Text color={blue}>›</Text> : undefined}
      disabled={disabled}
      onPress={onPress}
    />
  );
}

function AccessScreen() {
  const [state, setState] = useState<DeviceState>();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [editing, setEditing] = useState(false);
  const [settings, setSettings] = useState(false);
  const [updatePage, setUpdatePage] = useState(false);
  const [update, setUpdate] = useState<UpdateState>({ type: "update", status: "idle" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  function back() {
    setError("");
    if (panel) setPanel(null);
    else if (editing) setEditing(false);
    else if (updatePage) setUpdatePage(false);
    else if (settings) setSettings(false);
    else send({ type: "exit" });
  }

  useEffect(() => {
    const bridge = window.aBridgeNative;
    if (!bridge) return;
    bridge.onmessage = ({ data }) => {
      const message = JSON.parse(data) as Reply;
      if (message.type === "state") {
        setState(message);
        if (!message.bound) setEditing(false);
      } else if (message.type === "update") {
        setUpdate(message);
      } else if (message.type === "bound") {
        setError("");
        setPending(false);
        setEditing(false);
        setSettings(false);
      } else if (message.type === "bindingCancelled") {
        setPending(false);
      } else if (message.type === "error") {
        setError(message.message);
        setPending(false);
      } else if (message.type === "back") {
        back();
      }
    };
    send({ type: "ready" });
    return () => {
      bridge.onmessage = null;
    };
  }, [panel, editing, settings, updatePage]);

  const allowed = state?.agentAllowed ?? false;
  const effective =
    allowed && state?.connection === "Online"
      ? capabilities.filter(
          ({ key }) =>
            state.enabledCapabilities.includes(key) && (key !== "files" || state.directoryAuthorized),
        )
      : [];
  const blocked = state?.connection === "Revoked" || state?.connection === "ServiceUnavailable";
  const action =
    state?.connection === "Revoked"
      ? "重新绑定"
      : state?.connection === "ServiceUnavailable" && !allowed
        ? "打开无障碍设置"
        : allowed
          ? "暂停 Agent 操作"
          : "允许 Agent 操作";
  function primary() {
    setError("");
    if (state?.connection === "Revoked") setEditing(true);
    else if (state?.connection === "ServiceUnavailable" && !allowed) send({ type: "accessibility" });
    else send({ type: "access", allowed: !allowed });
  }

  const feedback =
    state?.connection === "Revoked"
      ? "重新绑定后可恢复访问"
      : state?.connection === "ServiceUnavailable"
        ? "请在系统设置中启用 aBridge 无障碍服务"
        : state?.connection !== "Online"
          ? "设备连接后才能接收 Agent 操作"
          : !allowed
            ? "手机仍在线，Agent 无法执行新操作"
            : effective.length
              ? "Agent 可使用本机已开启且获授权的能力"
              : "请先开启所需能力";

  return (
    <YStack
      maxWidth={480}
      marginHorizontal="auto"
      width="100%"
      minHeight="100vh"
      backgroundColor={surface}
      paddingTop={10}
      paddingHorizontal={20}
      paddingBottom={24}
    >
      <XStack minHeight={49} justifyContent="space-between" alignItems="center" marginBottom={19}>
        {settings || editing ? (
          <XStack gap={8} alignItems="center">
            <Button
              backgroundColor="transparent"
              borderWidth={0}
              height={44}
              width={44}
              aria-label="返回"
              color={blue}
              fontSize={26}
              onPress={back}
            >
              ‹
            </Button>
            <Text color={ink} fontSize={20} fontWeight="700">
              {editing ? (state?.bound ? "修改连接" : "连接设备") : updatePage ? "应用更新" : "设置"}
            </Text>
          </XStack>
        ) : (
          <XStack gap={7} alignItems="center">
            <img src="./bridge.svg" width="24" height="17" alt="" />
            <Text color={ink} fontSize={21} fontWeight="700">
              aBridge
            </Text>
          </XStack>
        )}
        {state && !settings && !editing && (
          <Button
            aria-label="设置"
            height={44}
            paddingHorizontal={10}
            borderWidth={0}
            backgroundColor="transparent"
            color={blue}
            fontSize={13}
            fontWeight="600"
            onPress={() => {
              setError("");
              setSettings(true);
            }}
          >
            设置
          </Button>
        )}
      </XStack>

      {error && (
        <Text color="#A5262B" aria-live="polite" marginBottom={12}>
          {error}
        </Text>
      )}
      {!state ? (
        <Text color={secondary}>正在载入设备状态</Text>
      ) : settings && !editing ? (
        updatePage && update.status === "available" ? (
          <YStack gap={15}>
            <YStack
              backgroundColor={white}
              borderColor={line}
              borderWidth={1}
              borderRadius={12}
              padding={16}
              gap={9}
            >
              <Text color={ink} fontSize={22} fontWeight="700">
                发现新版本
              </Text>
              <Text color={blue} fontWeight="600">
                可更新至 {update.version}
              </Text>
              <Text color={secondary} fontSize={13}>
                当前版本 {state.appVersion}
              </Text>
              <Button
                backgroundColor="transparent"
                borderWidth={0}
                alignSelf="flex-start"
                color={blue}
                onPress={() => send({ type: "updateNotes" })}
              >
                查看更新说明
              </Button>
            </YStack>
            <Button
              backgroundColor={blue}
              color={white}
              height={48}
              onPress={() => send({ type: "downloadUpdate" })}
            >
              下载更新
            </Button>
            <Text color={secondary} fontSize={13} aria-live="polite">
              {update.message ?? "下载后打开 APK，由 Android 安装器确认更新。"}
            </Text>
          </YStack>
        ) : (
          <YStack gap={19}>
            <SettingsSection title="连接">
              <SettingsRow
                title="服务器地址"
                detail={state.bound ? state.server : "尚未绑定"}
                onPress={() => setEditing(true)}
              />
              {state.bound && state.server.startsWith("http://") && (
                <Text color="#A5262B" fontSize={12} marginHorizontal={14} marginBottom={8}>
                  HTTP 连接未加密
                </Text>
              )}
              <Separator borderColor={line} />
              <SettingsRow title={connectionLabel[state.connection]} />
            </SettingsSection>
            <SettingsSection title="权限">
              <SettingsRow title="Agent 能力" onPress={() => setPanel("permissions")} />
              <Separator borderColor={line} />
              <SettingsRow
                title="工作目录"
                detail={state.directoryAuthorized ? "已授权，点击更换" : "未授权"}
                onPress={() => send({ type: "directory" })}
              />
              {state.directoryAuthorized && (
                <SettingsRow title="撤销目录授权" onPress={() => send({ type: "revokeDirectory" })} />
              )}
              <Separator borderColor={line} />
              <SettingsRow
                title="无障碍设置"
                detail={state.accessibilityActive ? "已开启" : "未开启"}
                onPress={() => send({ type: "accessibility" })}
              />
            </SettingsSection>
            <SettingsSection title="应用">
              <SettingsRow title="aBridge 版本" detail={`当前版本 ${state.appVersion}`} />
              <Separator borderColor={line} />
              <SettingsRow
                title={
                  update.status === "checking"
                    ? "正在检查更新…"
                    : update.status === "available"
                      ? "查看可用更新"
                      : "检查更新"
                }
                detail={
                  update.status === "latest"
                    ? "已是最新版本"
                    : update.status === "error"
                      ? update.message
                      : undefined
                }
                disabled={update.status === "checking"}
                onPress={() =>
                  update.status === "available" ? setUpdatePage(true) : send({ type: "checkUpdate" })
                }
              />
            </SettingsSection>
            {state.bound && (
              <Button
                backgroundColor="transparent"
                borderWidth={0}
                alignSelf="flex-start"
                color="#A5262B"
                onPress={() => setPanel("unbind")}
              >
                解除设备绑定
              </Button>
            )}
          </YStack>
        )
      ) : !state.bound || editing ? (
        <BindingForm
          key={editing ? "edit" : "bind"}
          state={state}
          editing={editing}
          pending={pending}
          cancel={() => {
            setEditing(false);
            setError("");
          }}
          bind={(address, key) => {
            setError("");
            setPending(true);
            send({ type: "bind", address, key });
          }}
        />
      ) : (
        <>
          <XStack alignItems="center" justifyContent="space-between" gap={10} marginBottom={15}>
            <YStack flex={1} minWidth={0}>
              <Text color={ink} fontSize={23} fontWeight="750">
                {state.model}
              </Text>
              <Text color={secondary} fontSize={12}>
                Android {state.androidVersion}
              </Text>
            </YStack>
            <XStack
              alignItems="center"
              gap={6}
              paddingHorizontal={8}
              paddingVertical={5}
              borderRadius={8}
              backgroundColor={state.connection === "Online" ? sky : neutral}
            >
              <Dot color={state.connection === "Online" ? blue : "#718098"} />
              <Text color={state.connection === "Online" ? blue : secondary} fontSize={12} fontWeight="600">
                {connectionLabel[state.connection]}
              </Text>
            </XStack>
          </XStack>
          <YStack backgroundColor={white} borderWidth={1} borderColor={line} borderRadius={16} padding={17}>
            <Text color={secondary} fontSize={13} fontWeight="600" marginBottom={9}>
              操作权限
            </Text>
            <XStack alignItems="center" gap={8} minHeight={34}>
              <Dot color={allowed && !blocked ? blue : "#718098"} />
              <Text aria-live="polite" color={ink} fontWeight="750" fontSize={24}>
                {allowed ? "Agent 访问已开启" : "Agent 访问已关闭"}
              </Text>
            </XStack>
            <Text color={secondary} fontSize={13} marginTop={7} minHeight={23}>
              {feedback}
            </Text>
            <Button
              aria-label={action}
              height={48}
              borderWidth={0}
              borderRadius={10}
              marginTop={13}
              backgroundColor={blue}
              color={white}
              fontWeight="650"
              onPress={primary}
            >
              {action}
            </Button>
          </YStack>
          <ListItem
            title={
              <Text color={ink} fontSize={15} fontWeight="650">
                Agent 能力
              </Text>
            }
            subTitle={
              <Text color={secondary} fontSize={12}>
                {effective.length ? effective.map(({ name }) => name).join("、") : "当前无生效能力"}
              </Text>
            }
            iconAfter={
              <Text color={blue} fontWeight="600" fontSize={13}>
                ›
              </Text>
            }
            aria-label="设置 Agent 能力"
            onPress={() => {
              setError("");
              setPanel("permissions");
            }}
            minHeight={65}
            marginTop={13}
            paddingVertical={10}
            paddingHorizontal={14}
            borderWidth={1}
            borderColor={line}
            borderRadius={12}
            backgroundColor={white}
          />
        </>
      )}
      {state && <DeviceDialog panel={panel} close={() => setPanel(null)} state={state} />}
    </YStack>
  );
}

const root = createRoot(document.getElementById("root")!);

function connectNative(event: MessageEvent) {
  if (event.data !== "aBridgeNative" || event.ports.length !== 1) return;
  window.removeEventListener("message", connectNative);
  window.aBridgeNative = event.ports[0];
  render();
}

function render() {
  root.render(
    <TamaguiProvider config={config} defaultTheme="light">
      <AccessScreen />
    </TamaguiProvider>,
  );
}

window.addEventListener("message", connectNative);
