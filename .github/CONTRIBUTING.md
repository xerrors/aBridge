# 贡献指南

## 开发环境

使用 Node.js 26.7.0–26.x 与 npm；根 `package.json` 和锁文件定义依赖及脚本。产品代码统一使用 strict TypeScript，管理台使用 Preact；macOS 壳仍使用 Swift，构建 App 另需 Xcode Command Line Tools。

```sh
npm ci
npm run build
npm run check
```

`npm ci` 安装锁定依赖；构建生成可运行 JavaScript、管理台和扩展，不在用户运行时调用编译器。检查包含类型、格式、测试及分发边界，具体步骤以根脚本为准。编辑后使用 `npm run format`。

源码按 npm workspaces 管理，运行依赖归应用声明，根目录只声明开发工具：

| 目录                 | 职责                                                  |
| -------------------- | ----------------------------------------------------- |
| `apps/server/`       | Server、唯一 Server CLI、MCP、授权和持久化            |
| `apps/desktop/`      | 桌面执行器与唯一 Desktop CLI；`native/` 内含 Swift 壳 |
| `apps/browser/`      | 独立扩展；`src/` 为逻辑，`public/` 为静态资源         |
| `apps/web/`          | 随 Server 分发的管理台                                |
| `packages/protocol/` | 跨进程共享契约                                        |
| `packages/shared/`   | Node 应用共享的路径约定                               |
| `tools/`             | 构建、安装与分发检查                                  |
| `tools/fixtures/`    | 自有桌面窗口和浏览器表单                              |

应用内部使用相对导入；共享包只通过 `@abridge/protocol`、`@abridge/shared/paths` 导入，不直接遍历其他应用源码。`npm run architecture:check` 校验生产导入图、声明依赖与 workspace 接口；应用测试放在各自 `tests/` 中。

## 修改与验证

修改职责前读 [架构](../docs/architecture.md)。共享契约在协议包中维护；外部输入用运行时 schema 校验，再交给持有明确类型的实现。保持授权交集、操作去重和未知副作用不重放的语义。

围绕公共行为和关键竞态验证，不复制实现。单元与集成测试使用临时数据目录、虚构身份和自有目标；涉及真实系统权限、截图或输入时，另行说明实际验证范围。个人账号、部署地址、日志和验收流水不进入仓库或 CI。

默认检查不要求桌面 SDK 在 Server 进程中加载。原生 SDK 的加载与桌面业务测试须区别于协议替身；构建通过不能证明已安装 App 的 TCC 权限或实际输入可用。

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

版本只在根 `package.json` 维护，构建和打包生成其余产物的版本。修改包内容时核对 Server 分发包不带桌面 SDK，扩展只包含已构建的浏览器资源，App 安装器复制独立运行时而不是依赖 npm 临时缓存路径。

[部署文档](../docs/deployment.md) 说明本地分发与安装。候选包可以先从本地 tarball 验证；包名存在于构建脚本不代表 npm 已发布。项目使用 Apache-2.0 许可证，第三方组件保留各自的许可。公开发布或替换真实部署须按用户任务范围执行。
