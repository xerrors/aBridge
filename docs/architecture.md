# 架构与模块职责

0.2.0 由一个 Python 服务和一个 macOS 菜单栏客户端组成。服务提供管理 API、MCP 与设备 WebSocket；客户端主动出站连接，不开放本机入站执行端口。

```text
Yuxi / MCP 客户端 ─ Agent Key ─ /mcp ─┐
管理台 ─ 管理登录会话 ─ /api ─────────┤ aBridge 服务
                                     │ SQLite + 在线设备路由
                                     └─ 设备 WebSocket ─ Mac App
                                                        └─ Python 设备进程
                                                           ├ Cua SDK 内嵌运行时
                                                           │  ├ 屏幕 / 窗口 AX
                                                           │  └ 临时或本机批准的现有 Chrome 页面
                                                           ├ Shell
                                                           └ UTF-8 文件
```

## 服务端

| 模块 | 职责 |
| --- | --- |
| `server.py` | HTTP 入口、管理会话、设备认证和连接生命周期 |
| `mcp_gateway.py` | 官方 MCP SDK 的 17 项工具声明、Agent 认证和图片编码 |
| `runtime.py` | 权限交集、会话租约、路由、去重、取消和结果状态 |
| `storage.py` | SQLite 身份、授权、会话与操作元信息 |
| `protocol.py` | 服务与设备共用的能力、工具映射及观察有效期 |
| `static/` | 无前端构建依赖的管理台与品牌矢量资产 |

管理登录、设备 Key 与 Agent Key 不可互换。主体与设备归属从认证和持久关系取得，不接受模型自报身份。每次执行重新检查所有者、设备、Grant、会话、能力和当前连接代次。

SQLite 和在线设备连接由同一服务进程持有，仅支持一个 worker。存储不交给并发线程复用；异步边界保持明确。服务重启将未完成操作标记为结果未知，没有动作重放队列。服务安装不选择 `macos` extra，导入服务模块也不加载 Cua 原生库。

## 设备端

| 模块 | 职责 |
| --- | --- |
| `client.py` | 出站连接、心跳、本机控制、能力上报、持久去重和会话清理 |
| `credentials.py` | 所有者私有文件中的设备凭据、原子写入、权限与服务地址校验 |
| `macos_access.py` | 接收本机选定连接文件的书签，以公开 CoreFoundation API 持有和释放访问作用域 |
| `executor.py` | 将工具路由到 Cua、当前用户级 Shell、UTF-8 文件；转换驱动异常 |
| `cua_driver.py` | 固定 SDK 的同进程适配、目标与引用绑定、AX/DOM 操作及资源回收 |
| `diagnostics.py` | 无客户端第三方依赖也可启动的只读运行环境报告 |
| `native/aBridge.swift` | 菜单栏 UI、权限入口、接管监视、安装修复及子进程管理 |
| `native/build.py` | 可复现构建输入、版本、签名校验和原生构建缓存 |
| `deploy/` | 明确调用的源码安装与可选内网转发工具 |

Cua 锁定为内部 `cua-driver==0.46.1+abridge.1`，基于固定上游源码修复中文 Chrome 授权弹窗的候选窗口过滤，补丁与产物信息保存在 `vendor/cua-driver/`。当前产物仅支持 Apple Silicon/macOS 14+。设备端通过公开 configured SDK 构造入口加载当前 Python 进程内的原生库，并检查 embedded 模式与空 socket；不安装原 CLI、CuaDriver.app、第二套 daemon、模型服务或浏览器引擎。SDK 的浏览器调用限制在固定工具与字段内，模型不能提交任意 JavaScript 或 CDP 方法。

原生 SDK 与异步授权回调使用同一 asyncio 事件循环。构造前通过 UniFFI 官方公开 setter 绑定循环；固定 wheel 仅在生成绑定模块导出该函数，适配边界明确保留这一依赖。活运行时禁止跨循环复用，关闭后新运行时重新绑定。授权会话身份使用当前 driver 的公开 `runtime_scope_prefix()` 与本机准备会话名精确合成，不信任请求自报前缀或后缀匹配。

Swift App 直接启动 Python 子进程，App 负责系统权限 UI。内嵌 SDK 不另外发起授权弹窗。权限归属与实际可操作性须以已安装 App 身份验证；从终端运行相同 Python 的结果只说明终端责任链。

设备运行凭据只读 `state_dir/credentials/device.json`，内容为服务地址与设备 Key。状态目录和凭据目录要求当前所有者700、普通文件600；写入先收紧目录再原子替换，读取拒绝符号链接、错误所有者、不安全权限和不匹配的服务地址。公开 save/load/delete 接口供本机安装与合法迁移使用，不输出秘密。缺文件明确要求重新绑定或由操作者轮换后保存，不回退 Keychain；配置、启动和解绑均不依赖原生凭据助手。解绑删除本机文件，在线时同时请求服务撤销，未确认时如实提示管理台确认。

## 能力与依赖

能力为 `screen`、`input`、`browser`、`shell`、`files`。有效能力取设备 Grant、Agent Grant、本机开关和实际就绪条件的交集；浏览器为独立授权，旧配置与旧 Grant 不自动扩权。前台桌面输入会话保持独占。

本机报告分别保留 Python 版本与依赖、SDK 安装版本与加载状态、系统权限、Chrome 安装版本及活跃专用窗口数量。`permissions.checked=false` 表示尚未检查，不能解释为用户拒绝授权。Chrome 已安装表示可检查连接条件，活跃会话才表示已绑定专用窗口。

依赖安装与修复仅由本机 UI 或明确调用的安装器执行，MCP 不提供安装或扩大授权的接口。暂停持久保存；重连和依赖修复不会自动解除暂停。

## 观察与动作

`computer_apps`、`computer_windows` 用于选择 PID 与 window_id。带这两个目标的 `computer_observe` 返回窗口 AX 树、元素引用和可选截图；`computer_act` 始终对该窗口操作，前台变化不会让动作转投另一窗口。上游不支持的背景动作会拒绝，不自动抢前台。

省略目标的 `computer_observe` 返回主屏视觉观察，不提供 AX 树。像素动作使用返回截图的坐标与 capture 信息；适配层在截图前后及动作前核对前台 PID、窗口 ID 和标题。变化返回 `focus_changed`，缺少可靠窗口证据返回 `focus_unavailable`。这层检查由 aBridge 明确实现，不能仅凭 SDK 的 capture_id 推定。

浏览器默认 `existing_profile` 待本机选择，缺少选择时不自动创建隔离浏览器；`isolated` 仅为显式可选模式。本机 `browser-targets` 只读列出 Chrome 窗口，再以 PID/window_id、进程实例指纹和明确批准保存到配置。调用 SDK prepare 前即核对批准与新鲜身份，auth-host 再核对 SDK 的精确资源和摘要；模型无法提交目标、Profile 路径或批准值。现有模式只绑定该窗口唯一明确的活动标签，随后固定它，不因用户换标签而漂移。SDK 不提供本路径的新建/关闭任务 tab 接口；操作者应先准备专用窗口，`browser_open` 导航的是批准页。

`browser_observe` 返回 DOM 语义元素，可选截图默认关闭。`browser_act` 点击首次即走 `dom_event` 合成事件，填充走 `insert_text` 并替换字段；站点可能拒绝，需要后续观察验证。Cookie 仅由 Chrome 用于登录态，不向模型导出。现有 Profile 连接默认后台，不能安全后台连接时拒绝，不静默激活其他窗口。

现有 Profile 另需本机明确执行 `browser-prepare`。这一步可请求前台连接并由操作者允许 Chrome 提示，创建一个有界的本机 owner SDK 上下文。它以公开 trusted-session 句柄请求最长 8 小时、空闲 30 分钟的授权；到期后结束，不以心跳或读取页面保活。MCP 不能创建或重新准备这个连接，未准备时浏览器不作为可用能力上报。

若系统拒绝读取 Chrome 连接元信息，本机 UI 允许操作者用系统文件选择器仅选 `DevToolsActivePort`。Native 持久保存只读安全作用域书签，并生成所有者600的隐式传递书签；Python 启动和本机准备连接前读取传递书签，通过公开 CoreFoundation 无 UI 解析，再显式持有作用域。成功替换后才释放旧作用域，退出时在 SDK 关闭后释放当前作用域；无效、过期或拒绝状态只影响浏览器，不使 Shell/AX 退出。书签状态不能代替真实受保护文件访问和 DOM 业务验收。

所有观察按 aBridge 会话绑定，10 秒失效；动作消费观察，跨会话或旧引用拒绝。桌面和隔离浏览器分别使用自己的 SDK 会话。现有 Profile 的远程会话独占借用本机 owner 上下文，仍单独保存观察、引用和操作；关闭或正常断线释放远程状态，健康的本机连接可供下一个会话使用。取消或失去回执的在途浏览器写操作会使连接失效并清理，要求本机重新准备，不让未知动作污染后续会话。

暂停、停止、解绑、客户端退出、关闭浏览器能力、变更目标或进程实例失效会结束本机 owner 上下文；租约过期和连接断开均先清理远程任务与引用。隔离模式回收自建 Chrome 与临时 profile；现有模式保留个人 Chrome 和原有标签。更换本机目标只关闭涉及浏览器的会话，不终止独立 Shell 或桌面会话。

## 执行与结果

操作以稳定 `operation_id` 去重，同 ID 改参数拒绝。设备持久记录执行意图和终态，恢复后不自动重放。aBridge 服务只短暂保留结果内容，SQLite 不保存命令、输入、文件正文或截图。

图片通过原生 MCP ImageContent 返回，JSON 元信息不再包含一份重复 base64。原始图片上限为 4 MiB，设备 WebSocket 消息上限为 8 MiB。`executed` 表示执行器回执，不代替业务验证。SDK 调用结果不确定时返回 `outcome_unknown`；取消不能回滚已产生的副作用，也不承诺撤回已经发出的系统输入。

## 验证与演进

`abridge/__init__.py` 是版本唯一来源。0.2.0 的本地协议、授权、引用隔离和回收测试已通过，真实固定 SDK 已完成构造、诊断、回调与关闭检查。本轮已安装 App 经 Yuxi 的普通窗口 AX 中文输入、点击及回收，以及现有 Chrome 登录态、DOM 业务和同一 owner 连接的两次会话复用均已独立复核。额外小窗坐标请求实际由 SDK 走 AX hit-test 背景路由，不能作为物理 CGEvent 或来源 PID 过滤的业务证据；后者尚未实测。具体见 [验证范围](verification.md)。

后续事项见 [工作计划](roadmap.md)，设计与资产入口见 [设计说明](design.md)。原型中的候选架构和演示界面不等于已实现系统。
