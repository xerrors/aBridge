# 架构与执行契约

## 组成与职责

Server、浏览器扩展和管理台使用 strict TypeScript。macOS 客户端使用 AppKit UI 和 Swift 6 运行时，通过私有 Unix socket 通信。Windows 客户端使用 Rust 和 Win32，Linux CLI 使用 Rust，Android App 使用 Kotlin。各客户端独立部署并直接连接 Server。

```text
MCP 客户端 ─ Agent Key ─ /mcp ──────────┐
管理台（预构建 Preact） ─ /api ────────┤ Fastify Server
                                       │ SQLite + 内存连接/结果缓存
                                       ├─ /ws/device ─ Swift 原生客户端
                                       │                ├ 官方 Cua SDK：screen / input
                                       │                ├ Shell
                                       │                └ UTF-8 文件
                                       ├─ /ws/device ─ Rust Windows 客户端
                                       │                ├ 截图与前台键鼠
                                       │                └ Shell / UTF-8 文件
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
| `apps/windows/windows-native-shell/`             | Rust 运行时、Win32 设置与系统托盘     |
| `apps/browser/src/worker.ts`                     | 扩展入口，创建并启动设备客户端        |
| `apps/browser/src/client.ts`                     | 设备绑定、连接、操作日志与本机控制    |
| `apps/browser/src/task-tabs.ts`                  | 自有任务标签、调试器与资源清理        |
| `apps/browser/src/bridge.ts`                     | 浏览器工具编排、观察、读取与输入      |
| `apps/web/`                                      | Preact 管理台                         |
| `packages/protocol/`                             | 共享 schema、能力与协议常量           |
| `packages/shared/`                               | Node 数据目录约定                     |

源码中的领域名统一为 `AgentConnection`（Agent 的持久授权连接）、`DeviceConnection`（设备当前传输连接）、`ControlSession`（控制会话）和 `Operation`（一次操作）。管理接口使用 `/api/agent-connections`，列表字段为 `connections`，操作及会话通过 `agent_connection_id` 引用授权连接；设备派发中的 `device_credential_version` 表示 Device Key 版本，不表示 Agent 连接策略版本。`operation_status` 与 `operation_cancel` 面向所有操作，包括 Shell 和浏览器代码。

协议包中的 `toolArgumentSchemas` 定义工具参数，`DeviceToolRequest` 把工具名和参数类型对应起来。MCP、Server 和执行端各自在入口按同一契约解析，执行时再核对授权、取消、连接代次、观察引用和目标。

管理 API 与管理台共用 `packages/protocol/src/management.ts` 中的输入与响应类型，数据库实体和界面状态由各自模块维护。

设备通信使用 `abridge/1`。进程边界通过运行时 schema 校验消息。TypeScript 使用严格类型检查，Swift 6 使用严格并发检查。原生客户端读取协议包生成的 `desktop-contract.json`，按共享规则处理消息、参数、默认值和跨字段约束。回归测试对照 Zod 和 Swift 的接受结果与规范化值。

根 `package.json` 提供软件版本，扩展 manifest 和分发包在构建时读取它。

Server 使用 Fastify 5 和官方 MCP TypeScript SDK v2。MCP HTTP transport 按请求维护状态，设备操作会话由 `ControlService` 持续管理。管理台是随 Server 提供的预构建 Preact 11 静态页面。

管理台源码按职责收拢在 `apps/web/src/`：`app/` 负责入口、导航、工作区布局与跨功能弹窗编排，`components/` 提供公共控件，`features/` 按 auth、overview、devices、connections、activity、admin 放置页面及相关逻辑，`lib/` 放置请求、公共类型与展示标签。页面不作为其他模块的公共类型出口；连接权限计算集中在 connections 的 policy 模块。表单与弹窗共享提交状态，保留在同一组件文件中。

样式通过 `src/styles/index.css` 有序汇入基础、公共控件、布局和各功能样式，构建后仍输出单个 `/static/app.css`；`public/` 只维护 HTML、字体与图片等静态资产。

持久化使用 Node 内置 `node:sqlite` 的 `DatabaseSync`，其调用同步占用事件循环。最低运行版本 Node 22.13.0 已取消该模块的启动 flag 要求，但该版本仍将其标为实验 API。数据库基线为 schema 6，Agent 连接使用 `agent_connections` / `platform_connections` 表。托管浏览器在启动时补齐独立登记表 `managed_browsers`。已有旧形状的托管登记需要离线转换。当前限制单个数据库由一个 Server 实例持有，内存连接与结果缓存不支持多 worker 或横向部署。[Node 22.13.0 发布说明](https://nodejs.org/en/blog/release/v22.13.0)

## Linux CLI 客户端

`apps/linux-client/` 提供 Rust 可执行文件 `abridge-client`。它在无图形环境中也能运行，以 `computer` / `linux` 身份连接 `/ws/device`，提供 `shell` 和 `files`。同一个二进制可以在用户级 systemd 中运行，也可以用 `run` 在前台运行。

`main.rs` 负责命令解析和 Device Token 绑定，`runtime.rs` 是连接代次、操作调度及本机策略的唯一所有者，`executor.rs` 执行 Shell/文件，`storage.rs` 维护私有绑定与操作日志，`service.rs` 管理用户服务。运行时先取得独占锁再读取绑定，配置与凭据作为同一份 0600 文件原子提交；本机控制通过同用户私有 Socket 进行。新绑定须先验证 Server 的设备身份，并要求停止原运行时。

Linux 构建消费 `@abridge/protocol/desktop-contract` 导出的能力、常量、JSON Schema 和 portable 约束；版本也由该契约从根 `package.json` 生成。Rust 解释器应用共享默认值、字段范围、未知字段策略和跨字段约束，对不支持的新规则拒绝启动并使契约检查失败。跨语言测试对照 Zod 的解析结果，避免独立维护第二套参数规则。

设备在执行前把操作 ID、请求哈希和执行意图同步写入日志，完成后保存终态。日志只记录这些操作元信息，压缩时仍保留历史操作身份。重启时，执行中的记录变为结果未知。若终态落盘失败，设备会保留已确认的执行回执，并停止接收新操作，直到修复存储并重启。

暂停、关闭能力或撤销时，客户端先停止接收相关操作，取消在途任务，再等待进程退出。重连沿用暂停状态并开启新的连接代次。Shell 在独立进程组中执行，结束、超时或取消时清理组内进程。Shell 和 UTF-8 文件操作使用客户端所在账户的权限。

`npm run linux:check` 执行 Rust 格式、测试、Clippy 及真实 Server 联调，Linux CI 另验收用户 systemd 安装/停止/重启/卸载。`npm run package:linux` 仅打包 Linux ELF，生成校验和、第三方许可及体积记录；可执行文件和压缩包预算分别为 15 MiB、5 MiB。安装、能力控制和后台运行见[部署说明](deployment.md#linux-cli)。

## Go Agent 服务

`apps/agent/` 是独立运行的 Android 任务服务。任务 API 接收显式设备 ID 和目标，执行器通过模型工具调用驱动 aBridge MCP，使用选中设备的控制会话读取观察并执行输入。调度按设备串行，同一进程可并行执行不同设备的任务。MCP Server 继续核对设备授权、运行状态和操作回执。[运行和接口示例](https://github.com/xerrors/aBridge/blob/main/apps/agent/README.md)

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

## Windows 客户端

Windows 客户端位于 `apps/windows/windows-native-shell/`。Win32 外壳负责窗口和本机控制，从同一个 `aBridge.exe` 启动 `--native-host` 运行时，通过私有 stdio 传递命令及事件。运行时直接连接 Server，处理授权、会话、SQLite 去重、操作调度、Shell 和文件。内嵌 PowerShell/UIA 驱动在输入前核对本机权限、焦点、遮挡和人工输入。旧 TypeScript 实现及驱动源保存在 `apps/windows/src/`，供对照测试。

Windows 壳消息和平台动作契约维护在 `packages/protocol/src/windows-shell.ts`、`windows-computer.ts`；平台动作仅接受 foreground 模式，保留现有服务端的公共工具 schema。[Windows 安装与验证](windows-client.md)。

外壳显示设置、托盘和活动边框，也处理暂停快捷键与子进程退出。边框使用物理屏幕坐标，允许鼠标穿透并保持当前窗口焦点，驱动会将它从操作目标中排除。运行时沿用原状态文件、SQLite 表和私有控制管道，并用生成的契约校验输入。暂停、撤销和能力开关在重连后继续生效。遇到结果未知的写操作时，先核对原操作及设备状态。

便携包包含原生程序及其资源，使用 Windows 自带的运行组件。构建和仓库外验包均要求完整程序目录小于 10,000,000 字节。

## 身份与授权

管理员通过 Admin Token 或管理员 Cookie 进入「实例管理」。可以用 `/api/admin/users` 创建本地普通账户，并查看全局用户和设备统计。设备和 MCP 操作使用各自的凭据。Admin Token 默认保存在数据库旁，可用 `ABRIDGE_ADMIN_TOKEN` 覆盖。浏览器用它换取有效期 30 天的签名 Cookie，管理员与普通用户各有自己的会话，Server 重启后仍有效。重置 Token 会使此前的管理员会话失效。

设备名称可在管理台、Mac App 和浏览器扩展中修改，服务端在连接欢迎消息及心跳确认中同步最新名称。管理台的设备设置只允许改名，设备本机能力由客户端管理并只读展示；首次绑定时确认的能力范围和 Agent 连接策略继续限制访问。新设备 ID 使用 12 位随机 Base64URL 字符，生成时检查重复；已有设备 ID 保持不变，ID 不作为认证凭据。

普通账户管理自己的设备与 Agent 连接。设备用 Device Key 认证，MCP 请求用 Agent Key 认证。开启 OIDC 后，首次登录按 `(issuer, sub)` 建立独立普通账户。平台委托使用提供方签发的短期令牌，Server 验证签名、用途、受众、客户端和最长 60 秒的有效期，再找到对应平台连接。初始平台连接覆盖本账户全部设备（含新设备），实际能力取决于设备授权、本机开关和就绪状态。撤销后需要显式重新授权。[配置 OIDC 与平台委托](deployment.md#可选-oidc-登录与平台-mcp-委托)

连接具有稳定 ID、名称、设备策略和可选的到期时间；修改策略不更换 Key，轮换 Key 不改变策略。设备类型限制能力上限：`computer` 为 `screen`、`input`、`shell`、`files`，`browser` 仅为 `browser`。

首次绑定采用浏览器确认与一次性授权码（S256 PKCE）。App 或扩展向 Server 发起五分钟有效的授权请求，用户在管理台登录并明确确认账户、设备与申请能力；仅成功兑换时创建设备并签发 Device Key。App 使用随机端口的本机回环回调，扩展使用自身 ID 的 Chromium 授权回调。客户端自动保存凭据并绑定 Server 地址，用户无需手动复制 Key；管理账户会话不传给客户端。

待授权请求只保存在当前 Server 实例的有界内存中，服务重启后重新发起。授权码只能兑换一次，拒绝、取消或过期不会生成设备凭据；批准不扩大既有 Agent 连接策略。App 和扩展重连及重新绑定继续保留本机暂停状态。

连接的设备策略为以下两种之一，类型与解析规则单源位于 `packages/protocol/src/`：

- `selected`：显式列出每台设备及其能力；新增设备不会自动加入。
- `all`：覆盖当前及以后加入的同账户设备，默认能力与设备类型、设备授权取交集；逐设备覆盖可缩小或调整能力，空覆盖表示排除该设备。

在管理台的连接预览里，可以看到该连接有权使用哪些设备以及设备当前的状态和能力。MCP 的 `devices_list` 返回当前连接获准且具有有效能力的设备，以及连接 ID 和名称。

`session_open` 保留顶层会话字段和 `server_time`，并在 `device` 中附带与 `devices_list` 一致的设备摘要，包含名称、类型、平台、连接状态和可用的系统与浏览器版本信息。管理台及已授权 Agent 的 `device_get` 可读取完整详情，包括主机名、型号、运行用户和归属账户。

Android 的 hello 和心跳可上报 `interaction_state`（`ready`、`screen_off`、`locked`）。在线时设备摘要包含该状态。熄屏或锁屏暂停屏幕和输入能力并终止受影响的会话，文件能力继续按独立授权判断。亮屏且退出锁屏界面后，任务打开新会话并重新观察。

浏览器设备的列表状态反映最近的心跳。打开新会话前，Server 用 WebSocket Ping/Pong 确认设备仍能应答。休眠或网络中断后，新会话可以短暂等待同一设备重连，包括原连接已被清理的情况。等待期间持续复核凭据、授权、本机暂停和调用方取消。Server 会持久记录浏览器已上报的暂停和能力关闭，重启后仍阻止新会话和候选换绑，直到有效设备连接上报恢复。已有会话绑定原连接代次。派发新操作前也会确认该连接，已经发出但未取得结果的操作保留 `outcome_unknown`，不会自动重放。

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

每次观察选择一个目标。整屏观察传 `desktop=true`，窗口观察传窗口目标。整屏截图前后都能确认同一个前台应用的唯一普通前窗时，结果标记 `focus_status=confirmed`。焦点查询有歧义、失败或期间切换时，仍返回可取得的观察和请求的截图，并标记 `focus_status=unconfirmed`、`pixel_actions=false`。截图错误、取消和会话关闭照常报告失败。

macOS 观察优先返回 `observation_id`、`available_actions` 和适用的恢复提示，其后是目标窗口、截图几何与有界控件列表。桌面引用最长有效 120 秒，截图坐标的底层凭据可能更早过期。一次刷新从选窗开始就使旧引用失效。枚举或读取失败后仍可重试原目标，取得新引用再继续。动作投递也会消耗当前引用。元素点击使用观察中的元素引用；坐标点击必须使用同一观察的可操作截图和截图像素坐标。macOS 的中键点击和双击均使用截图坐标。窗口坐标点击默认 `action.delivery_mode=background`，由驱动按指定窗口投递。macOS 后台坐标点击重新校验目标窗口的可见性、几何及点击点的同应用覆盖。观察期间被同应用窗口覆盖的点在覆盖消失后仍须重新观察。窗口坐标点击投递前，客户端用相同方式重新截取该窗口并比对整窗像素。图像改变或无法核实时返回 `stale_observation`；动态窗口优先使用新观察中的可用元素引用。可识别的普通文档窗口使用 SDK 原图；需要系统单窗裁取的叠层在像素几何无法确认时仅提供可取得的辅助功能观察。

macOS 控制会话与内嵌 SDK 会话独立计时。每次获准观察时，客户端在同一设备进程中激活同名 SDK 会话，从而恢复底层空闲回收后的读取。输入只消费已有观察。设备明确报告的只读驱动超时或故障分别返回 `failed/driver_timeout` 或 `failed/driver_error`，服务端等待读取回执超时返回 `failed/result_timeout`。单次操作的取消保留控制会话，调用方可继续观察。调用方取消动作后的等待时，若设备已经确认投递且会话仍获授权，返回最小执行回执及后续观察被取消的原因。结果未知的输入仍须重新观察以确认业务结果。

整屏和带修饰键的点击须显式指定 `action.delivery_mode=foreground` 并使用截图坐标。前台窗口点击要求截取时目标窗口焦点已确认，调用驱动前再次核对焦点、窗口位置与点击点遮挡，并为截图缩放保留边缘余量。驱动随后再次确认窗口焦点，通过系统鼠标投递。预检和系统投递之间桌面仍可能变化，动作后须核对目标窗口的实际结果。整屏动作（含键盘输入）要求观察时及执行前焦点一致。焦点无从确认时返回 `focus_unavailable`，前窗变化时返回 `focus_changed`。窗口位置变化或点击点被遮挡时分别返回 `window_frame_changed` 或 `window_point_occluded`。遮挡回执的 `error.desktop` 包含目标窗口、可识别的遮挡窗口和恢复动作。同应用遮挡提示观察该窗口，其他遮挡提示清除遮挡后观察原目标。恢复后使用新的引用和坐标。

`computer_act` 默认附带 `result.observation`，可直接继续操作。动作执行完成后，先等待 `wait_after_ms` 再进行后续观察或截图：默认 `2000` 毫秒，接受 `0–10000` 的整数，`0` 表示不等待；`observe_after=false` 仅执行动作且不等待。复合观察需要同时具备 `input` 与 `screen`。macOS 会跟踪同应用新获焦点的窗口，或通过辅助功能确认原窗口上方新出现的菜单。归属不明确时，返回 `window_selection_required` 和 `window_candidates`，清除之前的选窗，等待调用方选择。当结果附带新窗口时继续使用其中的 `observation_id`。动作已执行而后观察失败时分别返回动作结果与 `observation_error`，只补观察，不重放动作。

macOS 窗口观察的 `keyboard_focus` 分别报告已确认的窗口和接收键盘的控件状态。窗口按键需要可用的路由和已确认的窗口，不带元素引用直接输入文本还需要已确认的可编辑控件。指定元素引用时校验观察中该元素公布的动作。投递前发现窗口或键盘接收者发生变化时拒绝并提示刷新。

## 浏览器操作

每个扩展安装实例注册为独立设备；Profile 由会话的 `device_id` 确定。`browser_open(url=...)` 仅导航自有任务标签，并固定附带新页面观察，不公开关闭观察的选项。`browser_act` 支持 `click`、`fill`、`press`、`select`、`scroll`、`hover`，默认在动作完成后等待 `2000` 毫秒，再附带新观察；外层参数 `wait_after_ms` 可设为 `0–10000` 的整数毫秒，`observe_after=false` 时不等待。`browser_observe` 用于刷新、聚焦查询或检查仍在加载的同一任务页。

导航加载超时会保留任务页并返回 `navigation_state=loading`。导航等待与后观察（含 debugger 初始化）共享 15 秒内部预算。后观察遇到导航竞态时，最多再做两次只读重试，额外预算不超过 2 秒。接下来可继续观察同一任务页，原点击或填充回执保持有效。

动作后的等待计入现有预算，暂停、取消或关闭会话可以打断等待。动作已经投递时，结果会保留执行状态。后观察显示页面仍在加载时，继续观察同一目标。

浏览器观察的 JSON 文本预算约为 7,000 字符，图片有独立预算。正文优先，最多 4,000 字符，剩余空间留给控件和链接。`query` 对正文和控件做忽略大小写的子串匹配，接受一个非空字符串或 1–20 个非空字符串，数组中任一项命中即可。每项最多 200 字符，总长最多 2,000 字符。匹配会去重，截断信息说明本次扫描的范围。链接中的 `target` 是站点声明，实际打开的子标签见 `opened_tabs`。

浏览器引用绑定到会话、文档版本和目标，最长有效 60 秒，动作或导航后刷新。工具和脚本里的 `page` 都指向当前任务页。需要访问已观察到的链接时，可以把 URL 交给 `browser_open` 或 `page.goto`。

`browser_exec` 在 Server 的 QuickJS 引擎运行。每个浏览器步骤独立核对授权，使用派生操作 ID，并遵循普通动作的去重和取消规则。脚本保留会话独占，回执记录 `steps_completed` 和 `failed_step`。页面动作完成后如果观察失败，回执仍为 `executed`，并附 `observation_error`。默认脚本时限为 20 秒，可设至 120 秒。MCP 默认等待 15 秒，之后可用 `operation_status` 查询或 `operation_cancel` 取消。

`page.evaluate` 在任务页中用网站当前用户的页面权限执行，能读取页面向 JavaScript 开放的数据。它和固定观察的字段过滤有各自的访问范围。关于观察、浏览器输入、快照分页、异常回执和清理，见浏览器客户端文档。[浏览器客户端](browser-profile-design.md)

## Shell、文件与结果

`command_execute` 默认等待最多 15 秒，提前完成立即返回输出和退出码；等满则返回同一 `operation_id` 的当前状态，命令继续运行。`timeout` 独立限制实际执行时间，范围为 1–120 秒。`operation_status` 默认也最多等 15 秒，显式 `wait_seconds=0` 立即读取。等待结束或 HTTP 调用方断开不会取消或重新派发命令。取消等待确认，尚未确认时返回 `cancel_requested`。

Shell 完整 JSON 默认返回预算 `output_limit_chars=6000`，可设为 1024–12000。`output_truncated` 表示还有保留文本，使用原操作 ID 与 `next_output_offsets` 继续读取；偏移按解码字符计算。`capture_truncated` 表示执行捕获时已丢失内容，分页无法恢复。运行中的滚动窗口可报告 `output_unavailable_before`，最终结果可能仍保留相应前缀。分页只读缓存。

文件工具提供 UTF-8 文本读写和目录列表，正文上限为 1 MiB。覆盖现有文件时，显式使用 `overwrite=true`。Shell 和文件工具使用客户端所在账户的系统权限，可以访问该账户有权限使用的资源。

新操作通常省略 `operation_id`。显式提供时，它是当前 Agent 连接与会话内的请求去重键；Server 将其映射为短规范执行 ID，数据库、设备日志和响应使用该 ID。完整作用域键的 SHA-256 仅保存在数据库内部 `key_hash`，先按完整键查找已有操作；短 ID 碰撞时另选候选，不把不同请求键合并为一次操作。自动分配的短 ID 同样检查数据库重复。`op_` 加恰好 8 位 Base64URL 是 Server 返回 ID 的保留格式，调用方不要用它自建请求键；未知的该格式 ID 会被拒绝。重试同一会话中的同一请求可复用原键或返回 ID，同 ID 改参数会被拒绝；不同会话可独立使用同一原键，已返回的执行 ID 不能用于另一会话。查询和取消只使用响应的 `operation_id`。设备保存执行意图和终态，恢复后不自动重放。Server 仅短期缓存返回内容；SQLite 不保存命令、输入、文件正文或截图。服务重启后未完成操作标为结果未知。

图片通过 MCP `ImageContent` 单独返回，原始图片上限 4 MiB，设备 WebSocket 消息上限 8 MiB。收到 `executed` 后，可通过退出码、文件内容或新观察核对业务结果。取消和关闭只影响后续执行，已经发生的修改需要另行处理。

## 运行环境与打包

Server 的运行环境按根 `package.json` 的 `engines` 约定：Node.js 22.x 最低 22.13.0，23.x 最低 23.4.0，支持 24 及以上主版本。macOS App 目标为 Apple Silicon/macOS 14+，无需 Node、npm 或 Python。`NativeDriver.swift` 直接使用 Cua Driver 0.47.8 的版本化 C ABI（1.1），按需创建同进程实例并验证 embedded 模式与空 socket 路径。原生会话维持 standard 权限上限，不开启 unrestricted 或浏览器 profile 授权。Server 分发不携带该 SDK。

macOS App 包含 AppKit 主程序、Swift 设备客户端、更新器、共享契约和 arm64 Cua dylib。Foundation 处理 WebSocket 和 HTTP，系统 SQLite 保存去重日志，Shell 通过 POSIX 进程组取消，文件读写使用系统 API。凭据、暂停和本机状态位于 App Bundle 外的私有目录。更换原生代码或签名后，请在实际安装的 App 中检查截图和输入权限。

桌面接管保护只覆盖在途输入，读取和普通鼠标移动不触发暂停。手动暂停持久保存，远程请求不能解除。依赖及许可见 [第三方说明](third-party-notices.md)。

安装、更新与维护见 [部署说明](deployment.md)，开发和验证要求见 [贡献指南](https://github.com/xerrors/aBridge/blob/main/.github/CONTRIBUTING.md)，安全限制见 [SECURITY.md](https://github.com/xerrors/aBridge/blob/main/.github/SECURITY.md)。

### macOS 更新

`apps/desktop/native/runtime/Updater.swift` 负责正式版本选择、校验、暂存和回滚；独立 `abridge-updater` 使用 Foundation/CryptoKit，不经 Agent/Server 控制接口开放。AppKit 主程序负责用户更新入口、停止设备进程和启动确认。更新辅助程序复制到应用旁的私有暂存目录，等待主程序退出后原路径替换，确认新版 App 和原生客户端可运行后清理备份。启动确认使用独立的 `startup-check`，不依赖服务器连接、设备授权或系统权限状态；这些业务状态不能触发安装回滚。设备绑定与状态始终位于 App Bundle 外。

### 手动设备绑定和 HTTP 确认

设备凭据的手动签发与浏览器 PKCE 授权共享同一设备身份。`GET /api/device` 是设备凭据验证入口，电脑/浏览器客户端在绑定提交前校验设备类型；管理员 Token 和 Agent Key 不作为设备凭据。macOS 继续使用先验证、再停止旧运行时、最后提交的私有双阶段管道；扩展在验证期间保持旧绑定，提交前显式退役旧连接，避免迟到的撤销/关闭消息改变新绑定。

公网 HTTP 由用户显式确认具体 Origin；共享协议包负责地址规范化和确认匹配。确认写入成功绑定的本机配置，连接恢复时再次校验，浏览器 PKCE 状态与回调校验保持不变。HTTP 风险确认不代替 Server Host/Origin 访问校验，OIDC 的公网 HTTP 另由部署管理员通过 `--allow-insecure-http` / `ABRIDGE_ALLOW_INSECURE_HTTP=true` 显式开启。

macOS 的设备进程使用系统 URLSession 连接用户指定的 Server。HTTPS、WSS 和回环连接由使用系统默认 ATS 策略的 `abridge-desktop` 处理。经 Origin 确认的远端 HTTP 和 WS 由单独签名的 `abridge-desktop-http` 处理，只有这个进程包含 ATS 例外。绑定和启动时，设备进程在连接前复核所选传输方式。更新器也使用系统默认的 ATS 策略。

设备 WebSocket 握手的 HTTP 401/403 通常按连接错误重试。如果系统未提供握手响应或只返回普通 401，Mac 客户端会向同一 Server 发起有时限的 `GET /api/device` 验证。Server 收到并拒绝设备凭据时，HTTP 401 包含 `abridge-device-auth: invalid_device_key`。带这个标记的 401 和已建立连接收到的撤销消息会停止自动重连，直至重新绑定。反向代理需要传递设备请求的 Authorization 和 Server 的认证错误标记。
