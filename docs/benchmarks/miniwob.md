# 真实 Agent 浏览器任务评测

这组评测记录 Codex Agent 通过 aBridge 完成 MiniWoB++ 浏览器任务所需的时间和工具调用。Agent 从网页读取任务并操作实际加载的扩展，MiniWoB++ 独立判分。结果对应下面列出的模型、工具和运行环境。

## 快速复现

需要 Node、项目依赖、已登录且能使用指定模型的 Codex CLI，以及支持 `--load-extension` 的 Chrome for Testing / Chromium：

```sh
npm install --ignore-scripts
npm run benchmark:miniwob
```

默认运行 12 个任务与种子组合，会产生实际模型用量。脚本优先使用本机 Playwright 缓存的 Chrome for Testing，也可以通过 `ABRIDGE_BENCH_CHROME=/absolute/path/to/chrome` 指定。运行时会创建隔离的浏览器 Profile、临时 Server 和虚构设备。若遇到扩展加载失败，请确认浏览器支持 `--load-extension`。

先用不计分的简单任务检查认证、MCP 和浏览器：

```sh
npm run benchmark:miniwob -- --preflight
```

单独保存本地运行结果：

```sh
npm run benchmark:miniwob -- --out .local/bench/result.json
```

CI 用 `npm run benchmark:report:check` 核对仓库中的评测结果、README 和图表。需要从已登记的快照重新生成报告时，用 `npm run benchmark:report`。真实模型评测按需运行。基础设施、越权或清理失败会使命令返回非零状态，普通任务失败则记录在结果中。

## 数据来自哪里

任务、脚本、样式和图片使用 Farama Foundation MiniWoB++ 的固定提交，许可为 MIT。下载时根据来源清单逐项校验文件的 SHA-256。[上游源码](https://github.com/Farama-Foundation/miniwob-plusplus/tree/33c3b4ddef8c6eb67c57a29663d844b1eda7e614) · [来源清单](https://github.com/xerrors/aBridge/blob/main/tools/bench/miniwob-agent-source.json)

评测前先定下下表中的任务，每类在 test 模式下使用种子 0 和 1，各运行一次。控制器依次调用 `Math.seedrandom(seed)`、`core.setDataMode('test')` 和 `core.startEpisodeReal()`，由上游任务生成目标和页面。[评测配置](https://github.com/xerrors/aBridge/blob/main/tools/bench/agent-suite.json)

| 任务                     | 内容                     | 原始限时 |
| ------------------------ | ------------------------ | -------- |
| `form-sequence-3`        | 按指令完成顺序表单       | 10 秒    |
| `email-inbox-forward-nl` | 从邮件列表定位邮件并转发 | 30 秒    |
| `book-flight`            | 填写航班搜索表单         | 30 秒    |
| `navigate-tree`          | 展开层级并定位目标       | 10 秒    |
| `click-menu-2`           | 选择文字或图标菜单项     | 10 秒    |
| `multi-layouts`          | 在变化布局中填写表单     | 20 秒    |

任务覆盖顺序操作、自然语言定位、树结构、视觉目标和布局变化。邮件任务沿用 test 模式的措辞模板，航班日期来自上游任务。每类只取两个种子，尤其是耗时统计容易随样本变化。

## 固定 Agent 与权限边界

每例使用独立的 Codex 进程和新会话，模型为 `gpt-6.1-sol`，推理等级为 `medium`。统一限时 **180 秒**、最多 **40 次工具调用**、并发 **2**，CLI 启动和模型请求也计时。结果对应这一组延长限时的适配任务，奖励函数和答案沿用上游。

Agent 只拿到可见任务指令、当前会话 ID 和四个工具：`browser_observe`、`browser_read`、`browser_act`、`browser_wait`。首次要求观察截图，后续可使用 DOM 与截图。独立 MCP 网关限制工具、会话和读取范围，不暴露 `browser_exec`、会话管理、源码直接读取或判分接口。CLI 关闭 shell、其他 MCP、插件、web search 和多 Agent；工具轨迹按允许列表审计。超出调用预算的请求在转发前拒绝。

任务初始化和判分在控制器侧使用独立 `browser_exec`，这些调用不进入 Agent 工具数，也不暴露给模型。网关限制直接读取隐藏判分变量；本次还审计实际轨迹，检查是否调用等待工具探测隐藏内容、是否点击 START 重新开题。当前网关未对 `browser_wait` 的全部 selector/text 组合做防侧信道隔离，页面内重开也需靠轨迹复核。因此这是正常任务 Agent 的可审阅评测，不宣称恶意 Agent 的反作弊安全隔离。

实际扩展来自本项目构建；临时副本只预授本次 loopback Server 主机权限，使用真实 `bind_token` 与 WebSocket 绑定。未覆盖商店安装、系统授权弹窗、macOS App 或真实站点账号。

## 判分和指标

- **任务完成 `businessSuccess`**：上游 `WOB_DONE_GLOBAL === true` 且 `WOB_RAW_REWARD_GLOBAL === 1`。时间衰减奖励单独保存，不用平均奖励替代成功率。
- **严格成功 `success`**：任务完成，且 Agent 正常退出、未超时、未超调用预算、无工具越权。README 使用此口径。任务已完成但 Agent 超时仍计失败，原始完成状态可复核。若动作失败导致产品关闭任务页，记为 `task_tab_lost`，判分值为 `null`；只确认端到端未完成，不推测已经消失页面的奖励。
- **分母**：冻结的全部 12 个任务/种子，包括失败；每例不重试。启动环境失败不生成有效分数；已开始的逐例异常记录为失败并保留原因。
- **Agent 耗时**：从启动 CLI 前到进程退出，包含模型、MCP 和浏览器等待，不含页面初始化、判分、清理及一次性环境启动。已开始的失败/超时同样进入统计，尚未启动为 `null`。P50 是中位数，P95 是 nearest-rank；每类两个样本不足以推断稳定尾延迟。
- **工具调用**统计 Agent 发到网关的调用尝试，含错误与预算拒绝。准备和判分由控制器执行，另行记录。
- **token 消耗**来自 CLI 的用量报告。输入总量已包含缓存。超时或中断时，缺失的 usage 记为未知，同时报告已知合计和覆盖率。缺少 reasoning 时记为 `null`。
- **美元成本**字段保留为 `costUsd=null`，测量只收集 CLI 提供的 token 用量。
- **清理**：关闭会话后 10 秒内确认本次唯一标签已消失。任务成功与清理独立记录，清理失败使命令失败。

## 证据与局限

逐次结果包含判分、失败原因、耗时、工具调用数、用量和环境，README 由登记的快照生成。评测前后会核对任务文件哈希，结果也记录扩展 worker 的 SHA-256 与产品提交。[当前逐次结果](miniwob-v2-results.json) · [此前运行](miniwob-agent-results.json)

原始 CLI JSONL（含截图）、stderr、网关轨迹、隔离 Profile、临时凭据和数据库只保留在忽略的 `.local/bench/runs/agent-*/`，不公开上传。正常结束和 SIGINT/SIGTERM 都清理本次服务与浏览器，证据文件保留。公开快照不含原始提示回复、会话 ID 或凭据。

开发预检修复了 MCP Accept 头、CLI 工具审批配置和任务页丢失的错误分类；分类缺陷的未完成批次中止并保留在本地，正式结果使用修复后同一冻结协议的完整批次，未混用最好成绩。

本次运行覆盖一个模型和一台机器。公开任务可能进入过模型训练数据，同一任务也会受浏览器、日期、模型后端和网络影响。若要比较不同版本，可固定任务、模型和预算，增加配对种子，并一起报告失败分类、用量覆盖和置信区间。

## 独立的执行链冒烟与负对照

历史冒烟测试使用固定 DOM 策略，在上游 10 秒限时下完成 `click-test`、`enter-text` 和 `read-table`，共 30/30。它与 Agent 评测各自统计，历史源码版本可通过快照中的哈希核对。[冒烟历史数据](miniwob-results.json)

```sh
npm run benchmark:smoke -- --episodes 1
npm run benchmark:smoke -- --episodes 1 --negative-controls
```

负对照用三种预期失败的情况检查判分器：等待超时、提交错误文本和提交错误表格答案。这些例子单独统计。[负对照结果](miniwob-controls.json)
