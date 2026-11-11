# Yuxi 桌面验收 fixture

这些文件不属于无人值守测试。仅在用户同意占用桌面时运行；它会显示全屏随机码与测试按钮，按 Esc 退出。

```sh
fixture_dir="$(mktemp -d)"
swiftc -parse-as-library tests/manual/desktop.swift -o "$fixture_dir/DesktopFixture"
"$fixture_dir/DesktopFixture" "$fixture_dir/state.json"
```

在 Yuxi 中选择个人 aBridge 连接和支持图像的模型，使用 `yuxi-desktop-prompt.txt`。验证码不能提前写入提示词。核对真实工具截图中的计数 0→1，再独立读取 `state.json`；不能只接受模型口头报告或 executed 回执。

结束会话、退出 fixture 后删除自己创建的临时目录。不要用个人文档、登录窗口或真实聊天作为测试目标。
