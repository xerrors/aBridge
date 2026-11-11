import AppKit

// An isolated desktop target for real model vision and mouse acceptance tests.
// The random code is generated here, never supplied in the model's instructions.
@main
struct DesktopFixture {
    static func main() {
        guard CommandLine.arguments.count == 2 else {
            fputs("Usage: DesktopFixture <state.json>\n", stderr)
            exit(2)
        }
        let app = NSApplication.shared
        let delegate = FixtureDelegate()
        app.setActivationPolicy(.regular)
        app.delegate = delegate
        app.run()
    }
}

final class FixtureDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private var window: FixtureWindow!
    private var countLabel: NSTextField!
    private var inputField: NSTextField!
    private var clickCount = 0
    private let code = String((0..<6).map { _ in "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".randomElement()! })
    private let stateURL = URL(fileURLWithPath: ProcessInfo.processInfo.arguments[1])

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let screen = NSScreen.main else { NSApp.terminate(nil); return }
        let frame = screen.frame
        window = FixtureWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.title = "aBridge Yuxi Desktop Verification"
        window.appearance = NSAppearance(named: .aqua)
        window.backgroundColor = NSColor(calibratedWhite: 0.96, alpha: 1)
        window.level = .normal
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let content = NSView(frame: NSRect(origin: .zero, size: frame.size))
        window.contentView = content
        addLabel("aBridge × Yuxi", size: 32, y: frame.height * 0.78, to: content)
        addLabel("屏幕验证码", size: 24, y: frame.height * 0.65, to: content)
        addLabel(code, size: 78, y: frame.height * 0.55, to: content)

        inputField = NSTextField(string: "")
        inputField.placeholderString = "输入中文"
        inputField.setAccessibilityLabel("验收输入")
        inputField.identifier = NSUserInterfaceItemIdentifier("verification-input")
        inputField.font = .systemFont(ofSize: 26)
        inputField.frame = NSRect(x: frame.width * 0.30, y: frame.height * 0.43, width: frame.width * 0.40, height: 44)
        inputField.delegate = self
        content.addSubview(inputField)

        let button = NSButton(title: "点击验证", target: self, action: #selector(recordClick))
        button.frame = NSRect(x: frame.width * 0.57, y: frame.height * 0.30, width: 340, height: 100)
        button.bezelStyle = .rounded
        button.font = .systemFont(ofSize: 32, weight: .semibold)
        button.contentTintColor = NSColor(calibratedWhite: 0.12, alpha: 1)
        content.addSubview(button)

        countLabel = addLabel("点击次数：0", size: 30, y: frame.height * 0.20, to: content)
        addLabel("Esc 结束测试", size: 18, y: frame.height * 0.08, to: content)
        writeState()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func recordClick() {
        clickCount += 1
        countLabel.stringValue = "点击次数：\(clickCount)"
        writeState()
    }

    func controlTextDidChange(_ notification: Notification) {
        writeState()
    }

    private func writeState() {
        let state: [String: Any] = [
            "code": code, "click_count": clickCount, "text": inputField.stringValue,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "updated_at": Date().timeIntervalSince1970,
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
            try data.write(to: stateURL, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateURL.path)
        } catch {
            fputs("Fixture state write failed: \(error)\n", stderr)
            NSApp.terminate(nil)
        }
    }

    @discardableResult
    private func addLabel(_ text: String, size: CGFloat, y: CGFloat, to parent: NSView) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: size, weight: .medium)
        label.textColor = NSColor(calibratedWhite: 0.12, alpha: 1)
        label.alignment = .center
        label.frame = NSRect(x: 0, y: y, width: parent.bounds.width, height: size * 1.5)
        parent.addSubview(label)
        return label
    }
}

final class FixtureWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { NSApp.terminate(nil) }
        else { super.keyDown(with: event) }
    }
}
