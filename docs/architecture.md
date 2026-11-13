# 架构与执行契约

## 组成与职责

aBridge 使用统一 TypeScript 代码实现 Server、桌面运行时、浏览器扩展与管理台，Swift 只负责 macOS 壳与系统权限 UI。Server 和两种客户端分别部署：App 提供桌面、Shell 和文件，扩展提供浏览器，两者不互为运行前提。

```text
MCP 客户端 ─ Agent Key ─ /mcp ──────────┐
管理台（预构建 Preact） ─ /api ────────┤ Fastify Server
                                       │ SQLite + 内存连接/结果缓存
                                       ├─ /ws/device ─ Node 桌面客户端
                                       │                ├ 官方 Cua SDK：screen / input
                                       │                ├ Shell
                                       │                └ UTF-8 文件
                                       └─ /ws/browser ─ TypeScript 浏览器扩展
                                                        └ Profile 自有任务标签
```

可运行产品位于 `apps/`；`packages/` 只包含共享代码。各应用拥有自己的依赖声明、源码与测试，根目录的 npm scripts 协调构建。跨应用共享代码通过 workspace 的具名 exports 引用，生产构建将内部包内联，分发不要求消费者执行 TypeScript 或安装 workspace。

| 模块                                | 职责                                  |
| ----------------------------------- | ------------------------------------- |
| `apps/server/src/cli.ts`            | Server 唯一命令入口                   |
| `apps/server/src/server.ts`         | HTTP、管理认证、MCP 与 WebSocket 组合 |
| `apps/server/src/control.ts`        | 连接、会话和操作状态的唯一所有者      |
| `apps/server/src/store.ts`          | SQLite schema、事务与操作元信息       |
| `apps/server/src/mcp.ts`            | 工具与原生内容编码                    |
| `apps/server/src/transport.ts`      | 有界 WebSocket 发送与关闭             |
| `apps/desktop/src/cli.ts`           | Desktop 唯一命令入口                  |
| `apps/desktop/src/runtime.ts`       | 配置绑定、离线状态与进程生命周期      |
| `apps/desktop/src/local-control.ts` | 本机 Socket、JSON framing 与资源清理  |
| `apps/desktop/src/client.ts`        | 设备连接、执行调度与授权状态          |
| `apps/desktop/src/computer.ts`      | 观察引用及桌面动作契约                |
| `apps/desktop/src/native.ts`        | 官方 SDK 按需同进程适配               |
| `apps/desktop/src/executor.ts`      | 桌面、Shell 和文件执行                |
| `apps/desktop/native/`              | Swift 壳、权限 UI 与原生资源          |
| `apps/browser/`                     | 浏览器设备连接、任务页与 DOM 操作     |
| `apps/web/`                         | Preact 管理台                         |
| `packages/protocol/`                | 共享 schema、能力与协议常量           |
| `packages/shared/`                  | Node 数据目录约定                     |

共享线协议版本为 `abridge/1`。进程边界使用运行时 schema 校验，包内使用 strict TypeScript 和未使用声明检查；类型声明不替代不可信消息的解析。软件版本只从根 `package.json` 读取，扩展 manifest 和分发版本在构建时生成。

Server 使用 Fastify 5 和官方 MCP TypeScript SDK v2。MCP HTTP transport 状态按请求隔离，设备操作会话由 `ControlService` 管理，二者不是同一个生命周期。管理台是预构建 Preact 11 静态产物，正常运行不启动前端开发服务器。

持久化使用 Node 内置 `node:sqlite` 的 `DatabaseSync`，其调用同步占用事件循环。最低运行版本 Node 22.13.0 已取消该模块的启动 flag 要求，但该版本仍将其标为实验 API。当前限制单个数据库由一个 Server 实例持有，内存连接与结果缓存不支持多 worker 或横向部署。[Node 22.13.0 发布说明](https://nodejs.org/en/blog/release/v22.13.0)

## 身份与授权

实例管理员通过独立的 Admin Token 或管理员 Cookie 创建普通用户、查看全局用户及设备统计；第一个用户和后续用户统一由 `/api/admin/users` 创建。管理员不自动拥有普通账户身份，也不能用管理员凭据调用设备或 MCP 接口。Token 默认在数据库旁私有保存，支持 `ABRIDGE_ADMIN_TOKEN` 覆盖；浏览器用 Token 兑换 30 天签名 Cookie，会话与普通用户登录相互独立、跨重启保留，Token 重置使全部旧管理员会话失效。

设备名称可在管理台、Mac App 和浏览器扩展中修改，服务端在连接欢迎消息及心跳确认中同步最新名称。管理台的设备设置只允许改名，设备本机能力由客户端管理并只读展示；首次绑定时确认的能力范围和 Agent 连接策略继续限制访问。新设备 ID 使用 12 位随机 Base64URL 字符，生成时检查重复；已有设备 ID 保持不变，ID 不作为认证凭据。

普通管理账户负责维护自己的设备与 Agent 连接。Device Key 标识设备，Agent Key 标识调用 MCP 的连接，二者不可互换。可选 OIDC 外部登录按 issuer + sub 映射本地普通账户，不保存外部用户密码；启用平台委托后，首次登录建立默认覆盖全部设备（含新设备）的平台连接，能力仍受设备授权、本机开关与就绪状态限制。显式开启委托后，Server 通过提供方公钥验证用途、受众、客户端和最长 60 秒有效期的访问令牌，映射同一个持久平台连接。平台连接没有 Agent Key，撤销不因重新登录恢复；原有本地账户、Agent Key 和设备绑定保持独立。部署和失效约束见[可选 OIDC 登录](deployment.md#可选-oidc-登录与平台-mcp-委托)。

连接具有稳定 ID、名称、设备策略和可选的到期时间；修改策略不更换 Key，轮换 Key 不改变策略。设备类型限制能力上限：`computer` 为 `screen`、`input`、`shell`、`files`，`browser` 仅为 `browser`。

首次绑定采用浏览器确认与一次性授权码（S256 PKCE）。App 或扩展向 Server 发起五分钟有效的授权请求，用户在管理台登录并明确确认账户、设备与申请能力；仅成功兑换时创建设备并签发 Device Key。App 使用随机端口的本机回环回调，扩展使用自身 ID 的 Chromium 授权回调。客户端自动保存凭据并绑定 Server 地址，用户无需手动复制 Key；管理账户会话不传给客户端。

待授权请求只保存在当前 Server 实例的有界内存中，服务重启后重新发起。授权码只能兑换一次，拒绝、取消或过期不会生成设备凭据；批准不扩大既有 Agent 连接策略。App 和扩展重连及重新绑定继续保留本机暂停状态。

连接的设备策略为以下两种之一，类型与解析规则单源位于 `packages/protocol/src/`：

- `selected`：显式列出每台设备及其能力；新增设备不会自动加入。
- `all`：覆盖当前及以后加入的同账户设备，默认能力与设备类型、设备授权取交集；逐设备覆盖可缩小或调整能力，空覆盖表示排除该设备。

管理台提供连接视角的设备预览，展示同账户设备的授权范围、在线状态与可用能力。MCP 的 `devices_list` 只返回该连接获准访问且具有有效能力的设备，并附带非秘密的连接 ID 与名称；它不公开未授权设备或账户设备总数。设备在线不等于每个连接都获准访问。

`session_open` 保留顶层会话字段，并在 `device` 中附带与 `device_get`、`devices_list` 一致的设备详情。渲染端可直接读取 `device.name`、`device.kind`（`computer` 或 `browser`）和 `device.platform`（客户端上报的平台字符串，如 `darwin`、`win32` 或 `Browser extension`），无需再次查询设备。

有效能力取连接对该设备的策略、设备授权、会话请求、本机开关及实际就绪状态的交集。设备列举、执行和保留结果访问复用同一策略判定。每次执行重新核对所有者、密钥、撤销与过期状态、会话、能力和当前连接代次。收紧策略会终止不再满足要求的会话并请求取消在途操作；不会恢复本机暂停，也不能回滚已发生的副作用。桌面输入会话在同一设备上独占，浏览器任务分别持有自建标签页。

连接默认持续有效，直到撤销，亦可设置到期时间。控制会话的闲置租约为 300 秒，获准请求和在途操作续租；设置连接到期时间时，租约不越过该时间。设备连接心跳期限为 30 秒，操作开始期限也是独立的 30 秒。已结束的会话不能续活。

| 错误                          | 含义与恢复                       |
| ----------------------------- | -------------------------------- |
| `session_expired`             | 真正闲置到期；新建会话           |
| `session_stopped`             | 会话已停止；新建会话             |
| `session_connection_lost`     | 设备连接中断；恢复在线后新建会话 |
| `session_connection_replaced` | 当前连接被替换；新建会话         |
| `session_server_restarted`    | Server 重启；新建会话            |
| `device_paused`               | 本机暂停；由操作者在客户端恢复   |

重新连接后必须取得新观察，不能盲目重放结果未知的动作。

## 桌面操作

`computer_apps` 默认返回运行中的应用，`query` 可查找未启动的已安装应用。`computer_open(bundle_id=...)` 核对应用身份后启动或激活一次，返回目标窗口观察，需要 `input` 与 `screen`。应用已启动但观察失败时保留启动结果，不自动再次启动。

`computer_windows` 按应用 PID 列出窗口。带 `pid` 与 `window_id` 的 `computer_observe` 选择该窗口；省略目标时复用会话已选窗口，无目标返回 `target_required`。只有显式 `desktop=true` 才获取整屏图像，并且不能与窗口目标同时指定。空窗口列表不能单独证明权限或 Space 问题。

观察包含有界控件/文本列表、`observation_id` 和可选原生图片，支持 `query` 聚焦。桌面引用最长有效 120 秒，动作后失效。AX 动作固定使用观察中的元素引用；像素动作还需要该观察的截图与坐标，并核对前台目标。目标变化或证据不足时拒绝，不转投其他窗口。

`computer_act` 默认附带 `result.observation`，可直接继续操作。动作执行完成后，先等待 `wait_after_ms` 再进行后续观察或截图：默认 `2000` 毫秒，接受 `0–10000` 的整数，`0` 表示不等待；`observe_after=false` 仅执行动作且不等待。复合观察需要同时具备 `input` 与 `screen`。动作已执行而后观察失败时分别返回动作结果与 `observation_error`，只补观察，不重放动作。

## 浏览器操作

每个扩展安装实例注册为独立设备；Profile 由会话的 `device_id` 确定。`browser_open(url=...)` 仅导航自有任务标签，并固定附带新页面观察，不公开关闭观察的选项。`browser_act` 支持明确的 `click`/`fill`，默认在动作完成后等待 `2000` 毫秒，再附带新观察；外层参数 `wait_after_ms` 可设为 `0–10000` 的整数毫秒，`observe_after=false` 时不等待。`browser_observe` 用于刷新、聚焦查询或检查仍在加载的同一任务页。

导航加载超时保留任务页，返回 `navigation_state=loading`。导航等待与后观察（含 debugger 初始化）共享 15 秒内部预算；后观察遇导航竞态，最多只读重试两次，额外预算不超过 2 秒。不重新打开标签，也不重放点击或填充。该内部预算不等于标签创建、导航提交或 DOM 动作的总执行期限。

动作后的等待计入已有操作与后观察时间预算，不延长超时上限。等待期间暂停、取消或关闭会话仍优先；已执行的动作不会因等待或观察失败而重放。固定等待不保证所有异步任务已完成，页面仍在加载时继续观察同一目标。

浏览器观察文本 JSON 总预算约 7000 字符，不含独立图片；正文优先且上限 4000 字符，再分配交互元素和链接。`query` 聚焦已加载页面中的文本。截断不表示内容不存在，未显示字段也不能用于推断站点全部能力。

浏览器引用最长有效 10 秒，按会话、文档版本和目标绑定，动作与导航后失效。点击使用显式合成 DOM 事件，填充替换字段并触发 `input`/`change`；站点可能拒绝。远程接口不接受任意 JavaScript、原始 CDP 或 Cookie 导出。详细生命周期见 [浏览器客户端](browser-profile-design.md)。

## Shell、文件与结果

`command_execute` 默认等待最多 15 秒，提前完成立即返回输出和退出码；等满则返回同一 `operation_id` 的当前状态，命令继续运行。`timeout` 独立限制实际执行时间，范围为 1–120 秒。`command_status` 默认也最多等 15 秒，显式 `wait_seconds=0` 立即读取。等待结束或 HTTP 调用方断开不会取消或重新派发命令。取消等待确认，尚未确认时返回 `cancel_requested`。

Shell 完整 JSON 默认返回预算 `output_limit_chars=6000`，可设为 1024–12000。`output_truncated` 表示还有保留文本，使用原操作 ID 与 `next_output_offsets` 继续读取；偏移按解码字符计算。`capture_truncated` 表示执行捕获时已丢失内容，分页无法恢复。运行中的滚动窗口可报告 `output_unavailable_before`，最终结果可能仍保留相应前缀。分页只读缓存。

文件工具仅处理 UTF-8 文本与目录列表，遵循当前用户的系统文件权限。读写正文上限为 1 MiB；写入已存在文件需要显式 `overwrite=true`。Shell 与文件能力不提供隔离沙箱。

操作按稳定 `operation_id` 去重，同 ID 改参数会被拒绝。设备保存执行意图和终态，恢复后不自动重放。Server 仅短期缓存返回内容；SQLite 不保存命令、输入、文件正文或截图。服务重启后未完成操作标为结果未知。

图片通过原生 MCP `ImageContent` 返回，不在 JSON 中重复嵌入 base64。原始图片上限为 4 MiB，设备 WebSocket 消息上限为 8 MiB。`executed` 仅表示执行回执，业务结果还需检查退出码、文件内容或后续观察。取消和关闭不能回滚已发生的副作用。

## 运行环境与打包

运行环境按根 `package.json` 的 `engines` 约定：Node.js 22.x 最低 22.13.0，23.x 最低 23.4.0，支持 24 及以上主版本。23.0–23.3 的 SQLite 仍需实验启动参数，故不在支持范围内。Server 分发不携带桌面原生 SDK；桌面运行时按需动态加载官方 `@trycua/cua-driver@0.47.8`，通过显式构造入口并核对 embedded 模式与空 socket 路径，避免意外转为独立 daemon。当前 Swift App 目标为 Apple Silicon/macOS 14+。

App 安装器复制固定 Node、构建后的 CLI 和所需依赖到当前用户的稳定私有目录，Swift 壳只引用该目录的 Node 与 CLI 路径，不指向 npm 临时执行缓存。Node 负责设备连接和执行，Swift 负责权限 UI 与接管监视。原生代码或签名变化可能影响系统权限，构建和协议测试不能证明实际已安装 App 的截图或输入可用。

桌面接管保护只覆盖在途输入，读取和普通鼠标移动不触发暂停。手动暂停持久保存，远程请求不能解除。依赖及许可见 [第三方说明](third-party-notices.md)。

安装、更新与维护见 [部署说明](deployment.md)，开发和验证要求见 [贡献指南](../.github/CONTRIBUTING.md)，安全限制见 [SECURITY.md](../.github/SECURITY.md)。
