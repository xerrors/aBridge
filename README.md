# aBridge

通过 MCP 连接你自己的电脑。独立 Python 服务管理账户、设备和 Agent 授权，macOS 菜单栏客户端负责本机执行、权限与暂停。

当前为 **0.1.0 早期内部版本**。已实现截图、键鼠、Shell 和 UTF-8 文件读写；已通过 Yuxi 的真实截图识别与点击验证。浏览器 DOM 和 Cua Driver 接入仍在后续计划中，当前版本不依赖 Cua 或 Ego。

## 开发运行

需要 Python 3.12–3.14 和 [uv](https://docs.astral.sh/uv/getting-started/installation/)。

```sh
uv sync --frozen --extra dev
uv run --frozen abridge user create admin
uv run --frozen abridge serve
```

服务配置使用 `ABRIDGE_HOST`、`ABRIDGE_PORT` 和 `ABRIDGE_DB`，默认分别为 `127.0.0.1`、`8765` 和 `~/.local/share/abridge/server.db`。

打开 `http://127.0.0.1:8765`。登录后添加设备，再创建独立 Agent 授权。管理账户、设备 Key 和 Agent Key 各有用途，不能互换。

## macOS 客户端

从源码安装需要 macOS 14+、Swift 工具链及 uv：

```sh
python3 deploy/install_client.py
open "$HOME/Applications/aBridge.app"
```

在客户端填写服务地址与设备 Key，启用需要的能力，并按实际 App 身份授予系统权限。客户端使用独立 Python 运行时，安装后不依赖源码所在目录。

安装器会跳过未变化的原生构建。仅更新 Python 可使用 `--runtime-only`；真实原生变更仍可能需要重新授予 macOS 权限。当前默认 ad hoc 签名，尚未提供公证安装包或自动更新。[安装与维护](docs/deployment.md)

## MCP 接入

```json
{
  "url": "http://127.0.0.1:8765/mcp",
  "headers": {"Authorization": "Bearer <AGENT_KEY>"}
}
```

调用顺序为 `devices_list` → `session_open` → 工具操作 → `session_close`。会话能力由设备授权、Agent 授权、本机开关和实际权限共同决定。Yuxi 使用个人 Bearer 连接，具体配置见 [Yuxi 接入](docs/yuxi-integration.md)。

截图坐标以返回图像像素为准，桌面输入要求 10 秒内的观察。`executed` 仅表示执行器回执，业务目标仍需通过新观察或实际状态确认。结果未知时不能换操作 ID 盲重试。

## 验证与构建

```sh
make check
make build
```

`make check` 包含 Python lint、格式、测试与前端语法检查；开发检查需要 Node.js，产品运行不依赖 Node。CI 另外验证发行包边界，以及 macOS 原生编译和重复构建。

- [开发约定](CONTRIBUTING.md)
- [架构与模块职责](docs/architecture.md)
- [设计与资产](docs/design.md)
- [验证范围](docs/verification.md)
- [后续计划](docs/roadmap.md)
- [安全与已知边界](SECURITY.md)
- [变更记录](CHANGELOG.md)

服务使用 SQLite 和内存设备连接，限定单进程、单 worker。Shell 与文件访问遵守当前系统用户权限，不构成沙盒。跨机器通信使用 HTTPS/WSS，或部署说明中的 SSH 隧道。

项目当前按内部使用整理，尚未指定开源许可证。CI 负责检查和构建，不自动发布或部署到用户机器。
