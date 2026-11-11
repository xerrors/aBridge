# 安装与维护

## 部署方式

服务端要求 Python 3.12–3.14 和 uv，当前限定单进程、单 worker。推荐内网 HTTPS/WSS；也可将服务绑定服务器回环地址，通过 Mac SSH 隧道访问。

```text
Mac 客户端 / 管理台 ─ 本机回环 ─ SSH ─ 服务回环 ─ SQLite
同机容器 MCP 客户端 ─ 可选 Docker 网关转发 ─┘
```

部署脚本不预置个人服务器地址、账号和路径。先确认 SSH 主机、当前用户有写入权限的绝对安装目录及端口，再明确调用安装器：

```sh
python3 deploy/install.py server \
  --ssh-host bridge-host --remote-root /absolute/path/to/abridge
python3 deploy/install.py tunnel --ssh-host bridge-host
```

`bridge-host` 是运维者配置的 SSH 别名。远端 uv 默认安装在 `~/.local/bin/uv`，需用户级 systemd。安装器按锁文件同步代码与依赖，创建 `abridge.service` 并重启服务；更新前停止正在进行的任务。

| 内容 | 安装根目录下的位置 |
| --- | --- |
| 源码和虚拟环境 | `source/` |
| 数据库 | `state/server.db` |
| uv 缓存 | `uv-cache/` |
| systemd 单元 | 当前用户 `~/.config/systemd/user/abridge.service` |

首次管理账户应在服务器交互创建，`ABRIDGE_DB` 指向服务使用的数据库。自动化可用 `abridge user create NAME --password-stdin` 从安全标准输入提供密码，不把密码放入命令参数或日志。

```sh
systemctl --user status abridge.service --no-pager
journalctl --user -u abridge.service -n 50 --no-pager
systemctl --user restart abridge.service
systemctl --user disable --now abridge.service
```

备份使用 SQLite 备份接口，或停服务后保留数据库与其 WAL 文件；不要只复制运行中的主数据库。状态与备份需限制访问权限。

## macOS 客户端

从源码安装需要 macOS 14+、Python、uv 和 Swift 工具链。先退出已安装客户端，再运行：

```sh
python3 deploy/install_client.py
open "$HOME/Applications/aBridge.app"
```

运行时在 `~/Library/Application Support/aBridge/runtime/`，App 默认在 `~/Applications/aBridge.app`。设备 Key 在 Keychain，配置、暂停和操作去重记录在应用支持目录；运行不依赖源码所在卷。

普通安装在原生输入不变时跳过重建。`--runtime-only` 只更新 Python，要求已安装 App 指向同一运行时；`--rebuild-native` 明确强制重建。已有代码签名证书可用 `--signing-identity` 或 `ABRIDGE_SIGNING_IDENTITY` 指定。

默认 ad hoc 签名。原生构建变化可能使系统要求重新授权，不能把构建成功当作公证分发。首次安装或更新后，应按实际 App 身份核对屏幕录制与辅助功能权限。

## 绑定和管理

1. 登录管理台，创建设备并显式选择能力，保存仅显示一次的设备 Key。
2. 在客户端填写服务地址与设备 Key，确认本机能力并连接。
3. 在管理台为调用方创建独立 Agent Key，选择目标设备、能力和到期时间。
4. 配入 MCP 客户端，通过具体任务核对结果。

连接成功不等于系统权限已授予。新增能力不会自动加入旧授权。本机暂停在重连后保持；更新不能自动解除暂停或重放未知动作。

隧道的 launchd 配置为 `~/Library/LaunchAgents/app.abridge.tunnel.plist`，日志在 `~/Library/Logs/aBridge/tunnel.log`。长期停用时卸载并移走 plist，避免下次登录再次加载。

## 变更与回滚

部署前完成 `make check` 与发行包检查，保留上一份源码包和数据库备份。更新会断开内存中的连接，等待设备重新认证。当前没有自动迁移回滚或自动生产发布，不应在 CI 中持有用户设备凭据。

本机实际部署路径、容器转发和历史证据放在 `.local/`；不要把它们改回脚本默认值。
