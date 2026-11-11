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

当前内部客户端限 Apple Silicon、macOS 14+，需要 uv 和 Swift 工具链；浏览器能力另需系统安装的 Google Chrome。先退出旧客户端，再运行：

```sh
python3 deploy/install_client.py
open "$HOME/Applications/aBridge.app"
```

安装器从锁文件导出包含 `macos` extra 的依赖，使用哈希校验同步独立运行时，并复制应用源码。首次虚拟环境选择 Python 3.12，已有支持的 3.12–3.14 环境保留，不使用运行安装器的系统 Python 版本。固定内部 SDK 为 `cua-driver==0.46.1+abridge.1`，在设备 Python 进程内运行，不另装 CuaDriver.app 或原 CLI。Chrome 使用现有引擎，不由项目捆绑。

内部 SDK 修复上游中文授权弹窗重复计入候选窗口的问题，版本、源 commit、补丁与哈希在 [SDK 目录](../vendor/cua-driver/README.md)。仅维护者重建时需要隔离的固定 Rust 工具链，用户运行和修复不需要 Rust。安装器将已锁定 wheel 复制到本机运行时，并将修复清单指向该副本；源码卷断开后也能恢复同一依赖。

| 内容 | 默认位置 |
| --- | --- |
| App | `~/Applications/aBridge.app` |
| 运行时 | `~/Library/Application Support/aBridge/runtime/` |
| 内部 SDK wheel | 运行时下 `wheels/`，供哈希校验和修复使用 |
| 设备凭据 | `~/Library/Application Support/aBridge/credentials/device.json` |
| 配置、暂停与去重记录 | `~/Library/Application Support/aBridge/` |
| 客户端错误日志 | `~/Library/Logs/aBridge/client.log` |

安装后不依赖源码所在卷。原生输入不变时跳过重建；`--runtime-only` 只更新 Python，要求已有 App 指向同一运行时；`--rebuild-native` 强制重建。可用 `--signing-identity` 或 `ABRIDGE_SIGNING_IDENTITY` 指定已有证书。

默认 ad hoc 签名，原生变化可能需要重新授权。构建成功不等于公证分发，也不等于屏幕录制或辅助功能已可用。

## 检查与修复

客户端分别显示 Python、Cua Driver、屏幕录制、辅助功能和 Chrome 状态。现有模式区分待选择、待接入、已连接与过期；显式临时模式的按需状态不代表已经建立浏览器会话。

- “重新检查”：刷新依赖、版本、加载与权限报告，不安装依赖或启动浏览器。
- “安装 / 修复”或“修复运行时”：停止设备进程，按本机 `runtime/requirements.txt` 的哈希锁恢复依赖，再检查并启动。保留本机凭据文件、配置和暂停状态。
- 缺 uv：打开官方安装指南；缺源码或锁定依赖清单：从项目重新运行安装器。
- “前往设置”：由操作者授予当前 App 的系统权限；“打开 / 安装”使用现有 Chrome 或打开官方安装页。
- “重试连接”：已有配置复用所有者私有凭据文件，无需重新填写设备 Key；“查看诊断”打开本机错误日志。
- `credential_missing`：旧绑定没有文件凭据，需正规轮换后重新绑定；运行不会尝试读取 Keychain。

设备运行凭据目录与状态目录由当前用户所有，权限为700，`device.json` 为600。文件包含 `server_url` 和 `device_key`，保存使用原子替换；读取严格核对权限、普通文件类型及服务地址。它是当前用户可读的本机秘密文件，备份也需按凭据保护。

旧版本迁移由操作者在管理台轮换设备 Key，再通过客户端重新绑定，或调用 `abridge.credentials.save_device_credential` 安全保存新 Key；不要把 Key 放入命令行、日志或文档。`abridge client configure --stdin` 也不再要求 `--helper`，配置成功不会解除已有暂停。解绑仅移除设备凭据文件；在线时请求服务撤销，离线或回执未确认时还需在管理台确认旧 Key 已撤销。

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

0.2.0 的 `browser` 是独立能力。升级不会给旧设备授权、Agent Grant 或本机配置自动增加浏览器权限；需操作者分别选择。缺省为现有 Chrome 待本机选择/批准，未配置时保持不可用，不自动创建临时浏览器。隔离模式仅能显式选择。

在本机运行以下控制命令。只读列表返回 Chrome 窗口元信息与进程实例指纹，不读取 Cookie：

```sh
abridge client control browser-targets
abridge client control browser-target --mode existing_profile \
  --pid PID --window-id WINDOW_ID --fingerprint FINGERPRINT --approve
abridge client control browser-prepare
abridge client control browser-diagnostics
```

若明确需要临时模式，另行选择：

```sh
abridge client control browser-target --mode isolated
```

按独立运行时安装时，使用其 Python 和 `PYTHONPATH` 调用 `-m abridge.client` 即可。现有模式应先在希望使用的 Chrome Profile 中准备一个专用窗口，再选择并批准它；`browser_open` 会导航这个窗口首次绑定的活动标签。选择持久保存在本机配置，进程指纹过期时拒绝，不自动扩大到其他实例。此指纹是本机进程实例标识，与 SDK 授权资源字段分开核对。

本机“接入当前页”或 `browser-prepare` 明确建立一次 Chrome 连接，可能使选定窗口到前台并弹出 Chrome 许可提示。仅这个本机命令等待最多 120 秒；驱动内部连接仍有自己的超时，失败后需按诊断处理。MCP 后续只后台使用已准备的连接，不偷偷改成前台，不接受 Profile 路径、任意 PID 或授权参数。

同一个有界本机上下文供远程会话依次独占使用：远程会话关闭或干净断线会清理自己的引用和任务，保留连接；最长 8 小时或空闲 30 分钟后需本机重新接入，不自动保活。暂停、停止、解绑、退出、关闭浏览器能力或变更目标会结束连接。在途写操作结果不确定时也结束连接。现有模式不关闭个人 Chrome、原页或其他标签；隔离模式回收自建进程。

首次连接现有 Profile 时，可由本机操作者在该 Profile 打开 `chrome://inspect/#remote-debugging` 启用远程调试，再回到批准页并允许 Chrome 的连接提示。[Chrome 官方步骤](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)。固定 Cua 0.46.1 的自动准备在部分本地化界面会因找不到英文 New Tab 按钮拒绝；先正规启用后，SDK 会验证既有端点并跳过该助手，不需要修改语言或绕过后台保护。[固定版准备流程](https://github.com/trycua/cua/blob/93c9b500a0d4f9daa56063d3d3e3fb3c9e6070ee/libs/cua-driver/rust/crates/cua-driver-core/src/browser/prepare.rs#L1191)

固定 SDK 还需读取 Chrome 用户数据根目录中的 `DevToolsActivePort` 连接元信息，并核对监听进程；不读取或导出 Cookie。若诊断出现 `Operation not permitted`，需按系统实际拒绝的权限处理，不能因启用了 Chrome 调试就认为本机文件访问也已授权。macOS 对其他应用数据有独立访问控制；`NSAppDataUsageDescription` 是目的说明，不会自行授予权限，也不能仅凭该错误推断必须开放全磁盘。[Apple 权限说明](https://developer.apple.com/documentation/bundleresources/information-property-list/nsappdatausagedescription)

此时可在本机通过系统文件选择器，仅选择该 Chrome 的 `DevToolsActivePort` 文件，不选择整个 Profile 目录。App 保存只读书签，并将所有者600的 `state_dir/browser-access-transfer.bookmark` 交给设备进程；再点“接入当前页”，设备会重新解析最新书签，不需要重启或停止独立 Shell。当前文件访问状态在 `dependencies.browser.file_access`，解析失败、过期或权限拒绝会明确报告，不能据 `ready` 一项代替实际连接测试。App 重开会恢复书签，权限仍可能因系统策略或文件替换失效，需重新选择。[Apple 单文件授权流程](https://developer.apple.com/videos/play/wwdc2023/10053/?time=1206)

`browser-diagnostics` 仅供本机读取最近一次失败的阶段、工具、错误码和有界脱敏原因；它不进入默认诊断、设备上报或 MCP。失败仍需按具体阶段处理，不能把已种好的测试 Cookie 当作浏览器业务通过。

连接成功不等于权限授予或业务完成。本机暂停在重连和修复后保持；更新不能重放未知动作。远程 MCP 没有依赖安装或扩大授权入口。

隧道 launchd 配置为 `~/Library/LaunchAgents/app.abridge.tunnel.plist`，日志为 `~/Library/Logs/aBridge/tunnel.log`。长期停用时卸载并移走 plist，避免再次登录加载。

## 变更与回滚

更新前完成相关检查，保留上一份内部源码包与数据库备份。服务更新会断开内存连接，设备需重新认证；客户端更新应先退出活动进程。当前没有自动迁移回滚、自动生产发布或公证更新渠道。

真实主机地址、部署笔记与历史证据放在 `.local/`，不写回脚本默认值。本轮 AX、DOM 的实际业务状态以 [验证范围](verification.md) 为准。
