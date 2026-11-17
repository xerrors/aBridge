# 浏览器客户端

## 设备与 Profile

aBridge for Browser 是 TypeScript 实现的独立 Chromium 扩展，每个安装实例注册为一个 `browser` 设备，直接连接 Server。不同浏览器或 Profile 中的扩展分别命名、绑定、暂停和撤销。扩展与 App 独立运行。

Agent 通过 `devices_list` 选择设备 ID，再创建仅含 `browser` 的会话。Profile 已由设备身份确定，导航工具不接受 Profile 名称、默认项或配置目录，也不能在会话失联后自动切换账号。

## 首次绑定

先运行 `npm run build`，再通过开发者模式加载 `dist/browser/` 中已构建的扩展。源 TypeScript 目录不能直接加载。点击扩展图标，在弹窗中填写 Server 地址和设备名称，通过 `chrome.identity.launchWebAuthFlow` 打开管理台授权页；用户在浏览器中登录并确认后，扩展用一次性授权码和 PKCE 兑换 Device Key，只保存设备凭据。绑定时授权访问所填 Server 地址；远程连接推荐 HTTPS/WSS；公网 HTTP/WS 需在客户端确认风险，本机回环 HTTP/WS 无需额外确认。

首次绑定的名称默认为 `Chrome · Profile`，可直接修改。已获 `identity.email` 可选权限时，通过 `chrome.identity.getProfileUserInfo({ accountStatus: "ANY" })` 读取当前 Profile 的账户邮箱，建议名称为 `Chrome · 邮箱`；未获权限时，只有点击“使用 Profile 账户”才请求读取权限，不自动弹出授权或打开网页登录。浏览器 API 不提供 Profile 的本地昵称，也不保证未登录、隐身或其他 Chromium 浏览器能返回邮箱；无邮箱或读取失败时保留通用默认名。账户信息只用于未编辑的首次绑定表单，不覆盖手动修改、已保存设备名称或等待中的授权名称；最终设备名称仍随绑定请求发送给 Server。

扩展直接连接 `/ws/browser`，在首条认证消息传递设备凭据，不将凭据放入 URL。Agent Key 只用于 MCP 调用，不能作为设备凭据。使用“指定设备”的 Agent 连接时，在管理台为该浏览器开启 `browser`；选择“全部设备（含新设备）”且默认能力包含 `browser` 的连接自动覆盖新注册的浏览器。连接策略可编辑，无需重新配置 MCP Key。

授权流程由后台 worker 持有，弹窗因授权窗口获得焦点而关闭不会取消授权；重新打开弹窗可查看等待状态或取消。授权窗口的等待独立于配置消息队列，不阻塞状态读取和本机控制。授权回调固定为当前扩展 ID 的 `https://<id>.chromiumapp.org/abridge-authorize`；取消、拒绝或过期不会写入绑定。浏览器或 worker 异常退出后重新发起授权，不自动批准旧请求。

绑定、持久暂停和任务会话互相独立。任务结束、扩展重启或网络重连不要求重新绑定；撤销凭据后不会自动注册新设备。网站登录过期仍需要正常登录，设备授权并不延长站点会话。

## 任务与工具

每个任务会话创建自己的后台标签页，复用所在 Profile 的网站登录态。任务只导航和操作自有标签页，不接管原有个人标签；正常会话关闭、断连和停止时清理任务资源。浏览器的标签恢复行为可能受浏览器设置影响，清理失败会保留记录并阻止新任务。

| 工具              | 行为                                                  |
| ----------------- | ----------------------------------------------------- |
| `browser_open`    | 导航自有任务页，并在同一次调用中返回有界页面观察      |
| `browser_observe` | 刷新同一任务页，聚焦已加载文本或检查加载状态          |
| `browser_act`     | 对当前观察的精确引用执行输入，默认等 2 秒后附带新观察 |

`browser_act` 的外层参数 `wait_after_ms` 决定动作完成后、读取页面与截图前的等待时间，默认 `2000` 毫秒，可设 `0–10000` 的整数；例如 `3000` 等待 3 秒，`0` 立即观察。`observe_after=false` 不等待，单独的 `browser_open` 与 `browser_observe` 不新增固定等待。等待计入已有时间预算，可被取消或会话关闭打断；动作已经执行但后续观察失败时，只重新观察，不重复点击。

观察返回可见文本、交互元素、链接和明确截断标记。`query` 可为整段子串或1–20项字符串数组，不区分大小写；数组任一项匹配即可，正文与控件遵循同一规则。每项非空且最多200字符，数组总长最多2000字符。结果去重并保持原预算，零结果仅表示本次已加载正文与控件扫描未匹配。链接的 `target` 是 DOM 声明，不是实际打开事件。引用按会话与文档版本绑定，最长有效 60 秒，动作和导航后失效。截图需显式请求，通过原生 MCP 图片块返回。具体预算与恢复语义见 [执行契约](architecture.md)。

扩展通过固定 Chrome debugger 通道执行授权的操作。点击、按键、悬停和滚动使用 CDP Input；填充使用浏览器文本输入，原生 select 使用 DOM 语义事件。原始 CDP 不对 Agent 开放。代码模式的 `page.evaluate` 在任务页执行 JavaScript，具有该页登录用户权限，固定观察中的密码过滤不能约束脚本读取。原生动作已自动滚动并检查目标，不必先用 evaluate 模拟滚动或点击。页面可拒绝操作，执行回执不能代替实际业务效果确认；点击成功也不表示已导航。所有工具及代码中的 `page` 固定操作当前任务页，链接产生的新标签不会自动接管；访问已观察链接可将其 URL 传给 `browser_open` 或 `page.goto`。批量操作与自定义数据提取可用 `browser_exec`。

## 连接与本机控制

后台通过 WebSocket 心跳确认连接，并通过 Chrome alarms 恢复被意外终止的 worker。恢复沿用同一设备身份与暂停状态，不要求打开弹窗。浏览器完全退出或整机睡眠时无法保持在线，纯扩展不能自行冷启动浏览器或唤醒整机。

工具栏弹窗集中提供连接状态、暂停/恢复、停止、绑定与连接诊断。未绑定时直接显示授权表单；已绑定时通过齿轮在弹窗内展开设备信息与解绑，不另开设置页。暂停持久保存，自动重连不解除暂停；恢复只能由本机操作者执行。停止清理当前任务，不解除长期绑定；解除绑定则移除本机凭据并通知 Server 撤销。

连接只读诊断包含启动、确认心跳、关闭时间和关闭码，不包含凭据。已配置、已连接与已暂停是不同状态，配置存在不表示浏览器正在在线。

## 限制

- 仅支持 HTTP(S) 页面，不能导航浏览器内部页面。
- 下拉选择使用 DOM 语义事件；密码管理器、原生对话框、验证码和多因素验证可能需要用户操作。
- 网站登录、浏览器调试提示、跨进程 iframe 和各站点后台行为受浏览器与站点实现约束。
- 自动化 API 替身测试不能证明所有浏览器版本和网站行为；涉及新场景时，应使用自有测试页面核对实际效果。

## 编程执行与按需读取

公开工具增加 `browser_read`、`browser_wait` 和 `browser_exec`。`browser_act` 增加 `press`、`select`、`scroll`、`hover`；引用的单次使用和60秒期限保持原契约。代码中的 locator 每步重新解析唯一 CSS 目标，省去每字段一次整页观察及固定等待；不接受模糊多目标选择。

`browser_exec` 的 `code` 是 async JavaScript 函数体，可使用 `page`、`state`、`console` 和 `return`。代码在 QuickJS WASM 中运行，无 Node、文件、终端或直接网络接口；`page.evaluate` 是显式的页面内代码通道，网站网络请求仍由浏览器执行。每段创建新的执行上下文，只有 JSON `state` 跨调用保存，局部变量和函数不跨调用延续。状态归当前会话所有，关闭、断连、暂停或 Server 重启后清除；状态不是持久业务数据库。

```javascript
// browser_exec.code；重复调用使用同一个 session_id。
for (const item of [
  { name: "Apple", quantity: 2 },
  { name: "Pear", quantity: 3 },
]) {
  await page.locator("#name").fill(item.name);
  await page.locator("#quantity").fill(String(item.quantity));
  await page.locator("#save").click();
  await page.wait({ selector: "#status", text: "Saved", timeout_ms: 5000 });
  state.completed = (state.completed || 0) + 1;
}
return { completed: state.completed };
```

支持的页面接口：

| 接口                                             | 行为                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `page.goto(url)` / `page.observe(options?)`      | 导航自有任务页或刷新观察                                                      |
| `page.locator(css)`                              | 唯一 CSS 目标的 click/fill/press/select/hover/scroll/read/waitFor             |
| `page.read(options?)`                            | 文本或表格快照，支持 selector、mode、snapshot_id、offset、limit               |
| `page.wait(options)`                             | selector/text 的 visible/hidden/attached/detached，或 selector/value 的值等待 |
| `page.evaluate(expressionOrFunction, argument?)` | 执行页面 JavaScript 并返回 JSON，函数参数需可序列化                           |
| `page.frameLocator(css)`                         | 显式选择单层同源 iframe 后使用 locator/read/wait/evaluate                     |

按键支持 Enter、Tab、Escape、方向键等命名键和单字符，暂不接受修饰键组合；`select(valueOrValues)` 按原生选项 value 选择；`scroll(deltaY, deltaX?)` 发送滚轮输入。frame 支持当前同源文档，跨源 frame 明确拒绝，不回退到主文档；嵌套 frame、文件传输和原生文件对话框尚无专门接口。`evaluate` 可处理 DOM 数据与特定页面逻辑，但不能把它当成任意 frame 的通用替代。

代码默认限20秒，`timeout_ms` 可设至120秒；`wait_seconds` 默认15秒，等待返回后原操作可能仍在执行，应使用同一 `operation_id` 查询 `command_status`，或 `command_cancel` 取消。每段最多1000个浏览器步骤，QuickJS内存16MiB，连续纯计算有中断限额。日志最多100条/12000字符，状态和内部序列化结果最多1MiB；最终 value 超24000字符返回明确截断预览，建议在脚本内汇总或用快照分页。完整 JSON state 在正常序列化后保存；取消、超时或执行失败不能保证 state 包含最后一步进度，恢复应核对回执与实际页面。

每个浏览器调用都必须 `await`，不支持返回后继续后台写入。批次不是事务；第八步失败不会撤销前七步。回执附带 `steps_completed`，失败时还保留有界 `failed_step`（`operation_id`、`method`、`status`、`error`），外层和每个步骤分别记录操作ID。首次执行前明确拒绝为 `refused`；已有步骤完成后明确失败为 `failed`；在途超时、断连或无确认回执仍为 `outcome_unknown`，并可按失败步骤ID核对。纯脚本异常为 `failed`，没有在途未知步骤的明确取消为 `cancelled`。完成步数不能证明失败步骤无副作用，输入准备中的滚动与 focus 也可能触发页面事件。不重放整段；执行期间同会话独占，取消会终止运行并取消在途浏览器步骤。当前不提供业务事实 `expect` 与人工接管恢复协议。

`browser_read` 缓存单份当前会话快照，最多100万字符；新快照替换旧快照。文本按字符分页，表格按行分页，每页最多200行，并保留单元格行列合并信息。响应标记来源URL、缓存与截断，覆盖范围为已加载的主文档或显式同源 frame，不包含未加载分页或虚拟列表外的数据。缓存只供阅读，不授予动作权限。等待上限20秒，不自动重新提交动作；页面脚本一旦提交，执行或结果处理失败都可能已有副作用，会等待任务页清理并报告结果未知；提交前明确校验失败保留任务页。清理只执行一次，重复关闭、取消或停止等待相同结果；清理失败保留原始 `cause`、`cleanup_error` 与 `recovery`，不会宣称任务页已释放，需先停止任务重试清理。新任务页等待进行中的清理，旧会话迟到的清理不影响新页。控制会话仍活跃但任务页已缺失返回 `task_tab_missing`，此时使用 `browser_open`；控制会话真实停止、过期或断连仍遵循原会话恢复契约。

### 原生长按与等待

`page.locator(css).click({hold_ms:1500})` 原生按住鼠标左键 1500 毫秒后释放；`browser_act` 的 `click` 动作同样接受 `hold_ms`（0–10000 的整数，省略为普通单击）。保持期间关闭或取消会话会中断等待并清理任务页；页面导航导致结果未知，不重放。原生长按能否触发点赞、三连等业务行为仍由页面决定，DOM `dispatchEvent` 不能代替原生输入验证。

`browser_exec` 外层没有 `setTimeout`、`setInterval` 或 DOM 全局。优先通过 `page.wait` / `locator.waitFor` 等待页面条件；确实需要固定等待时使用 `await page.sleep(ms)`（0–10000 的整数）。等待可被取消并计入代码总超时，不计入浏览器步骤数。`page.evaluate` 内部运行在网页环境，与外层隔离运行时不同。批次后续代码出错不会回滚先前点击，应读取状态后再决定下一步。

### 手动 Device Token 绑定

在弹窗“绑定方式”选择 Device Token，输入管理台为浏览器设备生成的凭据后验证并连接。Token 默认隐藏，可手动显示；验证成功才替换本地绑定，保留暂停状态并清理旧任务会话，不重放旧操作。HTTP 确认与 Server Origin 精确绑定并保存在设备配置中；worker 独立复核确认，未确认时不发送 Token，也不建立 WS。扩展 CSP 允许 HTTP/WS 连接，实际地址仍由站点权限和绑定确认限制。浏览器授权继续使用 PKCE 与浏览器管理的授权窗口，两种方式取得相同的 Device Key。
