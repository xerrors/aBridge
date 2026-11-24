# Windows PC 客户端

在 Windows 10 或 11 x64 上安装客户端，就可以把这台电脑接入现有 aBridge Server。客户端提供截图、前台键鼠输入、Shell 和 UTF-8 文件读写，使用系统自带的 Windows PowerShell 5.1。要让 Agent 操作桌面，请保持桌面已解锁。ARM64 尚未验证。

## 下载与安装

在发布页面的 **Assets** 下载未签名便携包 `aBridge-<版本>-windows-x64-unsigned.zip` 和同名 `.sha256`。用普通 Windows 账户解压后即可运行，安装环境只需要上面列出的系统组件。[GitHub Releases](https://github.com/xerrors/aBridge/releases/latest)

1. 在 PowerShell 中运行 `Get-FileHash .\aBridge-<版本>-windows-x64-unsigned.zip -Algorithm SHA256`（将文件名换成实际下载的名称），与 `.sha256` 中的哈希值核对。
2. 将客户端 ZIP **完整解压**到自己的固定目录，例如 `%LOCALAPPDATA%\Programs\aBridge-preview-<版本>`，然后打开解压后 `aBridge` 文件夹中的 **aBridge.exe**。未签名包可能受 Windows 或组织策略限制。

要试用主分支上的新构建，登录 GitHub，打开一次通过 **Windows client** 检查的运行。下载 **windows-client-unsigned** 并解开外层 ZIP，可以找到客户端包和校验文件。每次构建的产物保留 30 天。[GitHub Actions](https://github.com/xerrors/aBridge/actions/workflows/ci.yml?query=branch%3Amain)

## 绑定设备

1. 在「连接」中填写 Server 地址，点击「连接并授权」。浏览器打开后，用普通账户登录管理台并确认。
2. 在客户端的「本机能力」中打开任务需要的能力，回到管理台的「设备」页确认这台电脑已上线。
3. 在「Agent 连接」中选中这台电脑，设置能力与有效期。让 Agent 调用 `devices_list` 查看设备。[连接 Agent](https://xerrors.github.io/aBridge/guide/start.html#连接-agent)

也可以在管理台「添加设备 → Windows → 设备凭证」生成 **Device Token**，填入客户端的「使用 Device Token」，再点击「连接并授权」。

跨机器连接建议使用 HTTPS。使用 HTTP 时，客户端会显示完整地址并请你确认。要让 Agent 在已有登录状态的 Chrome Profile 中操作网页，请在该 Profile 里安装并授权扩展。[浏览器客户端](https://xerrors.github.io/aBridge/browser-profile-design.html)

## 更新、退出和卸载

**更新**时先从托盘退出旧客户端，再把新 ZIP 完整解压到另一个目录，启动其中的 `aBridge.exe`。保留旧程序目录即可回退。更新后检查 Server 地址、设备和本机能力。暂停和能力开关会随原来的状态一起保留。

绑定、凭据、暂停状态和日志默认保存在 `%LOCALAPPDATA%\aBridge`。更新时保留这个目录。自定义目录时，客户端依次读取 `--state-dir`、程序旁的 `deployment.json` 中的 `state_dir` 和默认路径。继续使用旧目录可以直接沿用设备配置和 `windows-ui/native-preferences.json` 中的外观设置。再次从同一个状态目录启动时，客户端会唤起已打开的窗口。

例如，使用 `aBridge.exe --state-dir "D:\自己的私有状态目录"` 可以指定目录。空目录需要重新授权。请将含有凭据和日志的状态文件留在本机。

**卸载**时先退出，再删除解压出的程序目录和快捷方式。要一并撤销设备访问权限，请在管理台解绑。确认用不到本机记录后，可以删除状态目录。

## 源码构建

安装 Node.js（版本要求见根 `package.json`）、npm 和 **Rust stable（MSVC x64）及 Visual Studio C++ Build Tools / Windows SDK**。在仓库根目录执行：

```powershell
npm install --ignore-scripts --no-audit --no-fund
npm run build
npm run package:windows
npm run package:windows:check
npm run desktop:windows
```

打包器从 PATH（或 `CARGO` 环境变量）查找 Cargo，生成协议包定义的契约，再使用锁定的 crate 依赖构建原生 EXE。首次构建需要访问 npm 和 crates.io。输出位于 `dist/releases/`，版本来自根 `package.json`。构建和验包都要求完整解压的程序目录小于 **10,000,000 字节**，包括运行时清单、使用说明和第三方许可。[Windows 运行时与协议](https://xerrors.github.io/aBridge/architecture.html#windows-客户端)

## 能力边界和排障

Windows 输入在前台窗口执行。客户端会在投递前检查窗口身份、焦点、位置、遮挡和本机人工输入。遇到管理员权限窗口、UAC 安全桌面或客户端自己的控件，请由本机用户操作。传坐标或滚动参数时，以所连接 Server 的公开工具参数为准。

设备在线但操作失败时，先检查本机能力开关和 Agent 授权，再看客户端错误码。`invalid_dispatch` 表示收到的执行请求未通过协议校验，可以用日志中的诊断字段对照 Server 和客户端的契约。

验证截图时，在实际使用的 Agent 页面请求截取 Windows 桌面，然后打开返回的图片。

## 验证

```powershell
npm run check
npm run windows:shell:check
node --import tsx --test --test-concurrency=1 apps/windows/tests/*.test.ts
npm run package:windows
npm run package:windows:check
```

CI 使用虚构身份和独立测试环境。实际使用中的多显示器、UAC、桌面输入和 Yuxi 截图需要在对应环境中核对。测试真实输入时，设置 `ABRIDGE_WINDOWS_LIVE=1` 并使用专用测试窗口。

`package:windows:check` 在仓库外解压包，检查目录大小、原生 PE、许可和 SHA-256。随后通过独立的回环 Server 验证两种绑定方式、Shell 和文件操作，以及去重、暂停、能力开关、解绑和退出。升级验收关注新旧客户端的协议、状态和操作结果。

外壳升级对照可使用 `$env:ABRIDGE_WINDOWS_LIVE='1'; npm run test:windows:shell:live -- <旧包解压目录> <新包解压目录>`。使用隔离状态目录验证关闭隐藏、跨版本互斥与激活、快捷键只暂停、原外观偏好保留。托盘菜单和真实桌面输入须从解压 EXE 另行对照，记录响应与失败提示。
