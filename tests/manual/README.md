# Yuxi 窗口与浏览器验收

仅使用自有测试内容。桌面 fixture 是 640×560 的普通窗口，不激活应用；截图必须明确提供该进程的 `pid` 和 `window_id`，不能调用默认桌面观察。可在后台通过 AX 输入中文并点击控件。

```sh
fixture_dir="$(mktemp -d)"
swiftc -parse-as-library -O tests/manual/desktop.swift -o "$fixture_dir/DesktopFixture" -framework AppKit
"$fixture_dir/DesktopFixture" "$fixture_dir/state.json"
```

状态放在本机临时目录，避免外置卷访问权限阻塞启动。开始前核对状态中的 PID 存活、更新时间晚于进程启动、文本为空且点击次数为 0；不能沿用前一次进程的状态文件或窗口 ID。

在 Yuxi 选择个人 aBridge 连接。先通过 `computer_windows` 找到目标窗口，再定向观察并用 AX `element_ref` 填入中文；重新观察后点击一次。动作引用只在 10 秒内有效，每次动作后重新观察。核对最终窗口图像、输入值与持久计数 0→1，再关闭会话。`yuxi-desktop-prompt.txt` 仅保留早期坐标验证历史，不能作为本轮 AX 提示。

浏览器 fixture 使用本机回环 HTTP 表单；`/seed` 在正常浏览器中设置专用 HttpOnly 测试 Cookie，页面显示是否已登录，服务状态只保存验证结果，不记录 Cookie 原值。

```sh
python3 tests/manual/browser_fixture.py --state "$fixture_dir/browser.json"
```

用所需的现有 Chrome Profile 为任务打开一个专用窗口，访问打印地址的 `/seed`。在 aBridge 本机选择这个窗口并接入当前页；Yuxi 只申请 `browser`，核对登录态、DOM 中文填入、提交一次及实际持久结果。结束会话只解除连接，保留用户 Chrome 和页面。不要用个人聊天、真实文档或其他工作窗口做验收，也不要为了测试导出个人 Cookie。

独立验证应核对真实工具审计、截图或 DOM 状态、持久结果、过期拒绝与资源回收，不能只接受模型报告或 `executed` 回执。真实证据放在被忽略的 `.local/`，不提交到仓库。
