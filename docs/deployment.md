# 安装与维护

## 环境与分发

可以通过 GitHub Release 的 Server 包、Docker 镜像或源码运行 aBridge。直接运行 Server 需要 Node.js 22.13.0+（22.x）、23.4.0+（23.x）或 24 及以上版本。从源码构建还需要 npm。Node 版本要求来自内置的 `node:sqlite`。[Node 22 发布说明](https://nodejs.org/en/blog/release/v22.13.0) · [Node 23 发布说明](https://nodejs.org/en/blog/release/v23.4.0)

Server 包内含预构建的管理台，可以部署在无图形环境的机器上。想先用发布包跑通一次连接，可从快速开始里的命令开始。[快速开始](guide/start.md)

## 从源码运行 Server

```sh
npm install
npm run build
npm start -- --web
```

`abridge` 默认启动 Server，等同于 `abridge serve`。终端显示访问地址，`--web` 把带凭据的管理员链接直接交给本机浏览器。首次启动会在数据库旁生成 `<数据库文件>.admin-token`（权限为 `600`），后续重启继续使用它。也可设置 `ABRIDGE_ADMIN_TOKEN`，指定 32–512 个不含空白的可打印 ASCII 字符，文件中的 Token 会原样保留。

打开管理链接后，前端立即清除 URL fragment 中的 Token，再通过 API 兑换有效期 30 天的 `HttpOnly`、`SameSite=Strict` Cookie；HTTPS 使用 `Secure`。管理员会话跨 Server 重启保留，在同一浏览器、同一 Origin 下再次访问普通地址即可恢复。退出管理员清除浏览器会话；重置 Token 会使旧 Token 和全部旧管理员会话失效。自动生成的 Token 使用以下命令重置并启动：

```sh
node dist/server/cli.js --reset-admin-token
```

若使用环境变量配置 Token，修改变量后重启即可。请把管理员链接保存在私下，分享给普通用户时使用 Server 的访问地址。

用管理员身份进入「实例管理」，创建用户并查看设备统计。普通用户再用自己的账户登录，管理设备和 Agent 连接。自动化建账可调用管理员 API。[Server API](https://github.com/xerrors/aBridge/blob/main/apps/server/README.md#管理员-api)

### 配置

| CLI 选项              | 含义                                                   |
| --------------------- | ------------------------------------------------------ |
| `--host`              | 监听地址，默认 `127.0.0.1`                             |
| `--port`              | 监听端口，默认 `8765`；`0` 由系统分配临时端口          |
| `--data-dir`          | 持久状态目录                                           |
| `--db`                | 显式 SQLite 文件路径，覆盖数据目录中的默认数据库位置   |
| `--public-origin`     | 反向代理外部 Origin，例如 `https://bridge.example.com` |
| `--allowed-hosts`     | 额外允许的 Host，逗号分隔                              |
| `--allowed-origins`   | 额外允许的 MCP Origin，逗号分隔                        |
| `--web`               | 打开实例管理员链接                                     |
| `--reset-admin-token` | 启动时重置自动生成的管理员 Token                       |

默认状态目录在 macOS 为 `~/Library/Application Support/aBridge`，Linux 为 `$XDG_DATA_HOME/abridge` 或 `~/.local/share/abridge`，Windows 为 `%LOCALAPPDATA%/aBridge`。Server 数据库默认位于状态目录下 `server/server.db`。路径应位于持久磁盘，不放入 npm 临时执行缓存或临时目录。

Server 还接受 `ABRIDGE_HOST`、`ABRIDGE_PORT`、`ABRIDGE_DB`、`ABRIDGE_PUBLIC_ORIGIN`、`ABRIDGE_ALLOWED_HOSTS`、`ABRIDGE_ALLOWED_ORIGINS`、`ABRIDGE_ADMIN_TOKEN`。提供同名 CLI 选项的配置以 CLI 为先，管理员 Token 只接受环境变量或持久文件。启动时的 `--help` 是选项的完整索引。

### 反向代理与网络

跨机器连接可以用 HTTPS/WSS 反向代理，也可以通过 SSH 隧道访问回环服务。使用反向代理时，将对外地址配置为 Server 的 `public-origin`。

```sh
node dist/server/cli.js --data-dir /absolute/path/to/state \
  --public-origin https://bridge.example.com
```

地址写成 `scheme://host[:port]` 即可，例如 `https://bridge.example.com`。Server 根据这个地址检查管理台请求是否同源，并决定是否给 Cookie 设置 `Secure`。

如果还要允许其他 Host 或 MCP Origin，可设置 `--allowed-hosts bridge.example.com:8443` 或 `--allowed-origins https://mcp-client.example.com`。管理 API 仍按 `public-origin` 检查同源。代理需要支持 WebSocket，并转发 Host 与认证头。

也可由操作者使用已有 SSH 连接转发端口：

```sh
ssh -N -L 127.0.0.1:8765:127.0.0.1:8765 bridge-host
```

客户端必须能访问配置中的 Server URL。`127.0.0.1` 始终指向发起连接的机器或容器。

## 本地 Server 分发包

构建后，Server 入口位于 `dist/server/cli.js`，管理台资源在同目录的 `web/`。桌面和扩展产物分别在 `dist/desktop/` 和 `dist/browser/`。

运行分发工具，在 `dist/releases/` 生成 Server tarball 与扩展 ZIP，并检查分发边界：

```sh
npm run package
npm run package:check
```

Server 包包含预构建 CLI、管理台和生产依赖。打包时从本地 `package-lock.json` 提取 Server 的依赖锁，用 `npm ci` 安装并通过 `bundleDependencies` 随包分发。验包会按照根锁比对 tarball 中的依赖路径和版本。软件版本来自根 `package.json`。

用 `npm exec --package <本地tgz路径> -- abridge --web` 试运行本地包。数据库继续由 `--data-dir` 或 `--db` 指向持久目录。

## Docker 镜像

Server 和管理台随 `ghcr.io/xerrors/abridge` 一起提供，支持 `linux/amd64` 和 `linux/arm64`。示例固定使用已发布的 `0.4.23`，`latest` 随正式镜像更新。[GHCR 镜像列表](https://github.com/xerrors/aBridge/pkgs/container/abridge)

```sh
docker run -d --name abridge --restart unless-stopped \
  -p 127.0.0.1:8765:8765 \
  -v abridge-data:/data \
  -e ABRIDGE_PUBLIC_ORIGIN=http://127.0.0.1:8765 \
  ghcr.io/xerrors/abridge:0.4.23
```

将 `ABRIDGE_PUBLIC_ORIGIN` 换成实际访问地址；使用 HTTPS 反向代理时填外部 HTTPS Origin。远程连接推荐 HTTPS/WSS；公网 HTTP 需要客户端明确确认。命名卷保存数据库和管理员凭据，更新镜像时复用同一数据卷；不要同时启动两个容器使用同一个卷。

```sh
curl -f http://127.0.0.1:8765/health
docker stats --no-stream abridge
docker logs --tail 30 abridge
```

输出管理员链接（包含私密凭据，不转发）：

```sh
docker exec abridge node -e '
const fs = require("node:fs");
const token = process.env.ABRIDGE_ADMIN_TOKEN || fs.readFileSync("/data/server.db.admin-token", "utf8").trim();
console.log(process.env.ABRIDGE_PUBLIC_ORIGIN + "/#admin_token=" + encodeURIComponent(token));
'
```

更新时先备份数据，再停止并删除旧容器。用新镜像和原来的端口、环境变量、数据卷重建容器，继续使用 `abridge-data` 中的数据库和凭据。

## macOS App

macOS App 支持 Apple Silicon 和 macOS 14 及以上版本。可从 Release 下载 ZIP，解压后将 App 放进 Applications。若要从源码构建，先安装 Xcode Command Line Tools，再在仓库根目录运行以下命令。

```sh
npm install
npm run build
npm run desktop:install
open "$HOME/Applications/aBridge.app"
```

Swift 客户端、更新器和 Cua Driver 0.47.8 随 App 一起安装。构建从锁定的 SDK 包提取并签名 arm64 原生库，安装器再把完整 App 复制到目标目录。

| 内容                 | 默认位置                                                        |
| -------------------- | --------------------------------------------------------------- |
| App                  | `~/Applications/aBridge.app`                                    |
| 原生客户端与更新器   | `aBridge.app/Contents/MacOS/`                                   |
| Cua 原生库           | `aBridge.app/Contents/Frameworks/`                              |
| 设备凭据             | `~/Library/Application Support/aBridge/credentials/device.json` |
| 配置、暂停与操作日志 | `~/Library/Application Support/aBridge/`                        |
| 客户端日志           | `~/Library/Application Support/aBridge/logs/client.log`         |

原生构建比较 Swift、共享契约、SDK、资源和签名配置的指纹，未变化时复用已验证的 App。先运行 `npm run build` 生成共享契约，再使用底层构建入口：

```sh
node --import tsx tools/build-native.ts \
  --output /absolute/path/to/aBridge.app
```

构建默认使用 ad hoc 签名。可用 `--signing-identity` 或 `ABRIDGE_SIGNING_IDENTITY` 指定本机证书。更换二进制或签名后，请在实际安装的 App 中检查屏幕录制和辅助功能权限。

从 0.4.15 及更早版本升级时，请退出旧版 App，解压 Release ZIP 并替换原位置的 `aBridge.app`。保留 `~/Library/Application Support/aBridge`，原来的绑定、身份和暂停设置随之保留。装好原生版本后，可继续通过应用内更新升级。

### 绑定与控制

1. 在 App 填写 Server 地址，点击“在浏览器授权”。
2. 在打开的浏览器中登录管理台，核对账户、设备与能力并确认授权；App 自动保存设备凭据并连接，再开启需要的本机能力。
3. 为实际安装的 App 授予所需系统权限。仅 Shell/文件操作不需要桌面权限。
4. 创建 Agent 连接，选择指定设备或全部设备（包含以后新增设备），按设备设置能力；默认持续有效，也可指定到期日期。将生成的 Agent Key 配入 MCP 客户端。

连接范围、能力和期限可以随时调整，现有 Key 继续有效。轮换密钥时，旧 Key 会立即失效。在连接预览中可以看到该 Agent 能使用哪些设备，以及每台设备的状态。

在菜单或设置中可以暂停、停止任务、重连和查看日志。暂停状态会在重连后保留，恢复访问由本机用户操作。「环境检查」可刷新运行时、驱动和权限状态。缺少运行文件时，退出 App 并重新安装完整应用。

在「系统权限」中可以拖动 App 图标，也可以选择「在 Finder 中显示」。将正在运行的 App 添加到对应的 macOS 权限列表，然后打开它的权限开关。[Apple 辅助功能说明](https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/mac) · [Apple 屏幕录制说明](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac)

可使用已安装运行时的 CLI 读取状态，或从构建目录诊断：

```sh
dist/desktop/aBridge.app/Contents/MacOS/abridge-desktop status
dist/desktop/aBridge.app/Contents/MacOS/abridge-desktop diagnose
```

自定义状态目录使用 `--state-dir`，日志位于 `<state-dir>/logs/client.log`。检查屏幕录制及辅助功能时，请打开实际安装的 App，用自己的窗口验证截图和输入。

### 应用内更新

在 macOS 菜单选择“检查更新…”，或在设置的“软件更新”中检查。发现正式新版后，依次点击“下载更新”和“安装并重启”。下载期间可以继续使用；安装会结束当前执行，保留设备绑定、能力开关、暂停状态和数据目录。应用必须位于可写的本机目录；从磁盘镜像或 App Translocation 启动时先移入 Applications。

更新器读取 `xerrors/aBridge` 的 GitHub Latest 正式 Release，优先选择公证的 Apple Silicon ZIP，否则选择现有 unsigned 包。下载校验 GitHub 提供的 SHA-256 和大小，再核对 Bundle ID、版本与代码签名；已使用团队签名的应用拒绝换成其他团队或 ad hoc 包。应用在原安装路径替换，收到新版 App 及原生客户端的启动确认后才清理旧版；启动失败恢复并重新打开旧版，错误写入数据目录的 `logs/update-error.log` 并在设置显示。

更新沿用 Bundle ID、安装路径和用户状态。使用 ad hoc 签名的版本更新后，macOS 可能要求重新授予录屏和辅助功能权限。使用同一 Developer ID 签名可以延续签名身份。更新后从 Finder 打开 App 时，仍会使用此前设置的数据目录。

开发验证：`npm run check`；macOS 可另运行 `npm run test:desktop:update:live`，使用独立临时 App 验证真实下载、原路径替换、启动确认与失败回滚，不替换已安装客户端。

## Windows PC 客户端

Windows 10/11 x64 预览版提供截图、前台键鼠、Shell 和 UTF-8 文件读写。下载未签名便携 ZIP，完整解压后启动 `aBridge.exe`，填写客户端能访问的 Server 地址并完成浏览器授权。[下载、安装与绑定](windows-client.md)

桌面操作需要已解锁的交互式桌面。客户端通过「本机能力」控制开放的能力，通过设置窗或托盘暂停、停止任务和退出。更新前退出旧客户端，解压新包并沿用原状态目录，默认位于 `%LOCALAPPDATA%\aBridge`。[更新、退出和卸载](windows-client.md#更新、退出和卸载)

## Linux CLI

Linux CLI 适合在开发机或服务器上执行 Shell 和文件任务。客户端是独立的 Rust 可执行文件，运行需要系统 `/bin/sh` 和可信 CA 证书，可在无图形环境中使用。连接后，管理台会显示一台 Linux 电脑。可用能力由设备授权、Agent 策略和本机开关共同决定。

在管理台创建电脑设备并取得 Device Token，解压已校验的对应架构分发包后运行：

```sh
./abridge-client setup --url https://bridge.example.com
./abridge-client service install
./abridge-client status
```

`setup` 隐藏输入 Token，先校验再保存。连接远程 HTTP 时，终端先显示 Origin 并要求确认，再提示输入 Token。无人值守绑定使用 `setup --stdin` 从私有输入读取绑定 JSON，远程 HTTP 须提供完全匹配的 `http_confirmed_origin`。

默认安装当前账户的 systemd 服务，程序复制到 `~/.local/lib/abridge-client/abridge-client`。如果希望开机启动、退出登录后仍运行，可以用 `service install --linger`，按系统提示处理权限。日志可以用 `logs` 或 `journalctl --user -u abridge-client.service` 查看。使用其他进程管理器时，执行 `run` 在前台运行。

暂停、能力开关和绑定保存在用户私有状态目录，重启或重连后继续生效。更新时先停止任务，再用新版二进制执行 `service install`。自定义状态目录的用户可通过 `--state-dir` 继续使用原目录。`service uninstall` 会移除服务并保留状态目录。遇到结果未知的操作时，先检查原操作状态。

源码构建使用 `npm run linux:build`，Rust 检查使用 `npm run linux:check`，Linux 候选包使用 `npm run package:linux`。分发包含单个可执行文件、说明和许可证，并输出 SHA-256、实际体积报告；构建强制执行 15 MiB 二进制和 5 MiB 下载包预算。原生 Linux amd64/arm64 CI 另验证协议和真实 systemd 生命周期。完整命令、依赖和目标平台说明见 [Linux 客户端](https://github.com/xerrors/aBridge/blob/main/apps/linux-client/README.md)。

## 浏览器扩展

```sh
npm run build
```

在 `chrome://extensions` 开启开发者模式，选择「加载已解压的扩展程序」，再选 `dist/browser/`。也可以解压构建生成的扩展 ZIP 后按同样方式加载。扩展版本来自根 `package.json`。

点击扩展图标，选择「连接浏览器」，在打开的标签页填写 Server 地址和设备名，按表单提示确认后点击「在浏览器授权」，登录管理台并确认绑定当前 Profile。远端 Server 推荐 HTTPS/WSS；公网 HTTP/WS 需在客户端确认风险，本机回环 HTTP/WS 无需额外确认。绑定时只需允许扩展访问所填 Server 地址。

扩展独立注册为浏览器设备。在管理台把它加入所需的 Agent 连接，并授予 `browser` 能力。更新构建文件后，在扩展管理页选择「重新加载」并确认已连接，原绑定和暂停状态会保留。[浏览器客户端](browser-profile-design.md)

## 无头 Linux 浏览器客户端

`abridge-client-browser` 是独立浏览器设备，只提供 `browser`。由 aBridge 打包业务启动器、Playwright 版本和同版本扩展。构建机器执行 `npm run package:browser-client`，取出 `.local/release/browser-client/abridge-client-browser-<版本>-linux.tar.gz`。

在目标 Linux 上解包。当前已验证 Linux amd64，客户端要求 Python 3.10 或更新版本。管理员预装 Chromium 系统库与可信 CA；可使用发行物所钉住的 Playwright 执行 `python -m playwright install-deps chromium`。使用专用非 root 账户执行以下命令。在启用受限 user namespace 的发行版上，系统策略须允许此 Chromium 使用 user namespace 沙盒。Ubuntu AppArmor 可为实际安装路径上的受保护 Chromium 二进制设置单独的 `userns` 规则。

```sh
cd abridge-client-browser
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m playwright install --no-shell chromium
.venv/bin/python -I ./abridge-client-browser bind --server https://bridge.example.com
.venv/bin/python -I ./abridge-client-browser run
```

在管理台新建浏览器设备，生成 Browser Device Key，在 `bind` 提示中隐藏输入。然后将该设备加入需要控制它的 Agent 连接。`bind --stdin` 可经私有输入管道读取 Key。远端 HTTP 需要指定 `--allow-http`；回环可直接用于开发验收。运行账户可以用 `status` 查看本地绑定状态，aBridge 设备列表确认 WebSocket 在线。将前台 `run` 交给部署已有的进程管理器，重启沿用 `~/.local/state/abridge-client-browser` 中的 Profile。需要修改存储位置时为该账户设置 `ABRIDGE_BROWSER_HOME`，使用权限 0700 的目录。

### 可选平台托管浏览器

Server 启用平台委托并设置 `ABRIDGE_MANAGED_BROWSER_ENABLED=true` 后，受信平台可为工作负载登记浏览器。平台向 `GET /api/managed-browsers/status` 提交只读 JWT。首次安装、计划换绑或确认丢失本地绑定时，平台用当前登记版本签发 `POST /api/managed-browsers/provision` 的 JWT。Server 按发行方、客户端与主体登记专属浏览器设备，并维护递增的绑定版本。

平台通过私有 stdin 将 `browser_origin`、`device_id`、`revision` 与首次绑定需要的 `bootstrap_token` 交给浏览器客户端的 `start`。客户端从同一公开 Origin 的 `/api/managed-browsers/redeem` 换取 Browser Device Key。客户端从已确认的 Profile 恢复时，交接只需要 Origin、设备 ID 和版本。来宾须能访问公开 Origin 的 HTTPS 与 WebSocket。HTTP 部署须在 Server 显式打开相应配置，并在交接中提供与 Origin 一致的 `http_confirmed_origin`。

计划换绑使用 `replace: true`。换绑响应提供候选版本和票据，状态接口的 `binding` 继续报告当前安装，`replacement` 报告候选版本及其有效期。候选票据兑换出的 Key 可用于验证设备身份。新 Profile 保存凭据并通过 WebSocket 往返确认后，Server 才启用候选 Key、推进版本并结束旧会话。候选启动失败时，旧登记继续有效。有效期内可用当前版本及同一候选安装标识重新领票，新票据签发时上一轮候选 Key 即失效。

客户端运行时通过 `status` 返回扩展自己的 `connected`。平台应核对此值及 Server `binding` 的同一版本已在线，再将浏览器标为就绪。

工作负载的通用 `abridge-delegation` 委托还须携带当前 `installation_id` 与 `revision`。aBridge 只允许它控制本次登记的浏览器。新版本启用时，Server 同时撤销旧版 MCP 连接。若旧 Key 已泄露或需立即取消访问，平台使用 `POST /api/managed-browsers/stop`，按当前版本撤销设备 Key、该工作负载的 MCP 连接和全部候选凭据。客户端本地 `stop` 关闭浏览器进程并保留绑定。已有关闭状态可由受信平台查询，即使该部署随后关闭了新登记。

平台也可以在登录用户明确授权后，用该用户的 OIDC `sub` 登记其个人运行环境。`GET /api/personal-browsers/status` 和 `POST /api/personal-browsers/provision` 沿用上述状态和版本协议，分别校验 `abridge-personal-browser-status` 和 `abridge-personal-browser-provision` 用途及对应端点的受众，并使用同一票据兑换接口。个人登记使用账户级平台授权。首次登记时，若该账户尚无此平台连接，Server 会建立覆盖账户全部设备和能力的连接。已有连接沿用用户设定的设备、能力和撤销策略。用户可以在管理台管理平台连接和设备。

在管理台为个人浏览器重新生成凭据时，当前安装需要重新连接。管理台签发的 Device Key 可以照常绑定，直到用户在平台重新连接并兑换新凭据。

标准 SQLite schema 6 数据库可以直接启用托管浏览器。已有旧试用登记时，部署方先备份，再在隔离副本中转换该表。

## 数据与更新

每个数据库由一个 Server 实例使用，启动时会锁定该路径。重启后设备会重新连接，任务需要新建会话。重启前结果未知的操作，可先查询状态，再检查实际结果。

在线备份请使用 SQLite 备份接口。手工复制前先停止服务，再一并保留数据库和 WAL。把凭据、日志和备份保存在访问受限的目录里。旧开发数据库应先备份，再在副本上转换到当前 schema 或重新初始化。

更新前结束活动任务并备份状态。更新后重新连接一台设备，用实际安装的客户端确认所需能力可用。

## 发布与便携 App

各客户端的 tag 分发流程见[发布说明](releasing.md)。`npm run package:macos` 生成无需 Node 的便携原生 App ZIP；未配置 Developer ID 时文件名标注 unsigned。

## 可选 OIDC 登录与平台 MCP 委托

未配置时继续使用本地账户与 Agent Key。接入支持 discovery、Authorization Code + S256 PKCE、RS256 ID Token 的身份提供方：

```dotenv
ABRIDGE_PUBLIC_ORIGIN=https://bridge.example.com
ABRIDGE_OIDC_ISSUER_URL=https://yuxi.example.com/api/auth/provider
ABRIDGE_OIDC_CLIENT_ID=abridge
ABRIDGE_OIDC_CLIENT_NAME=Yuxi
ABRIDGE_OIDC_CLIENT_SECRET=<在提供方登记的客户端秘密>
ABRIDGE_DELEGATION_ENABLED=true
# 可选：仅限可信私有网络，容器内访问提供方的地址
ABRIDGE_OIDC_BACKCHANNEL_ORIGIN=http://api:5050
```

容器访问不到公开 issuer 时，可以把 `ABRIDGE_OIDC_BACKCHANNEL_ORIGIN` 设为内部 `scheme://host[:port]`。与 issuer 同源的 discovery、token 和 JWKS 请求会改用这个内部地址，并保留路径和查询参数。浏览器继续使用公开地址，issuer 和令牌校验照常进行。内部请求只访问配置的地址，遇到重定向会停止。HTTP backchannel 会传输客户端秘密和令牌，请只在可信私网内使用。

必须在提供方登记固定回调 `https://bridge.example.com/api/auth/oidc/callback`，客户端认证方式为 `client_secret_post`。登录入口 `GET /api/auth/oidc/login`，可用 `return_to=/?authorize=<id>` 保留现有设备绑定确认流程，仅接受本地限定入口；发现状态 `GET /api/auth/oidc/config`；请求 scope 为 `openid profile`，显示名使用可选的 `name`。提供方 issuer 必须精确匹配 discovery。默认要求非回环端点使用 HTTPS。需要公网 HTTP 时，可在 Server 启动参数中显式添加 `--allow-insecure-http`，或设置 `ABRIDGE_ALLOW_INSECURE_HTTP=true`；该开关允许 HTTP 的 aBridge 对外地址和 OIDC 提供方端点，不关闭 PKCE、state、nonce、签名、issuer 或 audience 校验。仅提供部分配置时拒绝启动。关闭委托但保留 OIDC 时仍可登录管理台、使用手工 Agent Key。

例如保留单点登录并通过公网 IP 访问 aBridge：

```dotenv
ABRIDGE_PUBLIC_ORIGIN=http://bridge.example:8765
ABRIDGE_ALLOW_INSECURE_HTTP=true
```

`public-origin` 会自动允许该地址的 Host 和同源请求，无需再对它重复设置 `allowed-hosts`。提供方须登记同一地址的 `/api/auth/oidc/callback`；提供方的浏览器登录入口也必须能被用户访问。HTTP 下 Cookie 不带 `Secure`，会话、凭据和业务数据未经传输加密；保持 `HttpOnly`、`SameSite` 及其他身份校验。此开关只能由部署管理员配置，登录页无法在启动校验之前切换它。

首次登录时，Server 按 `(issuer, sub)` 创建一个独立账户。用户通过身份提供方登录，可以为自己的设备配置权限。启用委托后，每个外部身份和客户端组合有一个持久的平台连接，初始范围覆盖本账户的全部设备（含新设备）和设备支持的能力。用户可以缩小范围，实际可用能力依然受设备授权、本机开关和就绪状态限制。设置 `ABRIDGE_OIDC_CLIENT_NAME` 可指定显示名称，默认使用 client ID。

平台通过短期令牌访问 MCP。账户可以在 Agent 连接列表中看到已撤销的平台连接。需要重新开放时，点击「重新授权」（`POST /api/agent-connections/:id/reconnect`），确认允许访问本账户全部设备（含新设备）。管理台会创建新连接，之后可以缩小范围。旧连接及其会话保持撤销。升级或再次登录会保留已有连接的自定义策略。

显式启用委托后，先登录管理台建立身份，再用同一 issuer 签发的 RS256 委托 JWT 调用 `POST /mcp`。令牌中的 `sub` 为登录时的主体，`aud` 为 `${ABRIDGE_PUBLIC_ORIGIN}/mcp`，`client_id` 为配置的 OIDC client ID，`purpose` 为 `abridge-delegation`。令牌须带 `iat` 和 `exp`，有效期最长 60 秒。Server 使用提供方 discovery 的 JWKS 验签。通过 MCP 的 `devices_list` 可以查看该连接获准使用的设备。

浏览器会话仍由 aBridge 持有，有效期 12 小时。退出/停用提供方账户不会立即注销已有 aBridge Cookie；平台停用用户后应停止签发委托，已签发令牌最多保留 60 秒。aBridge 本地撤权即时应用于后续操作与已有控制会话，不能回滚已发生副作用。身份提供方不可用时新登录和委托验证可能失败，本地账号与 Agent Key 继续工作。密钥轮换须保留旧验证公钥至少到已签发令牌过期，JWKS 缓存也需要考虑。

更换 issuer 或 sub 前，请先安排新身份下的设备归属。Server 会把新的 `(issuer, sub)` 当作独立账户。数据库和操作记录的存储方式见架构文档。[架构与执行契约](architecture.md)

## 两种设备绑定方式

macOS、Windows 和浏览器扩展支持浏览器授权和 Device Token。浏览器授权通过登录与确认自动领取设备凭证。手动绑定时，在管理台「添加设备」选择对应平台，在「绑定设备」中生成仅显示一次的设备凭证。macOS 和扩展将凭证填在 Device Token 栏，点击「验证并连接」。Windows 在「使用 Device Token」中填写凭证，点击「连接并授权」。Linux CLI 在 `setup` 提示时粘贴 Device Token。Android 在 App 中填写 Device Key 和 Server 地址后绑定。已有设备可在详情设置中重新生成凭证，旧凭证和当前设备连接会立即失效。

设备凭证只用于设备绑定。macOS、Windows、浏览器扩展和 Linux CLI 先调用 `GET /api/device` 验证设备凭证及类型，再提交本地绑定。无效、撤销或类型不匹配的凭证不替换旧绑定。凭证通过私有输入管道或扩展消息传递，不放入命令行、URL 或日志，绑定后保存在原设备凭据存储中，暂停状态保留。

HTTPS 无需额外确认。选择非本机 HTTP 地址时，两种绑定方式都会先显示完整 Origin 并提醒设备凭据、操作内容和截图未经加密；默认取消，确认后只对该 Origin 生效，换地址需重新确认。确认随成功绑定保存，重启/重连不会自动扩大允许范围。扩展仍需单独授予所填 Server 的站点访问权限。此设备连接确认不改变 Server 的 Host/Origin 防护；启用 OIDC 的 Server 使用公网 HTTP 时，管理员还需显式打开 `ABRIDGE_ALLOW_INSECURE_HTTP=true`。旧 Server 需升级后才能使用手动 Token 验证接口。
