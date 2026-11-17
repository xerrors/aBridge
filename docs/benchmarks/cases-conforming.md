# 按任务标准审核后的报告

政策版本：task-validity-v1。本轮剔除 0 例。

| 集合            | 严格成功 / 分母 |
| --------------- | --------------- |
| 主对照 seed 0/1 | 8/12            |
| 额外 seed 2     | 5/6             |

最终运行存在CLI模型目录刷新超时记录，端到端等待受工具之外因素干扰，详见通用修复报告。超时全部保留；此运行质量问题不属于任务不合规，不能据此剔除。

任务未初始化仅指Agent动作前已由独立证据确认的错误。操作后的异常、任务失败、预算耗尽、模型或工具能力不足都不是排除理由。判分采集异常与任务合规性分别记录；已超时即严格失败，不因奖励未知而剔除。

| 集合   | 任务                   | seed | 严格成功 | 原始奖励 | 失败记录              | 标准审核   |
| ------ | ---------------------- | ---- | -------- | -------- | --------------------- | ---------- |
| paired | form-sequence-3        | 0    | 是       | 1        | —                     | 符合，保留 |
| paired | form-sequence-3        | 1    | 是       | 1        | —                     | 符合，保留 |
| paired | email-inbox-forward-nl | 0    | 否       | 未知     | time_budget（已超时） | 符合，保留 |
| paired | email-inbox-forward-nl | 1    | 否       | 未知     | time_budget（已超时） | 符合，保留 |
| paired | book-flight            | 0    | 否       | 未知     | time_budget（已超时） | 符合，保留 |
| paired | book-flight            | 1    | 否       | 未知     | time_budget（已超时） | 符合，保留 |
| paired | navigate-tree          | 0    | 是       | 1        | —                     | 符合，保留 |
| paired | navigate-tree          | 1    | 是       | 1        | —                     | 符合，保留 |
| paired | click-menu-2           | 0    | 是       | 1        | —                     | 符合，保留 |
| paired | click-menu-2           | 1    | 是       | 1        | —                     | 符合，保留 |
| paired | multi-layouts          | 0    | 是       | 1        | —                     | 符合，保留 |
| paired | multi-layouts          | 1    | 是       | 1        | —                     | 符合，保留 |
| extra  | form-sequence-3        | 2    | 是       | 1        | —                     | 符合，保留 |
| extra  | email-inbox-forward-nl | 2    | 是       | 1        | —                     | 符合，保留 |
| extra  | book-flight            | 2    | 否       | 未知     | time_budget（已超时） | 符合，保留 |
| extra  | navigate-tree          | 2    | 是       | 1        | —                     | 符合，保留 |
| extra  | click-menu-2           | 2    | 是       | 1        | —                     | 符合，保留 |
| extra  | multi-layouts          | 2    | 是       | 1        | —                     | 符合，保留 |

## 版本历史（不混入最终分母）

| 版本     | 全量严格成功 | 原始数据                                      |
| -------- | ------------ | --------------------------------------------- |
| 原始基线 | 5/12         | [基线](miniwob-agent-results.json)            |
| stage1   | 8/12         | [逐次结果](miniwob-tools-stage1-results.json) |
| stage2   | 9/12         | [逐次结果](miniwob-tools-stage2-results.json) |
| stage3   | 10/12        | [逐次结果](miniwob-tools-stage3-results.json) |
| stage4   | 11/12        | [逐次结果](miniwob-tools-stage4-results.json) |
| 当前版本 | 8/12         | [逐次结果](miniwob-tools-results.json)        |

历史数据保留，不用不同版本的最好成绩拼接最终结果。额外种子另列，不将重复尝试混入主对照。

## 剔除清单

无。当前没有证据证明这些任务违反约定，不能为提高分数而强行剔除。

## 审核标准

- source_integrity_violation：任务源码或依赖不符合固定上游哈希，无法视为既定任务
- task_not_initialized：有独立证据证明任务未按约定种子、模式或初始状态启动
- undeclared_external_prerequisite：任务实际依赖评测约定未提供的外部账号、服务或数据
- outside_declared_task_scope：任务本身要求声明范围之外的操作，须有独立任务契约证据；工具实现缺陷不属于此类

固定上游任务在本地运行；日期范围和界面变化属于原始任务内容，不因难度或缺少语义标注而排除。工具不足应作为产品问题修复。

[原始逐次结果](miniwob-tools-results.json) · [额外种子结果](miniwob-tools-holdout.json) · [通用修复报告](browser-reliability.md)

这是小样本、单模型的探索性结果，不是官方榜单或大样本泛化结论。
