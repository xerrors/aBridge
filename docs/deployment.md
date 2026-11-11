# 安装与维护

## 服务端

需要 Python 3.12–3.14 和 uv，限定单进程、单 worker。服务不安装 `macos` extra，不需要 Cua、Chrome 或图形环境。推荐内网 HTTPS/WSS；也可绑定服务器回环地址，通过 Mac SSH 隧道访问。

```text
Mac 客户端 / 管理台 ─ 本机回环 ─ SSH ─ 服务回环 ─ SQLite
同机容器 MCP 客户端 ─ 可选 Docker 网关转发 ─┘
```

脚本不预置个人主机和路径。确认 SSH 别名、可写的绝对安装目录与端口后调用：

```sh
python3 deploy/install.py server \
  --ssh-host bridge-host --remote-root /absolute/path/to/abridge
python3 deploy/install.py tunnel --ssh-host bridge-host
```

远端 uv 默认在 `~/.local/bin/uv`，需用户级 systemd。安装器按锁文件同步源码、README 与依赖，创建 `abridge.service` 并重启服务；更新前结束活动任务。

| 内容 | 位置 |
| --- | --- |
| 源码与虚拟环境 | 安装根目录下 `source/` |
| 数据库 | 安装根目录下 `state/server.db` |
| uv 缓存 | 安装根目录下 `uv-cache/` |
| systemd 单元 | `~/.config/systemd/user/abridge.service` |

首次账户在服务器交互创建，`ABRIDGE_DB` 指向实际服务数据库。自动化可用 `abridge user create NAME --password-stdin` 从安全标准输入提供密码，不把密码放进参数或日志。

```sh
systemctl --user status abridge.service --no-pager
journalctl --user -u abridge.service -n 50 --no-pager
systemctl --user restart abridge.service
systemctl --user disable --now abridge.service
```

备份使用 SQLite 备份接口，或停服务后保留数据库与 WAL；不要只复制运行中的主数据库。状态与备份需限制访问。

## macOS 客户端

从源码安装需要 macOS 14+、Python 3.12–3.14、uv 和 Swift 工具链；浏览器能力另需系统安装的 Google Chrome。先退出旧客户端，再运行：

```sh
python3 deploy/install_client.py
open "$HOME/Applications/aBridge.app"
```

安装器从锁文件导出包含 `macos` extra 的依赖，使用哈希校验同步独立运行时，并复制应用源码。固定 SDK 为 `cua-driver==0.46.1`，在设备 Python 进程内运行，不另装 CuaDriver.app。Chrome 使用现有引擎，不由项目捆绑。

| 内容 | 默认位置 |
| --- | --- |
| App | `~/Applications/aBridge.app` |
| 运行时 | `~/Library/Application Support/aBridge/runtime/` |
| 设备凭据 | Keychain |
| 配置、暂停与去重记录 | `~/Library/Application Support/aBridge/` |
| 客户端错误日志 | `~/Library/Logs/aBridge/client.log` |

安装后不依赖源码所在卷。原生输入不变时跳过重建；`--runtime-only` 只更新 Python，要求已有 App 指向同一运行时；`--rebuild-native` 强制重建。可用 `--signing-identity` 或 `ABRIDGE_SIGNING_IDENTITY` 指定已有证书。

默认 ad hoc 签名，原生变化可能需要重新授权。构建成功不等于公证分发，也不等于屏幕录制或辅助功能已可用。

## 检查与修复

客户端分别显示 Python、Cua Driver、屏幕录制、辅助功能和 Chrome 状态。Chrome“专用窗口按需打开”表示前置条件满足，不代表已经建立浏览器会话；已连接时显示专用窗口状态。

- “重新检查”：刷新依赖、版本、加载与权限报告，不安装依赖或启动浏览器。
- “安装 / 修复”或“修复运行时”：停止设备进程，按本机 `runtime/requirements.txt` 的哈希锁恢复依赖，再检查并启动。保留 Keychain、配置和暂停状态。
- 缺 uv：打开官方安装指南；缺源码或锁定依赖清单：从项目重新运行安装器。
- “前往设置”：由操作者授予当前 App 的系统权限；“打开 / 安装”使用现有 Chrome 或打开官方安装页。
- “重试连接”：已有配置复用 Keychain 凭据，无需重新填写设备 Key；“查看诊断”打开本机错误日志。
- `native_timeout`：解锁 Mac 并处理 aBridge 的 Keychain 访问弹窗，再重试连接。

只读命令行诊断不依赖客户端第三方包，可在运行时部分损坏时使用：

```sh
PYTHONPATH="$HOME/Library/Application Support/aBridge/runtime/src" \
  "$HOME/Library/Application Support/aBridge/runtime/.venv/bin/python" \
  -m abridge.diagnostics --json
```

报告区分缺包、版本不符、加载失败与权限检查。`permissions.checked=false` 表示未检查。终端诊断只说明该进程的权限责任链；正式 App 的实际截图、AX 操作和浏览器连接须另行验证。Python 可执行文件本身缺失时，使用本机 UI 修复或重新运行安装器。

## 绑定与能力

1. 管理台创建设备，显式选择能力并保存仅显示一次的设备 Key。
2. 客户端填写地址与设备 Key，开启本机所需能力并连接。
3. 为调用方创建独立 Agent Key，选择设备、能力与期限。
4. 配入 MCP 客户端，通过自有目标核对实际结果。

0.2.0 的 `browser` 是独立能力。升级不会给旧设备授权、Agent Grant 或本机配置自动增加浏览器权限；需操作者分别选择。浏览器会话使用自己的 Chrome 临时 profile，不复用个人登录状态。

连接成功不等于权限授予或业务完成。本机暂停在重连和修复后保持；更新不能重放未知动作。远程 MCP 没有依赖安装或扩大授权入口。

隧道 launchd 配置为 `~/Library/LaunchAgents/app.abridge.tunnel.plist`，日志为 `~/Library/Logs/aBridge/tunnel.log`。长期停用时卸载并移走 plist，避免再次登录加载。

## 变更与回滚

更新前完成相关检查，保留上一份内部源码包与数据库备份。服务更新会断开内存连接，设备需重新认证；客户端更新应先退出活动进程。当前没有自动迁移回滚、自动生产发布或公证更新渠道。

真实主机地址、部署笔记与历史证据放在 `.local/`，不写回脚本默认值。本轮 AX、DOM 的实际业务状态以 [验证范围](verification.md) 为准。
