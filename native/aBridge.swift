import AppKit
import ApplicationServices
import CoreGraphics

// The App owns the menu bar and privacy permissions.
// The device client embeds Cua in its child process under this App responsibility chain.
// Runtime credentials live in the current user's private application directory.

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
    private let browserPicker = NSPopUpButton(frame: .zero, pullsDown: false)
    private var pauseItem: NSMenuItem!
    private var daemon: Process?
    private var runtime: [String: String] = [:]
    private var current: [String: Any] = [:]
    private var monitor: Any?
    private var checkingEnvironment = false
    private var repairing = false
    private var preparingBrowser = false
    private var browserConnectionFailed = false
    private var browserAccessURL: URL?
    private var browserScopeActive = false
    private var browserAccessMessage = "可按需授权"
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
        restoreBrowserAccess()
        buildMenu()
        buildWindow()
        loadConfig()
        startDaemon()
        if daemon?.isRunning != true { checkEnvironment() }
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        monitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .mouseMoved, .keyDown]
        ) { [weak self] event in
            // Cua posts input from the device process without the retired helper's event tag.
            let sourcePID = event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID)
            Task { @MainActor in
                guard let self,
                      sourcePID != Int64(self.daemon?.processIdentifier ?? -1),
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
        releaseBrowserAccess()
        if let monitor { NSEvent.removeMonitor(monitor) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        refreshBrowserTargets()
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
        root.spacing = 10
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
        addEnvironmentRow("browser_access", title: "连接信息", action: "允许访问…", selector: #selector(grantBrowserAccess), to: root)
        environmentLabels["browser_access"]?.stringValue = browserAccessMessage
        addBrowserSelection(to: root)
        let guide = NSButton(title: "安装说明", target: self, action: #selector(showSetupGuide))
        let diagnostics = NSButton(title: "查看诊断", target: self, action: #selector(showDiagnostics))
        guide.bezelStyle = .rounded
        diagnostics.bezelStyle = .rounded
        root.addArrangedSubview(NSStackView(views: [guide, diagnostics]))
    }

    private func addBrowserSelection(to root: NSStackView) {
        let label = NSTextField(labelWithString: "浏览器窗口")
        label.widthAnchor.constraint(equalToConstant: 82).isActive = true
        browserPicker.addItem(withTitle: "选择 Chrome 窗口")
        browserPicker.widthAnchor.constraint(equalToConstant: 250).isActive = true
        let refresh = NSButton(title: "刷新", target: self, action: #selector(refreshBrowserTargets))
        let connect = NSButton(title: "接入当前页", target: self, action: #selector(connectBrowserTarget))
        refresh.bezelStyle = .rounded
        connect.bezelStyle = .rounded
        let row = NSStackView(views: [label, browserPicker, refresh, connect])
        row.spacing = 8
        root.addArrangedSubview(row)
        let scope = NSTextField(labelWithString: "使用所选窗口的 Profile 与登录态，Agent 将控制其当前标签页。")
        scope.font = .systemFont(ofSize: 11)
        scope.textColor = .secondaryLabelColor
        root.addArrangedSubview(scope)
    }

    @objc private func refreshBrowserTargets() {
        guard daemon?.isRunning == true else { return }
        runClient(["control", "browser-targets"]) { [weak self] result in
            guard let self, result["ok"] as? Bool == true else { return }
            self.browserPicker.removeAllItems()
            self.browserPicker.addItem(withTitle: "选择 Chrome 窗口")
            self.browserPicker.addItem(withTitle: "临时窗口（不复用登录态）")
            self.browserPicker.lastItem?.representedObject = ["mode": "isolated"]
            let profile = result["browser_profile"] as? [String: Any] ?? [:]
            if profile["mode"] as? String == "isolated" { self.browserPicker.selectItem(at: 1) }
            for target in result["browser_targets"] as? [[String: Any]] ?? [] {
                self.browserPicker.addItem(withTitle: target["title"] as? String ?? "Chrome 窗口")
                self.browserPicker.lastItem?.representedObject = target
                if target["pid"] as? Int == profile["pid"] as? Int,
                   target["window_id"] as? Int == profile["window_id"] as? Int {
                    self.browserPicker.select(self.browserPicker.lastItem)
                }
            }
            self.render(result)
        }
    }

    @objc private func connectBrowserTarget() {
        guard let selected = browserPicker.selectedItem?.representedObject as? [String: Any] else {
            statusLabel.stringValue = "请先选择 Chrome 窗口"
            return
        }
        var arguments = ["control", "browser-target", "--mode"]
        if selected["mode"] as? String == "isolated" {
            arguments.append("isolated")
        } else {
            guard let pid = selected["pid"] as? Int, let window = selected["window_id"] as? Int,
                  let fingerprint = selected["fingerprint"] as? String else { return }
            arguments += ["existing_profile", "--pid", String(pid), "--window-id", String(window),
                          "--fingerprint", fingerprint, "--approve"]
        }
        runClient(arguments) { [weak self] result in
            guard let self else { return }
            guard result["ok"] as? Bool == true else {
                self.statusLabel.stringValue = result["error"] as? String ?? "浏览器接入失败，请刷新窗口"
                return
            }
            self.render(result)
            guard selected["mode"] as? String != "isolated" else { return }
            self.browserConnectionFailed = false
            self.preparingBrowser = true
            self.statusLabel.stringValue = "正在连接 Chrome，请允许浏览器中的调试请求…"
            self.runClient(["control", "browser-prepare"]) { [weak self] prepared in
                guard let self else { return }
                self.preparingBrowser = false
                self.browserConnectionFailed = prepared["ok"] as? Bool != true
                if prepared["ok"] as? Bool == true { self.render(prepared) }
                else { self.statusLabel.stringValue = prepared["error"] as? String ?? "浏览器尚未连接，请查看安装说明" }
            }
        }
    }

    @objc private func grantBrowserAccess() {
        let panel = NSOpenPanel()
        panel.title = "允许读取 Chrome 连接信息"
        panel.message = "仅选择 DevToolsActivePort 文件，用于连接已批准的 Chrome 窗口。"
        panel.prompt = "允许访问"
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Google/Chrome")
        panel.nameFieldStringValue = "DevToolsActivePort"
        guard panel.runModal() == .OK, let selected = panel.url?.resolvingSymlinksInPath() else { return }
        guard selected.lastPathComponent == "DevToolsActivePort" else {
            statusLabel.stringValue = "请选择 Chrome 的 DevToolsActivePort 连接信息文件"
            return
        }
        do {
            let bookmark = try selected.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess])
            try activateBrowserAccess(bookmark, persist: true)
            statusLabel.stringValue = "连接信息已允许，请接入当前页"
        } catch {
            if browserAccessURL == nil { browserAccessMessage = "授权未恢复，请重新选择" }
            statusLabel.stringValue = "无法保留连接文件访问，请重新选择"
        }
        environmentLabels["browser_access"]?.stringValue = browserAccessMessage
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
        alert.informativeText = "当前执行会停止，设备 Key 将从本机删除。"
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
        runClient(["control", "browser-diagnostics"]) { [weak self] result in
            guard let self else { return }
            let diagnostics = result["browser_diagnostics"] as? [String: Any] ?? [:]
            let browserError = diagnostics["last_error"] as? [String: Any]
            let alert = NSAlert()
            alert.messageText = "aBridge 诊断"
            if let reason = browserError?["reason"] as? String {
                alert.informativeText = "\(browserError?["code"] as? String ?? "browser_error")\n\(reason)"
            } else {
                alert.informativeText = result["error"] as? String ?? "当前没有已记录的浏览器错误。"
            }
            alert.addButton(withTitle: "查看运行日志")
            alert.addButton(withTitle: "关闭")
            alert.buttons[0].isEnabled = FileManager.default.fileExists(atPath: self.logURL.path)
            if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(self.logURL) }
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
        process.terminationHandler = { terminated in
            let message = "Device client exited: status=\(terminated.terminationStatus), reason=\(terminated.terminationReason.rawValue)\n"
            if let data = message.data(using: .utf8) { try? log.write(contentsOf: data) }
        }
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
        ["--state-dir", stateDirectory.path] + arguments
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
        if preparingBrowser {
            statusLabel.stringValue = "正在连接 Chrome，请允许浏览器中的调试请求…"
        } else if paused {
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
        let fileAccess = browser["file_access"] as? [String: Any] ?? [:]
        let accessMessages = [
            "ready": "连接文件已授权",
            "invalid": "请重新授权连接文件",
            "stale": "连接文件已变更，请重新授权",
            "denied": "未获访问，请重新授权",
            "unavailable": "文件访问恢复失败，请查看诊断",
        ]
        environmentLabels["browser_access"]?.stringValue = accessMessages[fileAccess["status"] as? String ?? ""]
            ?? browserAccessMessage
        if browser["installed"] as? Bool != true {
            environmentLabels["browser"]?.stringValue = "未安装"
        } else {
            let version = browser["version"] as? String ?? ""
            let count = browser["active_sessions"] as? Int ?? 0
            if driver["ready"] as? Bool != true {
                environmentLabels["browser"]?.stringValue = "\(version) · 已安装，等待驱动"
            } else if browser["mode"] as? String == "existing_profile" {
                if browser["status"] as? String == "expired" {
                    environmentLabels["browser"]?.stringValue = "\(version) · 请重新选择窗口"
                } else if browser["selection_ready"] as? Bool != true {
                    environmentLabels["browser"]?.stringValue = "\(version) · 请先选择窗口"
                } else if browser["ready"] as? Bool == true {
                    environmentLabels["browser"]?.stringValue = count > 0
                        ? "\(version) · 正在使用用户 Profile"
                        : "\(version) · 用户 Profile 已就绪"
                } else {
                    environmentLabels["browser"]?.stringValue = browserConnectionFailed
                        ? "\(version) · 接入失败，请查看诊断"
                        : "\(version) · 请接入当前页"
                }
            } else {
                environmentLabels["browser"]?.stringValue = count > 0
                    ? "\(version) · 已连接临时窗口"
                    : "\(version) · 临时窗口按需打开"
            }
        }
    }

    private func restoreBrowserAccess() {
        let bookmark = stateDirectory.appendingPathComponent("browser-access.bookmark")
        guard FileManager.default.fileExists(atPath: bookmark.path) else { return }
        do { try activateBrowserAccess(Data(contentsOf: bookmark)) }
        catch { browserAccessMessage = "连接文件授权已失效，请重新选择" }
    }

    private func activateBrowserAccess(_ data: Data, persist: Bool = false) throws {
        var stale = false
        let url = try URL(resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI],
                          relativeTo: nil, bookmarkDataIsStale: &stale)
        guard !stale, url.lastPathComponent == "DevToolsActivePort" else {
            throw CocoaError(.fileReadNoPermission)
        }
        guard url.startAccessingSecurityScopedResource() else {
            throw CocoaError(.fileReadNoPermission)
        }
        var adopted = false
        defer { if !adopted { url.stopAccessingSecurityScopedResource() } }
        // Opening proves that the grant applies here without reading or logging
        // the endpoint contents. Keep an older working scope until this succeeds.
        let probe = try FileHandle(forReadingFrom: url)
        try probe.close()
        // An implicit security-scoped bookmark carries the selected file's access
        // to the Python process; a path string alone does not carry that scope.
        let transfer = try url.bookmarkData(options: [])
        if persist { try saveBrowserBookmark(data, name: "browser-access.bookmark") }
        try saveBrowserBookmark(transfer, name: "browser-access-transfer.bookmark")
        releaseBrowserAccess()
        browserAccessURL = url
        browserScopeActive = true
        adopted = true
        browserAccessMessage = "已允许单个连接文件"
    }

    private func saveBrowserBookmark(_ data: Data, name: String) throws {
        try FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let file = stateDirectory.appendingPathComponent(name)
        try data.write(to: file, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    private func releaseBrowserAccess() {
        if browserScopeActive { browserAccessURL?.stopAccessingSecurityScopedResource() }
        browserAccessURL = nil
        browserScopeActive = false
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
                if self.daemon?.isRunning != true { self.checkEnvironment() }
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
    else { response(failure("invalid_arguments", "Unknown helper action")) }
} else {
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
