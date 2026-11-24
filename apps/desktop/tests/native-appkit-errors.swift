import AppKit

@main
@MainActor
struct NativeAppKitErrors {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        Task {
            let state = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
            await verifyErrors(state: state, secret: CommandLine.arguments[2])
            FileHandle.standardOutput.write(Data("PASS native AppKit errors\n".utf8))
            app.terminate(nil)
        }
        withExtendedLifetime(delegate) { app.run() }
    }

    private static func verifyErrors(state: URL, secret: String) async {
        let settings = await waitFor("设置窗口没有打开") {
            NSApp.windows.first(where: { $0.title == "aBridge 设置" && $0.isVisible })?.contentView
        }
        let connect = button("在浏览器授权", in: settings)
        connect.performClick(nil)

        let expected = "无法读取 aBridge 随附的协议文件，请重新安装完整的 Mac 应用。"
        let field = await waitFor("设备绑定没有显示协议文件错误") {
            fields(in: settings).first { $0.stringValue == expected }
        }
        precondition(field.cell?.wraps == true, "设备绑定错误需要在设置窗口内完整显示")
        assertRedacted(settings, secret: secret)
        button("运行诊断", in: settings).performClick(nil)
        assertDiagnostics("设备绑定：\(expected)", in: settings, secret: secret)

        connect.performClick(nil)
        _ = await waitFor("无效的运行时输出应显示真实退出码和恢复操作") {
            fields(in: settings).first { $0.stringValue == "本机授权进程已退出（退出码 7），请重新发起绑定。" }
        }
        assertRedacted(settings, secret: secret)

        do { try storeBinding(in: state, secret: secret) }
        catch { fatalError("无法准备测试绑定：\(error)") }
        _ = await waitFor("已有绑定时应提供重新连接入口") {
            connect.title == "重新连接" && connect.isEnabled ? connect : nil
        }
        connect.performClick(nil)

        let alreadyRunning = "已有 aBridge 设备客户端正在运行，请检查是否同时打开了两份应用。"
        _ = await waitFor("设备客户端结构化退出应显示重复运行提示") {
            fields(in: settings).first { $0.stringValue == alreadyRunning }
        }
        assertRedacted(settings, secret: secret)
        assertDiagnostics("设备连接：\(alreadyRunning)", in: settings, secret: secret)
    }

    private static func storeBinding(in state: URL, secret: String) throws {
        let manager = FileManager.default
        let server = "http://127.0.0.1:8765"
        try manager.createDirectory(
            at: state.appendingPathComponent("credentials"),
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        let records: [(String, [String: Any])] = [
            ("config.json", ["url": server, "paused": false, "capabilities": ["files": true]]),
            ("credentials/device.json", ["server_url": server, "device_key": secret]),
        ]
        for (file, record) in records {
            let data = try JSONSerialization.data(withJSONObject: record)
            precondition(manager.createFile(
                atPath: state.appendingPathComponent(file).path,
                contents: data,
                attributes: [.posixPermissions: 0o600]
            ), "无法写入测试绑定文件 \(file)")
        }
    }

    private static func assertDiagnostics(_ expected: String, in settings: NSView, secret: String) {
        let diagnostics = Timer(timeInterval: 0.02, repeats: true) { timer in
            MainActor.assumeIsolated {
                guard let content = NSApp.modalWindow?.contentView else { return }
                precondition(fields(in: content).contains { $0.stringValue.contains(expected) },
                             "连接诊断没有显示完整错误")
                assertRedacted(content, secret: secret)
                timer.invalidate()
                NSApp.stopModal(withCode: .alertSecondButtonReturn)
            }
        }
        RunLoop.main.add(diagnostics, forMode: .modalPanel)
        button("连接诊断", in: settings).performClick(nil)
        precondition(!diagnostics.isValid, "连接诊断窗口没有打开")
    }

    private static func visibleViews(in view: NSView) -> [NSView] {
        if view.isHidden { return [] }
        return [view] + view.subviews.flatMap { visibleViews(in: $0) }
    }

    private static func fields(in view: NSView) -> [NSTextField] {
        visibleViews(in: view).compactMap { $0 as? NSTextField }
    }

    private static func assertRedacted(_ view: NSView, secret: String) {
        precondition(fields(in: view).allSatisfy {
            !$0.stringValue.contains(secret) && $0.toolTip?.contains(secret) != true
        }, "设置窗口或诊断泄露了运行时原始输出")
    }

    private static func button(_ title: String, in view: NSView) -> NSButton {
        guard let result = visibleViews(in: view).compactMap({ $0 as? NSButton }).first(where: { $0.title == title }) else {
            fatalError("找不到按钮 \(title)")
        }
        return result
    }

    private static func waitFor<T>(_ message: String, _ check: () -> T?) async -> T {
        for _ in 0..<200 {
            if let value = check() { return value }
            try? await Task.sleep(for: .milliseconds(20))
        }
        fatalError(message)
    }
}
