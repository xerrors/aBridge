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
                                                           │  └ 自建 Chrome 临时 profile
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
| `executor.py` | 将工具路由到 Cua、当前用户级 Shell、UTF-8 文件；转换驱动异常 |
| `cua_driver.py` | 固定 SDK 的同进程适配、目标与引用绑定、AX/DOM 操作及资源回收 |
| `diagnostics.py` | 无客户端第三方依赖也可启动的只读运行环境报告 |
| `native/aBridge.swift` | 菜单栏 UI、权限入口、Keychain、接管监视、安装修复及子进程管理 |
| `native/build.py` | 可复现构建输入、版本、签名校验和原生构建缓存 |
| `deploy/` | 明确调用的源码安装与可选内网转发工具 |

Cua 锁定为 `cua-driver==0.46.1`，通过公开的 configured SDK 构造入口加载当前 Python 进程内的原生库，并检查运行模式为 embedded、socket 为空。aBridge 继续提供自己的远程 MCP 和身份边界，不启动 CuaDriver.app、第二套 daemon、模型服务或浏览器引擎。SDK 的浏览器调用限制在固定工具与字段内，模型不能提交任意 JavaScript 或 CDP 方法。

Swift App 直接启动 Python 子进程，App 负责系统权限 UI。内嵌 SDK 不另外发起授权弹窗。权限归属与实际可操作性须以已安装 App 身份验证；从终端运行相同 Python 的结果只说明终端责任链。

## 能力与依赖

能力为 `screen`、`input`、`browser`、`shell`、`files`。有效能力取设备 Grant、Agent Grant、本机开关和实际就绪条件的交集；浏览器为独立授权，旧配置与旧 Grant 不自动扩权。前台桌面输入会话保持独占。

本机报告分别保留 Python 版本与依赖、SDK 安装版本与加载状态、系统权限、Chrome 安装版本及活跃专用窗口数量。`permissions.checked=false` 表示尚未检查，不能解释为用户拒绝授权。Chrome 已安装表示可检查连接条件，活跃会话才表示已绑定专用窗口。

依赖安装与修复仅由本机 UI 或明确调用的安装器执行，MCP 不提供安装或扩大授权的接口。暂停持久保存；重连和依赖修复不会自动解除暂停。

## 观察与动作

`computer_apps`、`computer_windows` 用于选择 PID 与 window_id。带这两个目标的 `computer_observe` 返回窗口 AX 树、元素引用和可选截图；`computer_act` 始终对该窗口操作，前台变化不会让动作转投另一窗口。上游不支持的背景动作会拒绝，不自动抢前台。

省略目标的 `computer_observe` 返回主屏视觉观察，不提供 AX 树。像素动作使用返回截图的坐标与 capture 信息；适配层在截图前后及动作前核对前台 PID、窗口 ID 和标题。变化返回 `focus_changed`，缺少可靠窗口证据返回 `focus_unavailable`。这层检查由 aBridge 明确实现，不能仅凭 SDK 的 capture_id 推定。

`browser_open` 只创建当前会话拥有的 Chrome 临时 profile，并绑定其唯一明确窗口与页面。`browser_observe` 返回 DOM 语义元素，可选截图默认关闭。`browser_act` 的点击首次即走 `dom_event` 合成事件，填充走 `insert_text` 并替换字段；站点可能拒绝合成事件，需要后续观察验证。个人 profile、登录状态和用户已有标签不在此路径中。

所有观察按 aBridge 会话绑定，10 秒失效；动作消费观察，跨会话或旧引用拒绝。aBridge 会话对应一个 SDK 会话。关闭、租约过期、授权失效、能力关闭会按会话通知设备；暂停、停止和断线关闭全部本机 SDK 上下文。SDK 结束会话回收其创建的 Chrome 进程与临时 profile，保留其他会话和用户浏览器。

## 执行与结果

操作以稳定 `operation_id` 去重，同 ID 改参数拒绝。设备持久记录执行意图和终态，恢复后不自动重放。aBridge 服务只短暂保留结果内容，SQLite 不保存命令、输入、文件正文或截图。

图片通过原生 MCP ImageContent 返回，JSON 元信息不再包含一份重复 base64。原始图片上限为 4 MiB，设备 WebSocket 消息上限为 8 MiB。`executed` 表示执行器回执，不代替业务验证。SDK 调用结果不确定时返回 `outcome_unknown`；取消不能回滚已产生的副作用，也不承诺撤回已经发出的系统输入。

## 验证与演进

`abridge/__init__.py` 是版本唯一来源。0.2.0 的本地协议、授权、引用隔离和回收测试已通过，真实固定 SDK 已完成只读构造、诊断与关闭检查。本轮已安装 App 身份下的 AX 中文输入、DOM 填表及 Yuxi 业务闭环仍待验收，见 [验证范围](verification.md)。

后续事项见 [工作计划](roadmap.md)，设计与资产入口见 [设计说明](design.md)。原型中的候选架构和演示界面不等于已实现系统。
