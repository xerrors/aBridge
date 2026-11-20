# Chrome Web Store 发布

## 分发包与首次上架

执行 `npm run build && npm run package && npm run package:check`，上传 `dist/releases/abridge-browser-<version>.zip`。ZIP 根目录包含生成版本的 manifest 与已构建 JavaScript；不要上传源码目录、Server tarball 或 App。

上传商店时使用打包工具生成的 ZIP。打包工具会移除 manifest 的 `key` 并核对版本。用 `dist/browser/` 本地调试时，manifest 保留开发公钥，以便继续使用同一扩展 ID。

首次上传可先保存草稿，在 Package 页查看商店分配的 ID 和公钥。想让开发版使用同一个 ID，可以把公钥填回开发 manifest。若切换到另一个扩展 ID，请检查本地绑定并按需重新连接。[Chrome 的 key 配置说明](https://developer.chrome.com/docs/extensions/reference/manifest/key)

## 商店介绍草稿

**名称：** aBridge for Browser

**简述：** Connect authorized AI agents to task pages in your browser, using the Profile you already use.

**单一用途：** Let agents authorized through a user-selected aBridge Server observe and operate extension-owned task tabs in the current browser Profile.

**详细说明：**

aBridge for Browser connects directly to an aBridge Server you configure. Add this browser device to an Agent connection in that Server, then let the Agent open task pages, inspect visible content, click controls and fill fields. Task pages use the current Profile's normal website sessions.

The toolbar popup shows connection status and provides Pause, Resume and Stop controls. Browser authorization persists across extension restarts; reconnecting does not undo a pause. Task tabs are separate from your existing personal tabs. The extension does not require the aBridge desktop App.

You must run or have access to an aBridge Server and configure an MCP client with an Agent Key. Website sign-in, multi-factor authentication and browser permission dialogs can still require your interaction. Closing Chrome disconnects this browser device.

## Privacy practices 填写依据

填写表单时，按实际处理的数据逐项说明用途和接收方。扩展会把授权任务页的数据交给用户配置的 Server 和 Agent。将政策链接填入表单对应字段，确保内容与实际版本一致。[aBridge 隐私政策](privacy.md) · [商店隐私政策要求](https://developer.chrome.com/docs/webstore/program-policies/privacy)

建议根据提交时的实际版本逐项核对数据类别：

| 类别                               | 当前处理情况                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Website content                    | 页面可见正文、表单观察、控件及按需截图，可能含个人或敏感内容                                                                    |
| User activity                      | 已授权任务的导航、点击、填充及执行结果                                                                                          |
| Authentication information         | 设备 Key 的本地保存和认证传输；绑定时通过指定 Server 的浏览器授权页确认，扩展不读取管理账户密码。Agent 提供的填充内容也可能敏感 |
| Web history / personal identifiers | 按类别定义核对所处理的任务 URL、标题、账户名和页面内容                                                                          |

提交前由发布者按当前版本核对认证声明。

权限理由草稿：

| 权限                 | 可提交的英文理由                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| debugger             | Inspect the accessibility/DOM structure of extension-owned task tabs and capture screenshots when requested by an authorized Agent. All supported inspection and action logic is included in the extension package.      |
| tabs                 | Create, navigate, identify and close task tabs owned by an authorized control session, and verify the current URL/title and navigation state. The extension does not enumerate personal browsing history for collection. |
| storage              | Save the chosen Server, browser device binding, pause state, connection diagnostics and operation receipts needed to avoid replaying interrupted actions.                                                                |
| identity             | Open the user-selected Server authorization page and receive its one-time, PKCE-bound device authorization callback. This does not request access to the user’s Google account.                                          |
| alarms               | Retry connection after the extension worker is suspended or connectivity is interrupted, while Chrome is running.                                                                                                        |
| webNavigation        | Identify new tabs opened by the active task tab during an authorized action, including links that omit opener information. Events are matched to the task's source tab.                                                  |
| Optional host access | Contact only the Server origin entered during binding. The extension requests that specific origin at the time the user configures it.                                                                                   |

权限需保持与单一用途相关且范围最小。[官方 Privacy practices 指南](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)

## 代码与远端命令说明

当前扩展将观察、输入、读取、等待和任务页执行通道打包在本地 JavaScript 内。Server 提交已定义工具及参数；代码模式在 Server 的 QuickJS 引擎组织流程，并可通过 `page.evaluate` 在自有任务页执行 JavaScript。原始 CDP 不对 Agent 开放，也没有专用 Cookie 导出工具；页面脚本可读取站点向页面开放的数据，不能把固定观察的敏感字段过滤视为脚本限制。浏览器执行通过 `chrome.debugger` 完成，生命周期和权限以[浏览器客户端](browser-profile-design.md)为准。

提交时说明扩展内置了哪些操作、Server 传入哪些参数，以及页面脚本在哪里执行。对照 MV3 的 Debugger API 条款及隐私、用途和可审查性要求。[官方 MV3 要求](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)

## 素材

商店要求 ZIP 内的 128×128 PNG 图标及至少一张真实体验截图，截图尺寸为 1280×800 或640×400。截图应展示真实面板、配置或自有任务页面，使用虚构身份，不展示用户凭据或私人页面。README 概念图不能替代产品体验截图。[官方图片要求](https://developer.chrome.com/docs/webstore/images)

图标使用 `apps/browser/public/icons/icon-128.png`。提交前检查透明背景和小尺寸可辨识度。可另外准备440×280宣传图；它与截图是不同素材。

## 审核复现说明

下面步骤供审核人员在隔离环境中使用自己的临时数据。不要提供开发者本人的真实账户、网站登录或 Agent Key。

1. 准备 Node.js 22.13.0+，克隆本仓库，执行 `npm install && npm run build`。
2. 执行 `npm start -- --web --data-dir /absolute/path/to/review-state`，在打开的本机管理台创建临时管理账户。
3. 安装审核包，点击扩展图标，在弹窗中填写 `http://127.0.0.1:8765` 和浏览器名称，批准访问此 Server 地址；点击“在浏览器授权”，在打开的页面使用临时账户登录并确认绑定。
4. 管理台出现独立 browser 设备后，创建 Agent 连接，选择该设备的 `browser` 能力，设置临时到期日期并保存 Agent Key，接入支持 Streamable HTTP 的 MCP 客户端。
5. 按 `tools/fixtures/README.md` 启动自有表单目标，用浏览器会话打开 `/seed`，再在另一个任务会话中观察登录态、填入文字并提交。关闭会话，检查任务页清理。
6. 在工具栏暂停访问，确认 Agent 无法继续；恢复访问后使用新会话。测试后撤销临时 Agent Key 并删除本次临时状态。

以上流程在审核人员自己的机器上启动 Server。如果商店要求在线测试，提供审核人员可访问的 HTTPS 演示 Server、独立的可撤销测试账户和操作说明。

## 更新

在同一个 Store Item 下上传更高 manifest 版本，保留既有商店安装的更新身份。版本由根 `package.json` 生成。上传成功、提交审核、审核通过和公开可安装是不同状态，发布记录分别确认。
