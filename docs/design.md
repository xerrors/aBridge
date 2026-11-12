# 设计与资产

管理台围绕“设备、Agent 授权、记录”组织；原生客户端围绕“连接、能力、暂停、系统权限”组织。任务编排与聊天属于调用方，aBridge 展示可信设备状态与执行结果。

## 当前设计约定

| 用途 | 值 |
| --- | --- |
| 主色 | `#0064e1` |
| 页底 | `#f4f6fa` |
| 工作区 | `#ffffff` |
| 正文 | `#172336` |
| 分隔 | `#dce4ee` |
| 就绪 | `#137a56` |

使用系统字体、左对齐内容和行级权限对照。桌面端采用 AppKit 原生控件。保留可见焦点与窄屏布局；文案只说明状态和必要操作，不重复描述页面。

生产界面在 `abridge/static/`，原生界面在 `native/aBridge.swift`。品牌矢量源为 `abridge/static/brand.svg`，由页面标识和 favicon 共用。

## 原型边界

[技术架构图](prototype/design-review.html#tech-stack) 集中展示调用方、aBridge 服务和 Mac 执行层，版本与取舍收进折叠参考。模块细节见 [架构文档](architecture.md)，实际结果见 [验证范围](verification.md)。

[交互原型](../abridge-review.html) 与折叠的历史评审保留为设计输入；当前能力以架构图、README 和架构文档为准。

旧版截图、设计迭代和真实机器验证截图已移入本机 `.local/archive/`；源码只保留当前可运行的原型源。
