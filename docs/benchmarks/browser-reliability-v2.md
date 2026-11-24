# 浏览器通用可靠性与固定环境对照

这次对照从 0.4.14 开始，比较启动修复版与完整的浏览器工具修复版。最终测量的提交为 `c02c42b`，已整合 main 的 `0bda49d`（0.4.16 和 Swift 6 原生桌面架构）。两侧使用同一组任务、可用工具和预算，修复范围集中在扩展启动、页面观察与原生输入。

## 修复范围

- 默认浏览器定时器保留原生全局 receiver，解决真实扩展绑定时的 `Illegal invocation`。Node 替身此前无法暴露此问题，新回归模拟浏览器品牌检查，反向验证旧实现明确失败。
- 观察为非语义可见文字补充引用，文字点击使用 Range；页面根节点按键保持当前焦点。
- 只读输入框返回 `read_only`、`input_type`；已知无效输入及当前覆盖层在滚动、聚焦或输入前拒绝，保留页面以便恢复。
- 引用期限从10秒调整至60秒，动作、导航、会话和文档失效检查保持。实际旧基线预检在无目录刷新错误时仍两次遇到过期，说明期限与模型往返不匹配是独立的通用问题。
- 指针操作保持原生鼠标事件与聚焦顺序；可见无文字图标通过有界扫描提供中性视觉引用，并保留原始 DOM 身份。
- 滚动使用明确的即时 DOM 语义，返回实际前后偏移和 delta；不发送滚轮事件，不支持依赖 wheel 的 canvas 手势。嵌套容器裁切可以先露出目标，最终命中检查仍保留；真正覆盖层仍拒绝，select 不借此放行。
- select 的控件类型、禁用、单多选和有效选项在无副作用阶段验证，写入前再次复核。实际写入后即使抛出字符串，也仍按未知结果处理、关闭任务且不重放。
- 已超时或超调用预算的 Actor 不再与未结束操作争抢判分，失败保留原预算原因并继续清理。

实现保持 TaskTabs、设备连接、控制会话和操作各自的生命周期归属；未知写结果不自动重放。

## 对照设计

0.4.14 在真实 Chrome 中的设备绑定会失败。先做最小启动修复 `6014447`，让浏览器能够接入 Server，然后以这个版本作为基线。绑定阶段的故障保留在日志中，任务评分从浏览器可用后开始。

基线和修复版使用同一个评测器、任务提示和模型（`gpt-6.1-sol`，medium）。主集合用种子 0 和 1，每例 180 秒、最多 40 次调用，并发 2，每例运行一次。开发期间也使用过种子 2，因此把它作为同六类任务的额外运行单独统计。

通过 `--model-catalog` 将同一份目录传入两侧的 Codex 子进程，对应 `model_catalog_json` 配置。目录条目从本机缓存逐字复制，运行前后核对 SHA-256，摘要随结果保存。这样可以避开模型目录刷新超时。网络和模型响应时间仍会波动。

[官方本地目录说明](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway#distribute-a-local-catalog) · [配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。使用临时子进程配置，不修改用户全局 Codex 配置或认证。

运行时关闭评测子进程的 `features.plugins` 和 `features.remote_plugin`，避免后台刷新插件市场占用任务预算。功能开关只应用于本次子进程。[官方功能开关说明](https://learn.chatgpt.com/docs/enterprise/managed-configuration#control-plugin-availability)

Codex 通过 MCP 调用 Server，再由实际的 Chrome 扩展执行操作。Agent 可调用 `browser_observe`、`browser_read`、`browser_act` 和 `browser_wait`。控制器单独初始化和判分。[上游任务与评分方法](miniwob.md)

## 结果与审核

README 的表格从原始快照生成。[试验基线](miniwob-v2-baseline.json) · [修复版主集合](miniwob-v2-results.json) · [额外种子](miniwob-v2-extra.json)

本轮审核保留所有案例，失败和超时照常计入分母。缺少奖励或用量的记录保留为未知。[全量案例](cases-all.md) · [任务审核](cases-conforming.md) · [审核标准](https://github.com/xerrors/aBridge/blob/main/tools/bench-case-policy.json)

不同版本的历史运行各自统计，额外种子和重复运行也单独保留。[历史快照](https://github.com/xerrors/aBridge/tree/b335d16b28eca4ce801e2dee687c0bfffce5a331/docs/benchmarks)

## 最终结果与剩余问题

| 指标             | 同配置可启动基线 | 通用修复后    |
| ---------------- | ---------------- | ------------- |
| 主集合严格成功   | 5/12（41.7%）    | 12/12（100%） |
| Agent耗时P50     | 120.1秒          | 69.5秒        |
| 工具调用尝试总数 | 102              | 67            |
| 用量覆盖         | 10/12            | 12/12         |

额外种子 2 完成 6/6，共调用 37 次。主集合和额外集合的 18 个会话均成功清理。两组各有两次可恢复的 `invalid_action`，Agent 恢复后完成了任务。运行日志里的越权、目录刷新错误、插件诊断和终止错误均为 0。[审计计数](miniwob-v2-diagnostics.json)

整合 0.4.16 前，0.4.14 修复版的主集合完成 11/12。失败的是 `book-flight` 的种子 1。渲染准备后目标复核失败，任务页关闭，记录为 `task_tab_lost`，奖励未知。本轮重跑的两例订票都成功。[整合前主集合](miniwob-v2-premerge-results.json) · [额外种子](miniwob-v2-premerge-extra.json) · [对应基线](miniwob-v2-premerge-baseline.json)

对照的起点是 0.4.14 启动修复版，终点包括浏览器修复和 0.4.16 的整合，因此表格反映两者之间的整体差异。整合后也修复了 Swift 6 对同步 C ABI 借用指针的编译错误，通过原生 SDK 只读调用和 App 构建检查。桌面权限和真实输入需要在实际安装的 App 中单独验收。

修复后减少了重复观察和输入失败，也可能受到模型及网络耗时波动影响。基线有两例缺少用量，成本分析限于 CLI 实际返回的 token 数据。

本地 `npm run check` 已通过，300/300自动测试通过；9/9组真实Chrome自有fixture通过。检查还包括格式、架构、类型、分发和离线安装；GitHub CI按五个Node/系统组合另行验证。公开数据生成README和图，并通过输入摘要核对一致性。

## 第一轮评测器问题与完整留痕

第一轮固定目录后，正式基线3/12、候选原始8/12。候选有一例官方奖励1、CLI正常退出，却因插件市场更新超时产生的纯诊断 `item.type=error` 被误算为未知工具调用。判分器现只将已知 `id/type/message` 形态归为诊断；带执行字段或未知字段仍拒绝，实际工具白名单没有放宽。

重新解析双方完整日志后，基线为 3/12，候选为 9/12。唯一更正是上述一例的越权标签，原有任务结果、奖励、耗时、用量和分母均保留。

[第一轮基线](miniwob-v2-stage1-baseline.json) · [候选原始8/12](miniwob-v2-stage1-results.json) · [重算9/12](miniwob-v2-stage1-rescored.json) · [逐例修正记录](miniwob-v2-stage1-adjudication.json)。第一轮命令因误判越权非零退出，额外种子尚未运行；没有借用其他版本的额外成绩。

之后双方按相同的禁用插件配置重跑完整集合。更早的 Docker 清理后运行使用不同的版本和目录配置，单独保留在历史记录中。[历史主集合 8/12](miniwob-clean-host-results.json) · [额外种子 4/6](miniwob-clean-host-extra.json)

## 独立验证与复现

真实 Chrome 自有 fixture 覆盖文字精确点击、页面根键盘、只读拒绝与恢复、候选框原生鼠标顺序、视觉图标、覆盖层拒绝与恢复、后台 DOM 滚动、嵌套容器裁切与点击、select 已知拒绝与写后异常边界。它们不包含公开 benchmark 的业务逻辑。

```sh
npm run check
npm run test:browser:reliability:live
npm run benchmark:miniwob -- --model-catalog /absolute/path/to/models.json --out result.json
npm run benchmark:miniwob -- --holdout --model-catalog /absolute/path/to/models.json --out extra.json
npm run benchmark:report
python3 tools/bench-plot.py
```

本地模型目录应来自实际模型提供方或已缓存的匹配条目；不得使用文档示例替换真实模型的指令和能力。认证、Profile、截图与原始 CLI/网关日志保留在忽略的 `.local/bench/`，不随公开结果上传。制图单独需要 matplotlib 与 CJK 字体，默认 CI 不安装 Python。

这组结果对应一台机器上的一个模型和六类适配任务。复现时，网络、模型服务和宿主机资源都会影响耗时和成功率。
