# Windows PC 客户端

Windows x64 客户端提供截图、前台键鼠输入、Shell 和文件能力，直接连接现有 aBridge Server。`apps/windows/windows-native-shell/` 包含 Rust 原生运行时和 Win32 界面；`src/` 保留此前 TypeScript 实现及驱动参考，供行为对照测试使用，不随包分发。无需修改或重新部署 Server。

## 普通用户：下载、解压、启动

当前提供**未签名便携 ZIP**，不是 MSI/Setup 安装器，也没有自动更新。需要 Windows 10/11 x64、系统自带的 Windows PowerShell 5.1、可交互且未锁定的桌面；ARM64 尚未验证。界面和运行时均为 Rust 原生程序，不分发或下载 Node、.NET、WinUI 3 或 Windows App SDK。用户不必安装开发工具，也不需要管理员权限。完整解压程序目录须小于 **10,000,000 字节**；构建和验包都强制检查此上限，许可与文档也计入其中。用户状态、操作日志及用户创建的文件单独存放，不属于静态程序包。

1. 在提供该代码分支的 GitHub 仓库进入 **Actions → CI**，选择与你要安装的提交号一致、**Windows client** 检查成功的运行。
2. 下载页面底部的 **windows-client-unsigned** artifact（需要登录 GitHub）。先解开 artifact 外层 ZIP，得到 `aBridge-<版本>-windows-x64-unsigned.zip` 和同名 `.sha256` 文件。Actions 产物会过期；这不是官方 Release 已发布的承诺。
3. 可用 PowerShell 的 `Get-FileHash .\aBridge-<版本>-windows-x64-unsigned.zip -Algorithm SHA256` 与 `.sha256` 核对。校验和用于核对内容一致性，不替代发布者身份或代码签名。
4. 将客户端 ZIP **完整解压**到自己的固定目录，例如 `%LOCALAPPDATA%\Programs\aBridge-preview-<提交号>`。不要直接在 ZIP 内启动，也不要只复制 EXE。
5. 双击解压后 `aBridge` 文件夹中的 **aBridge.exe**。可以右键为它创建桌面快捷方式。未签名包可能受到 Windows 或组织策略拦截；不要关闭系统防护或绕过组织策略。
6. 在客户端填写 Server 地址，选择浏览器授权并在页面确认；也可输入管理台为这台电脑生成的 **Device Token**。按需开启截图、输入、Shell、文件能力。浏览器扩展需要另外安装和授权。

非本机 HTTP 连接会要求确认完整地址；推荐 HTTPS。Device Token 不等于 Agent Key 或管理员 Token，不要把凭据粘贴进聊天、命令行或日志。

## 更新、退出和卸载

- **更新前先从托盘退出旧客户端**。完整解压新 ZIP 到新的程序目录，启动新目录的 EXE；不要让两个程序同时使用同一份状态。保留旧目录即可回退程序文件。
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

打包器从 PATH（或 `CARGO` 环境变量）查找 Cargo，生成协议包定义的契约，再使用锁定的 crate 依赖构建原生 EXE。首次构建需要访问 npm 和 crates.io；Node 只用于开发构建和验证。SQLite 编译进程序，TLS 使用 Windows 系统实现，桌面驱动使用内嵌脚本调用系统 PowerShell。输出位于 `dist/releases/`，版本单源为根 `package.json`。构建产物不提交到 Git；CI artifact 或本地构建包才包含可运行二进制。包内附带本文、运行时清单及第三方许可，不包含私有部署配置或凭据。

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
