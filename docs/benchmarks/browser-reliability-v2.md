# 浏览器通用可靠性与固定环境对照

本轮从 main 的 0.4.14 重新审查并移植通用修复，再整合 main `0bda49d`（0.4.16，Swift 6 原生桌面架构），最终测量产品提交 `c02c42b`。旧开发分支的修复尚未合入 main，不能直接用旧版本结果代表当前实现。没有加入具体任务的选择器、收件人、日期、答案或操作路径，也没有增加 Agent 可用的工具、Skill、时间或调用预算。

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

未修改的 0.4.14 在真实 Chrome 中无法完成设备绑定。这是启动故障，保留其日志，不伪装成12道任务全部失败的得分。先单独提交最小启动修复 `6014447`，再将这个**可启动基线**与完整工具修复版作正式对照。

两侧使用逐字相同的评测器源码、任务 prompt、`gpt-6.1-sol` / medium、主集合 seed 0/1、每例180秒/40次调用、并发2，无逐例重试。额外 seed=2 另行统计；它仍是同六类任务，开发过程中曾使用，不是独立盲测或六类新题。

本轮使用 Codex 的 `--model-catalog` 评测参数，最终传递官方 `model_catalog_json` CLI配置项。模型条目从本机已有缓存逐字复制，不编写替代指令、不修改模型能力。基线与修复版共用同一份文件，运行前后核验 SHA-256，并随结果记录摘要。它只固定元数据，不能消除模型响应或网络波动，也不能把历史未固定目录的成绩当成严格受控对照。

[官方本地目录说明](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway#distribute-a-local-catalog) · [配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。使用临时子进程配置，不修改用户全局 Codex 配置或认证。

另显式关闭评测子进程的 `features.plugins`、`features.remote_plugin`，避免用户全局插件市场后台刷新占用本轮预算。空 `plugins={}` 不能替代功能开关。[官方功能开关说明](https://learn.chatgpt.com/docs/enterprise/managed-configuration#control-plugin-availability)。只修改本次子进程设置，不改变用户全局配置。

真实链路为 Codex → MCP → Server → WebSocket → 实际扩展 → Chrome。Actor 仅可使用 browser_observe/read/act/wait，不能执行 JS、直接读取源码或访问判分状态；初始化和判分由控制器单独执行。继续使用[固定上游与评分方法](miniwob.md)。

## 结果与审核

结果由 README 表格和原始快照生成，不手写分数：[可启动基线](miniwob-v2-baseline.json)、[修复版主集合](miniwob-v2-results.json)、[额外种子](miniwob-v2-extra.json)。

[全量案例](cases-all.md)与[按标准审核后的案例](cases-conforming.md)分开提供。沿用[任务有效性政策](https://github.com/xerrors/aBridge/blob/main/tools/bench-case-policy.json)，失败、超时、工具不足或 CLI 故障均不能作为剔除依据；当前没有任务不符合约定的独立证据。未知奖励与用量保持未知，不能当作零或推算完整美元成本。

历史结果保留在[之前开发分支的快照](https://github.com/xerrors/aBridge/tree/b335d16b28eca4ce801e2dee687c0bfffce5a331/docs/benchmarks)，不从不同版本抽取最好样本，也不将额外种子或重复运行混入主集合分母。

## 最终结果与剩余问题

| 指标             | 同配置可启动基线 | 通用修复后    |
| ---------------- | ---------------- | ------------- |
| 主集合严格成功   | 5/12（41.7%）    | 12/12（100%） |
| Agent耗时P50     | 120.1秒          | 69.5秒        |
| 工具调用尝试总数 | 102              | 67            |
| 用量覆盖         | 10/12            | 12/12         |

额外seed=2为6/6，37次调用，单独统计、不合并主集合分母。最终18例会话清理均成功，实际越权为0，未见目录刷新、插件诊断或终止错误事件。但**不是零工具错误**：主集合与额外集合各2次可恢复invalid_action，Agent恢复后完成任务。详见[审计计数](miniwob-v2-diagnostics.json)。

本次完整运行没有失败案例；这不表示历史问题被删除。整合0.4.16前，0.4.14完整修复版的[主集合11/12](miniwob-v2-premerge-results.json)、[额外6/6](miniwob-v2-premerge-extra.json)与[对应基线](miniwob-v2-premerge-baseline.json)均保留。那轮book-flight seed1在渲染准备后目标复核失败，按未知结果保护关闭任务页；保留task_tab_lost和未知奖励，没有重放或加入专用规则。本轮完整重跑两例订票均成功，不能据此断言该偶发风险已消失。

基线仍为0.4.14最小启动修复版 `6014447`，不是未修改的0.4.16。比较固定了评测器、模型目录和环境，但跨越了main集成，不能把全部差异单独归因某一项工具改动。整合后额外修复Swift 6对同步C ABI借用指针的隔离编译错误；原生SDK只读调用和App构建通过，不代表系统权限或真实桌面输入已验收。

耗时改善包含较少重复观察和输入失败，也仍受模型/网络时间波动影响，不能单独等同于桥接执行器更快。基线2例缺失usage，已知token合计不能当作完整总成本；CLI没有实际美元账单。

本地 `npm run check` 已通过，300/300自动测试通过；9/9组真实Chrome自有fixture通过。检查还包括格式、架构、类型、分发和离线安装；GitHub CI按五个Node/系统组合另行验证。公开数据生成README和图，并通过输入摘要核对一致性。

## 第一轮评测器问题与完整留痕

第一轮固定目录后，正式基线3/12、候选原始8/12。候选有一例官方奖励1、CLI正常退出，却因插件市场更新超时产生的纯诊断 `item.type=error` 被误算为未知工具调用。判分器现只将已知 `id/type/message` 形态归为诊断；带执行字段或未知字段仍拒绝，实际工具白名单没有放宽。

对两侧全部原始日志重解析后，基线仍3/12，候选9/12；仅该例的错误越权标签被纠正，任务、奖励、耗时、用量与分母不变。这是判分器修复，不是剔除案例，也未将时间预算失败改成成功。

[第一轮基线](miniwob-v2-stage1-baseline.json) · [候选原始8/12](miniwob-v2-stage1-results.json) · [重算9/12](miniwob-v2-stage1-rescored.json) · [逐例修正记录](miniwob-v2-stage1-adjudication.json)。第一轮命令因误判越权非零退出，额外种子尚未运行；没有借用其他版本的额外成绩。

随后双方均使用相同的禁用插件配置重新跑完整集合。不能把不同配置的最好结果混成最终成绩。此前清理Docker后的[主集合8/12](miniwob-clean-host-results.json)与[额外4/6](miniwob-clean-host-extra.json)也保留为历史记录，因版本与CLI目录配置不同，不作为本轮受控基线。

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

这是小样本、单模型、单机器的适配子集，不是官方 MiniWoB 榜单或竞品比较。单次点估计达到80%–90%不等于已经证明长期稳定的泛化成功率；网络、模型服务和宿主机资源仍会变化。真实浏览器回归不证明 macOS App 权限或系统输入已经验收。
