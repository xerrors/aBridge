# aBridge Server

MCP 与设备连接网关，包含预构建的管理台。需要 Node.js 26.7.0–26.x 与 npm；运行时不需要编译 TypeScript 或启动前端开发服务器。

这是本地分发候选，`@abridge/server` 尚未公开发布到 npm。使用实际生成的 tarball 路径运行：

```sh
npm exec --package /absolute/path/to/server.tgz -- abridge --web
```

安装到自己的 npm 环境后，入口命令为 `abridge`。下文以该入口展示；通过本地 tarball 运行时，沿用开头的 `npm exec --package … --` 前缀。此包只包含 Server，不含桌面运行时或 Cua SDK，不提供 `client` 子命令。App 和浏览器扩展独立安装。

## 首次配置

默认命令启动 Server，监听 `127.0.0.1:8765`。`--web` 打开已构建的管理台；Server 绑定回环地址且数据库为空时，通过一次性 URL fragment 提供首次账户配置。令牌有效10分钟，账户创建后入口失效。浏览器打开失败时，服务仍可运行。

在无图形环境或非回环监听下，先使用标准输入创建管理账户：

```sh
abridge user create --stdin --data-dir /absolute/path/to/state
```

输入为含 `username`、`password` 的 JSON 对象，密码至少12字符。凭据通过标准输入提供，不作为命令参数。随后使用相同数据目录启动：

```sh
abridge --data-dir /absolute/path/to/state
```

## 配置

| 选项                | 含义                                    |
| ------------------- | --------------------------------------- |
| `--web`             | 打开管理台，不启动开发服务器            |
| `--host`            | 监听地址，默认 `127.0.0.1`              |
| `--port`            | 监听端口，默认 `8765`；`0` 使用临时端口 |
| `--data-dir`        | 持久状态目录                            |
| `--db`              | 显式 SQLite 路径                        |
| `--public-origin`   | 反向代理的外部 Origin                   |
| `--allowed-hosts`   | 额外 Host 白名单，逗号分隔              |
| `--allowed-origins` | 额外 MCP Origin 白名单，逗号分隔        |
| `--version`         | 输出软件版本                            |
| `--help`            | 完整用法                                |

默认状态目录：macOS 为 `~/Library/Application Support/aBridge`，Linux 为 `$XDG_DATA_HOME/abridge` 或 `~/.local/share/abridge`，Windows 为 `%LOCALAPPDATA%/aBridge`。数据库位于该目录的 `server/server.db`，不会放入 npm 临时执行缓存。

对应环境变量为 `ABRIDGE_HOST`、`ABRIDGE_PORT`、`ABRIDGE_DB`、`ABRIDGE_PUBLIC_ORIGIN`、`ABRIDGE_ALLOWED_HOSTS`、`ABRIDGE_ALLOWED_ORIGINS`。同名 CLI 选项优先。

## 远程访问

跨机器连接使用 HTTPS/WSS 反向代理，或通过 SSH 隧道访问回环服务。反向代理显式配置外部 Origin：

```sh
abridge --data-dir /absolute/path/to/state \
  --public-origin https://bridge.example.com
```

Origin 必须是纯 `scheme://host[:port]`，没有路径、查询、fragment 或结尾斜杠。它用于管理台同源校验和安全 Cookie。代理需要支持 WebSocket，保留 Host 并转发认证头。

额外白名单按需要显式设置，例如 `--allowed-hosts bridge.example.com:8443`、`--allowed-origins https://mcp-client.example.com`。Host 不含协议，Origin 包含协议；额外 Origin 不放宽管理 API 的同源要求。

## MCP 与设备

在管理台添加设备，再创建只包含所需设备、能力和期限的 Agent Key。MCP 客户端使用 Streamable HTTP 地址与 Bearer 认证：

```json
{
  "url": "http://127.0.0.1:8765/mcp",
  "headers": { "Authorization": "Bearer <AGENT_KEY>" }
}
```

Device Key 用于设备连接，Agent Key 用于 MCP 调用，两者不能互换。电脑与浏览器是独立设备，扩展只提供 `browser`；桌面 App 提供屏幕、键鼠、Shell 与文件。任务按设备 ID 建立会话，完成后关闭会话；暂停只能由本机操作者恢复。

## 数据与进程

每个数据库仅运行一个 Server 实例。设备连接和结果缓存在内存中，不支持多 worker 或横向扩展。Node 内置 `node:sqlite` 的 `DatabaseSync` 是同步接口；最低支持版本 Node 26.7.0 的官方文档将该模块标为 Release Candidate，运行时升级时须重新核对 API 状态。

Server 重启后，客户端需要重新连接并创建任务会话，未知动作不自动重放。数据库只保存身份、授权和操作元信息；命令输出、文件正文与截图不写入数据库，临时返回内容仍可能敏感。

备份使用 SQLite 备份接口，或先停止服务后保留数据库及 WAL。开发数据库需匹配当前 schema，不提供历史数据迁移。包的第三方组件说明位于随包的 `THIRD_PARTY_NOTICES.md`；这些组件许可不代替 aBridge 自身的分发授权。
