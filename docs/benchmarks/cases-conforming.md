# 按任务标准审核后的报告

审核按 task-validity-v1 执行，本轮排除 0 例。

| 集合            | 严格成功 / 分母 |
| --------------- | --------------- |
| 主对照 seed 0/1 | 12/12           |
| 额外 seed 2     | 6/6             |

两侧使用相同的模型目录和评测器。网络、模型响应和工具等待都计入端到端时间。超时按失败计入分母，即使原始奖励未知。判定任务未初始化时，以 Agent 动作前取得的独立证据为准。判分采集异常另行记录。

| 集合   | 任务                   | seed | 严格成功 | 原始奖励 | 失败记录 | 标准审核   |
| ------ | ---------------------- | ---- | -------- | -------- | -------- | ---------- |
| paired | form-sequence-3        | 0    | 是       | 1        | —        | 符合，保留 |
| paired | form-sequence-3        | 1    | 是       | 1        | —        | 符合，保留 |
| paired | email-inbox-forward-nl | 0    | 是       | 1        | —        | 符合，保留 |
| paired | email-inbox-forward-nl | 1    | 是       | 1        | —        | 符合，保留 |
| paired | book-flight            | 0    | 是       | 1        | —        | 符合，保留 |
| paired | book-flight            | 1    | 是       | 1        | —        | 符合，保留 |
| paired | navigate-tree          | 0    | 是       | 1        | —        | 符合，保留 |
| paired | navigate-tree          | 1    | 是       | 1        | —        | 符合，保留 |
| paired | click-menu-2           | 0    | 是       | 1        | —        | 符合，保留 |
| paired | click-menu-2           | 1    | 是       | 1        | —        | 符合，保留 |
| paired | multi-layouts          | 0    | 是       | 1        | —        | 符合，保留 |
| paired | multi-layouts          | 1    | 是       | 1        | —        | 符合，保留 |
| extra  | form-sequence-3        | 2    | 是       | 1        | —        | 符合，保留 |
| extra  | email-inbox-forward-nl | 2    | 是       | 1        | —        | 符合，保留 |
| extra  | book-flight            | 2    | 是       | 1        | —        | 符合，保留 |
| extra  | navigate-tree          | 2    | 是       | 1        | —        | 符合，保留 |
| extra  | click-menu-2           | 2    | 是       | 1        | —        | 符合，保留 |
| extra  | multi-layouts          | 2    | 是       | 1        | —        | 符合，保留 |

## 历史运行

| 版本                             | 全量严格成功 | 原始数据                                     |
| -------------------------------- | ------------ | -------------------------------------------- |
| 0.4.14启动修复后基线             | 5/12         | [基线](miniwob-v2-baseline.json)             |
| 早期0.4.12原始基线（不同配置）   | 5/12         | [逐次结果](miniwob-agent-results.json)       |
| 清理Docker后历史重跑（不同配置） | 8/12         | [逐次结果](miniwob-clean-host-results.json)  |
| 本轮stage1基线                   | 3/12         | [逐次结果](miniwob-v2-stage1-baseline.json)  |
| 本轮stage1候选原始判分           | 8/12         | [逐次结果](miniwob-v2-stage1-results.json)   |
| 本轮stage1候选全量重解析         | 9/12         | [逐次结果](miniwob-v2-stage1-rescored.json)  |
| 整合0.4.16前的0.4.14完整修复版   | 11/12        | [逐次结果](miniwob-v2-premerge-results.json) |
| 当前版本                         | 12/12        | [逐次结果](miniwob-v2-results.json)          |

历史运行和额外种子各自统计。第一阶段原始得分为 8/12，其中一例的 CLI 诊断消息被误判为越权。重新解析完整日志后，得分为 9/12，分母仍为 12。[修正记录](miniwob-v2-stage1-adjudication.json)

## 剔除清单

本轮所有任务均保留。

## 审核标准

- source_integrity_violation：任务源码或依赖不符合固定上游哈希，无法视为既定任务
- task_not_initialized：有独立证据证明任务未按约定种子、模式或初始状态启动
- undeclared_external_prerequisite：任务实际依赖评测约定未提供的外部账号、服务或数据
- outside_declared_task_scope：任务本身要求声明范围之外的操作，须有独立任务契约证据；工具实现缺陷不属于此类

在本机运行固定版本的上游任务，保留原有日期范围与界面。任务难度、语义标注缺失和工具能力不足均记录在试验结果中。

[原始逐次结果](miniwob-v2-results.json) · [额外种子结果](miniwob-v2-extra.json) · [通用修复报告](browser-reliability-v2.md)

本次测量覆盖一个模型和这组适配任务。评测范围和复现方式见 [MiniWoB++ 方法](miniwob.md)。
