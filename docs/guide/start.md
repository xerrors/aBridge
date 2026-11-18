# 快速开始

先在同一台电脑上运行 aBridge Server、浏览器扩展和一个支持 Streamable HTTP 的 MCP 客户端。完成后，Agent 就能列出你授权的浏览器。

## 启动 Server

准备 npm 和 Node.js 22.13+（22.x）、23.4+（23.x）或 24 及以上版本。在终端运行：

```sh
npm exec --yes \
  --package=https://github.com/xerrors/aBridge/releases/download/v0.4.18/xerrors-abridge-0.4.18.tgz \
  -- abridge --web
```

浏览器会打开本机的「实例管理」。在这里创建普通账户，然后用普通账户登录 [本机管理台](http://127.0.0.1:8765)。实例管理员链接包含凭据，请妥善保管。

如果 Server 运行在另一台机器，请先配置设备和 Agent 都能访问的地址。详见[反向代理与网络](../deployment.md#反向代理与网络)。

## 绑定浏览器

在准备交给 Agent 使用的 Chrome Profile 中安装 [aBridge 扩展](https://chromewebstore.google.com/detail/abridge-for-browser/jbkhngckehhhhkbgpjlifbbchhbeodjc)。打开扩展，填写 Server 地址 `http://127.0.0.1:8765`，按提示完成绑定。

回到管理台的「设备」页，确认刚绑定的浏览器已上线。每个 Chrome Profile 都可以单独授权。其他设备的安装步骤见 [macOS App](../deployment.md#macos-app)、[Linux CLI](../deployment.md#linux-cli) 和 [Android 预览](https://github.com/xerrors/aBridge/blob/main/apps/android/README.md)。

## 连接 Agent

在「Agent 连接」中创建连接，选中刚绑定的浏览器，设置能力和有效期。保存生成的 **Agent Key**，通过「复制接入参数」获取 MCP 端点和请求头。

以本机 Codex CLI 为例，先通过环境变量 `ABRIDGE_AGENT_KEY` 向 Codex 提供密钥，再执行：

```sh
codex mcp add abridge --url http://127.0.0.1:8765/mcp \
  --bearer-token-env-var ABRIDGE_AGENT_KEY
codex
```

在新会话中输入：

> 请调用 aBridge 的 `devices_list`，列出我已授权的设备和可用能力。

返回列表中出现刚绑定的浏览器，即表示 Agent 已连接。如果列表为空，请在管理台核对该设备所属账户和 Agent 的授权范围。
