# 贡献指南

## 开发环境

使用 Node.js 22.13.0+ 与 npm；各 workspace 的 `package.json` 声明依赖，根目录提供开发脚本。Server、扩展和管理台使用 strict TypeScript，管理台使用 Preact；macOS 使用 Swift 6 原生运行时及 AppKit UI，构建 App 另需 Xcode Command Line Tools。

```sh
npm install
npm run build
npm run check
```

`npm install` 会生成本地锁文件，供打包和分发检查使用；构建生成 Server JavaScript、管理台、扩展及 macOS 原生 App（Apple Silicon 上），不在用户运行时调用编译器。检查包含类型、格式、测试及分发边界，具体步骤以根脚本为准。编辑后使用 `npm run format`。

源码按 npm workspaces 管理，运行依赖归应用声明，根目录只声明开发工具：

| 目录                           | 职责                                               |
| ------------------------------ | -------------------------------------------------- |
| `apps/server/`                 | Server、唯一 Server CLI、MCP、授权和持久化         |
| `apps/desktop/`                | 原生桌面客户端、AppKit UI 与更新器                 |
| `apps/linux-client/`           | Rust Linux CLI、Shell/File 执行与 systemd 用户服务 |
| `apps/browser/`                | 独立扩展；`src/` 为逻辑，`public/` 为静态资源      |
| `apps/web/`                    | 随 Server 分发的管理台                             |
| `packages/protocol/`           | 跨进程共享契约                                     |
| `packages/shared/`             | Node 应用共享的路径约定                            |
| [`tools/`](../tools/README.md) | 构建、安装与分发检查                               |
| `tools/fixtures/`              | 自有桌面窗口和浏览器表单                           |

应用内部使用相对导入；共享包只通过 `@abridge/protocol`、`@abridge/shared/paths` 导入，不直接遍历其他应用源码。`npm run architecture:check` 校验生产导入图、声明依赖与 workspace 接口；应用测试放在各自 `tests/` 中。

Linux CLI 开发另需 Rust（含 rustfmt、Clippy）；版本及安装命令见 [Linux 客户端说明](../apps/linux-client/README.md)。`npm run linux:build` 从共享协议生成原生契约并构建，`npm run linux:check` 运行 Rust 检查及真实 Server 联调，`npm run package:linux` 在 Linux 生成分发包。Linux CI 在 amd64/arm64 上执行这些检查并验证真实用户级 systemd。普通 `npm run check` 仍负责 Node/协议与现有分发；Linux 改动必须同时通过 `linux:check`。

## 接手阅读顺序

先读 [README](../README.md) 的工作方式，再看[执行链与状态归属](../docs/architecture.md#执行链与状态归属)。按要修改的行为选择一条链路阅读：

| 行为                   | 代码路径                                                                                           | 重点回归入口                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 普通工具调用           | 协议参数 → `server/mcp.ts` → `control.ts` → 设备客户端 → 执行器                                    | Server `server.test.ts`、`session-recovery.test.ts`         |
| 浏览器脚本与页面输入   | `browser-execution.ts` → `browser-runtime.ts` → 普通工具链 → `browser/bridge.ts`                   | Server `browser-code.test.ts`、Browser `bridge.test.js`     |
| 浏览器连接、停止与重连 | `browser/worker.ts` → `client.ts` → `task-tabs.ts`                                                 | Browser `worker.test.js`、Server `browser-worker.test.ts`   |
| 桌面观察与输入         | `desktop/native/runtime/Client.swift` → `Executor.swift` → `Computer.swift` → `NativeDriver.swift` | Desktop `native-execution.test.ts`、`native-client.test.ts` |

TypeScript 路径位于对应 `apps/*/src/`，Swift 路径位于 `apps/desktop/native/`，测试位于 `apps/*/tests/`。阅读异步流程时先确认状态所有者、资源失效条件和副作用开始位置，再跟踪正常结果与取消回执；设备连接、控制会话、任务标签和单次操作有不同的生命周期。

## 修改与验证

修改职责前读 [架构](../docs/architecture.md)。共享契约在协议包中维护；外部输入用运行时 schema 校验，再交给持有明确类型的实现。保持授权交集、操作去重和未知副作用不重放的语义。

围绕公共行为和关键竞态验证，不复制实现。单元与集成测试使用临时数据目录、虚构身份和自有目标；涉及真实系统权限、截图或输入时，另行说明实际验证范围。个人账号、部署地址、日志和验收流水不进入仓库或 CI。

默认检查不要求桌面 SDK 在 Server 进程中加载。原生 SDK 的加载与桌面业务测试须区别于协议替身；构建通过不能证明已安装 App 的 TCC 权限或实际输入可用。

### 回归与长期维护

修复前确认失败证据和预期行为，区分已知事实与推测；偶发问题无法稳定复现时，可依据日志或代码中的明确违约修复，并说明验证限制。验证范围取决于行为风险，不按修改文件数量或审查轮数决定。

- **契约与状态有明确归属。** 跨模块共享的含义在协议或架构中定义，使用方复用；修改异步流程时核对受影响的状态转换、失效条件和副作用边界，避免各层自行推断。
- **回归保护放在能发现问题的最小边界。** 优先扩展现有测试；只有问题跨越进程、产物或系统环境时，才增加对应层级的集成或真实环境验收。独立验证检查原失败和实现可能遗漏的路径，不要求每次遍历全部入口。
- **验证面向使用结果。** 构建、协议回执、安装和业务效果各有自己的证据。分发检查保留工作区外的候选包消费验证；具体覆盖和运行入口维护在[工具索引](../tools/README.md)，不在协作规则中重复实现细节。

同类问题反复出现或单次影响足够大时，优先消除重复实现或增加有区分力的回归用例；需要解释的设计约束就地写入现有文档。只有可复用的多步工作流才考虑 Skill。无需为每次修复新增规则或复盘文件；调整实现时同步更新或删除失效约束，不长期叠加补丁式规定。私有事故过程留在 `.local/`，长期有效的契约、理由和可复现测试进入版本控制，不能只保存在聊天或本地记录中。

## 提交规范

使用 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/zh-hans/v1.0.0/)：

```text
<type>[(scope)][!]: <description>

[body]

[footer]
```

允许类型为 `feat`、`fix`、`refactor`、`perf`、`docs`、`test`、`build`、`ci`、`chore`、`style`、`revert`。scope 可选，例如 `server`、`browser`、`desktop`、`tools`。标题不超过100字符，描述具体变化；正文说明原因与必要验证。破坏性变更使用 `!` 或 `BREAKING CHANGE:` footer。

```text
fix(browser): isolate task cancellation by session
refactor(desktop): separate native driver initialization
build: package server without desktop dependencies
```

每个提交只表达一个可解释的逻辑变化，相关代码、测试和文档一起提交；批量格式化与功能修改尽量分开。历史提交保留，新规范用于后续提交，不为标题样式重写已发布历史。

仓库的 `.github/hooks/commit-msg` 使用已安装的 commitlint。启用本地检查：

```sh
npm run hooks
```

已有自定义 hooks 时手动整合校验。自动化可通过 `npm run commitlint -- --edit <message-file>` 检查单条消息，或使用 commitlint 的 `--from`/`--to` 检查明确的提交范围。启用规则不代表已有未提交改动已按主题拆分。

## 版本与分发

版本只在根 `package.json` 维护，构建和打包生成其余产物的版本。修改包内容时核对 Server 分发包不带桌面 SDK，扩展只包含已构建的浏览器资源，App 包内包含原生客户端、更新器与 SDK，不包含 Node 或 npm 依赖。

[部署文档](../docs/deployment.md) 说明本地分发与安装。候选包可以先从本地 tarball 验证；包名存在于构建脚本不代表 npm 已发布。项目使用 Apache-2.0 许可证，第三方组件保留各自的许可。公开发布或替换真实部署须按用户任务范围执行。
