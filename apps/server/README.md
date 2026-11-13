# aBridge Server

MCP 与设备连接网关，包含预构建的管理台。需要 Node.js 22.13.0+ 与 npm；运行时不需要编译 TypeScript 或启动前端开发服务器。

公开 npm 包名为 `@xerrors/abridge`。发布完成后可使用 `npx @xerrors/abridge --web`；本地分发候选使用实际生成的 tarball 路径运行：

```sh
npm exec --package /absolute/path/to/server.tgz -- abridge --web
```

安装到自己的 npm 环境后，入口命令为 `abridge`。下文以该入口展示；通过本地 tarball 运行时，沿用开头的 `npm exec --package … --` 前缀。此包只包含 Server，不含桌面运行时或 Cua SDK，不提供 `client` 子命令。App 和浏览器扩展独立安装。

## 首次配置

默认命令启动 Server，监听 `127.0.0.1:8765`，终端输出带 `#admin_token=…` 的实例管理链接；`--web` 自动打开该链接。首次启动自动生成并私有保存管理员 Token，之后重启复用；`ABRIDGE_ADMIN_TOKEN` 可覆盖，要求 32–512 个不含空白的可打印 ASCII 字符。

打开链接后，浏览器清除地址栏 Token，通过 API 建立 30 天管理员 Cookie 会话。之后访问同一地址自动恢复管理员身份。实例管理员不需要普通账户；在“实例管理”面板创建用户、查看用户和设备统计。普通用户登录自己的账户后绑定设备、管理 Agent 连接。

Token 保存在数据库旁的 `<数据库文件>.admin-token`（权限 `600`）。`abridge --reset-admin-token` 重置自动生成的 Token 并启动服务，旧 Token 和全部旧管理员会话立即对新实例失效。环境变量 Token 通过修改变量并重启更换。退出管理员清除当前浏览器 Cookie，不影响普通用户登录。

## 管理员 API

外部程序使用 `Authorization: Bearer <ADMIN_TOKEN>`，管理台使用独立的管理员 Cookie。普通账户、Device Key 和 Agent Key 均不能调用这些接口。管理员身份只授予全局统计与创建用户权限，不代替普通账户或设备授权。

| 方法     | 路径                  | 作用                                                 |
| -------- | --------------------- | ---------------------------------------------------- |
| `POST`   | `/api/admin/session`  | 使用 Bearer Token 和 `{}` 请求体建立浏览器管理员会话 |
| `GET`    | `/api/admin/session`  | 验证管理员身份，返回 `{"admin":true}`                |
| `DELETE` | `/api/admin/session`  | 清除当前浏览器的管理员 Cookie                        |
| `POST`   | `/api/admin/users`    | 创建普通用户，成功返回 `201` 和 `{id,username}`      |
| `GET`    | `/api/admin/overview` | 返回全局统计、用户列表和各用户的设备                 |

创建用户：

```sh
curl http://127.0.0.1:8765/api/admin/users \
  -H "Authorization: Bearer ${ABRIDGE_ADMIN_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-binary @/absolute/path/to/user.json
```

`user.json` 内容为 `{"username":"alice","password":"<至少12字符的实际密码>"}`，应作为私有文件提供。自动生成 Token 时，外部调用也可从私有 Token 文件读取到调用程序的凭据配置。用户名去除两端空白并转为小写，长度 1–80；密码长度 12–1024。账户重复返回 `409`，字段不合法返回 `422`，缺失或无效管理员身份返回 `401`，请求过频返回 `429`。创建用户不切换或创建普通账户登录会话。第一个用户与后续用户使用同一接口，不提供 CLI 创建或公开注册。

统计返回 `totals`（`users`、`devices`、`online_devices`、`computers`、`browsers`）及 `users` 数组。每个用户包含 `id`、`username`、`created_at`、`computer_count`、`browser_count`、`online_count` 和 `devices`；设备包含 `id`、`name`、`kind`、`status`、`paused`、`last_seen`、`created_at`。时间为 Unix 秒，未连接设备的 `last_seen` 为 `null`。电脑与浏览器扩展分别计为独立设备，已解绑设备不计入；在线状态使用实时连接和心跳判定，暂停的在线设备仍计为在线。接口不返回密码、密钥或设备操作内容。

## 配置

| 选项                  | 含义                                    |
| --------------------- | --------------------------------------- |
| `--web`               | 打开实例管理员链接                      |
| `--reset-admin-token` | 重置自动生成的管理员 Token 并启动       |
| `--host`              | 监听地址，默认 `127.0.0.1`              |
| `--port`              | 监听端口，默认 `8765`；`0` 使用临时端口 |
| `--data-dir`          | 持久状态目录                            |
| `--db`                | 显式 SQLite 路径                        |
| `--public-origin`     | 反向代理的外部 Origin                   |
| `--allowed-hosts`     | 额外 Host 白名单，逗号分隔              |
| `--allowed-origins`   | 额外 MCP Origin 白名单，逗号分隔        |
| `--version`           | 输出软件版本                            |
| `--help`              | 完整用法                                |

默认状态目录：macOS 为 `~/Library/Application Support/aBridge`，Linux 为 `$XDG_DATA_HOME/abridge` 或 `~/.local/share/abridge`，Windows 为 `%LOCALAPPDATA%/aBridge`。数据库位于该目录的 `server/server.db`，不会放入 npm 临时执行缓存。

对应环境变量为 `ABRIDGE_HOST`、`ABRIDGE_PORT`、`ABRIDGE_DB`、`ABRIDGE_PUBLIC_ORIGIN`、`ABRIDGE_ALLOWED_HOSTS`、`ABRIDGE_ALLOWED_ORIGINS`、`ABRIDGE_ADMIN_TOKEN`。提供同名 CLI 选项的配置以 CLI 为先。

## 远程访问

跨机器连接使用 HTTPS/WSS 反向代理，或通过 SSH 隧道访问回环服务。反向代理显式配置外部 Origin：

```sh
abridge --data-dir /absolute/path/to/state \
  --public-origin https://bridge.example.com
```

Origin 必须是纯 `scheme://host[:port]`，没有路径、查询、fragment 或结尾斜杠。它用于管理台同源校验和安全 Cookie。代理需要支持 WebSocket，保留 Host 并转发认证头。

额外白名单按需要显式设置，例如 `--allowed-hosts bridge.example.com:8443`、`--allowed-origins https://mcp-client.example.com`。Host 不含协议，Origin 包含协议；额外 Origin 不放宽管理 API 的同源要求。

## MCP 与设备

在管理台添加设备，再创建 Agent 连接：选择指定设备或全部设备（含以后新增设备），按设备配置能力；默认持续有效，也可指定到期日期。连接策略可编辑且不更换 Agent Key，密钥轮换单独操作。管理台提供连接视角的设备预览。MCP 客户端使用 Streamable HTTP 地址与 Bearer 认证：

```json
{
  "url": "http://127.0.0.1:8765/mcp",
  "headers": { "Authorization": "Bearer <AGENT_KEY>" }
}
```

Device Key 用于设备连接，Agent Key 用于 MCP 调用，两者不能互换。电脑与浏览器是独立设备，扩展只提供 `browser`；桌面 App 提供屏幕、键鼠、Shell 与文件。任务按设备 ID 建立会话，完成后关闭会话；暂停只能由本机操作者恢复。

## 设备信息

管理账户通过 `PATCH /api/devices/:id` 修改自己的设备名称，请求只接受 `{ "name": "设备名称" }`。客户端通过 `PATCH /api/device` 和自身 Device Key 修改当前设备名称；不能指定其他设备。名称在欢迎消息和心跳中同步。设备本机能力由客户端管理，管理台只读展示；Agent 连接的访问策略仍在管理台维护。新建设备 ID 为 12 位随机字符，既有 ID 不变。

## 数据与进程

每个数据库仅运行一个 Server 实例。设备连接和结果缓存在内存中，不支持多 worker 或横向扩展。Node 内置 `node:sqlite` 的 `DatabaseSync` 是同步接口，在最低支持版本 Node 22.13.0 中仍为实验 API，但无需实验启动参数；运行时升级时须重新核对 API 状态。

Server 重启后，客户端需要重新连接并创建任务会话，未知动作不自动重放。数据库只保存身份、授权和操作元信息；命令输出、文件正文与截图不写入数据库，临时返回内容仍可能敏感。

备份使用 SQLite 备份接口，或先停止服务后保留数据库及 WAL。开发数据库需匹配当前 schema，不提供历史数据迁移。包的第三方组件说明位于随包的 `THIRD_PARTY_NOTICES.md`；aBridge 自身使用 Apache-2.0 许可证。
