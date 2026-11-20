# 浏览器客户端

## 设备与 Profile

aBridge for Browser 是 TypeScript 实现的独立 Chromium 扩展，每个安装实例注册为一个 `browser` 设备，直接连接 Server。不同浏览器或 Profile 中的扩展分别命名、绑定、暂停和撤销。扩展与 App 独立运行。

Agent 用 `devices_list` 找到浏览器设备，再用设备 ID 开启只请求 `browser` 能力的会话。这个设备 ID 已经选定 Profile。会话失联后，请重新连接原设备并建立会话。

## 首次绑定

在选好的 Chrome Profile 中安装扩展。开发时先运行 `npm run build`，再到 `chrome://extensions` 加载 `dist/browser/`。[Chrome 应用商店](https://chromewebstore.google.com/detail/abridge-for-browser/jbkhngckehhhhkbgpjlifbbchhbeodjc)

点击工具栏图标，选择「连接浏览器」，填写 Server 地址和设备名称。远程连接建议使用 HTTPS。使用远程 HTTP 时，先确认地址，再允许扩展访问该站点。本机回环地址只需授予站点访问权限。

选择「在浏览器授权」后，扩展通过 `chrome.identity.launchWebAuthFlow` 打开管理台。登录并确认后，扩展用一次性授权码和 PKCE 换取 Device Key，保存在本地。

首次绑定时的默认名称是 `Chrome · Profile`，你可以直接修改。点击「使用 Profile 账户」时，扩展按需请求 `identity.email` 权限，用 `chrome.identity.getProfileUserInfo({ accountStatus: "ANY" })` 读取邮箱，并建议 `Chrome · 邮箱` 作为名称。浏览器未提供邮箱时保留默认名称。建议仅用于尚未编辑的首次绑定表单，授权进行中和已保存的名称会原样保留。Server 收到的是你最终选定的设备名称。

扩展通过 `/ws/browser` 连接，在首条认证消息中提交 Device Key。为 Agent 配置 MCP 时使用 Agent Key。

如果 Agent 连接只允许访问指定设备，请在管理台为这台浏览器开启 `browser`。如果连接允许全部设备（含新设备），且默认能力包含 `browser`，新浏览器会自动加入。修改连接范围后可以继续使用原 Agent Key。

发起授权后，后台 worker 负责等待浏览器回调，期间仍可读取状态和使用本机控制。工具栏弹窗可以查看进度，连接页可以取消申请。回调地址为 `https://<id>.chromiumapp.org/abridge-authorize`，其中 `<id>` 为当前扩展 ID。绑定只在授权成功后写入。浏览器异常退出、请求被取消或过期时，请重新发起授权。

任务结束、扩展重启或网络重连时继续使用现有绑定，暂停设置也会保留。设备凭据被撤销后，需要重新绑定。网站会话到期时，请按网站提示重新登录。

## 任务与工具

每个会话会在当前 Profile 中打开自己的后台任务标签页，沿用这个 Profile 的网站会话。任务只在这些标签中运行。关闭会话、断连或停止任务时，扩展会清理任务资源。标签页也受浏览器的恢复设置影响。清理失败时，扩展保留记录并暂停接收新任务。

| 工具              | 行为                                                  |
| ----------------- | ----------------------------------------------------- |
| `browser_open`    | 导航自有任务页，并在同一次调用中返回有界页面观察      |
| `browser_observe` | 刷新同一任务页，聚焦已加载文本或检查加载状态          |
| `browser_act`     | 对当前观察的精确引用执行输入，默认等 2 秒后附带新观察 |

`browser_act` 的外层参数 `wait_after_ms` 决定动作完成后、读取页面与截图前的等待时间，默认 `2000` 毫秒，可设 `0–10000` 的整数；例如 `3000` 等待 3 秒，`0` 立即观察。`observe_after=false` 不等待，单独的 `browser_open` 与 `browser_observe` 不新增固定等待。等待计入已有时间预算，可被取消或会话关闭打断；动作已经执行但后续观察失败时，只重新观察，不重复点击。

一次观察包括页面可见文本、控件和链接。观察会优先返回有语义的控件，也可以用 StaticText 引用定位文字、用指针目标定位未命名的可见图标。后续动作应原样传回 `observation_id`（`obs_` 加 8 位 Base64URL）。引用绑定到会话和文档版本，最长有效 60 秒，执行动作或导航后需要刷新。

`query` 接受一个非空字符串或 1–20 个非空字符串。正文与控件都按忽略大小写的子串匹配，数组中命中任一项即可。每项最多 200 字符，总长最多 2,000 字符。`page_summary` 提供未过滤的短摘要，`scan`、`elements_total` 和 `elements_returned` 说明扫描范围。还想看后续匹配控件时，用同一查询，把 `next_element_offset` 传入 `element_offset`。续页会重新扫描当前页面并签发引用，动态页面上的顺序可能变化。读取长正文可用 `browser_read`。

零个匹配表示本次扫描在已加载内容中没有找到结果。链接的 `target` 来自页面声明，实际新标签见回执中的 `opened_tabs`。需要截图时，在观察请求中明确开启，MCP 会返回图片块。[执行契约](architecture.md)

点击、按键和悬停由扩展通过 Chrome debugger 执行。原生动作会先滚动并核对目标。填充使用浏览器文本输入，原生下拉框使用 DOM 语义事件。`scroll` 改变最近可滚动容器或页面的 DOM 偏移，回执返回实际移动量。Document 引用可用于按键和滚动，并保留当前键盘焦点。指针准备保持原焦点，按元素引用发送按键时才定位焦点。

发现目标只读、类型不匹配或被覆盖时，扩展会在预检中拒绝并保留任务页。若是嵌套容器裁剪，扩展可以尝试滚动到可见位置后再次检查。收到执行回执后，使用新观察核对站点是否完成了预期操作或导航。

所有工具和代码里的 `page` 都指向当前任务页。`opened_tabs` 最多返回三个由这次输入打开的子标签，包含 ID 和可取得的标题及 HTTP(S) 地址。登记后 5 秒内可以补录第一个 HTTP(S) 地址，此后保留首次记录。地址太长或超出回包预算时，回执提供 ID 和 `url_omitted: true`。要继续访问链接，可以把完整地址交给 `browser_open` 或 `page.goto`。子页的脚本和 POST 状态留在原标签中。

批量操作或提取数据时可以使用 `browser_exec`。如调用 `page.evaluate`，JavaScript 会在任务页中按当前网站用户的权限执行，可以读取页面开放给脚本的数据，包括普通观察会过滤的内容。

## 连接与本机控制

扩展在连接握手中上报浏览器声明的平台标签与扩展版本，并在可得时上报浏览器品牌、浏览器主版本、宿主系统和平台架构。macOS 和 Android 仅在浏览器提供可用的宿主版本时上报该值。设备名可由用户填写为 Profile 标签，宿主主机名与运行用户名由原生客户端上报。Server 保存最近一次成功连接的上报信息，更新扩展后成功重连即可刷新详情。

后台通过 WebSocket 心跳确认在线。只要浏览器还在运行，Chrome alarms 就可以重新唤起被终止的 worker，并使用原来的设备身份和暂停状态。退出浏览器或整机进入睡眠后，设备会离线。

工具栏弹窗显示浏览器和当前连接状态，可以暂停访问、恢复访问或停止任务。暂停由本机用户解除，重连时继续保留。停止任务会清理任务标签，设备继续连接。需要改名、查看 Server 地址、排障或解除绑定时，从工具栏打开「管理连接」。解除绑定会删除本机凭据，并通知 Server 撤销设备。

遇到连接问题时，先在弹窗检查在线与暂停状态，再到「管理连接」查看启动时间、最近确认的心跳、关闭时间和关闭码。

## 限制

- 支持 HTTP(S) 任务页面。
- 密码管理器、原生对话框、验证码和多因素验证可能需要用户操作。
- 网站登录、浏览器调试提示、跨进程 iframe 和各站点后台行为受浏览器与站点实现约束。
- 接入新场景时，可以先用自有页面在目标浏览器中验证。

## 编程执行与按需读取

公开工具增加 `browser_read`、`browser_wait` 和 `browser_exec`。`browser_act` 增加 `press`、`select`、`scroll`、`hover`；引用的单次使用和60秒期限保持原契约。代码中的 locator 每步重新解析唯一 CSS 目标，省去每字段一次整页观察及固定等待；不接受模糊多目标选择。

`browser_exec` 接收异步 JavaScript 函数体，可使用 `page`、`state`、`console` 和 `return`。外层代码运行在 QuickJS WASM 中，网页脚本通过 `page.evaluate` 在任务页执行。每次调用都有独立的执行上下文，只有 JSON `state` 在同一会话的调用间保存。关闭、断连、暂停或 Server 重启后会清除状态。

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

原生动作可用 `page.locator({within: "#item-42", role: "button", name: "加入购物车"}).click()` 在唯一 CSS 容器内按可访问角色和名称精确定位。省略 `within` 时从文档根查找。观察中无名称的元素可用描述作为显示名称，此时 `accessible_name` 明示空字符串。语义定位匹配完整的可访问名称；显示文本被截断或来自描述时，可直接使用元素引用。原生输入成功回执包含 `input_dispatched: true`。核验数量变化时先读取对应规格的当前数量，例如数量为 2 时，给 `browser_act` 传入 `verify: {selector: "#sku-42 input.qty", state: "value", value: "3"}`。回执的 `verification.matched` 表示页面是否满足该条件。超时仍保留已执行回执，先读取该规格再决定下一步。原生 locator 动作都接受末尾的 options 参数，例如 `fill(text, {verify})`、`scroll(deltaY, deltaX, {verify})`。CSS locator 还支持 read 和 waitFor。脚本中的 `locator.click({verify: {selector: "#sku-42 input.qty", state: "value", value: "3"}})` 复用同一核验和回执；省略核验的 frame_selector 时沿用动作 frame，显式指定时使用指定 frame。值核验及正向动作核验要求目标唯一，多个候选会返回 target_not_unique。后续步骤应检查 `verification.matched`。

选择 iframe 时，`invalid_selector` 表示 CSS 语法错误，`target_missing` 表示没有匹配，`target_not_unique` 包含匹配数量。`unsupported_frame` 表示选中元素无法提供已加载的同源 iframe 文档或可用的执行上下文。

按键支持 Enter、Tab、Escape、方向键等命名键和单字符，暂不接受修饰键组合；`select(valueOrValues)` 按原生选项 value 选择；`scroll(deltaY, deltaX?)` 修改最近可滚动容器或页面的 DOM 偏移，回执包含 before、after 和实际 delta。frame 支持当前同源文档，跨源 frame 明确拒绝，不回退到主文档；嵌套 frame、文件传输和原生文件对话框尚无专门接口。`evaluate` 可处理 DOM 数据与特定页面逻辑，但不能把它当成任意 frame 的通用替代。

代码默认限20秒，`timeout_ms` 可设至120秒；`wait_seconds` 默认15秒，等待返回后原操作可能仍在执行，应使用同一 `operation_id` 查询 `operation_status`，或 `operation_cancel` 取消。每段最多1000个浏览器步骤，QuickJS内存16MiB，连续纯计算有中断限额。日志最多100条/12000字符，状态和内部序列化结果最多1MiB；最终 value 超24000字符返回明确截断预览，建议在脚本内汇总或用快照分页。完整 JSON state 在正常序列化后保存；取消、超时或执行失败不能保证 state 包含最后一步进度，恢复应核对回执与实际页面。

在脚本中逐个 `await` 浏览器方法。中途失败时，先查看 `steps_completed` 与 `failed_step`。后者包含步骤 ID、方法、状态及错误信息。外层操作和页面步骤分别有自己的操作 ID。已完成的动作仍然生效，结果未知的步骤也可能已经触发滚动、聚焦或输入。检查原步骤的操作状态和实际页面后，再继续剩余步骤。

首步执行前明确拒绝时返回 `refused`。已有步骤完成后出错，或遇到纯脚本异常，则返回 `failed`。在途步骤超时、断连或缺少确认回执时报告 `outcome_unknown`。明确取消且没有未知步骤时返回 `cancelled`。脚本执行期间独占该会话，取消会终止脚本并请求取消在途步骤。

`browser_read` 在会话中缓存一份快照，最多 100 万字符。新快照替换旧快照。续页传回当前 `snapshot_id`（`snap_` 加 8 位 Base64URL）和 `offset`，默认沿用快照格式。文本按字符分页，表格按行分页，每页最多 200 行，保留合并单元格。响应标明来源 URL、缓存与截断情况。快照范围是已加载的主文档或创建时明确选定的同源 frame，适合读取数据。输入时要获取当前文档的操作引用。

等待条件最多 20 秒。提交页面脚本前的校验失败会保留任务页。脚本提交后如果执行或结果处理失败，扩展会等待清理并报告结果未知。对同一任务页发起的关闭、取消和停止会等待同一次清理。清理失败时，先按 `recovery` 提示停止任务以重试，诊断见 `cause` 和 `cleanup_error`。新任务会等待清理完成，迟到的旧会话清理只处理原任务页。

若控制会话仍有效但任务页已丢失，返回 `task_tab_missing`，使用 `browser_open` 创建任务页。会话已停止、到期或断连时，需要按会话恢复流程新建会话。

### 原生长按与等待

`page.locator(css).click({hold_ms:1500})` 原生按住鼠标左键 1500 毫秒后释放；`browser_act` 的 `click` 动作同样接受 `hold_ms`（0–10000 的整数，省略为普通单击）。保持期间关闭或取消会话会中断等待并清理任务页；页面导航导致结果未知，不重放。原生长按能否触发点赞、三连等业务行为仍由页面决定，DOM `dispatchEvent` 不能代替原生输入验证。 Server 等待动作终态回执的预算为 30 秒，加上显式长按时长及核验超时（核验默认 10 秒），合计最多 60 秒。后观察和 `wait_after_ms` 共用原有预算。设备接受操作的开始期限仍为 30 秒，`browser_exec` 的外层超时独立生效。

`browser_exec` 外层没有 `setTimeout`、`setInterval` 或 DOM 全局。优先通过 `page.wait` / `locator.waitFor` 等待页面条件；确实需要固定等待时使用 `await page.sleep(ms)`（0–10000 的整数）。等待可被取消并计入代码总超时，不计入浏览器步骤数。`page.evaluate` 内部运行在网页环境，与外层隔离运行时不同。批次后续代码出错不会回滚先前点击，应读取状态后再决定下一步。

### 手动 Device Token 绑定

在连接标签页的「绑定方式」选择「设备凭证」，输入管理台为浏览器设备生成的凭据后验证并连接。Token 默认隐藏，可手动显示；验证成功才替换本地绑定，保留暂停状态并清理旧任务会话，不重放旧操作。HTTP 确认与 Server Origin 精确绑定并保存在设备配置中；worker 独立复核确认，未确认时不发送 Token，也不建立 WS。扩展 CSP 允许 HTTP/WS 连接，实际地址仍由站点权限和绑定确认限制。浏览器授权继续使用 PKCE 与浏览器管理的授权窗口，两种方式取得相同的 Device Key。
