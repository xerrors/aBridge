# 快速开始

启动 aBridge Server，绑定一台设备，再将它授权给支持 Streamable HTTP 的 MCP 客户端。可以先接入 Chrome 扩展或 Windows 客户端。

## 启动 Server

准备 npm 和 Node.js 22.13+（22.x）、23.4+（23.x）或 24 及以上版本。在终端运行：

```sh
npm exec --yes \
  --package=https://github.com/xerrors/aBridge/releases/download/v0.4.23/xerrors-abridge-0.4.23.tgz \
  -- abridge --web
```

在 Windows PowerShell 中运行：

```powershell
npm.cmd exec --yes --package=https://github.com/xerrors/aBridge/releases/download/v0.4.23/xerrors-abridge-0.4.23.tgz -- abridge --web
```

浏览器会打开本机的「实例管理」。在这里创建普通账户，然后用普通账户登录 [本机管理台](http://127.0.0.1:8765)。实例管理员链接包含凭据，请妥善保管。

如果 Server 运行在另一台机器，请先配置设备和 Agent 都能访问的地址。详见[反向代理与网络](../deployment.md#反向代理与网络)。

## 绑定设备

按需要选择一个客户端。Server 和客户端在同一台电脑时，服务端网址可填 `http://127.0.0.1:8765`。跨机器连接时，填写客户端能访问的 Server 地址。

### Chrome 扩展 {#绑定浏览器}

在准备交给 Agent 使用的 Chrome Profile 中安装扩展。打开扩展并点击「连接浏览器」，在绑定标签页填写 Server 地址，按提示完成绑定。每个 Chrome Profile 都可以单独授权。[Chrome 应用商店](https://chromewebstore.google.com/detail/abridge-for-browser/jbkhngckehhhhkbgpjlifbbchhbeodjc)

### Windows 客户端预览

1. 获取 Windows 10/11 x64 的未签名便携 ZIP，完整解压后启动 `aBridge.exe`。[下载与安装](../windows-client.md#下载与安装)
2. 在「连接」中填写服务端网址，点击「连接并授权」，在浏览器中用普通账户登录并确认授权。
3. 回到客户端，在「本机能力」中开启任务需要的能力。要尝试桌面截图，先开启屏幕能力并保持 Windows 桌面解锁。

回到管理台的「设备」页，确认刚绑定的设备已上线。其他设备的安装步骤见 [macOS App](../deployment.md#macos-app)、[Linux CLI](../deployment.md#linux-cli) 和 [Android App](https://github.com/xerrors/aBridge/blob/main/apps/android/README.md)。

## 连接 Agent

在「Agent 连接」中创建连接，选中刚绑定的设备，设置能力和有效期。保存生成的 **Agent Key**，通过「复制接入参数」获取 MCP 端点和请求头。

以本机 Codex CLI 为例，先通过环境变量 `ABRIDGE_AGENT_KEY` 向 Codex 提供密钥，再执行：

```sh
codex mcp add abridge --url http://127.0.0.1:8765/mcp --bearer-token-env-var ABRIDGE_AGENT_KEY
codex
```

在新会话中输入：

> 请调用 aBridge 的 `devices_list`，列出我已授权的设备和可用能力。

返回列表中出现刚绑定的设备，即表示 Agent 已连接。如果列表为空，请在管理台核对该设备所属账户和 Agent 的授权范围。

验证 Windows 屏幕能力时，可请 Agent 截取当前桌面，并在 Agent 界面确认结果中显示了截图。
