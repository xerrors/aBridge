# aBridge 品牌资产

- `bridge.svg`：已确认的 C3 桥接标记。
- `wordmark.svg`：以 Helvetica Bold 为基础、`a` 右下脚平直收尾的路径化字标，`a` 为 `#4D94E8`，`Bridge` 为 `#0066DD`。

在 macOS 运行 `npm run icons` 统一导出；需预装 librsvg 和 Xcode Command Line Tools。字标由 `tools/brand-wordmark.swift` 使用系统 Helvetica-Bold 生成轮廓，不分发字体文件。正常安装和发行包构建直接使用导出产物。

详细规范见 [设计与资产](../../design.md)。

`npm run icons` 同时同步商店宣传图 `docs/assets/store/promo.svg` 与 `promo.jpg`，字标不单独编辑。
