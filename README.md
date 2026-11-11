# aBridge

通过 MCP 连接你自己的电脑。独立 Python 服务管理账户、设备和 Agent 授权，macOS 菜单栏客户端负责本机执行、依赖与权限检查、暂停和停止。


## 开发运行

需要 Python 3.12–3.14 和 [uv](https://docs.astral.sh/uv/getting-started/installation/)。

```sh
uv sync --frozen --extra dev
uv run --frozen abridge user create admin
uv run --frozen abridge serve
```

服务配置使用 `ABRIDGE_HOST`、`ABRIDGE_PORT` 和 `ABRIDGE_DB`，默认分别为 `127.0.0.1`、`8765` 和 `~/.local/share/abridge/server.db`。服务端不需要 `macos` extra，也不会加载 Cua 原生库。

打开 `http://127.0.0.1:8765`。登录后添加设备，再为调用方创建独立 Agent 授权。管理账户、设备 Key 和 Agent Key 各有用途，不能互换。

## macOS 客户端

从源码安装需要 macOS 14+、Python 3.12–3.14、Swift 工具链和 uv。浏览器能力另需已安装的 Google Chrome。

```sh
python3 deploy/install_client.py
open "$HOME/Applications/aBridge.app"
```

安装器复制独立运行时，并按锁文件安装 `macos` extra 中的 `cua-driver==0.46.1`。aBridge 在设备 Python 进程内创建 SDK，不启动 CuaDriver.app 或另一套 daemon，不依赖 Ego、Node、本地模型或捆绑浏览器引擎。

在客户端填写服务地址与设备 Key，显式选择能力并连接。界面分别显示 Python、驱动版本与加载状态、系统权限、Chrome 安装与专用窗口连接状态；“重新检查”刷新报告，“安装 / 修复”在本机按哈希锁恢复依赖，“安装说明”提供缺失项指引。已有配置可用“重试连接”复用 Keychain 凭据。

原生输入不变时安装器跳过重建；`--runtime-only` 只更新 Python。当前为 ad hoc 签名，原生更新后需按实际 App 身份核对屏幕录制和辅助功能权限。[安装与维护](docs/deployment.md)

## MCP 接入

```json
{
  "url": "http://127.0.0.1:8765/mcp",
  "headers": {"Authorization": "Bearer <AGENT_KEY>"}
}
```

调用顺序为 `devices_list` → `session_open` → 工具操作 → `session_close`。有效能力取设备授权、Agent 授权、本机开关、驱动与系统就绪状态的交集。`browser` 是独立能力，旧配置和旧 Grant 不会自动加入它。Yuxi 使用个人 Bearer 连接，见 [Yuxi 接入](docs/yuxi-integration.md)。

当前有 17 项 MCP 工具：

| 用途 | 工具 |
| --- | --- |
| 设备与会话 | `devices_list`、`device_get`、`session_open`、`session_close` |
| 桌面与窗口 | `computer_apps`、`computer_windows`、`computer_observe`、`computer_act` |
| 浏览器 DOM | `browser_open`、`browser_observe`、`browser_act` |
| Shell | `command_execute`、`command_status`、`command_cancel` |
| UTF-8 文件 | `files_list`、`file_read`、`file_write` |

窗口操作先选 PID 和 window_id，再观察 AX 元素并使用返回的 `element_ref`。省略目标的桌面观察保留截图像素操作入口，并检查前台窗口变化。观察有效期为 10 秒；动作后重新观察，过期或跨会话引用会被拒绝。

浏览器只在本会话自建的 Chrome 临时 profile 和绑定页面内操作，不接管个人标签或登录状态。DOM 点击首次即使用明确的合成事件；网页可能拒绝这类事件。填表通过驱动的 `insert_text` 路由替换字段。每次动作后都要核对业务状态；`executed` 仅表示执行器回执，结果未知时不能换操作 ID 盲重试。

## 验证与构建

```sh
make check
make build
```

`make check` 包含依赖同步、Python lint、格式、测试、前端语法检查及构建冒烟检查。开发检查需要 Node.js，产品运行不依赖 Node。CI 另验证发行包边界、macOS 原生编译与重复构建，并仅用真实 SDK 做不接触桌面的生命周期检查。

- [开发约定](CONTRIBUTING.md)
- [架构与模块职责](docs/architecture.md)
- [设计与资产](docs/design.md)
- [验证范围](docs/verification.md)
- [后续工作](docs/roadmap.md)
- [安全与已知边界](SECURITY.md)
- [变更记录](CHANGELOG.md)
- [第三方许可](THIRD_PARTY_NOTICES.md)

服务限定单进程、单 worker。Shell 与文件遵守当前系统用户权限，不构成沙盒。跨机器通信使用 HTTPS/WSS 或 SSH 隧道。

项目按内部使用交付，尚未指定开源许可证。CI 负责检查和构建，不自动发布或部署到用户机器。
