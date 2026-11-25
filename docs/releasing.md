# 发布

1. 从上个发布 tag 开始核对变更，在根 `package.json` 中修改版本号。把版本、日期和变更写入变更记录。涉及协议、数据库或安装方式的调整，一起写清升级步骤。[变更记录](changelog.md)
2. 版本提交进入 `main` 后，在该提交上创建并推送对应的 `v<version>` tag。发布工作流会核对版本和提交归属。
3. Release 工作流构建并验证 Server、浏览器扩展、macOS App、Linux CLI 和 Windows 预览包。启用 Android 签名时，也会打包 APK。构建成功后检查 GitHub Release 中的文件和校验和。

分发包内应保留项目和第三方组件的许可证。[Apache-2.0](https://github.com/xerrors/aBridge/blob/main/LICENSE) · [第三方许可](third-party-notices.md)

## npm

公开包默认为 `@xerrors/abridge`，包含编译后的 Server、管理台和服务端依赖。更名时设置仓库变量 `NPM_PACKAGE_NAME`。

第一次发布前，在已登录 npm 的终端构建公开包：

```sh
npm install
npm run build
node --import tsx tools/package-release.ts --public
npm run package:check
npm publish dist/releases/*.tgz --access public
```

也可以用 npm staged publishing 暂存首包，核对后再确认。发布前检查 npm CLI 的登录状态，按提示完成账户验证。首包发布后，在 npm 包的 Settings 添加 Trusted Publisher。

| 字段                 | 值                                   |
| -------------------- | ------------------------------------ |
| Provider             | GitHub Actions                       |
| Organization or user | `xerrors`                            |
| Repository           | `aBridge`                            |
| Workflow filename    | `release.yml`                        |
| Environment          | 留空，本 workflow 不声明 environment |
| Allowed actions      | 启用直接 `npm publish`               |

新建 Trusted Publisher 默认只允许 staged publishing；本仓库 tag 工作流使用直接发布，需显式允许。完成配置后及时用首个 tag 验证，npm 的新信任配置在两天内未首次成功发布会过期。最后设置仓库变量 `NPM_PUBLISH_ENABLED=true`，后续 tag 使用 OIDC 发布，不设置长期 npm token。未开启该变量时仍构建和生成 GitHub Release，并在摘要明确 npm 被跳过。

首次引导也可先保持 `NPM_PUBLISH_ENABLED=false`，推送 tag 生成 GitHub 候选产物，再人工发布同版本首包、配置 npm 信任并打开该变量。之后先递增根版本，再创建新的 tag；不要对已人工发布的同版本重跑 npm 发布。

带预发布后缀的版本使用 npm `next`，并标记为 GitHub Pre-release。无后缀的版本作为正式版发布，使用 npm `latest`。已存在版本不可覆盖；修改版本后再创建新的 tag。

npm 发布完成后，用 `npx @xerrors/abridge --web` 验证可安装性。通过 GitHub Release 分发时，按快速开始里的 tarball 命令验证。[快速开始](guide/start.md)

[npm 官方可信发布说明](https://docs.npmjs.com/trusted-publishers/) · [npm trust 的包存在前提](https://docs.npmjs.com/cli/v11/commands/npm-trust/)

## macOS

GitHub 的 `macos-15` Apple Silicon runner 先构建 ad hoc 签名、未经公证的 `aBridge-<version>-macos-arm64-unsigned.zip`。App 随包带上 Swift 客户端、更新器和 arm64 Cua dylib，用户数据保存在 `~/Library/Application Support/aBridge`。应用支持 Apple Silicon 和 macOS 14 及以上版本。

本地构建：

```sh
npm run build
npm run package:macos -- --reuse-build
```

面向其他用户稳定分发需要 Apple Developer Program、Developer ID Application 证书与私钥，以及 Apple 公证凭据。准备好后添加 GitHub Secrets：

| Secret                       | 内容                                     |
| ---------------------------- | ---------------------------------------- |
| `APPLE_CERTIFICATE_BASE64`   | 含私钥的 Developer ID `.p12` 文件 Base64 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 导出密码                          |
| `APPLE_SIGNING_IDENTITY`     | `Developer ID Application: ... (TEAMID)` |
| `APPLE_API_KEY_BASE64`       | App Store Connect API `.p8` 私钥 Base64  |
| `APPLE_API_KEY_ID`           | API key ID                               |
| `APPLE_API_ISSUER`           | API issuer ID                            |

设置仓库变量 `APPLE_SIGNING_ENABLED=true` 才执行签名公证。缺任一输入会明确失败，不把未签名产物冒充正式包。临时 keychain 与私钥在该步骤退出时清理；内嵌 Mach-O 先签名，再签 App；公证 Accepted 后 staple 并输出 `*-notarized.zip`。

验收时解压实际发布的 App，检查启动、录屏和辅助功能权限。ad hoc 签名变化后，macOS 可能要求重新授权。继续使用同一 Developer ID 签名，可保持发布身份一致。

[Apple 官方公证说明](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) · [GitHub 官方 runner 列表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

## Windows

CI 和 tag 发布复用 `windows-client.yml`。Windows runner 执行 `npm run check`、`npm run windows:shell:check`、`npm run package:windows` 和 `npm run package:windows:check`。完整解压后的程序目录须小于 10,000,000 字节。

CI 上传 **windows-client-unsigned**，保留 30 天。tag 发布另将 `aBridge-<version>-windows-x64-unsigned.zip` 和同名 `.sha256` 附在 GitHub Release 中。创建 Release 前会再次核对 ZIP 的 SHA-256。Windows 仍以未签名便携预览包分发。[Windows 安装与验证](windows-client.md)

## Android

发布正式 APK 时，设置 `ANDROID_SIGNING_ENABLED=true`，并配置 `ANDROID_KEYSTORE_BASE64`（密钥库的单行 Base64）、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS` 和 `ANDROID_KEY_PASSWORD`。工作流重新压缩并对齐 APK，然后签名。在加入 GitHub Release 前，检查 `aBridge-<version>-android.apk` 签名和 200,000 字节的体积上限。

后续版本继续使用同一签名密钥，已安装用户即可原地升级。Android 安装器会检查包标识、签名和版本。调试 APK 使用开发签名，供本地和 CI 测试。

## Linux

发布复用 Linux CI，在原生 amd64 和 arm64 runner 上构建 musl 静态包，并验证打包二进制与 Server 联调、用户级 systemd 生命周期。两个架构均须通过才进入发布。GitHub Release 附带两个架构各自的 `abridge-client-<version>-<target>.tar.gz` 和一份 `SHA256SUMS`。各架构的体积报告和单独的校验文件留在 CI artifact 中。下载后按 [Linux 安装说明](https://github.com/xerrors/aBridge/blob/main/apps/linux-client/README.md#安装与绑定) 核对校验和。

GitHub Release 同时附带 `abridge-client-browser-<version>-linux.tar.gz` 和 `install-browser-client.sh`。运行 `npm run package:browser-client` 会在 `.local/release/browser-client/` 生成两者。安装器使用根版本和本次生成的压缩包 SHA-256。发布任务校验包内版本，核对两份产物并将其 SHA-256 汇总到 `SHA256SUMS`。[无头 Linux 浏览器安装流程](deployment.md#无头-linux-浏览器客户端)

## Chrome 应用商店

`dist/releases/abridge-browser-<version>.zip` 是商店上传包。首次上传在开发者信息中心完成，需准备商店名称、简要说明、用途、截图、图标、隐私政策及权限用途说明。上传后还需完成商店审核并取得 item ID；首次发布状态以信息中心为准。

tag 工作流会生成商店 ZIP。到开发者信息中心提交审核，再核对上架状态。若以后启用自动上传，使用已登记的 item ID 和 Chrome Web Store API 凭据。

## 容器镜像发布

`release.yml` 在正式 GitHub Release 创建成功后显式调用可复用的 `.github/workflows/container.yml` 构建镜像，也支持手动输入已发布的正式 tag 补发。使用 `GITHUB_TOKEN` 创建 Release 不会触发另一个 release 事件工作流，因此发布链路直接调用。带预发布后缀的版本不生成容器镜像。使用对应 tag 的源码和当前 Dockerfile，在原生 amd64、arm64 Linux runner 分别构建并验收健康接口、页面脚本、管理员认证及 Server 分发边界，再向 GHCR 推送版本和 `latest` 多架构清单。发布权限使用临时 `GITHUB_TOKEN`，不配置长期 registry token。

首次推送后，在 GitHub Package 设置中把镜像可见性设为 Public，并实际验证匿名拉取。[Docker 部署](deployment.md#docker-镜像)
