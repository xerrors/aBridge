# 架构与执行契约

## 组成与职责

Server、浏览器扩展和管理台使用 strict TypeScript；macOS 客户端使用 Swift 原生实现，AppKit UI 与 Swift 6 运行时通过私有 Unix socket 通信；Linux CLI 使用 Rust，Android App 使用 Kotlin。Server 与各客户端分别部署：Mac 提供桌面、Shell 和文件，Linux CLI 提供 Shell 和文件，Android App 提供屏幕、输入和授权目录读写，扩展提供浏览器。

```text
MCP 客户端 ─ Agent Key ─ /mcp ──────────┐
管理台（预构建 Preact） ─ /api ────────┤ Fastify Server
                                       │ SQLite + 内存连接/结果缓存
                                       ├─ /ws/device ─ Swift 原生客户端
                                       │                ├ 官方 Cua SDK：screen / input
                                       │                ├ Shell
                                       │                └ UTF-8 文件
                                       ├─ /ws/device ─ Rust Linux CLI：Shell / UTF-8 文件
                                       ├─ /ws/device ─ Kotlin Android 客户端
                                       │                ├ 无障碍观察与触摸输入
                                       │                └ 系统选择器授权的 UTF-8 文件
                                       └─ /ws/browser ─ TypeScript 浏览器扩展
                                                        └ Profile 自有任务标签
```

可运行产品位于 `apps/`；`packages/` 只包含共享代码。各应用拥有自己的依赖声明、源码与测试，根目录的 npm scripts 协调构建。跨应用共享代码通过 workspace 的具名 exports 引用，生产构建将内部包内联，分发不要求消费者执行 TypeScript 或安装 workspace。

| 模块                                             | 职责                                  |
| ------------------------------------------------ | ------------------------------------- |
| `apps/server/src/cli.ts`                         | Server 唯一命令入口                   |
| `apps/server/src/server.ts`                      | HTTP、管理认证、MCP 与 WebSocket 组合 |
| `apps/server/src/control.ts`                     | 连接、会话和操作状态的唯一所有者      |
| `apps/server/src/store.ts`                       | SQLite schema、事务与操作元信息       |
| `apps/server/src/browser-execution.ts`           | 浏览器脚本独占、步骤进度与取消协调    |
| `apps/server/src/mcp.ts`                         | 工具与原生内容编码                    |
| `apps/server/src/transport.ts`                   | 有界 WebSocket 发送与关闭             |
| `apps/desktop/native/runtime/Main.swift`         | Desktop 唯一命令入口                  |
| `apps/desktop/native/runtime/Storage.swift`      | 配置绑定、离线状态与进程生命周期      |
| `apps/desktop/native/runtime/LocalControl.swift` | 本机 Socket、JSON framing 与资源清理  |
| `apps/desktop/native/runtime/Client.swift`       | 设备连接、执行调度与授权状态          |
| `apps/desktop/native/runtime/Computer.swift`     | 观察引用及桌面动作契约                |
| `apps/desktop/native/runtime/NativeDriver.swift` | 官方 SDK 按需同进程适配               |
| `apps/desktop/native/runtime/Executor.swift`     | 桌面、Shell 和文件执行                |
| `apps/desktop/native/`                           | AppKit UI、权限入口与原生运行时       |
| `apps/browser/src/worker.ts`                     | 扩展入口，创建并启动设备客户端        |
| `apps/browser/src/client.ts`                     | 设备绑定、连接、操作日志与本机控制    |
| `apps/browser/src/task-tabs.ts`                  | 自有任务标签、调试器与资源清理        |
| `apps/browser/src/bridge.ts`                     | 浏览器工具编排、观察、读取与输入      |
| `apps/web/`                                      | Preact 管理台                         |
| `packages/protocol/`                             | 共享 schema、能力与协议常量           |
| `packages/shared/`                               | Node 数据目录约定                     |

源码中的领域名统一为 `AgentConnection`（Agent 的持久授权连接）、`DeviceConnection`（设备当前传输连接）、`ControlSession`（控制会话）和 `Operation`（一次操作）。管理接口使用 `/api/agent-connections`，列表字段为 `connections`，操作及会话通过 `agent_connection_id` 引用授权连接；设备派发中的 `device_credential_version` 表示 Device Key 版本，不表示 Agent 连接策略版本。`operation_status` 与 `operation_cancel` 面向所有操作，包括 Shell 和浏览器代码。

工具参数由协议包的 `toolArgumentSchemas` 定义，`DeviceToolRequest` 关联工具名与参数类型。MCP 使用同一字段定义，Server 和执行端在各自输入边界解析；默认值、范围及跨字段约束保持单源。执行时仍独立核对授权、取消、连接代次、观察引用和当前目标。管理 API 的公共视图及输入契约位于 `packages/protocol/src/management.ts`，Server 构造与 Web 解析共用类型；数据库实体及本地界面状态不是公共视图。

共享线协议版本为 `abridge/1`。进程边界使用运行时 schema 校验，TypeScript 包使用严格类型与未使用声明检查，原生运行时使用 Swift 6 严格并发检查；类型声明不替代不可信消息的解析。软件版本只从根 `package.json` 读取，扩展 manifest 和分发版本在构建时生成。原生客户端使用协议包生成的 `desktop-contract.json` 校验消息、参数与默认值；跨字段约束由共享可移植规则表达，回归测试对照 Zod 和 Swift 的接受结果与规范化值。

Server 使用 Fastify 5 和官方 MCP TypeScript SDK v2。MCP HTTP transport 状态按请求隔离，设备操作会话由 `ControlService` 管理，二者不是同一个生命周期。管理台是预构建 Preact 11 静态产物，正常运行不启动前端开发服务器。

管理台源码按职责收拢在 `apps/web/src/`：`app/` 负责入口、导航、工作区布局与跨功能弹窗编排，`components/` 提供公共控件，`features/` 按 auth、overview、devices、connections、activity、admin 放置页面及相关逻辑，`lib/` 放置请求、公共类型与展示标签。页面不作为其他模块的公共类型出口；连接权限计算集中在 connections 的 policy 模块。表单与弹窗共享提交状态，保留在同一组件文件中。

样式通过 `src/styles/index.css` 有序汇入基础、公共控件、布局和各功能样式，构建后仍输出单个 `/static/app.css`；`public/` 只维护 HTML、字体与图片等静态资产。

持久化使用 Node 内置 `node:sqlite` 的 `DatabaseSync`，其调用同步占用事件循环。最低运行版本 Node 22.13.0 已取消该模块的启动 flag 要求，但该版本仍将其标为实验 API。当前开发数据库为 schema 6，Agent 连接使用 `agent_connections` / `platform_connections` 表，以及 `agent_connection_id` 引用字段；旧开发数据库须显式调整为当前结构，Server 不自动迁移或清空。当前限制单个数据库由一个 Server 实例持有，内存连接与结果缓存不支持多 worker 或横向部署。[Node 22.13.0 发布说明](https://nodejs.org/en/blog/release/v22.13.0)

## Linux CLI 客户端

`apps/linux-client/` 使用 Rust 实现独立的 `abridge-client`，仅提供 `shell` 和 `files`，以 `computer` / `linux` 身份直接连接 `/ws/device`。它不依赖 Node、图形环境或桌面 SDK。CLI 和后台服务使用同一个二进制，后台生命周期由用户级 systemd 管理；非 systemd 环境可以使用前台 `run`。

`main.rs` 负责命令解析和 Device Token 绑定，`runtime.rs` 是连接代次、操作调度及本机策略的唯一所有者，`executor.rs` 执行 Shell/文件，`storage.rs` 维护私有绑定与操作日志，`service.rs` 管理用户服务。运行时先取得独占锁再读取绑定，配置与凭据作为同一份 0600 文件原子提交；本机控制通过同用户私有 Socket 进行。新绑定须先验证 Server 的设备身份，并要求停止原运行时。

Linux 构建消费 `@abridge/protocol/desktop-contract` 导出的能力、常量、JSON Schema 和 portable 约束；版本也由该契约从根 `package.json` 生成。Rust 解释器应用共享默认值、字段范围、未知字段策略和跨字段约束，对不支持的新规则拒绝启动并使契约检查失败。跨语言测试对照 Zod 的解析结果，避免独立维护第二套参数规则。

执行前同步保存并刷盘操作 ID、请求哈希和执行意图，完成后保存终态；不记录命令、文件正文、输出或凭据。重启时执行中的记录转为结果未知，日志压缩保留所有操作身份而不自动过期。终态落盘失败仍报告已确认的执行回执，并阻止新操作直到修复存储并重启。暂停、能力关闭和撤销先停止接收相关操作并发出取消，再等待进程清理；连接代次隔离迟到输出，重连不恢复旧会话或解除暂停。Shell 采用独立进程组，结束、超时和取消时清理组内进程；文件权限及 UTF-8 行为与现有协议一致。该客户端不提供隔离沙箱。

`npm run linux:check` 执行 Rust 格式、测试、Clippy 及真实 Server 联调，Linux CI 另验收用户 systemd 安装/停止/重启/卸载。`npm run package:linux` 仅打包 Linux ELF，生成校验和、第三方许可及体积记录；可执行文件和压缩包预算分别为 15 MiB、5 MiB。安装、能力控制和后台运行见[部署说明](deployment.md#linux-cli)。

## 执行链与状态归属

普通工具经过 `mcp.ts → ControlService.execute → 设备 WebSocket → 客户端 dispatch → 执行器`，设备回执由 `ControlService.receive` 校验归属，再由 `finish` 发布终态。SQLite 保存操作元信息和去重身份，返回内容留在有界内存缓存中。

`browser_exec` 的外层操作由 Server 执行。`BrowserExecutions` 调用 QuickJS，每个页面步骤回到 `ControlService.execute`，重新经过授权、去重及设备派发。协调模块拥有脚本的步骤编号、在途步骤、进度和取消控制器；`ControlService` 仍是操作终态、结果缓存和持久化的唯一所有者。父操作结束时先取得包含已确认步骤回执的进度，再停止脚本和请求取消在途子操作；脚本结束前保留会话独占，迟到结果不能再次发布终态。

| 状态                              | 所有者                                          | 失效与清理                                              |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| 设备绑定与持久暂停                | 设备客户端及本机存储                            | 重新连接不会解除暂停；换绑须先退役旧连接                |
| 设备当前连接                      | Server `ControlService`、设备客户端各自维护本端 | 连接代次变化后，旧回调不能覆盖新状态                    |
| 控制会话与操作终态                | Server `ControlService`                         | 断连、撤销、过期和停止终止相应会话；未知操作不重放      |
| 浏览器脚本及 JSON state           | Server `BrowserExecutions` / `BrowserRuntime`   | 会话结束清除；每步仍受当前授权约束                      |
| 任务标签、debugger、frame context | 扩展 `TaskTabs`                                 | 创建、attach 与关闭均核对资源归属；重复关闭等待同次清理 |
| 观察引用与读取快照                | `BrowserBridge` 的任务状态                      | 观察随导航或动作失效；快照仅供读取，不授予输入权限      |

`BrowserDeviceClient.start()` 启动实例，`close()` 结束实例生命周期并释放监听器、定时器和任务资源；本机“停止任务”只清理任务，不关闭设备连接或撤销绑定。worker 入口只负责装配，测试直接创建独立客户端实例。

停止和暂停先使任务资源失效，再等待清理与状态保存；存储失败不能跳过清理，恢复暂停须保存成功后才生效。启动遗留标签由 `TaskTabs` 使用同一清理规则处理，无法确认标签已删除时保留所有权并阻止连接。操作执行结果与日志持久化分开处理：终态保存失败附带诊断，但不把已确认执行改成拒绝；重启后未保存终态的操作仍按结果未知处理，不重放。

引用动作先验证观察引用，locator 动作先解析唯一 DOM 目标；二者共享输入执行函数，均核对任务页、文档版本和目标可用性。locator 不创建临时观察，也不通过替换观察状态来获得输入权限。输入准备可能滚动或聚焦，因此准备开始后的失败仍需按未知副作用处理。

## 身份与授权

实例管理员通过独立的 Admin Token 或管理员 Cookie 创建普通用户、查看全局用户及设备统计；本地账户统一由 `/api/admin/users` 创建；可选 OIDC 外部身份在首次验证登录时建立独立账户。管理员不自动拥有普通账户身份，也不能用管理员凭据调用设备或 MCP 接口。Token 默认在数据库旁私有保存，支持 `ABRIDGE_ADMIN_TOKEN` 覆盖；浏览器用 Token 兑换 30 天签名 Cookie，会话与普通用户登录相互独立、跨重启保留，Token 重置使全部旧管理员会话失效。

设备名称可在管理台、Mac App 和浏览器扩展中修改，服务端在连接欢迎消息及心跳确认中同步最新名称。管理台的设备设置只允许改名，设备本机能力由客户端管理并只读展示；首次绑定时确认的能力范围和 Agent 连接策略继续限制访问。新设备 ID 使用 12 位随机 Base64URL 字符，生成时检查重复；已有设备 ID 保持不变，ID 不作为认证凭据。

普通管理账户负责维护自己的设备与 Agent 连接。Device Key 标识设备，Agent Key 标识调用 MCP 的连接，二者不可互换。可选 OIDC 外部登录按 issuer + sub 映射本地普通账户，不保存外部用户密码；启用平台委托后，首次登录建立默认覆盖全部设备（含新设备）的平台连接，能力仍受设备授权、本机开关与就绪状态限制。显式开启委托后，Server 通过提供方公钥验证用途、受众、客户端和最长 60 秒有效期的访问令牌，映射同一个持久平台连接。平台连接没有 Agent Key，撤销不因重新登录恢复；原有本地账户、Agent Key 和设备绑定保持独立。部署和失效约束见[可选 OIDC 登录](deployment.md#可选-oidc-登录与平台-mcp-委托)。

连接具有稳定 ID、名称、设备策略和可选的到期时间；修改策略不更换 Key，轮换 Key 不改变策略。设备类型限制能力上限：`computer` 为 `screen`、`input`、`shell`、`files`，`browser` 仅为 `browser`。

首次绑定采用浏览器确认与一次性授权码（S256 PKCE）。App 或扩展向 Server 发起五分钟有效的授权请求，用户在管理台登录并明确确认账户、设备与申请能力；仅成功兑换时创建设备并签发 Device Key。App 使用随机端口的本机回环回调，扩展使用自身 ID 的 Chromium 授权回调。客户端自动保存凭据并绑定 Server 地址，用户无需手动复制 Key；管理账户会话不传给客户端。

待授权请求只保存在当前 Server 实例的有界内存中，服务重启后重新发起。授权码只能兑换一次，拒绝、取消或过期不会生成设备凭据；批准不扩大既有 Agent 连接策略。App 和扩展重连及重新绑定继续保留本机暂停状态。

连接的设备策略为以下两种之一，类型与解析规则单源位于 `packages/protocol/src/`：

- `selected`：显式列出每台设备及其能力；新增设备不会自动加入。
- `all`：覆盖当前及以后加入的同账户设备，默认能力与设备类型、设备授权取交集；逐设备覆盖可缩小或调整能力，空覆盖表示排除该设备。

管理台提供连接视角的设备预览，展示同账户设备的授权范围、在线状态与可用能力。MCP 的 `devices_list` 只返回该连接获准访问且具有有效能力的设备，并附带非秘密的连接 ID 与名称；它不公开未授权设备或账户设备总数。设备在线不等于每个连接都获准访问。

`session_open` 保留顶层会话字段和 `server_time`，并在 `device` 中附带与 `devices_list` 一致的设备摘要，包含名称、类型、平台、连接状态和可用的系统与浏览器版本信息。管理台及已授权 Agent 的 `device_get` 可读取完整详情，包括主机名、型号、运行用户和归属账户。

`devices_list` 与 `session_open` 通过 `available_tools` 公布默认参数下可用的设备工具。会话清单还受本次请求的能力约束。Server 按同一平台清单拒绝未实现的工具。桌面输入被拒绝后，`error.recovery.action` 可提示重新观察或请求用户接管。重新观察后应核对目标，并且只重试一次明确未执行的操作。

设备的 `platform`、`version` 和可选 `details` 保存最近一次通过身份校验且成功发送欢迎消息的连接上报，断连和 Server 重启后仍可读取。后续成功连接替换整份上报，缺失字段保持未知。基础字段 `platform` 保留平台标签，`version` 表示 aBridge 客户端或扩展版本。`details` 可包含系统及版本、发行版、架构和浏览器品牌及主版本。macOS 和 Linux 可提供主机名、型号和客户端进程的系统用户名，Linux 额外提供内核版本。归属账户来自 Server 的绑定关系。设备上报只用于展示和排障，授权仍由 Server 验证，在线状态由连接与心跳判定。失败、过期连接和凭据撤销后的迟到握手不会更新设备信息。

有效能力取连接对该设备的策略、设备授权、会话请求、本机开关及实际就绪状态的交集。设备列举、执行和保留结果访问复用同一策略判定。每次执行重新核对所有者、密钥、撤销与过期状态、会话、能力和当前连接代次。收紧策略会终止不再满足要求的会话并请求取消在途操作；不会恢复本机暂停，也不能回滚已发生的副作用。桌面输入会话在同一设备上独占，浏览器任务分别持有自建标签页。

连接默认持续有效，直到撤销，亦可设置到期时间。控制会话的闲置租约为 300 秒，新操作、操作完成、获准的结果查询及同请求去重返回续租，在途操作由定时维护续租；设置连接到期时间时，租约不越过该时间。操作响应中的 `session` 在返回时生成，包含当前状态、`lease_until` 和 `server_time`，不使用缓存结果中的旧期限。读取已结束会话的保留结果不续活会话。设备发现和监控不续租。设备连接心跳期限为 30 秒，操作开始期限也是独立的 30 秒。

新会话 ID 使用 `ses_` 加 8 位随机 Base64URL 字符，提供 48 位随机量，生成时检查重复并在碰撞时重抽；调用方应原样保存，不手工拼写。设备详情的 `sessions` 仅列当前 Agent 连接自己的有效会话；`desktop_busy` 错误也只附自己的占用会话。调用方可复用正确会话，或显式关闭后新建；不能自动抢占其他任务。只有读文件或运行命令时无需申请 `input`。

Agent 高频使用的公开引用保持短：`observation_id` 为 `obs_` 加 8 位 Base64URL，`snapshot_id` 为 `snap_` 加 8 位 Base64URL，规范 `operation_id` 为 `op_` 加 8 位 Base64URL；不要将 UUID 或完整哈希直接暴露为这些 ID。观察与快照由客户端运行时共享的随机起点 48 位递增序列生成，不按会话重置、不回绕；同一运行时内新旧观察、快照及不同会话不会复用引用，无需保存历史 ID 集合。运行时重启后使用新随机起点，原控制会话遵循断连失效契约。引用不是凭据，动作仍校验当前会话、观察期限与目标。

| 错误                          | 含义与恢复                       |
| ----------------------------- | -------------------------------- |
| `session_expired`             | 真正闲置到期；新建会话           |
| `session_stopped`             | 会话已停止；新建会话             |
| `session_connection_lost`     | 设备连接中断；恢复在线后新建会话 |
| `session_connection_replaced` | 当前连接被替换；新建会话         |
| `session_server_restarted`    | Server 重启；新建会话            |
| `device_paused`               | 本机暂停；由操作者在客户端恢复   |

重新连接后必须取得新观察，不能盲目重放结果未知的动作。执行结果未知时可附安全的 `cause` 分类，区分超时、中止与未确认执行，不返回原始异常正文。连接中断的操作错误附 `connection`，该字段仅由 Server 生成，设备回执中的同名字段会被忽略。设备详情的 `last_disconnect` 保留当前 Server 进程最近一次断连分类、时间、连接代次、心跳间隔及可用的关闭码；不保存远端关闭文本、命令或输入内容。

## 桌面操作

`computer_apps` 默认返回运行中的应用。`query` 匹配应用名、Bundle ID 和运行中应用的系统本地化名称，也可按应用名或 Bundle ID 查找未启动的已安装应用。`computer_open(bundle_id=...)` 核对应用身份后启动或激活一次，返回目标窗口观察，需要 `input` 与 `screen`。macOS 优先观察可确认的焦点窗或主窗，多个候选无法判定时返回 `window_candidates`，由调用方显式选择。应用已启动但观察失败时保留启动结果，不自动再次启动。

`computer_windows` 按应用 PID 列出窗口，包含屏幕外窗口。`computer_observe` 在 macOS 上只传 `pid` 刷新同一应用时复用当前会话已选窗口。如果已选窗口消失，需显式选择新窗口。首次选择该应用时，唯一窗口直接观察；多个窗口返回 `window_selection_required`，提示先调用 `computer_windows(pid=...)` 再传 `pid` 与 `window_id` 选择；没有窗口返回 `window_unavailable`。显式传入 `window_id` 时须同时提供 `pid`，且 ID 必须是有效的正安全整数；缺少 PID 或 ID 非法时返回 `invalid_arguments`，错误信息说明缺失字段或提示从 `computer_windows` 取得有效 ID。省略目标时复用会话已选窗口，无目标返回 `target_required`；失败不会替换已选窗口。空窗口列表不能单独证明权限或 Space 问题。

只有显式 `desktop=true` 才选择整屏，并且不能与窗口目标同时指定。整屏观察不以焦点确认为截图前提：观察前后均确认恰好一个前台普通应用，且其唯一可判定的屏幕内普通前窗保持一致时，返回 `focus_status=confirmed`；焦点无法确认、查询失败或期间切换时，仍返回观察及请求的截图，标记 `focus_status=unconfirmed`、`pixel_actions=false`。截图自身的错误、取消与会话关闭仍正常返回失败。

macOS 观察优先返回 `observation_id`、`available_actions` 和适用的恢复提示，其后是目标窗口、截图几何与有界控件列表。桌面引用最长有效 120 秒，截图坐标的底层凭据可能更早过期。一次刷新从选窗开始就使旧引用失效。枚举或读取失败后仍可重试原目标，取得新引用再继续。动作投递也会消耗当前引用。元素点击使用观察中的元素引用；坐标点击必须使用同一观察的可操作截图和截图像素坐标。macOS 的中键点击和双击均使用截图坐标。窗口坐标点击默认 `action.delivery_mode=background`，由驱动按指定窗口投递。macOS 后台坐标点击重新校验目标窗口的可见性、几何及点击点的同应用覆盖。观察期间被同应用窗口覆盖的点在覆盖消失后仍须重新观察。窗口坐标点击投递前，客户端用相同方式重新截取该窗口并比对整窗像素。图像改变或无法核实时返回 `stale_observation`；动态窗口优先使用新观察中的可用元素引用。可识别的普通文档窗口使用 SDK 原图；需要系统单窗裁取的叠层在像素几何无法确认时仅提供可取得的辅助功能观察。

macOS 控制会话与内嵌 SDK 会话独立计时。每次获准观察时，客户端在同一设备进程中激活同名 SDK 会话，从而恢复底层空闲回收后的读取。输入只消费已有观察。设备明确报告的只读驱动超时或故障分别返回 `failed/driver_timeout` 或 `failed/driver_error`，服务端等待读取回执超时返回 `failed/result_timeout`。单次操作的取消保留控制会话，调用方可继续观察。调用方取消动作后的等待时，若设备已经确认投递且会话仍获授权，返回最小执行回执及后续观察被取消的原因。结果未知的输入仍须重新观察以确认业务结果。

整屏和带修饰键的点击须显式指定 `action.delivery_mode=foreground` 并使用截图坐标。前台窗口点击要求截取时目标窗口焦点已确认，调用驱动前再次核对焦点、窗口位置与点击点遮挡，并为截图缩放保留边缘余量。驱动随后再次确认窗口焦点，通过系统鼠标投递。预检和系统投递之间桌面仍可能变化，动作后须核对目标窗口的实际结果。整屏动作（含键盘输入）要求观察时及执行前焦点一致。焦点无从确认时返回 `focus_unavailable`，前窗变化时返回 `focus_changed`。窗口位置变化或点击点被遮挡时分别返回 `window_frame_changed` 或 `window_point_occluded`。遮挡回执的 `error.desktop` 包含目标窗口、可识别的遮挡窗口和恢复动作。同应用遮挡提示观察该窗口，其他遮挡提示清除遮挡后观察原目标。恢复后使用新的引用和坐标。

`computer_act` 默认附带 `result.observation`，可直接继续操作。动作执行完成后，先等待 `wait_after_ms` 再进行后续观察或截图：默认 `2000` 毫秒，接受 `0–10000` 的整数，`0` 表示不等待；`observe_after=false` 仅执行动作且不等待。复合观察需要同时具备 `input` 与 `screen`。macOS 会跟踪同应用新获焦点的窗口，或通过辅助功能确认原窗口上方新出现的菜单。归属不明确时，返回 `window_selection_required` 和 `window_candidates`，清除之前的选窗，等待调用方选择。当结果附带新窗口时继续使用其中的 `observation_id`。动作已执行而后观察失败时分别返回动作结果与 `observation_error`，只补观察，不重放动作。

macOS 窗口观察的 `keyboard_focus` 分别报告已确认的窗口和接收键盘的控件状态。窗口按键需要可用的路由和已确认的窗口，不带元素引用直接输入文本还需要已确认的可编辑控件。指定元素引用时校验观察中该元素公布的动作。投递前发现窗口或键盘接收者发生变化时拒绝并提示刷新。

## 浏览器操作

每个扩展安装实例注册为独立设备；Profile 由会话的 `device_id` 确定。`browser_open(url=...)` 仅导航自有任务标签，并固定附带新页面观察，不公开关闭观察的选项。`browser_act` 支持 `click`、`fill`、`press`、`select`、`scroll`、`hover`，默认在动作完成后等待 `2000` 毫秒，再附带新观察；外层参数 `wait_after_ms` 可设为 `0–10000` 的整数毫秒，`observe_after=false` 时不等待。`browser_observe` 用于刷新、聚焦查询或检查仍在加载的同一任务页。

导航加载超时保留任务页，返回 `navigation_state=loading`。导航等待与后观察（含 debugger 初始化）共享 15 秒内部预算；后观察遇导航竞态，最多只读重试两次，额外预算不超过 2 秒。不重新打开标签，也不重放点击或填充。该内部预算不等于标签创建、导航提交或 DOM 动作的总执行期限。

动作后的等待计入已有操作与后观察时间预算，不延长超时上限。等待期间暂停、取消或关闭会话仍优先；已执行的动作不会因等待或观察失败而重放。固定等待不保证所有异步任务已完成，页面仍在加载时继续观察同一目标。

浏览器观察文本 JSON 总预算约 7000 字符，不含独立图片；正文优先且上限 4000 字符，再分配交互元素和链接。`query` 接受非空字符串或1–20个非空字符串：单串按整段不区分大小写做子串匹配，数组任一项匹配即可，正文和控件使用同一规则；每项最多200字符、数组总长最多2000字符。匹配结果去重并保持原观察预算。零结果只表示本次扫描的已加载正文与控件未匹配，截断不表示内容不存在，未显示字段也不能用于推断站点全部能力。链接附带声明的 `target` 属性，它不证明已经打开新标签。

浏览器引用最长有效 60 秒，按会话、文档版本和目标绑定，动作与导航后失效。所有工具及代码中的 `page` 固定指向当前任务页；点击成功不表示导航成功，新标签不会自动接管。访问已观察链接可把其 URL 交给 `browser_open` 或 `page.goto`。点击、键盘与悬停自动滚动并检查目标，在元素准备后通过 CDP Input 执行；滚动修改最近可滚动容器或页面的 DOM 偏移并返回实际 delta，不发送 wheel 事件；已知只读、错误目标类型与当前覆盖层在无副作用预检中拒绝并保留任务页，嵌套滚动容器裁剪则允许显露后再次命中检查；填充使用浏览器文本输入，原生下拉选择触发 DOM 语义事件。站点仍可能拒绝操作。`browser_exec` 在 Server 的隔离 QuickJS 引擎中组织浏览器代码，通过受会话约束的内部工具执行；`page.evaluate` 可执行任务页 JavaScript，原始 CDP 不对 Agent 开放。页面脚本具有该站点登录用户的页面权限，因此固定观察的密码过滤不约束脚本读取。`browser_read` 保存有界文本或表格快照并支持缓存分页；`browser_wait` 支持有期限的条件等待。代码运行与普通动作共用授权、去重和取消，单会话代码执行期间拒绝其他操作；每个浏览器步骤独立检查授权并持有派生操作 ID。脚本失败保留 `steps_completed` 和有界的 `failed_step`（步骤操作 ID、方法、状态及原始错误）；首次执行前的明确拒绝为 `refused`，已有步骤完成后的明确失败为 `failed`，在途超时、断连或无确认回执保持 `outcome_unknown`。纯脚本错误为 `failed`，明确取消与结果未知分别报告，不能用步骤数为零推断没有副作用；输入准备的滚动和 focus 也会触发页面事件。动作成功后观察失败仍为 `executed` 并附 `observation_error`。代码默认最多20秒，可设至120秒，MCP等待默认15秒后可通过 `operation_status` 查询或 `operation_cancel` 取消。同一任务页的重复清理等待同一次清理结果，新任务页不能越过清理；清理失败保留原始原因、`cleanup_error` 与必要的恢复信息，无客户端确认时不宣称任务页已清理。控制会话仍有效而任务页缺失返回 `task_tab_missing`，用 `browser_open` 创建任务页；真实停止或过期仍需新建控制会话。详细生命周期及代码接口见 [浏览器客户端](browser-profile-design.md)。

## Shell、文件与结果

`command_execute` 默认等待最多 15 秒，提前完成立即返回输出和退出码；等满则返回同一 `operation_id` 的当前状态，命令继续运行。`timeout` 独立限制实际执行时间，范围为 1–120 秒。`operation_status` 默认也最多等 15 秒，显式 `wait_seconds=0` 立即读取。等待结束或 HTTP 调用方断开不会取消或重新派发命令。取消等待确认，尚未确认时返回 `cancel_requested`。

Shell 完整 JSON 默认返回预算 `output_limit_chars=6000`，可设为 1024–12000。`output_truncated` 表示还有保留文本，使用原操作 ID 与 `next_output_offsets` 继续读取；偏移按解码字符计算。`capture_truncated` 表示执行捕获时已丢失内容，分页无法恢复。运行中的滚动窗口可报告 `output_unavailable_before`，最终结果可能仍保留相应前缀。分页只读缓存。

文件工具仅处理 UTF-8 文本与目录列表，遵循当前用户的系统文件权限。读写正文上限为 1 MiB；写入已存在文件需要显式 `overwrite=true`。Shell 与文件能力不提供隔离沙箱。

新操作通常省略 `operation_id`。显式提供时，它是当前 Agent 连接与会话内的请求去重键；Server 将其映射为短规范执行 ID，数据库、设备日志和响应使用该 ID。完整作用域键的 SHA-256 仅保存在数据库内部 `key_hash`，先按完整键查找已有操作；短 ID 碰撞时另选候选，不把不同请求键合并为一次操作。自动分配的短 ID 同样检查数据库重复。`op_` 加恰好 8 位 Base64URL 是 Server 返回 ID 的保留格式，调用方不要用它自建请求键；未知的该格式 ID 会被拒绝。重试同一会话中的同一请求可复用原键或返回 ID，同 ID 改参数会被拒绝；不同会话可独立使用同一原键，已返回的执行 ID 不能用于另一会话。查询和取消只使用响应的 `operation_id`。设备保存执行意图和终态，恢复后不自动重放。Server 仅短期缓存返回内容；SQLite 不保存命令、输入、文件正文或截图。服务重启后未完成操作标为结果未知。

图片通过原生 MCP `ImageContent` 返回，不在 JSON 中重复嵌入 base64。原始图片上限为 4 MiB，设备 WebSocket 消息上限为 8 MiB。`executed` 仅表示执行回执，业务结果还需检查退出码、文件内容或后续观察。取消和关闭不能回滚已发生的副作用。

## 运行环境与打包

Server 的运行环境按根 `package.json` 的 `engines` 约定：Node.js 22.x 最低 22.13.0，23.x 最低 23.4.0，支持 24 及以上主版本。macOS App 目标为 Apple Silicon/macOS 14+，无需 Node、npm 或 Python。`NativeDriver.swift` 直接使用 Cua Driver 0.47.8 的版本化 C ABI（1.1），按需创建同进程实例并验证 embedded 模式与空 socket 路径。原生会话维持 standard 权限上限，不开启 unrestricted 或浏览器 profile 授权。Server 分发不携带该 SDK。

App 包内包含 AppKit 主程序、Swift 设备客户端、独立 Swift 更新器、共享契约资源及裁剪到 arm64 的 Cua dylib；不分发 Node、JavaScript 桌面程序或 npm 依赖树。Foundation 负责 WebSocket/HTTP，系统 SQLite 保存操作去重日志，POSIX 进程组实现 Shell 取消，文件操作使用系统 API。凭据、暂停与本机状态保留在 App Bundle 外的私有目录。原生代码或签名变化可能影响系统权限，构建和协议测试不能证明实际已安装 App 的截图或输入可用。

桌面接管保护只覆盖在途输入，读取和普通鼠标移动不触发暂停。手动暂停持久保存，远程请求不能解除。依赖及许可见 [第三方说明](third-party-notices.md)。

安装、更新与维护见 [部署说明](deployment.md)，开发和验证要求见 [贡献指南](https://github.com/xerrors/aBridge/blob/main/.github/CONTRIBUTING.md)，安全限制见 [SECURITY.md](https://github.com/xerrors/aBridge/blob/main/.github/SECURITY.md)。

### macOS 更新

`apps/desktop/native/runtime/Updater.swift` 负责正式版本选择、校验、暂存和回滚；独立 `abridge-updater` 使用 Foundation/CryptoKit，不经 Agent/Server 控制接口开放。AppKit 主程序负责用户更新入口、停止设备进程和启动确认。更新辅助程序复制到应用旁的私有暂存目录，等待主程序退出后原路径替换，确认新版 App 和原生客户端可运行后清理备份。启动确认使用独立的 `startup-check`，不依赖服务器连接、设备授权或系统权限状态；这些业务状态不能触发安装回滚。设备绑定与状态始终位于 App Bundle 外。

### 手动设备绑定和 HTTP 确认

设备凭据的手动签发与浏览器 PKCE 授权共享同一设备身份。`GET /api/device` 是设备凭据验证入口，电脑/浏览器客户端在绑定提交前校验设备类型；管理员 Token 和 Agent Key 不作为设备凭据。macOS 继续使用先验证、再停止旧运行时、最后提交的私有双阶段管道；扩展在验证期间保持旧绑定，提交前显式退役旧连接，避免迟到的撤销/关闭消息改变新绑定。

公网 HTTP 由用户显式确认具体 Origin；共享协议包负责地址规范化和确认匹配。确认写入成功绑定的本机配置，连接恢复时再次校验，浏览器 PKCE 状态与回调校验保持不变。HTTP 风险确认不代替 Server Host/Origin 访问校验，OIDC 的公网 HTTP 另由部署管理员通过 `--allow-insecure-http` / `ABRIDGE_ALLOW_INSECURE_HTTP=true` 显式开启；默认 HTTPS 策略和身份校验保持不变。
