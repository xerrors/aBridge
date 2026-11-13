# 安装与维护

## 环境与分发

当前为 0.4 开发候选。运行环境支持 Node 22.x（最低 22.13.0）、23.x（最低 23.4.0）及 24 以上版本；源码构建需要 npm。两个最低补丁版本均来自内置 `node:sqlite` 取消实验启动参数的版本，22.0–22.12 和 23.0–23.3 不在支持范围内。[Node 22 官方说明](https://nodejs.org/en/blog/release/v22.13.0) · [Node 23 官方说明](https://nodejs.org/en/blog/release/v23.4.0) macOS App 目标为 Apple Silicon、macOS 14+，原生编译另需 Xcode Command Line Tools。Server 不需要桌面 SDK、Chrome 或图形环境。

Server、管理台和扩展从同一套 TypeScript 源码构建。用户运行预构建 JavaScript，管理台作为静态资源随 Server 提供，不启动 Vite 等开发服务器。候选 npm 包尚未公开发布，不能把示例包名当作已可执行的公共 `npx` 入口。

## 从源码运行 Server

```sh
npm ci
npm run build
npm start -- --web
```

`abridge` 默认等同于 `abridge serve`。每次启动只输出普通地址；`--web` 在本机浏览器打开带管理员 Token 的管理链接，终端不输出凭据。首次启动自动生成实例管理员 Token，保存在数据库旁的 `<数据库文件>.admin-token`，文件权限为 `600`，之后重启复用。也可用 `ABRIDGE_ADMIN_TOKEN` 覆盖，值须为 32–512 个不含空白的可打印 ASCII 字符；环境变量覆盖不会改写已保存的 Token。

打开管理链接后，前端立即清除 URL fragment 中的 Token，再通过 API 兑换有效期 30 天的 `HttpOnly`、`SameSite=Strict` Cookie；HTTPS 使用 `Secure`。管理员会话跨 Server 重启保留，在同一浏览器、同一 Origin 下再次访问普通地址即可恢复。退出管理员清除浏览器会话；重置 Token 会使旧 Token 和全部旧管理员会话失效。自动生成的 Token 使用以下命令重置并启动：

```sh
node dist/server/cli.js --reset-admin-token
```

环境变量配置的 Token 通过修改变量并重启更换。管理链接包含实例管理员凭据，不写入终端或请求日志；也可通过已配置的管理员 Token 登录。普通用户使用不带 fragment 的地址。

实例管理员独立于普通账户，进入“实例管理”即可创建用户、查看用户及其设备统计，不需要先登录普通账户。第一个用户和后续用户统一由管理员 API 创建，不提供 CLI 创建用户或公开注册入口。普通账户登录后维护自己的设备与 Agent 连接，管理员凭据不授予设备操作权限。完整接口与外部调用示例见 [Server API](../apps/server/README.md#管理员-api)。

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

跨机器连接使用 HTTPS/WSS 反向代理，或经 SSH 隧道访问回环服务。默认 Host/Origin 防护保留；反向代理明确配置外部 Origin：

```sh
node dist/server/cli.js --data-dir /absolute/path/to/state \
  --public-origin https://bridge.example.com
```

Origin 必须是纯 `scheme://host[:port]`，不带路径、凭据、查询、fragment 或结尾斜杠。它也决定管理台同源检查和安全 Cookie，不依赖未受信任的转发头推断。

仅在需要额外地址时使用 `--allowed-hosts bridge.example.com:8443` 或 `--allowed-origins https://mcp-client.example.com`。Origin 带协议，Host 不带协议；额外 Origin 不放宽管理 API 同源要求。代理须支持 WebSocket，并转发需要的 Host 与认证头。回环 HTTP 不直接作为公网入口。

也可由操作者使用已有 SSH 连接转发端口：

```sh
ssh -N -L 127.0.0.1:8765:127.0.0.1:8765 bridge-host
```

客户端必须能访问配置中的 Server URL。Mac 上的回环地址不等于服务器或容器内的回环地址。

## 本地 Server 分发包

构建输出按产品收拢：`dist/server/cli.js` 与同目录 `web/`、`dist/desktop/cli.js`、`dist/browser/`。Server 和 Desktop 使用各自入口，没有混合分发 CLI。

运行分发工具，在 `dist/releases/` 生成 Server tarball 与扩展 ZIP，并检查分发边界：

```sh
npm run package
npm run package:check
```

分发构建只包含 Server 所需的预构建 CLI、管理台和依赖声明，剥离桌面 SDK。版本由根 `package.json` 生成。使用构建工具生成的本地 tarball 验证安装，再决定是否发布到 npm。

`npm exec --package <本地tgz路径> -- abridge --web` 的 package 参数必须指向实际生成的文件，不能替换为尚未发布的候选包名。npx/npm exec 的临时包目录仅用于运行程序；数据库仍由 `--data-dir` 或 `--db` 指向持久位置。

## macOS App

在完整源码目录安装：

```sh
npm ci
npm run build
npm run desktop:install
open "$HOME/Applications/aBridge.app"
```

安装器获取并校验固定的官方 Node 可搬移发行物，再把 Node、已构建桌面 CLI 和锁文件对应的桌面依赖闭包复制到当前用户的独立运行目录，并保留 Node 发行许可证。Swift 壳引用该目录的 Node 与 CLI，不依赖原源码目录或 npm 临时缓存。自定义 Node 路径也必须通过版本、平台、可搬移链接与许可证检查。官方 `@trycua/cua-driver@0.47.8` 只在桌面运行时按需加载，Server 分发不包含它。

| 内容                 | 默认位置                                                        |
| -------------------- | --------------------------------------------------------------- |
| App                  | `~/Applications/aBridge.app`                                    |
| 运行时               | `~/Library/Application Support/aBridge/runtime/`                |
| 设备凭据             | `~/Library/Application Support/aBridge/credentials/device.json` |
| 配置、暂停与操作日志 | `~/Library/Application Support/aBridge/`                        |
| 客户端日志           | `~/Library/Application Support/aBridge/logs/client.log`         |

原生构建比较 Swift、资源、运行时路径和签名配置的指纹，未变化时复用已验证的 App。底层构建入口接受明确的 Node 与 CLI 路径：

```sh
node --import tsx tools/build-native.ts \
  --output /absolute/path/to/aBridge.app \
  --node /absolute/path/to/node \
  --cli /absolute/path/to/cli.js
```

使用 `--signing-identity` 或 `ABRIDGE_SIGNING_IDENTITY` 指定本机已有证书；默认 ad hoc 签名。原生代码或签名变化后，macOS 可能要求重新授予屏幕录制或辅助功能权限。项目不提供公证自动更新渠道，候选构建成功不能代表真实安装和系统权限验收已通过。

### 绑定与控制

1. 在 App 填写 Server 地址，点击“在浏览器授权”。
2. 在打开的浏览器中登录管理台，核对账户、设备与能力并确认授权；App 自动保存设备凭据并连接，再开启需要的本机能力。
3. 为实际安装的 App 授予所需系统权限。仅 Shell/文件操作不需要桌面权限。
4. 创建 Agent 连接，选择指定设备或全部设备（包含以后新增设备），按设备设置能力；默认持续有效，也可指定到期日期。将生成的 Agent Key 配入 MCP 客户端。

连接范围、能力和期限可以编辑，修改策略不更换现有 Key。密钥轮换是单独操作，旧 Key 立即失效。连接预览显示已授权设备数量和每台设备的实际可用状态；设备在线不代表已加入该连接。

菜单与设置提供暂停/恢复、停止、能力开关、重连、环境检查和日志。恢复只能由本机操作者执行；重连不解除暂停。环境检查只刷新 Node、驱动与权限状态，不自动下载依赖或重置授权。运行文件缺失时，退出 App 后从完整源码目录重新安装。

可使用已安装运行时的 CLI 读取状态，或从构建目录诊断：

```sh
node dist/desktop/cli.js status
node dist/desktop/cli.js diagnose
```

自定义状态目录使用 `--state-dir`，日志相应位于 `<state-dir>/logs/client.log`。终端诊断的权限责任链不等于 App 的责任链；实际窗口截图和输入需在 App 环境中用自有目标核对。

## 浏览器扩展

```sh
npm run build
```

在 `chrome://extensions` 开启开发者模式，加载 `dist/browser/`，不能直接加载 `apps/browser/src/`。独立分发使用构建工具生成的扩展 ZIP，解压后加载；版本由根项目版本生成。

点击扩展图标，在弹窗中填写 Server 地址和设备名，点击“在浏览器授权”，登录管理台并确认绑定当前 Profile。远端 Server 使用 HTTPS/WSS，本机开发允许回环 HTTP/WS。绑定时只需允许扩展访问所填 Server 地址。

每个扩展安装实例注册为独立浏览器设备，仅有 `browser` 能力；在管理台加入所需 Agent 连接。任务无需在 App 中选择窗口或准备浏览器连接。更新构建文件后在扩展管理页“重新加载”，再确认连接状态；绑定与暂停保留。更多约束见 [浏览器客户端](browser-profile-design.md)。

## 数据与更新

每个数据库只启动一个 Server 实例；实例锁防止同一路径被第二个服务同时持有。Server 重启会断开内存连接，设备重连后新建任务会话，不恢复未知在途动作。

备份使用 SQLite 备份接口，或先停止服务再保留数据库及 WAL；不要只复制运行中的主数据库。凭据、日志和备份须限制访问。开发数据库必须匹配当前 schema，结构冲突直接调整开发数据，不提供兼容迁移脚本。

更新前结束活动任务，保留需要的状态与备份。源码、候选分发包、实际安装和真实业务验证是不同范围，交付时分别说明。

## 发布与便携 App

tag 驱动的 npm、Chrome ZIP 和 macOS 分发流程见[发布说明](releasing.md)。`npm run package:macos` 生成内置 Node 的便携 App ZIP；未配置 Developer ID 时文件名明确标注 unsigned，不能将其视为已公证版本。

## 可选 OIDC 登录与平台 MCP 委托

未配置时继续使用本地账户与 Agent Key。接入支持 discovery、Authorization Code + S256 PKCE、RS256 ID Token 的身份提供方：

```dotenv
ABRIDGE_PUBLIC_ORIGIN=https://bridge.example.com
ABRIDGE_OIDC_ISSUER_URL=https://yuxi.example.com/api/auth/provider
ABRIDGE_OIDC_CLIENT_ID=abridge
ABRIDGE_OIDC_CLIENT_SECRET=<在提供方登记的客户端秘密>
ABRIDGE_DELEGATION_ENABLED=true
# 可选：仅限可信私有网络，容器内访问提供方的地址
ABRIDGE_OIDC_BACKCHANNEL_ORIGIN=http://api:5050
```

公开 issuer 在容器内部不能直接访问时，可显式配置 `ABRIDGE_OIDC_BACKCHANNEL_ORIGIN` 为内部 HTTP(S) 纯 Origin，不含路径、结尾斜杠、凭据、查询或 fragment。只有与 issuer 相同 Origin 的服务端认证请求（discovery、token、JWKS）会改用该地址，保留原有路径和查询；浏览器链接、issuer 和令牌校验不变。不跟随重定向，不将其他域名自动映射为内部地址；未配置时保持正常公开访问。HTTP backchannel 会承载客户端秘密和令牌，仅可用于可信私有网络，不能替代公开 HTTPS。

必须在提供方登记固定回调 `https://bridge.example.com/api/auth/oidc/callback`，客户端认证方式为 `client_secret_post`。登录入口 `GET /api/auth/oidc/login`，可用 `return_to=/?authorize=<id>` 保留现有设备绑定确认流程，仅接受本地限定入口；发现状态 `GET /api/auth/oidc/config`；请求 scope 为 `openid profile`，显示名使用可选的 `name`。提供方 issuer 必须精确匹配 discovery。非回环端点必须使用 HTTPS；生产公开地址必须配置 HTTPS。仅提供部分配置时拒绝启动。关闭委托但保留 OIDC 时仍可登录管理台、使用手工 Agent Key。

首次登录按 `(issuer, sub)` 创建没有本地密码的普通账户，不匹配用户名或邮箱，不接管已有账户。启用平台委托后，每个外部身份和客户端拥有一个持久“平台连接”，初始设备范围为空；用户在 Agent 连接中编辑设备与能力后平台才有设备权限。该连接无 Agent Key、不支持密钥轮换；撤销后再次登录也不恢复授权。用户可在已撤销连接中显式点击“重新授权”（`POST /api/client-grants/:id/reconnect`），创建一个设备范围为空的新平台连接，再重新选择设备和能力。旧授权与会话保持撤销，重复点击旧记录不能重建授权，其他用户和手工 Key 连接不能使用此入口。

显式启用委托时，`POST /mcp` 接受同一 issuer 签发的 RS256 JWT：`sub` 为登录时的稳定主体、`aud` 精确为 `${ABRIDGE_PUBLIC_ORIGIN}/mcp`、`client_id` 为配置的 OIDC client ID、`purpose` 为 `abridge-delegation`，必须包含 `iat`、`exp`，最长 60 秒。公钥来自提供方 discovery 的 JWKS，浏览器 ID Token 不具备这些访问声明，不可用于 MCP。委托只解析已经登录建立的身份；不能通过 MCP 自动开户。个人设备列表通过 MCP `devices_list` 读取，无需为 HTTP 管理 API增加 Bearer 登录方式。

浏览器会话仍由 aBridge 持有，有效期 12 小时。退出/停用提供方账户不会立即注销已有 aBridge Cookie；平台停用用户后应停止签发委托，已签发令牌最多保留 60 秒。aBridge 本地撤权即时应用于后续操作与已有控制会话，不能回滚已发生副作用。身份提供方不可用时新登录和委托验证可能失败，本地账号与 Agent Key 继续工作。密钥轮换须保留旧验证公钥至少到已签发令牌过期，JWKS 缓存也需要考虑。

数据库开发 schema 为 3。历史开发数据库不能直接打开；请备份并在隔离副本中明确转换或重新初始化，禁止用现有服务的数据目录试运行。更换 issuer 或 sub 会建立新身份，必须事先安排设备归属恢复，不能靠显示名自动合并。
