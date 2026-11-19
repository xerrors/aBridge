import "./webview-compat";
import React, { useEffect, useState } from "react";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { defaultConfig } from "@tamagui/config/v6";
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

const config = createTamagui(defaultConfig);
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
};
type Request =
  | { type: "ready" | "accessibility" | "directory" | "revokeDirectory" | "unbind" | "exit" }
  | { type: "bind"; address: string; key: string }
  | { type: "access"; allowed: boolean }
  | { type: "capability"; name: Capability; enabled: boolean };
type Reply = DeviceState | { type: "bound" | "back" } | { type: "error"; message: string };

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

type Panel = "permissions" | "device" | "unbind";

function DeviceDialog({
  panel,
  close,
  state,
  select,
  edit,
}: {
  panel: Panel | null;
  close: () => void;
  state: DeviceState;
  select: (panel: Panel) => void;
  edit: () => void;
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
            {permissions ? "能力设置" : confirming ? "解除本机绑定？" : "设备详情"}
          </Dialog.Title>
          <Dialog.Description color={secondary} fontSize={13}>
            {permissions
              ? state.agentAllowed
                ? "关闭开关可随时收回对应能力"
                : "所选能力在允许 Agent 访问后生效"
              : confirming
                ? "此设备将停止接收 aBridge 操作。"
                : `${state.model} · Android ${state.androidVersion}`}
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
          ) : confirming ? (
            <Button
              height={44}
              color="#A5262B"
              backgroundColor="#FFF1F1"
              onPress={() => run({ type: "unbind" })}
            >
              解除绑定
            </Button>
          ) : (
            <YStack gap={8}>
              <Text color={ink} fontSize={14}>
                服务器地址
              </Text>
              <Text color={secondary} fontSize={13}>
                {state.server}
              </Text>
              <Button height={44} onPress={() => run({ type: "accessibility" })}>
                {state.accessibilityActive ? "无障碍设置（已开启）" : "打开无障碍设置"}
              </Button>
              <Button height={44} onPress={() => run({ type: "directory" })}>
                {state.directoryAuthorized ? "更换工作目录" : "选择工作目录"}
              </Button>
              {state.directoryAuthorized && (
                <Button height={44} onPress={() => run({ type: "revokeDirectory" })}>
                  撤销目录授权
                </Button>
              )}
              <Button height={44} onPress={edit}>
                修改连接
              </Button>
              <Button height={44} color="#A5262B" onPress={() => select("unbind")}>
                解除本机绑定
              </Button>
            </YStack>
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
    setKey("");
  }
  return (
    <YStack gap={12}>
      <Text color={ink} fontSize={27} fontWeight="750">
        连接设备
      </Text>
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
        backgroundColor={blue}
        borderWidth={0}
        color={white}
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

function AccessScreen() {
  const [state, setState] = useState<DeviceState>();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const bridge = window.aBridgeNative;
    if (!bridge) return;
    bridge.onmessage = ({ data }) => {
      const message = JSON.parse(data) as Reply;
      if (message.type === "state") {
        setState(message);
        if (!message.bound) setEditing(false);
      } else if (message.type === "bound") {
        setError("");
        setPending(false);
        setEditing(false);
      } else if (message.type === "error") {
        setError(message.message);
        setPending(false);
      } else if (message.type === "back") {
        if (panel) setPanel(null);
        else if (editing) {
          setEditing(false);
          setError("");
        } else send({ type: "exit" });
      }
    };
    send({ type: "ready" });
    return () => {
      bridge.onmessage = null;
    };
  }, [panel, editing]);

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
        <XStack gap={7} alignItems="center">
          <img src="./bridge.svg" width="24" height="17" alt="" />
          <Text color={ink} fontSize={21} fontWeight="700">
            aBridge
          </Text>
        </XStack>
        {state?.bound && !editing && (
          <Button
            aria-label="设备详情"
            height={44}
            paddingHorizontal={10}
            borderWidth={0}
            backgroundColor="transparent"
            color={blue}
            fontSize={13}
            fontWeight="600"
            onPress={() => {
              setError("");
              setPanel("device");
            }}
          >
            设备详情
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
                设置
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
          <DeviceDialog
            panel={panel}
            close={() => setPanel(null)}
            state={state}
            select={setPanel}
            edit={() => {
              setPanel(null);
              setEditing(true);
            }}
          />
        </>
      )}
    </YStack>
  );
}

createRoot(document.getElementById("root")!).render(
  <TamaguiProvider config={config} defaultTheme="light">
    <AccessScreen />
  </TamaguiProvider>,
);
