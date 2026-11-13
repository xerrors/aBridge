# Chrome Web Store 发布

## 分发包与首次上架

执行 `npm run build && npm run package && npm run package:check`，上传 `dist/releases/abridge-browser-<version>.zip`。ZIP 根目录包含生成版本的 manifest 与已构建 JavaScript；不要上传源码目录、Server tarball 或 App。

商店 ZIP 的 manifest 故意不带 `key`；源码和 `dist/browser/` 中的加载开发版仍保留开发公钥及其身份，不能直接把该目录压缩上传商店。打包检查同时核对商店 manifest 无 `key` 且版本与根 `package.json` 相同。

首次上传可先保存草稿。商店分配的 Item ID 与开发版当前 ID 不应假定相同；需要统一开发 ID 时，在草稿的 Package 页面查看商店公钥，再按 [Chrome 官方 key 流程](https://developer.chrome.com/docs/extensions/reference/manifest/key)回填开发 manifest。扩展公钥不是秘密；商店 ID 变化不保证保留另一扩展 ID 的本地绑定。

## 商店介绍草稿

**名称：** aBridge for Browser

**简述：** Connect authorized AI agents to task pages in your browser, using the Profile you already use.

**单一用途：** Let agents authorized through a user-selected aBridge Server observe and operate extension-owned task tabs in the current browser Profile.

**详细说明：**

aBridge for Browser connects directly to an aBridge Server you configure. Add this browser device to an Agent grant in that Server, then let the Agent open task pages, inspect visible content, click controls and fill fields. Task pages use the current Profile's normal website sessions.

The toolbar popup shows connection status and provides Pause, Resume and Stop controls. Browser authorization persists across extension restarts; reconnecting does not undo a pause. Task tabs are separate from your existing personal tabs. The extension does not require the aBridge desktop App.

You must run or have access to an aBridge Server and configure an MCP client with an Agent Key. Website sign-in, multi-factor authentication and browser permission dialogs can still require your interaction. Closing Chrome disconnects this browser device.

## Privacy practices 填写依据

商店字段与 [隐私政策](privacy.md) 必须一致。扩展会将授权任务页的数据交给用户配置的 Server 和 Agent，不能仅因没有开发者运营的收集端就声明“不处理用户数据”。Chrome 要求准确披露收集、使用及共享方，并在指定字段提供可访问的政策链接。[官方隐私政策要求](https://developer.chrome.com/docs/webstore/program-policies/privacy)

建议根据提交时的实际版本逐项核对数据类别：

| 类别                               | 当前处理情况                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Website content                    | 页面可见正文、表单观察、控件及按需截图，可能含个人或敏感内容                                                                      |
| User activity                      | 用户授权的导航、点击、填充及执行结果；不是后台收集全部浏览记录                                                                    |
| Authentication information         | 设备 Key 的本地保存和认证传输；注册时管理凭据发给指定 Server。Agent 提供的填充内容也可能敏感                                      |
| Web history / personal identifiers | 任务 URL、标题、账户名或页面内容可能落入这些类别；按实际处理定义选择，不能把“不读取全局历史数据库”等同“不涉及任何 URL 或身份数据” |

最后的认证声明应由发布者按事实核对；上表不是对审核结论的保证。

权限理由草稿：

| 权限                 | 可提交的英文理由                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| debugger             | Inspect the accessibility/DOM structure of extension-owned task tabs and capture screenshots when requested by an authorized Agent. All supported inspection and action logic is included in the extension package.      |
| tabs                 | Create, navigate, identify and close task tabs owned by an authorized control session, and verify the current URL/title and navigation state. The extension does not enumerate personal browsing history for collection. |
| storage              | Save the chosen Server, browser device binding, pause state, connection diagnostics and operation receipts needed to avoid replaying interrupted actions.                                                                |
| alarms               | Retry connection after the extension worker is suspended or connectivity is interrupted, while Chrome is running.                                                                                                        |
| Optional host access | Contact only the Server origin entered during binding. The extension requests that specific origin at the time the user configures it.                                                                                   |

权限需保持与单一用途相关且范围最小。[官方 Privacy practices 指南](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)

## 代码与远端命令说明

当前扩展将观察、点击和填充实现打包在本地 JavaScript 内。Server 只提交已定义工具及参数；扩展不提供任意 JavaScript、原始 CDP 或 Cookie 导出接口。固定 DOM 读取/操作通过 `chrome.debugger` 调用执行。

MV3 对远程执行有严格要求，Debugger API 有特定例外；例外不豁免隐私、用途或可审查性要求。提交时应准确解释固定实现和有限参数，不能据此宣称“一定通过审核”。[官方 MV3 要求](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)

## 素材

商店要求 ZIP 内的 128×128 PNG 图标及至少一张真实体验截图，截图尺寸为 1280×800 或640×400。截图应展示真实面板、配置或自有任务页面，使用虚构身份，不展示用户凭据或私人页面。README 概念图不能替代产品体验截图。[官方图片要求](https://developer.chrome.com/docs/webstore/images)

图标使用 `apps/browser/public/icons/icon-128.png`。提交前检查透明背景和小尺寸可辨识度。可另外准备440×280宣传图；它与截图是不同素材。

## 审核复现说明

下面步骤供审核人员在隔离环境中使用自己的临时数据。不要提供开发者本人的真实账户、网站登录或 Agent Key。

1. 准备 Node.js 26.7–26.x，克隆本仓库，执行 `npm ci && npm run build`。
2. 执行 `npm start -- --web --data-dir /absolute/path/to/review-state`，在打开的本机管理台创建临时管理账户。
3. 安装审核包，点击扩展图标进入设置，填写 `http://127.0.0.1:8765`、临时账户及浏览器名称，批准访问此 Server 地址。
4. 管理台出现独立 browser 设备后，创建只覆盖该设备和 `browser` 能力的临时 Agent Key，接入支持 Streamable HTTP 的 MCP 客户端。
5. 按 `tools/fixtures/README.md` 启动自有表单目标，用浏览器会话打开 `/seed`，再在另一个任务会话中观察登录态、填入文字并提交。关闭会话，检查任务页清理。
6. 在工具栏暂停访问，确认 Agent 无法继续；恢复访问后使用新会话。测试后撤销临时 Agent Key 并删除本次临时状态。

本机步骤要求审核环境能够运行 Node 和自有 Server，并不保证审核人员一定采用此方式。若商店要求在线测试，需另行提供受限的 HTTPS 演示 Server、独立可撤销测试身份及完整说明；没有准备演示服务时，不得填写一个实际不可访问的 localhost 地址当作在线测试账号。

## 更新

在同一个 Store Item 下上传更高 manifest 版本，保留既有商店安装的更新身份。版本由根 `package.json` 生成。上传成功、提交审核、审核通过和公开可安装是不同状态，发布记录分别确认。
