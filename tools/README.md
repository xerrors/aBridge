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
| [check-package.ts](check-package.ts)           | 校验分发内容、版本与依赖边界                    | `package:check`                           |
| [check-release.ts](check-release.ts)           | 校验发布标签、版本及 main 历史                  | 发布 CI                                   |

`check` 串联格式、架构、类型、测试和分发检查；发布流程见 [发布说明](../docs/releasing.md)。

## macOS 构建、安装与发布

| 文件                                           | 用途                                 | 入口                                       |
| ---------------------------------------------- | ------------------------------------ | ------------------------------------------ |
| [build-native.ts](build-native.ts)             | 编译、签名并按输入指纹复用 App 壳    | `desktop:build`；安装器和 macOS 打包器调用 |
| [install-desktop.ts](install-desktop.ts)       | 安装独立 Node、桌面依赖与 App        | `desktop:install`；macOS 打包器调用        |
| [package-macos.ts](package-macos.ts)           | 生成包含运行时的便携 App 分发包      | `package:macos`；发布 CI                   |
| [sign-macos-release.sh](sign-macos-release.sh) | 配置临时签名环境并执行签名、公证打包 | 发布 CI 在签名启用时调用                   |

构建与安装参数见 [部署说明](../docs/deployment.md)。这些脚本在准备产品时执行，安装完成后的 App 使用已复制的运行时。

## 按需品牌资源生成

| 文件                                         | 用途                                 | 入口                         |
| -------------------------------------------- | ------------------------------------ | ---------------------------- |
| [generate-icons.ts](generate-icons.ts)       | 统一导出 App、扩展、管理台和商店素材 | `icons`                      |
| [brand-wordmark.swift](brand-wordmark.swift) | 生成品牌字标矢量轮廓                 | `generate-icons.ts` 编译调用 |

仅在修改品牌源时运行，正常构建与安装使用已导出的资源；依赖和资源单源见 [设计规范](../docs/design.md)。

## 共用模块、配置与测试

| 文件或目录                                                     | 用途                                         | 使用位置                           |
| -------------------------------------------------------------- | -------------------------------------------- | ---------------------------------- |
| [lib/dependency-closure.ts](lib/dependency-closure.ts)         | 复制锁定的桌面生产依赖及许可                 | 安装器、安装测试                   |
| [lib/node-runtime.ts](lib/node-runtime.ts)                     | 获取官方 Node 并校验版本、校验和与可搬移性   | 安装器、安装测试                   |
| [lib/process.ts](lib/process.ts)                               | 共用外部进程执行封装                         | 原生构建、安装、打包及其他工具模块 |
| [lib/sign-runtime.ts](lib/sign-runtime.ts)                     | 在封装 App 前签名嵌套原生代码                | 原生构建                           |
| [config/commitlint.json](config/commitlint.json)               | 提交消息规范                                 | `commitlint`、commit hook 与 CI    |
| [tests/desktop-install.test.ts](tests/desktop-install.test.ts) | 安装参数、依赖复制、运行时校验及构建指纹测试 | `test.ts` 自动发现                 |
| [fixtures/desktop.swift](fixtures/desktop.swift)               | 受控桌面窗口验收目标                         | 手工验收                           |
| [fixtures/browser_fixture.ts](fixtures/browser_fixture.ts)     | 受控浏览器表单与登录态验收目标               | 手工验收、浏览器商店验收           |
| [fixtures/README.md](fixtures/README.md)                       | 启动验收目标、核对结果与清理说明             | 手工验收指南                       |

`fixtures/` 保存可复用的受控验收源码，不是中间过程产物。临时编译文件使用临时目录，验收后清理；需要保留的日志、截图和验收结果放入已忽略的 `.local/`，不混入 `tools/`。

`test:browser:live` 使用自有本机 HTTP 页面，核对三条批量提交的服务端记录、数字/邮箱替换与清空、跨调用状态、条件等待、长文快照分页、表格提取、键盘、滚动和同源 iframe 输入。测试直接运行实际 BrowserBridge 与 QuickJS，通过薄 Chrome API 适配器调用真实 CDP；它不替代已安装扩展的绑定、WebSocket 重连或商店包验收。标准 `check` 保持无需真实浏览器；服务端与扩展 worker 的线缆集成由自动测试单独覆盖。
