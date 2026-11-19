# 开发工具索引

`tools/` 只用于开发、构建、安装、发布和验证。已构建的 Server、macOS App 与浏览器扩展运行时不依赖此目录；产品代码和运行依赖分别归属 `apps/`、`packages/` 及各 workspace。现有 `architecture:check` 会检查生产导入边界，禁止应用跨目录导入这里的工具代码。

本地 npm 命令以根 [package.json](../package.json) 为单源；下表列出脚本名称，不重复其实现命令。CI 专用步骤见 [发布工作流](../.github/workflows/release.yml)。

## 日常构建、检查与通用发布

| 文件                                           | 用途                                            | 入口                                      |
| ---------------------------------------------- | ----------------------------------------------- | ----------------------------------------- |
| [build.ts](build.ts)                           | 构建 Server、Desktop CLI、管理台和扩展          | `build`，也由 `pretest` 调用              |
| [test.ts](test.ts)                             | 发现并执行各 workspace 与工具的自动测试         | `test`                                    |
| [browser-live.ts](browser-live.ts)             | 通过 ego-browser 在真实引擎上验收代码执行与输入 | `test:browser:live`（需本机 ego-browser） |
| [check-architecture.ts](check-architecture.ts) | 校验生产导入、运行依赖归属与 workspace 接口     | `architecture:check`                      |
| [package-release.ts](package-release.ts)       | 生成 Server tarball 与扩展 ZIP                  | `package`；发布 CI 使用公开分发参数       |
| [check-package.ts](check-package.ts)           | 校验分发边界及候选包离线安装、CLI/HTTP/WASM     | `package:check`                           |
| [check-release.ts](check-release.ts)           | 校验发布标签、版本及 main 历史                  | 发布 CI                                   |

`check` 串联格式、架构、类型、测试和分发检查。[普通 CI](../.github/workflows/ci.yml) 在 Ubuntu 的最低支持 Node 版本运行 `check`，其余 Ubuntu Node 版本运行 `test`，两个 macOS runner 各用一版 Node 运行 `test:desktop`。普通 CI 和 Linux 客户端检查在 PR、主分支 push 及手动触发时运行。发布流程见 [发布说明](../docs/releasing.md)。

源码测试可能借用工作区的依赖和资源，因此分发检查还需验证用户实际安装的候选包。`package:check` 通过 [check-installed-package.ts](lib/check-installed-package.ts) 在工作区外、空缓存下离线安装 tarball，再核对安装后的 CLI 版本、HTTP、管理台资源及 QuickJS/WASM 初始化。安装脚本禁用，使用隔离配置与本机临时端口，结束后停止进程并清理目录。普通 CI 在 Ubuntu 的最低支持 Node 版本执行这一检查，发布 CI 在 Linux 校验最终分发包。

[package-consumer.test.ts](tests/package-consumer.test.ts) 使用受控进程验证检查器会拒绝缺失资源及提前异常退出、保留验证与关闭的双重错误，并关闭进程；由 `test` 自动发现，无需预先打包。实际依赖和 WASM 仍由候选包检查验证。分发方式、CLI 或脚本运行时调整时，同步维护对应探针和测试，不把当前依赖布局当成永久契约。

## 浏览器 Benchmark

`npm run benchmark:miniwob` 使用固定模型的真实 Codex Agent，通过 MCP、Server、WebSocket 和实际扩展完成冻结的 MiniWoB++ 任务（6 类 × 2 个种子）。需要已登录的 Codex CLI 和 Chrome for Testing；入口为 `tools/bench/agent-run.ts`。`benchmark:smoke` 单独运行固定策略冒烟测试。真实评测不纳入 CI；CI 只核验已提交结果与 README 一致。[方法、评分与复现](../docs/benchmarks/miniwob.md)。

## macOS 构建、安装与发布

| 文件                                           | 用途                                 | 入口                                       |
| ---------------------------------------------- | ------------------------------------ | ------------------------------------------ |
| [build-native.ts](build-native.ts)             | 编译、签名并按输入指纹复用 App 壳    | `desktop:build`；安装器和 macOS 打包器调用 |
| [install-desktop.ts](install-desktop.ts)       | 安装包含原生程序与 SDK 的 App        | `desktop:install`；macOS 打包器调用        |
| [package-macos.ts](package-macos.ts)           | 生成包含运行时的便携 App 分发包      | `package:macos`；发布 CI                   |
| [sign-macos-release.sh](sign-macos-release.sh) | 配置临时签名环境并执行签名、公证打包 | 发布 CI 在签名启用时调用                   |

构建与安装参数见 [部署说明](../docs/deployment.md)。这些脚本在准备产品时执行，安装完成后的 App 使用包内 Swift 程序和 Cua dylib。

## Linux 原生客户端

[linux-client.ts](linux-client.ts) 提供 `linux:build`、`linux:check`、`package:linux`。它从协议包的原生导出选择 Linux 使用的消息与 Shell/File 参数 schema，在构建时嵌入 Rust 客户端；版本仍由根 `package.json` 决定。`linux:check` 检查 Rust 格式、单元测试与 Clippy，并构建当前源码执行真实 Server 联调和跨语言契约测试；调用 Cargo 时锁定依赖。

构建产物为 `dist/linux-client/<target>/abridge-client`。Linux 打包要求 ELF 文件，生成确定性 tar.gz、依赖许可证、SHA-256 和体积报告，并限制二进制 ≤15 MiB、压缩包 ≤5 MiB。正式 CI 使用 musl 静态目标，核验产物没有 ELF 动态解释器和动态库依赖。macOS 本机构建只用于开发验证，不能冒充 Linux 分发。

[Linux 工作流](../.github/workflows/linux-client.yml) 在 amd64/arm64 原生 Ubuntu runner 上验证 Rust、Server 协议集成、包内可执行文件和真实用户级 systemd 安装、暂停持久化、重启与卸载。实际服务验收只使用虚构 Token、自有回环 fixture 和临时状态目录。工具链与安装说明见 [Linux 客户端](../apps/linux-client/README.md)。

## 按需品牌资源生成

| 文件                                         | 用途                                 | 入口                         |
| -------------------------------------------- | ------------------------------------ | ---------------------------- |
| [generate-icons.ts](generate-icons.ts)       | 统一导出 App、扩展、管理台和商店素材 | `icons`                      |
| [brand-wordmark.swift](brand-wordmark.swift) | 生成品牌字标矢量轮廓                 | `generate-icons.ts` 编译调用 |

仅在修改品牌源时运行，正常构建与安装使用已导出的资源；依赖和资源单源见 [设计规范](../docs/design.md)。

## 共用模块、配置与测试

| 文件或目录                                                     | 用途                                      | 使用位置                           |
| -------------------------------------------------------------- | ----------------------------------------- | ---------------------------------- |
| [lib/process.ts](lib/process.ts)                               | 共用外部进程执行封装                      | 原生构建、安装、打包及其他工具模块 |
| [config/commitlint.json](config/commitlint.json)               | 提交消息规范                              | `commitlint`、commit hook 与 CI    |
| [tests/desktop-install.test.ts](tests/desktop-install.test.ts) | 安装参数、原生程序/SDK 校验及构建指纹测试 | `test.ts` 自动发现                 |
| [fixtures/desktop.swift](fixtures/desktop.swift)               | 受控桌面窗口验收目标                      | 手工验收                           |
| [fixtures/browser_fixture.ts](fixtures/browser_fixture.ts)     | 受控浏览器表单与登录态验收目标            | 手工验收、浏览器商店验收           |
| [fixtures/README.md](fixtures/README.md)                       | 启动验收目标、核对结果与清理说明          | 手工验收指南                       |

`fixtures/` 保存可复用的受控验收源码，不是中间过程产物。临时编译文件使用临时目录，验收后清理；需要保留的日志、截图和验收结果放入已忽略的 `.local/`，不混入 `tools/`。

`test:browser:live` 使用自有本机 HTTP 页面，核对三条批量提交的服务端记录、数字/邮箱替换与清空、跨调用状态、条件等待、长文快照分页、表格提取、键盘、滚动和同源 iframe 输入。测试直接运行实际 BrowserBridge 与 QuickJS，通过薄 Chrome API 适配器调用真实 CDP；它不替代已安装扩展的绑定、WebSocket 重连或商店包验收。标准 `check` 保持无需真实浏览器；服务端与扩展 worker 的线缆集成由自动测试单独覆盖。

`npm run test:browser:reliability:live` 使用独立真实 Chrome 和自有页面验证通用输入与恢复。`benchmark:miniwob -- --model-catalog /absolute/path/to/models.json` 固定实际模型元数据并记录其摘要，`--holdout` 单独运行额外 seed=2（非盲测）。[对照方法与边界](../docs/benchmarks/browser-reliability-v2.md)。
原生回归覆盖电脑执行、WebSocket/Shell 生命周期、共享契约、授权和原生更新器。`npm run test:desktop` 在 Apple Silicon macOS 构建完整 App，运行 `apps/desktop/tests/` 下的测试以及 `tools/tests/` 下的原生和安装器测试。macOS 上的 `npm run check` 也会构建完整 App 并运行全部测试。
