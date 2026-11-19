# 发布

软件版本只修改根 `package.json`。发布使用 `v<version>` tag，tag 必须与该版本完全相同，提交必须在 `main` 历史中。`.github/workflows/release.yml` 在 tag 推送后验证源码，在 Linux 打包并验证最终 Server 和浏览器 ZIP，在 macOS 构建并验证 Apple Silicon App，并运行 Linux CLI 发布检查。

创建 tag 前，将本次版本号、日期、发布状态及变更摘要写入[变更记录](changelog.md)顶部，与版本号一起提交。对照上一发布 tag 核对实际交付内容；涉及协议、数据库或安装方式变化时，写明受影响的用户和升级步骤。

项目采用根目录 [Apache-2.0](https://github.com/xerrors/aBridge/blob/main/LICENSE)；第三方组件保留各自许可证。候选构建成功、上传到商店、商店审核通过和 npm 实际可安装是不同状态。

## npm

公开分发包默认名为 `@xerrors/abridge`，内部 `@abridge/server` workspace 不公开发布。分发只有编译后的 Server、管理台及服务端依赖，不包含桌面 SDK。可用仓库变量 `NPM_PACKAGE_NAME` 调整公开包名。

第一次发布前，在已登录 npm 的终端构建公开包：

```sh
npm install
npm run build
node --import tsx tools/package-release.ts --public
npm run package:check
npm publish dist/releases/*.tgz --access public
```

也可以使用 npm staged publishing 先暂存再确认。网页已登录不等于 CLI 已登录；首次发布可能需要 npm 账户验证。不要把凭据放入仓库。完成首包后，在 npm 包 Settings 中添加 Trusted Publisher：

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

发布验证后，Server 的使用入口为 `npx @xerrors/abridge --web`；在确认 npm 上实际存在之前，不将这个入口表述为已可用。

[npm 官方可信发布说明](https://docs.npmjs.com/trusted-publishers/) · [npm trust 的包存在前提](https://docs.npmjs.com/cli/v11/commands/npm-trust/)

## macOS

**编译不要求 Apple Developer 证书。** GitHub `macos-15` Apple Silicon runner 构建 `aBridge-<version>-macos-arm64-unsigned.zip`，其中 App 为 ad hoc 签名候选，未公证。下载后不能宣称已通过 Gatekeeper 分发审核。

App 内含 Swift 客户端、独立原生更新器和 arm64 Cua dylib；所有程序与资源从 App Bundle 相对解析，用户数据仍在 `~/Library/Application Support/aBridge`。产物不包含 CI 用户名、构建目录或本机凭据。将 App 拖入 Applications 后即可运行，不需要源码目录、Python 或本机 npm 环境。

Server 最低支持 Node 22.13.0，CI 覆盖最低补丁版本及 Node 22、24、26。npm 发布 job 单独使用 Node 26 附带的新 npm，以满足可信发布要求；这不提高产品的最低运行版本。

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

当前仅支持 Apple Silicon/macOS14+。构建与运行时自检不等于用户设备已授予录屏和辅助功能；ad hoc 原生签名改变还可能影响现有系统授权。不要放宽 designated requirement 来规避权限校验。

[Apple 官方公证说明](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) · [GitHub 官方 runner 列表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

## Android

Set `ANDROID_SIGNING_ENABLED=true` and configure repository secrets `ANDROID_KEYSTORE_BASE64` (single-line Base64 of the release keystore), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. The tag workflow verifies the signed `aBridge-<version>-android.apk` and enforces a 500,000-byte size limit before including it in the GitHub Release.

Use the same signing key for subsequent releases to allow in-place upgrades. Android checks package identity, signing identity, and version when the user opens the downloaded APK. The Debug APK uses a development signature and is intended for testing.

## Linux

发布复用 Linux CI，在原生 amd64 和 arm64 runner 上构建 musl 静态包，并验证打包二进制与 Server 联调、用户级 systemd 生命周期。两个架构均须通过才进入发布。GitHub Release 附带两个架构各自的 `abridge-client-<version>-<target>.tar.gz` 和一份 `SHA256SUMS`。各架构的体积报告和单独的校验文件留在 CI artifact 中。下载后按 [Linux 安装说明](https://github.com/xerrors/aBridge/blob/main/apps/linux-client/README.md#安装与绑定) 核对校验和。

## Chrome 应用商店

`dist/releases/abridge-browser-<version>.zip` 是商店上传包。首次上传在开发者信息中心完成，需准备商店名称、简要说明、用途、截图、图标、隐私政策及权限用途说明。上传后还需完成商店审核并取得 item ID；首次发布状态以信息中心为准。

当前 tag 工作流生成可上传 ZIP，不自动代替商店提交与审核。后续自动上传需要已建立的 item ID 和 Chrome Web Store API 凭据；不把 Google 登录 Cookie 或账号密码放进 CI。

## 容器镜像发布

`release.yml` 在正式 GitHub Release 创建成功后显式调用可复用的 `.github/workflows/container.yml` 构建镜像，也支持手动输入已发布的正式 tag 补发。使用 `GITHUB_TOKEN` 创建 Release 不会触发另一个 release 事件工作流，因此发布链路直接调用。带预发布后缀的版本不生成容器镜像。使用对应 tag 的源码和当前 Dockerfile，在原生 amd64、arm64 Linux runner 分别构建并验收健康接口、页面脚本、管理员认证及 Server 分发边界，再向 GHCR 推送版本和 `latest` 多架构清单。发布权限使用临时 `GITHUB_TOKEN`，不配置长期 registry token。

首次推送后须在 GitHub Package 设置中将镜像设为 Public，并验证匿名拉取；仓库公开不代表首次创建的容器包自动公开。部署命令见[Docker 镜像](deployment.md#docker-镜像)。
