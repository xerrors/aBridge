import AppKit
import ApplicationServices
import CoreGraphics
import Security

let bridgeEventTag: Int64 = 0x61427269646765

// The App owns the menu bar, privacy permissions and Keychain.
// The device client embeds Cua in its child process under this App responsibility chain.
// Helper requests travel over stdin; credentials are never command-line arguments.

func response(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}

func failure(_ code: String, _ message: String) -> [String: Any] {
    ["error": ["code": code, "message": message]]
}

func permissions() -> [String: Any] {
    ["screen": CGPreflightScreenCaptureAccess(), "input": AXIsProcessTrusted()]
}

func keychain(_ request: [String: Any]) -> [String: Any] {
    guard let service = request["service"] as? String, ["dev.abridge.client.device", "dev.abridge.account", "dev.abridge.agent"].contains(service), let account = request["account"] as? String else {
        return failure("invalid_arguments", "Invalid Keychain identity")
    }
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    switch request["action"] as? String {
    case "keychain_set":
        guard let secret = request["secret"] as? String else { return failure("invalid_arguments", "Device Key is required") }
        let data = Data(secret.utf8)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let result = SecItemAdd(item as CFDictionary, nil)
            return result == errSecSuccess ? ["ok": true] : failure("keychain_failed", "Cannot save Device Key (\(result))")
        }
        return update == errSecSuccess ? ["ok": true] : failure("keychain_failed", "Cannot update Device Key (\(update))")
    case "keychain_get":
        var read = query
        read[kSecReturnData as String] = true
        read[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let result = SecItemCopyMatching(read as CFDictionary, &value)
        guard result == errSecSuccess, let data = value as? Data, let secret = String(data: data, encoding: .utf8) else {
            return failure("keychain_missing", "Device Key is unavailable; connect this Mac again")
        }
        return ["secret": secret]
    case "keychain_delete":
        let result = SecItemDelete(query as CFDictionary)
        return result == errSecSuccess || result == errSecItemNotFound ? ["ok": true] : failure("keychain_failed", "Cannot delete Device Key")
    default: return failure("invalid_arguments", "Unknown Keychain action")
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var item: NSStatusItem!
    private var window: NSWindow!
    private let urlField = NSTextField(string: "http://127.0.0.1:8765")
    private let keyField = NSSecureTextField(string: "")
    private let statusLabel = NSTextField(labelWithString: "尚未连接")
    private var environmentLabels: [String: NSTextField] = [:]
    private var capabilityButtons: [String: NSButton] = [:]
    private var connectButton: NSButton!
    private var repairButton: NSButton!
    private var pauseItem: NSMenuItem!
    private var daemon: Process?
    private var runtime: [String: String] = [:]
    private var current: [String: Any] = [:]
    private var monitor: Any?
    private var checkingEnvironment = false
    private var repairing = false
    private let stateDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/aBridge")
    private let logURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/aBridge/client.log")

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        if let location = Bundle.main.url(forResource: "runtime", withExtension: "json"),
           let data = try? Data(contentsOf: location),
           let settings = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            runtime = settings
        }
        buildMenu()
        buildWindow()
        loadConfig()
        startDaemon()
        checkEnvironment()
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        monitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .mouseMoved, .keyDown]
        ) { [weak self] event in
            guard event.cgEvent?.getIntegerValueField(.eventSourceUserData) != bridgeEventTag else { return }
            Task { @MainActor in
                guard let self,
                      (self.current["desktop_active_until"] as? Double ?? 0) > Date().timeIntervalSince1970
                else { return }
                self.control(["command": "pause"])
            }
        }
        if !FileManager.default.fileExists(atPath: stateDirectory.appendingPathComponent("config.json").path) {
            showWindow()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopDaemon()
        if let monitor { NSEvent.removeMonitor(monitor) }
    }

    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildMenu() {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "aB"
        item.button?.toolTip = "aBridge"
        let menu = NSMenu()
        menu.addItem(withTitle: "aBridge", action: #selector(showWindow), keyEquivalent: "")
        menu.addItem(.separator())
        pauseItem = menu.addItem(withTitle: "暂停访问", action: #selector(togglePause), keyEquivalent: "")
        menu.addItem(withTitle: "停止当前执行", action: #selector(stop), keyEquivalent: "")
        menu.addItem(withTitle: "设置…", action: #selector(showWindow), keyEquivalent: ",")
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 aBridge", action: #selector(quit), keyEquivalent: "q")
        for entry in menu.items { entry.target = self }
        item.menu = menu
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 544, height: 680),
            styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false
        )
        window.title = "aBridge"
        window.center()
        window.isReleasedWhenClosed = false
        window.delegate = self
        let root = NSStackView()
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 13
        root.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(root)
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 28),
            root.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -28),
            root.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24),
        ])
        let title = NSTextField(labelWithString: "连接这台 Mac")
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        root.addArrangedSubview(title)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.maximumNumberOfLines = 2
        statusLabel.lineBreakMode = .byWordWrapping
        root.addArrangedSubview(statusLabel)
        for (label, field) in [("服务地址", urlField), ("设备 Key", keyField)] {
            let group = NSStackView(views: [NSTextField(labelWithString: label), field])
            group.orientation = .vertical
            group.alignment = .leading
            group.spacing = 5
            field.placeholderString = label == "设备 Key" ? "首次连接时粘贴设备 Key" : "https://…"
            field.widthAnchor.constraint(equalToConstant: 488).isActive = true
            root.addArrangedSubview(group)
        }
        let capabilities = NSStackView()
        capabilities.orientation = .horizontal
        capabilities.spacing = 16
        for (key, label) in [
            ("screen", "截图"), ("input", "键鼠"), ("browser", "浏览器"),
            ("shell", "Shell"), ("files", "文件"),
        ] {
            let button = NSButton(checkboxWithTitle: label, target: self, action: #selector(capabilityChanged(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(key)
            capabilityButtons[key] = button
            capabilities.addArrangedSubview(button)
        }
        root.addArrangedSubview(capabilities)
        let consent = NSTextField(wrappingLabelWithString: "已授权的 Agent 可持续使用所选能力。本机可随时暂停。")
        consent.font = .systemFont(ofSize: 12)
        consent.textColor = .secondaryLabelColor
        root.addArrangedSubview(consent)
        connectButton = NSButton(title: "连接", target: self, action: #selector(connect))
        connectButton.bezelStyle = .rounded
        connectButton.keyEquivalent = "\r"
        connectButton.contentTintColor = .systemBlue
        let unbind = NSButton(title: "解除绑定", target: self, action: #selector(unbindDevice))
        unbind.bezelStyle = .rounded
        root.addArrangedSubview(NSStackView(views: [connectButton, unbind]))
        let separator = NSBox()
        separator.boxType = .separator
        root.addArrangedSubview(separator)
        let heading = NSTextField(labelWithString: "运行环境")
        heading.font = .systemFont(ofSize: 14, weight: .semibold)
        let refresh = NSButton(title: "重新检查", target: self, action: #selector(checkEnvironment))
        refresh.bezelStyle = .rounded
        let headingRow = NSStackView(views: [heading, refresh])
        headingRow.spacing = 16
        root.addArrangedSubview(headingRow)
        addEnvironmentRow("runtime", title: "Python", action: "修复运行时", selector: #selector(repairRuntime), to: root)
        repairButton = addEnvironmentRow("driver", title: "Cua Driver", action: "安装 / 修复", selector: #selector(repairRuntime), to: root)
        addEnvironmentRow("screen", title: "屏幕录制", action: "前往设置", selector: #selector(requestScreen), to: root)
        addEnvironmentRow("input", title: "辅助功能", action: "前往设置", selector: #selector(requestInput), to: root)
        addEnvironmentRow("browser", title: "Chrome", action: "打开 / 安装", selector: #selector(openChrome), to: root)
        let guide = NSButton(title: "安装说明", target: self, action: #selector(showSetupGuide))
        let diagnostics = NSButton(title: "查看诊断", target: self, action: #selector(showDiagnostics))
        guide.bezelStyle = .rounded
        diagnostics.bezelStyle = .rounded
        root.addArrangedSubview(NSStackView(views: [guide, diagnostics]))
    }

    @discardableResult
    private func addEnvironmentRow(
        _ key: String, title: String, action: String, selector: Selector, to root: NSStackView
    ) -> NSButton {
        let name = NSTextField(labelWithString: title)
        name.widthAnchor.constraint(equalToConstant: 82).isActive = true
        let value = NSTextField(labelWithString: "检查中…")
        value.textColor = .secondaryLabelColor
        value.lineBreakMode = .byTruncatingTail
        value.widthAnchor.constraint(equalToConstant: 280).isActive = true
        environmentLabels[key] = value
        let button = NSButton(title: action, target: self, action: selector)
        button.bezelStyle = .rounded
        let row = NSStackView(views: [name, value, button])
        row.spacing = 8
        root.addArrangedSubview(row)
        return button
    }

    @objc private func connect() {
        if keyField.stringValue.isEmpty {
            let configURL = stateDirectory.appendingPathComponent("config.json")
            if let data = try? Data(contentsOf: configURL),
               let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                guard config["url"] as? String == urlField.stringValue else {
                    statusLabel.stringValue = "更换服务地址时需填写新的设备 Key"
                    return
                }
                stopDaemon()
                startDaemon()
                checkEnvironment()
            } else {
                statusLabel.stringValue = "请输入设备 Key"
            }
            return
        }
        stopDaemon()
        runClient(["configure", "--stdin"], input: [
            "url": urlField.stringValue, "device_key": keyField.stringValue,
            "capabilities": capabilityButtons.mapValues { $0.state == .on },
        ]) { [weak self] result in
            guard let self else { return }
            if result["ok"] as? Bool == true {
                self.keyField.stringValue = ""
                self.startDaemon()
            } else {
                self.statusLabel.stringValue = result["error"] as? String ?? "连接配置失败"
            }
        }
    }

    @objc private func togglePause() {
        control(["command": current["paused"] as? Bool == true ? "resume" : "pause"])
    }

    @objc private func stop() { control(["command": "stop"]) }

    @objc private func capabilityChanged(_ sender: NSButton) {
        guard let capability = sender.identifier?.rawValue else { return }
        control(["command": "capability", "capability": capability, "enabled": sender.state == .on])
    }

    @objc private func unbindDevice() {
        let alert = NSAlert()
        alert.messageText = "解除这台 Mac 的绑定？"
        alert.informativeText = "当前执行会停止，设备 Key 将从钥匙串删除。"
        alert.addButton(withTitle: "解除绑定")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn { control(["command": "unbind"]) }
    }

    @objc private func requestScreen() {
        CGRequestScreenCaptureAccess()
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
    }

    @objc private func requestInput() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }

    @objc private func openChrome() {
        let identifier = "com.google.Chrome"
        if let location = NSWorkspace.shared.urlForApplication(withBundleIdentifier: identifier) {
            NSWorkspace.shared.openApplication(at: location, configuration: .init())
        } else {
            NSWorkspace.shared.open(URL(string: "https://www.google.com/chrome/")!)
        }
    }

    @objc private func showSetupGuide() {
        if let location = Bundle.main.url(forResource: "setup", withExtension: "html") {
            NSWorkspace.shared.open(location)
        }
    }

    @objc private func showDiagnostics() {
        if FileManager.default.fileExists(atPath: logURL.path) {
            NSWorkspace.shared.open(logURL)
        } else {
            checkEnvironment()
            statusLabel.stringValue = "诊断已重新检查，当前没有运行错误日志"
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    private func loadConfig() {
        let location = stateDirectory.appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: location),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        urlField.stringValue = config["url"] as? String ?? urlField.stringValue
        let capabilities = config["capabilities"] as? [String: Bool] ?? [:]
        for (key, button) in capabilityButtons { button.state = capabilities[key] == true ? .on : .off }
        connectButton.title = "重试连接"
    }

    private func startDaemon() {
        guard !repairing,
              FileManager.default.fileExists(atPath: stateDirectory.appendingPathComponent("config.json").path),
              daemon?.isRunning != true else { return }
        guard let process = runtimeProcess(module: "abridge.client", arguments: clientArguments(["run"])) else {
            statusLabel.stringValue = "运行时缺失，请修复或查看安装说明"
            environmentLabels["runtime"]?.stringValue = "未安装 / 路径失效"
            return
        }
        daemon = process
        let log = errorLog()
        process.standardOutput = log
        process.standardError = log
        do {
            try process.run()
            statusLabel.stringValue = "正在连接"
        } catch {
            statusLabel.stringValue = "无法启动运行时，请查看诊断"
        }
    }

    private func stopDaemon() {
        if let daemon, daemon.isRunning {
            daemon.terminate()
            daemon.waitUntilExit()
        }
        daemon = nil
    }

    private func runtimeProcess(module: String, arguments: [String]) -> Process? {
        guard let python = runtime["python_path"], let project = runtime["project_path"],
              FileManager.default.isExecutableFile(atPath: python),
              FileManager.default.fileExists(atPath: project + "/abridge/__init__.py")
        else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = ["-m", module] + arguments
        process.currentDirectoryURL = URL(fileURLWithPath: project)
        var environment = ProcessInfo.processInfo.environment
        environment["PYTHONPATH"] = project
        environment["ABRIDGE_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        process.environment = environment
        return process
    }

    private func clientArguments(_ arguments: [String]) -> [String] {
        ["--helper", Bundle.main.executablePath!, "--state-dir", stateDirectory.path] + arguments
    }

    private func runClient(
        _ arguments: [String], input: [String: Any]? = nil,
        completion: @escaping ([String: Any]) -> Void
    ) {
        runModule("abridge.client", arguments: clientArguments(arguments), input: input, completion: completion)
    }

    private func runModule(
        _ module: String, arguments: [String], input: [String: Any]? = nil,
        completion: @escaping ([String: Any]) -> Void
    ) {
        guard let process = runtimeProcess(module: module, arguments: arguments) else {
            completion(["error": "运行时缺失，请修复或查看安装说明"])
            return
        }
        let output = Pipe()
        process.standardOutput = output
        process.standardError = errorLog()
        if let input, let data = try? JSONSerialization.data(withJSONObject: input) {
            let pipe = Pipe()
            process.standardInput = pipe
            do { try process.run() } catch {
                completion(["error": "无法启动运行时，请查看诊断"])
                return
            }
            pipe.fileHandleForWriting.write(data)
            try? pipe.fileHandleForWriting.close()
        } else {
            do { try process.run() } catch {
                completion(["error": "无法启动运行时，请查看诊断"])
                return
            }
        }
        DispatchQueue.global().async {
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let result = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                ?? ["error": "运行时返回异常，请查看诊断并修复"]
            DispatchQueue.main.async { completion(result) }
        }
    }

    private func control(_ request: [String: Any]) {
        guard let command = request["command"] as? String else { return }
        var arguments = ["control", command]
        if command == "capability", let capability = request["capability"] as? String,
           let enabled = request["enabled"] as? Bool {
            arguments += ["--capability", capability, "--enabled", enabled ? "true" : "false"]
        }
        runClient(arguments) { [weak self] result in
            if result["ok"] as? Bool == true { self?.render(result) }
            else { self?.statusLabel.stringValue = result["error"] as? String ?? "本机控制暂不可用" }
        }
    }

    private func poll() {
        guard !repairing else { return }
        guard daemon?.isRunning == true else {
            if daemon != nil { statusLabel.stringValue = "客户端已退出，可重试连接或查看诊断" }
            return
        }
        let location = stateDirectory.appendingPathComponent("status.json")
        if let data = try? Data(contentsOf: location),
           let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            render(status)
        }
    }

    @objc private func checkEnvironment() {
        guard !checkingEnvironment, !repairing else { return }
        checkingEnvironment = true
        if daemon?.isRunning == true {
            runClient(["control", "status"]) { [weak self] result in
                guard let self else { return }
                self.checkingEnvironment = false
                if result["ok"] as? Bool == true { self.render(result) }
                else { self.statusLabel.stringValue = result["error"] as? String ?? "环境检查失败" }
            }
        } else {
            runModule("abridge.diagnostics", arguments: ["--json"]) { [weak self] result in
                guard let self else { return }
                self.checkingEnvironment = false
                if let error = result["error"] as? String {
                    self.environmentLabels["runtime"]?.stringValue = error
                    self.statusLabel.stringValue = error
                } else { self.renderEnvironment(result) }
            }
        }
    }

    private func render(_ status: [String: Any]) {
        current = status
        let paused = status["paused"] as? Bool == true
        let connection = status["connection"] as? String ?? "offline"
        let active = status["active_operations"] as? [String] ?? []
        let controllers = status["active_controllers"] as? [String] ?? []
        if paused {
            statusLabel.stringValue = "已暂停，需在本机恢复"
        } else if !active.isEmpty {
            statusLabel.stringValue = "\(controllers.isEmpty ? "Agent" : controllers.joined(separator: "、")) 正在执行 \(active.count) 项操作"
        } else if connection == "online" {
            statusLabel.stringValue = "已连接 \(status["owner_name"] as? String ?? "")"
        } else {
            statusLabel.stringValue = connection == "connecting" ? "正在连接" : "连接已断开"
        }
        if let error = status["error"] as? String, !error.isEmpty { statusLabel.stringValue = error }
        pauseItem.title = paused ? "恢复访问" : "暂停访问"
        item.button?.title = paused ? "aB ‖" : (active.isEmpty ? "aB" : "aB ●")
        let requested = status["requested_capabilities"] as? [String: Bool] ?? [:]
        for (key, button) in capabilityButtons { button.state = requested[key] == true ? .on : .off }
        renderEnvironment(status["dependencies"] as? [String: Any] ?? [:])
    }

    private func renderEnvironment(_ report: [String: Any]) {
        guard !report.isEmpty else { return }
        let python = report["runtime"] as? [String: Any] ?? [:]
        let pythonVersion = python["python"] as? String ?? ""
        let missing = python["missing_packages"] as? [String] ?? []
        if python["ready"] as? Bool == true {
            environmentLabels["runtime"]?.stringValue = "\(pythonVersion) · 已就绪"
        } else if !missing.isEmpty {
            environmentLabels["runtime"]?.stringValue = "缺少 \(missing.joined(separator: "、"))"
        } else {
            environmentLabels["runtime"]?.stringValue = "Python \(pythonVersion) · 需要 3.12–3.14"
        }
        let driver = report["driver"] as? [String: Any] ?? [:]
        if driver["installed"] as? Bool != true {
            environmentLabels["driver"]?.stringValue = "未安装"
        } else if driver["ready"] as? Bool == true {
            environmentLabels["driver"]?.stringValue = "\(driver["version"] as? String ?? "") · 内嵌已就绪"
        } else {
            let error = driver["error"] as? [String: Any]
            let messages = [
                "cua_version_mismatch": "版本不兼容，请安装锁定版本",
                "cua_load_failed": "组件加载失败，请修复",
                "cua_permission_probe_failed": "权限检查失败，请查看诊断",
                "cua_platform_unsupported": "当前系统不受支持",
                "cua_mode_mismatch": "运行模式异常，请修复",
            ]
            environmentLabels["driver"]?.stringValue = messages[error?["code"] as? String ?? ""] ?? "已安装，尚未就绪"
            environmentLabels["driver"]?.toolTip = error?["message"] as? String
        }
        let permissions = report["permissions"] as? [String: Any] ?? current["permissions"] as? [String: Any] ?? [:]
        for key in ["screen", "input"] {
            environmentLabels[key]?.stringValue = driver["loaded"] as? Bool == true
                ? (permissions[key] as? Bool == true ? "已允许" : "未允许")
                : "驱动未就绪，尚未检查"
        }
        let browser = report["browser"] as? [String: Any] ?? [:]
        if browser["installed"] as? Bool != true {
            environmentLabels["browser"]?.stringValue = "未安装"
        } else {
            let version = browser["version"] as? String ?? ""
            let count = browser["active_sessions"] as? Int ?? 0
            if driver["ready"] as? Bool != true {
                environmentLabels["browser"]?.stringValue = "\(version) · 已安装，等待驱动"
            } else {
                environmentLabels["browser"]?.stringValue = count > 0
                    ? "\(version) · 已连接专用窗口"
                    : "\(version) · 专用窗口按需打开"
            }
        }
    }

    @objc private func repairRuntime() {
        guard !repairing else { return }
        guard let uv = findUV() else {
            let alert = NSAlert()
            alert.messageText = "需要先安装 uv"
            alert.informativeText = "uv 用于安装和修复锁定的 Python 运行环境。安装后重新打开 aBridge。"
            alert.addButton(withTitle: "打开安装说明")
            alert.addButton(withTitle: "取消")
            if alert.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.open(URL(string: "https://docs.astral.sh/uv/getting-started/installation/")!)
            }
            return
        }
        let root = stateDirectory.appendingPathComponent("runtime")
        let python = root.appendingPathComponent(".venv/bin/python")
        let source = root.appendingPathComponent("src").resolvingSymlinksInPath()
        guard runtime["python_path"] == python.path, runtime["project_path"] == source.path else {
            statusLabel.stringValue = "当前使用自定义运行时，请在原项目环境中修复"
            showSetupGuide()
            return
        }
        let requirements = root.appendingPathComponent("requirements.txt")
        guard FileManager.default.fileExists(atPath: requirements.path),
              FileManager.default.fileExists(atPath: root.appendingPathComponent("src/abridge/__init__.py").path)
        else {
            statusLabel.stringValue = "安装文件不完整，请从项目目录重新运行安装器"
            showSetupGuide()
            return
        }
        stopDaemon()
        repairing = true
        repairButton.isEnabled = false
        connectButton.isEnabled = false
        statusLabel.stringValue = "正在安装运行环境…"
        var commands: [[String]] = []
        if !FileManager.default.isExecutableFile(atPath: python.path)
            || !FileManager.default.fileExists(atPath: root.appendingPathComponent(".venv/pyvenv.cfg").path) {
            commands.append(["venv", "--clear", "--python", "3.12", root.appendingPathComponent(".venv").path])
        }
        commands.append(["pip", "sync", "--python", python.path, "--require-hashes", "--link-mode", "copy", requirements.path])
        let log = errorLog()
        DispatchQueue.global().async {
            var success = true
            for arguments in commands {
                let process = Process()
                process.executableURL = uv
                process.arguments = arguments
                process.standardOutput = log
                process.standardError = log
                do {
                    try process.run()
                    process.waitUntilExit()
                    if process.terminationStatus != 0 { success = false; break }
                } catch { success = false; break }
            }
            DispatchQueue.main.async {
                self.repairing = false
                self.repairButton.isEnabled = true
                self.connectButton.isEnabled = true
                self.statusLabel.stringValue = success ? "运行环境已安装" : "安装失败，请查看诊断后重试"
                self.startDaemon()
                self.checkEnvironment()
            }
        }
    }

    private func findUV() -> URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let candidates = [
            home.appendingPathComponent(".local/bin/uv").path,
            "/opt/homebrew/bin/uv", "/usr/local/bin/uv",
        ]
        return candidates.first(where: FileManager.default.isExecutableFile(atPath:))
            .map { URL(fileURLWithPath: $0) }
    }

    private func errorLog() -> FileHandle {
        let manager = FileManager.default
        try? manager.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let attributes = try? manager.attributesOfItem(atPath: logURL.path),
           (attributes[.size] as? NSNumber)?.intValue ?? 0 > 1_048_576 {
            let previous = logURL.appendingPathExtension("previous")
            try? manager.removeItem(at: previous)
            try? manager.moveItem(at: logURL, to: previous)
        }
        if !manager.fileExists(atPath: logURL.path) {
            manager.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let handle = try? FileHandle(forWritingTo: logURL) else { return .nullDevice }
        _ = try? handle.seekToEnd()
        return handle
    }
}

if CommandLine.arguments.contains("--helper") {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let request = try? JSONSerialization.jsonObject(with: input) as? [String: Any], let action = request["action"] as? String else {
        response(failure("invalid_arguments", "Expected a JSON request"))
        exit(0)
    }
    if action == "permissions" { response(permissions()) }
    else if action.hasPrefix("keychain_") { response(keychain(request)) }
    else { response(failure("invalid_arguments", "Unknown helper action")) }
} else {
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
