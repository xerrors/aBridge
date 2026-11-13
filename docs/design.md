# 设计与资产

## 品牌

采用桥接标记与双色 `aBridge` 字标。

| 用途                   | 颜色      |
| ---------------------- | --------- |
| Bridge / 品牌 / 主操作 | `#0066DD` |
| a                      | `#4D94E8` |
| 悬停                   | `#0058C2` |
| 浅蓝背景               | `#EDF4FF` |

品牌、按钮及在线状态不使用绿色。状态栏使用单色模板图，随 macOS 明暗主题呈现。字标使用 Helvetica Bold，包含标准双层 `a`，导出为矢量路径，不依赖接收端安装字体。

## 资源单源

`docs/assets/brand/bridge.svg` 是桥标矢量源；字标由 `tools/brand-wordmark.swift` 的 Helvetica-Bold 定义生成 `docs/assets/brand/wordmark.svg`。统一导出以下派生资源：

| 使用位置                   | 资源目录                      |
| -------------------------- | ----------------------------- |
| App 图标、状态栏模板和字标 | `apps/desktop/native/assets/` |
| 浏览器扩展图标             | `apps/browser/public/icons/`  |
| 管理台 SVG                 | `apps/web/public/`            |

在 macOS 使用 `npm run icons` 从矢量源导出；导出需要 Xcode Command Line Tools、librsvg 的 `rsvg-convert` 与系统 `iconutil`。正常产品构建直接使用已导出的资源生成分发产物。状态栏图标采用单色 template 图，字标使用矢量路径，避免依赖接收端安装字体。

## 界面

扩展点击图标打开小面板，设置页只承载绑定与详细诊断。App 状态栏提供常用控制，设置窗分为连接、本机能力和运行环境。管理台围绕设备、Agent 授权和记录组织。

用布局、分组和层级解释结构。只保留必要的状态、字段、动作和错误，不增加描述段落或重复提示。保留键盘焦点、必要的加载和失败状态；连接未知时不能保留“已连接”的旧状态。
