# Windows PC 客户端

Windows 客户端预览版提供截图、前台键鼠输入、Shell 和 UTF-8 文件读写，可直接连接现有 aBridge Server。使用 Windows 10 或 11 x64，并保留系统自带的 Windows PowerShell 5.1。截图和键鼠操作需要解锁的交互式桌面。ARM64 尚未验证。

## 下载与安装

预览版以**未签名便携 ZIP** 分发，解压后即可运行，无需管理员权限、Node.js 或 .NET。GitHub Actions 的下载需要登录 GitHub，产物保留 30 天。也可以在 Windows 上[从源码构建](#源码构建)。

1. 打开主分支的 CI 运行列表，选择 **Windows client** 检查成功且有 **windows-client-unsigned** 产物的运行。[GitHub Actions](https://github.com/xerrors/aBridge/actions/workflows/ci.yml?query=branch%3Amain)
2. 下载并解开产物的外层 ZIP，得到 `aBridge-<版本>-windows-x64-unsigned.zip` 和同名 `.sha256` 文件。
3. 在 PowerShell 中运行 `Get-FileHash .\aBridge-<版本>-windows-x64-unsigned.zip -Algorithm SHA256`（将文件名换成实际下载的名称），与 `.sha256` 中的哈希值核对。
4. 将客户端 ZIP **完整解压**到自己的固定目录，例如 `%LOCALAPPDATA%\Programs\aBridge-preview-<提交号>`，然后打开解压后 `aBridge` 文件夹中的 **aBridge.exe**。未签名包可能受 Windows 或组织策略限制。

## 绑定设备

1. 在客户端的「连接」中填写 Server 地址，点击「连接并授权」。在打开的浏览器中以普通账户登录管理台并确认。已有这台电脑的 **Device Token** 时，也可以在「使用 Device Token」中填写。
2. 在「本机能力」里打开所需的屏幕、输入、Shell 或文件能力，再到管理台「设备」页确认 Windows 设备已上线。
3. 在管理台的「Agent 连接」中选择这台设备，授予任务所需的能力与有效期。在 Agent 端运行 `devices_list` 检查设备列表。[连接 Agent](https://xerrors.github.io/aBridge/guide/start.html#连接-agent)

跨机器连接建议使用 HTTPS。使用非本机 HTTP 地址时，客户端会先要求确认完整地址。Device Token 仅用于设备绑定。需要使用 Chrome Profile 的登录态时，请单独安装并授权扩展。[浏览器客户端](https://xerrors.github.io/aBridge/browser-profile-design.html)

## 更新、退出和卸载

- 预览版使用手动更新。**先从托盘退出旧客户端**，再完整解压新 ZIP 到新的程序目录，启动新目录的 EXE。保留旧目录即可回退程序文件。
- 默认凭据、绑定、暂停状态和操作日志位于 `%LOCALAPPDATA%\aBridge`，与程序目录分开。更新程序不要删除或覆盖这个状态目录；使用过 `--state-dir` 或私有 `deployment.json` 的用户应继续指定原状态目录，不要将这些私有文件上传到 GitHub。
- 如需自定义状态目录，可运行 `aBridge.exe --state-dir "D:\自己的私有状态目录"`。首次使用新的空状态目录需要重新授权。
- 状态目录优先级为 `--state-dir`、程序旁的 `deployment.json` 中的 `state_dir`、`%LOCALAPPDATA%\aBridge`。Rust 外壳与旧 WPF 外壳使用相同的目录规范化、互斥锁和激活事件名称；同一目录重复启动只唤起已有窗口。外观仍保存在该目录的 `windows-ui/native-preferences.json`，无需转换设备配置。
- 暂停和关闭能力不会因重连自动解除。更新后确认 Server 地址、设备和本机能力是否正确。
- 卸载时退出客户端，删除该版本的程序目录和自己建立的快捷方式即可；默认保留状态。彻底移除访问权限还需在管理台撤销设备，确认不再需要后再自行删除私有状态目录。

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

- UIA 引用和截图坐标会检查窗口身份、焦点、几何位置、遮挡和人工输入。提升权限的窗口、UAC 安全桌面及客户端自身控件不接受输入。
- Windows 输入采用前台操作，不支持后台输入；调用参数必须符合所连接 Server 的公共工具 schema。客户端专有坐标与滚动参数不代表所有 Server 都接受它们。
- 在线但操作失败时，先查看客户端错误码、本机能力开关和 Server 授权。`invalid_dispatch` 表示帧契约校验失败，不能仅凭版本数字判断需要升级 Server。日志只报告安全字段诊断，不应包含凭据或操作正文。
- 截图用例需在实际使用的 Agent 页面验证：设备在线后请求截图，确认返回真实图片，而不只是“已连接”或文字宣称成功。

## 验证

```powershell
npm run check
npm run windows:shell:check
node --import tsx --test --test-concurrency=1 apps/windows/tests/*.test.ts
npm run package:windows
npm run package:windows:check
```

测试使用虚构身份和自有 fixture。真实桌面输入用例需要显式设置 `ABRIDGE_WINDOWS_LIVE=1`，并使用专用测试窗口；CI 不连接真实账号、桌面或服务。单元测试和包启动检查不能代替多显示器、UAC、真实输入或 Yuxi 截图端到端验收。

`package:windows:check` 在仓库外解压包，检查完整目录大小、原生 PE、许可和 SHA-256，并通过自有回环 Server 验证浏览器授权、Token 绑定、Shell/文件效果、重复写入不重放、暂停、能力关闭、解绑及退出。新旧客户端的运行时实现不同，验收比较协议、状态和操作结果。

外壳升级对照可使用 `$env:ABRIDGE_WINDOWS_LIVE='1'; npm run test:windows:shell:live -- <旧包解压目录> <新包解压目录>`。使用隔离状态目录验证关闭隐藏、跨版本互斥与激活、快捷键只暂停、原外观偏好保留。托盘菜单和真实桌面输入须从解压 EXE 另行对照，记录响应与失败提示。
