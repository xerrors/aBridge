# 真实 Agent 浏览器任务评测

本评测衡量固定 Agent 使用 aBridge 完成公开浏览器任务的效果与资源消耗。真实链路为 **Codex Agent → HTTP MCP → Server → WebSocket → 实际加载的 aBridge 扩展 → Chrome CDP 输入 → 上游判分**。任务求解没有人工操作或预写答案脚本。它评测的是这一整套模型与工具配置，不能将成功或失败全部归因于 aBridge。

## 快速复现

需要 Node、项目依赖、已登录且能使用指定模型的 Codex CLI，以及支持 `--load-extension` 的 Chrome for Testing / Chromium：

```sh
npm ci --ignore-scripts
npm run benchmark:miniwob
```

默认运行冻结的 12 个样本，会真实消耗模型用量。优先发现本机 Playwright 缓存中的 Chrome for Testing，也可用 `ABRIDGE_BENCH_CHROME=/absolute/path/to/chrome` 指定。不需要 Python、Selenium、BrowserGym 或新 npm 运行依赖。使用隔离的有界面 Chrome、临时 Server 和虚构设备，不连接个人 Profile 或真实业务账户。普通 Chrome 可能禁止命令行加载扩展；找不到实际扩展 worker 会失败，不使用扩展替身。

先用不计分的简单任务检查认证、MCP 和浏览器：

```sh
npm run benchmark:miniwob -- --preflight
```

生成新的完整结果并更新 README：

```sh
npm run benchmark:miniwob -- --out docs/benchmarks/miniwob-agent-results.json
npm run benchmark:report
npm run check
```

真实模型评测不进入默认 CI。CI 只运行确定性测试、校验冻结协议、完整样本集合及 README 与快照的一致性。任务失败是跑分数据；基础设施、越权、清理失败则命令非零退出。预检任何失败都非零退出。

## 数据来自哪里

使用 [Farama Foundation MiniWoB++](https://github.com/Farama-Foundation/miniwob-plusplus/tree/33c3b4ddef8c6eb67c57a29663d844b1eda7e614)，固定 commit `33c3b4ddef8c6eb67c57a29663d844b1eda7e614`，MIT 许可。任务、脚本、样式、图像保持上游原样；[来源清单](https://github.com/xerrors/aBridge/blob/main/tools/bench/miniwob-agent-source.json) 保存每个文件的 SHA-256，下载缓存逐项校验。数据不是我们编写的业务题或根据模型成绩挑选的样例。

[冻结协议](https://github.com/xerrors/aBridge/blob/main/tools/bench/agent-suite.json) 在正式运行前确定以下任务，每类使用数字种子 `0、1`，test 模式。上游通过种子生成文字、目标和界面布局，控制器调用 `Math.seedrandom(seed)`、`core.setDataMode('test')`、`core.startEpisodeReal()`。不手写答案，不根据失败修改样例，不重试或挑选最好结果。

| 任务                     | 内容                     | 原始限时 |
| ------------------------ | ------------------------ | -------- |
| `form-sequence-3`        | 按指令完成顺序表单       | 10 秒    |
| `email-inbox-forward-nl` | 从邮件列表定位邮件并转发 | 30 秒    |
| `book-flight`            | 填写航班搜索表单         | 30 秒    |
| `navigate-tree`          | 展开层级并定位目标       | 10 秒    |
| `click-menu-2`           | 选择文字或图标菜单项     | 10 秒    |
| `multi-layouts`          | 在变化布局中填写表单     | 20 秒    |

这些任务覆盖顺序操作、自然语言定位、树结构、视觉目标和布局变化，但不等于复杂企业流程。邮件 test 模式的措辞模板有限，航班日期来自上游旧任务。每类仅两个种子，结果方差可能很大。

## 固定 Agent 与权限边界

模型 `gpt-6.1-sol`，reasoning `medium`，独立 ephemeral Codex 进程，每例新会话、不携带上例聊天。统一限时 **180 秒**、最多 **40 次工具调用**、并发 **2**。限时包括 CLI 启动与模型请求。上游原始限时过短，因此统一覆盖为 180 秒，奖励函数和答案不变：这是适配子集，不能与官方原始限时榜单直接比较。

Agent 只拿到可见任务指令、当前会话 ID 和四个工具：`browser_observe`、`browser_read`、`browser_act`、`browser_wait`。首次要求观察截图，后续可使用 DOM 与截图。独立 MCP 网关限制工具、会话和读取范围，不暴露 `browser_exec`、会话管理、源码直接读取或判分接口。CLI 关闭 shell、其他 MCP、插件、web search 和多 Agent；工具轨迹按允许列表审计。超出调用预算的请求在转发前拒绝。

任务初始化和判分在控制器侧使用独立 `browser_exec`，这些调用不进入 Agent 工具数，也不暴露给模型。网关限制直接读取隐藏判分变量；本次还审计实际轨迹，检查是否调用等待工具探测隐藏内容、是否点击 START 重新开题。当前网关未对 `browser_wait` 的全部 selector/text 组合做防侧信道隔离，页面内重开也需靠轨迹复核。因此这是正常任务 Agent 的可审阅评测，不宣称恶意 Agent 的反作弊安全隔离。

实际扩展来自本项目构建；临时副本只预授本次 loopback Server 主机权限，使用真实 `bind_token` 与 WebSocket 绑定。未覆盖商店安装、系统授权弹窗、macOS App 或真实站点账号。

## 判分和指标

- **任务完成 `businessSuccess`**：上游 `WOB_DONE_GLOBAL === true` 且 `WOB_RAW_REWARD_GLOBAL === 1`。时间衰减奖励单独保存，不用平均奖励替代成功率。
- **严格成功 `success`**：任务完成，且 Agent 正常退出、未超时、未超调用预算、无工具越权。README 使用此口径。任务已完成但 Agent 超时仍计失败，原始完成状态可复核。若动作失败导致产品关闭任务页，记为 `task_tab_lost`，判分值为 `null`；只确认端到端未完成，不推测已经消失页面的奖励。
- **分母**：冻结的全部 12 个任务/种子，包括失败；每例不重试。启动环境失败不生成有效分数；已开始的逐例异常记录为失败并保留原因。
- **Agent 耗时**：从启动 CLI 前到进程退出，包含模型、MCP 和浏览器等待，不含页面初始化、判分、清理及一次性环境启动。已开始的失败/超时同样进入统计，尚未启动为 `null`。P50 是中位数，P95 是 nearest-rank；每类两个样本不足以推断稳定尾延迟。
- **工具调用**：Agent 发到网关的调用尝试总数，包括错误与预算拒绝，不是鼠标点击次数。准备和判分不计入。
- **token 消耗**：CLI 完整 turn 返回的输入、缓存输入、输出 token。输入包含缓存；缓存不能重复相加。超时或中断可能缺少 usage，因此同时报告已知合计与覆盖率，未知不等于 0。reasoning 未提供时为 `null`。
- **美元成本**：CLI 不返回实际账单，`costUsd=null`，不编造金额，也不拿不完整 token 合计计算每次成功的完整成本。
- **清理**：关闭会话后 10 秒内确认本次唯一标签已消失。任务成功与清理独立记录，清理失败使命令失败。

## 证据与局限

[逐次结果](miniwob-agent-results.json) 保存每例判分、失败原因、耗时、工具数、用量及环境；README 自动生成，不手填成绩。运行前冻结协议和 benchmark 文件哈希，运行后确认文件未变。结果包含扩展 worker SHA-256 和产品基线提交；新增 benchmark 尚未提交时，其准确版本由文件哈希描述。

原始 CLI JSONL（含截图）、stderr、网关轨迹、隔离 Profile、临时凭据和数据库只保留在忽略的 `.local/bench/runs/agent-*/`，不公开上传。正常结束和 SIGINT/SIGTERM 都清理本次服务与浏览器，证据文件保留。公开快照不含原始提示回复、会话 ID 或凭据。

开发预检修复了 MCP Accept 头、CLI 工具审批配置和任务页丢失的错误分类；分类缺陷的未完成批次中止并保留在本地，正式结果使用修复后同一冻结协议的完整批次，未混用最好成绩。

这是首次小样本基线，单模型、单机器、无竞争工具对照。公开任务可能存在训练污染风险；同一种子跨环境仍可能受浏览器、日期、模型后端和网络影响。要形成比较结论，应先扩大冻结种子，再对不同 aBridge 版本或工具后端使用相同任务、模型、预算作配对评测，同时报告失败分类、完整用量覆盖与置信区间。当前结果不能证明跨模型泛化或工具性能优势。

## 独立的执行链冒烟与负对照

此前固定可见 DOM 策略的 `click-test`、`enter-text`、`read-table` 30/30 是[冒烟历史数据](miniwob-results.json)，不是 Agent 能力得分。其源码使用上游原始 10 秒限时；不与本次真实 Agent 合并统计。历史快照的源码哈希代表当时版本，不保证与后续重构逐字一致。

```sh
npm run benchmark:smoke -- --episodes 1
npm run benchmark:smoke -- --episodes 1 --negative-controls
```

[负对照结果](miniwob-controls.json) 分别验证不操作导致超时、错误文本、错误表格答案会被上游拒绝。人为制造的错误仅验证判分器，绝不混入真实 Agent 失败率。
