import AppKit
import ApplicationServices
import CoreGraphics
import Darwin

// The App owns the menu bar and privacy permissions.
// The device client embeds Cua in its child process under this App responsibility chain.
// Runtime credentials live in the current user's private application directory.

func permissions() -> [String: Any] {
    ["screen": CGPreflightScreenCaptureAccess(), "input": AXIsProcessTrusted()]
}

private final class StatusTextField: NSTextField {
    override var stringValue: String {
        didSet { toolTip = stringValue }
    }
}

private final class ApplicationDragIcon: NSImageView, NSDraggingSource {
    override func mouseDown(with event: NSEvent) {}

    override func mouseDragged(with event: NSEvent) {
        let item = NSDraggingItem(pasteboardWriter: Bundle.main.bundleURL as NSURL)
        item.setDraggingFrame(bounds, contents: image)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        .copy
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate, NSTextFieldDelegate {
    private var item: NSStatusItem!
    private var window: NSWindow!
    private let urlField = NSTextField(string: "http://127.0.0.1:8765")
    private let deviceNameField = NSTextField(string: String((Host.current().localizedName ?? ProcessInfo.processInfo.hostName).prefix(80)))
    private let deviceNameMessage = StatusTextField(wrappingLabelWithString: "")
    private var saveNameButton: NSButton!
    private var deviceNameDirty = false
    private var savingDeviceName = false
    private var renderedDeviceId = ""
    private let statusLabel = StatusTextField(labelWithString: "尚未连接")
    private var environmentLabels: [String: NSTextField] = [:]
    private var capabilityButtons: [String: NSSwitch] = [:]
    private var connectButton: NSButton!
    private var bindingMethod: NSPopUpButton!
    private var tokenFields: NSStackView!
    private let deviceTokenField = NSSecureTextField(string: "")
    private let visibleTokenField = NSTextField(string: "")
    private var revealToken: NSButton!
    private var httpConfirmedOrigin: String?
    private var pauseButton: NSButton!
    private var unbindButton: NSButton!
    private var authorizationCancelButton: NSButton!
    private var authorizationOpenButton: NSButton!
    private let authorizationLabel = StatusTextField(wrappingLabelWithString: "")
    private var authorizationProcess: Process?
    private var authorizationInput: FileHandle?
    private var authorizationURL: URL?
    private var authorizationServer: String?
    private var authorizationCommitting = false
    private var settingsRoot: NSStackView!
    private var diagnosticsDisclosure: NSButton!
    private var diagnosticsContent: NSStackView!
    private var diagnosticsBox: NSBox!
    private var permissionButtons: [String: NSButton] = [:]
    private var pauseItem: NSMenuItem!
    private var menuStatus: NSMenuItem!
    private var menuActivity: NSMenuItem!
    private var stopItem: NSMenuItem!
    private var reconnectItem: NSMenuItem!
    private var menuCapabilities: [String: NSMenuItem] = [:]
    private var pendingCapabilities: Set<String> = []
    private var updateButton: NSButton!
    private var updateItem: NSMenuItem!
    private let updateLabel = StatusTextField(labelWithString: "")
    private var updateVersion: String?
    private var updatePlan: String?
    private var updateProcess: Process?
    private var updateBusy = false
    private var installingUpdate = false
    private var daemon: Process?
    private var runtime: [String: String] = [:]
    private var current: [String: Any] = [:]
    private var monitor: Any?
    private var lastControlFailure: String?
    private var checkingEnvironment = false
    private var stoppingDaemon = false
    private var daemonStopActions: [() -> Void] = []
    private var stateDirectory: URL!
    private var logURL: URL!

    func applicationDidFinishLaunching(_ notification: Notification) {
        writeUpdateReceipt(ready: false)
        NSApp.setActivationPolicy(.accessory)
        if let location = Bundle.main.url(forResource: "runtime", withExtension: "json"),
           let data = try? Data(contentsOf: location),
           let settings = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            runtime = settings
        }
        runtime["cli_path"] = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/abridge-desktop").path
        if runtime["state_dir"] == nil {
            runtime["state_dir"] = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/aBridge").path
        }
        let savedDirectories = UserDefaults.standard.dictionary(forKey: "aBridgeStateDirectories") as? [String: String] ?? [:]
        if let saved = savedDirectories[Bundle.main.bundleURL.path] {
            runtime["state_dir"] = saved
        }
        if let index = CommandLine.arguments.firstIndex(of: "--state-dir"),
           index + 1 < CommandLine.arguments.count,
           CommandLine.arguments[index + 1].hasPrefix("/") {
            runtime["state_dir"] = CommandLine.arguments[index + 1]
            var directories = savedDirectories
            directories[Bundle.main.bundleURL.path] = CommandLine.arguments[index + 1]
            UserDefaults.standard.set(directories, forKey: "aBridgeStateDirectories")
        }
        guard let state = runtime["state_dir"], state.hasPrefix("/") else {
            NSLog("aBridge runtime metadata requires an absolute state_dir")
            NSApp.terminate(nil)
            return
        }
        stateDirectory = URL(fileURLWithPath: state, isDirectory: true)
        logURL = stateDirectory.appendingPathComponent("logs/client.log")
        buildEditingMenu()
        buildMenu()
        buildWindow()
        loadConfig()
        renderMenu()
        startDaemon()
        if daemon?.isRunning != true { checkEnvironment() }
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        monitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .keyDown]
        ) { [weak self] event in
            // Ignore input generated by the embedded device process.
            let sourcePID = event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID)
            Task { @MainActor in
                guard let self,
                      self.daemon?.isRunning == true,
                      sourcePID != Int64(self.daemon?.processIdentifier ?? -1),
                      self.desktopInputIsActive()
                else { return }
                self.control(["command": "pause", "if_desktop_active": true])
            }
        }
        if boundServerAddress() == nil {
            showWindow()
        }
        let updateError = stateDirectory.appendingPathComponent("logs/update-error.log")
        if let message = try? String(contentsOf: updateError, encoding: .utf8) {
            updateStatus("上次更新未完成：" + message, busy: false)
            try? FileManager.default.removeItem(at: updateError)
            showWindow()
        }
        if let index = CommandLine.arguments.firstIndex(of: "--update-receipt"), index + 1 < CommandLine.arguments.count {
            runClient(["startup-check"]) { result in
                if result["ready"] as? Bool == true { self.writeUpdateReceipt(ready: true) }
            }
        }
    }

    private func writeUpdateReceipt(ready: Bool) {
        guard let index = CommandLine.arguments.firstIndex(of: "--update-receipt"), index + 1 < CommandLine.arguments.count else { return }
        let receipt = ["version": appVersion, "pid": ProcessInfo.processInfo.processIdentifier, "ready": ready] as [String: Any]
        if let data = try? JSONSerialization.data(withJSONObject: receipt) {
            try? data.write(to: URL(fileURLWithPath: CommandLine.arguments[index + 1]), options: .atomic)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        cancelAuthorization()
        if updateProcess?.isRunning == true { updateProcess?.terminate() }
        if !installingUpdate, let plan = updatePlan {
            try? FileManager.default.removeItem(at: URL(fileURLWithPath: plan).deletingLastPathComponent())
        }
        stopDaemon()
        if let monitor { NSEvent.removeMonitor(monitor) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildEditingMenu() {
        let mainMenu = NSMenu()
        mainMenu.addItem(NSMenuItem())
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)
        NSApp.mainMenu = mainMenu
    }

    private func buildMenu() {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let image = NSImage(named: "StatusIcon") {
            image.isTemplate = true
            image.size = NSSize(width: 19, height: 19)
            item.button?.image = image
        } else {
            item.button?.image = NSImage(systemSymbolName: "network", accessibilityDescription: "aBridge")
        }
        item.button?.toolTip = "aBridge"
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        menuStatus = menu.addItem(withTitle: "尚未连接", action: nil, keyEquivalent: "")
        menuStatus.isEnabled = false
        menuActivity = menu.addItem(withTitle: "当前没有执行中的操作", action: nil, keyEquivalent: "")
        menuActivity.isEnabled = false
        menu.addItem(.separator())
        pauseItem = menu.addItem(withTitle: "暂停访问", action: #selector(togglePause), keyEquivalent: "")
        pauseItem.image = NSImage(systemSymbolName: "pause.circle", accessibilityDescription: nil)
        stopItem = menu.addItem(withTitle: "停止当前执行", action: #selector(stop), keyEquivalent: "")
        stopItem.image = NSImage(systemSymbolName: "stop.circle", accessibilityDescription: nil)
        let accessItem = menu.addItem(withTitle: "本机能力", action: nil, keyEquivalent: "")
        accessItem.image = NSImage(systemSymbolName: "slider.horizontal.3", accessibilityDescription: nil)
        let accessMenu = NSMenu()
        accessMenu.autoenablesItems = false
        for (key, label, symbol) in [("screen", "屏幕截图", "viewfinder"), ("input", "键鼠操作", "cursorarrow"), ("shell", "Shell 命令", "terminal"), ("files", "文件访问", "folder")] {
            let entry = accessMenu.addItem(withTitle: label, action: #selector(menuCapabilityChanged(_:)), keyEquivalent: "")
            entry.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            entry.representedObject = key
            entry.target = self
            menuCapabilities[key] = entry
        }
        accessItem.submenu = accessMenu
        menu.addItem(.separator())
        reconnectItem = menu.addItem(withTitle: "重新连接", action: #selector(reconnectFromMenu), keyEquivalent: "")
        reconnectItem.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil)
        let environment = menu.addItem(withTitle: "重新检查运行环境", action: #selector(checkEnvironment), keyEquivalent: "")
        environment.image = NSImage(systemSymbolName: "stethoscope", accessibilityDescription: nil)
        updateItem = menu.addItem(withTitle: "检查更新…", action: #selector(updateAction), keyEquivalent: "")
        updateItem.image = NSImage(systemSymbolName: "arrow.down.circle", accessibilityDescription: nil)
        let logs = menu.addItem(withTitle: "查看运行日志", action: #selector(openLogs), keyEquivalent: "")
        logs.image = NSImage(systemSymbolName: "doc.text", accessibilityDescription: nil)
        let settings = menu.addItem(withTitle: "设置…", action: #selector(showWindow), keyEquivalent: ",")
        settings.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: nil)
        menu.addItem(.separator())
        let quitItem = menu.addItem(withTitle: "退出 aBridge", action: #selector(quit), keyEquivalent: "q")
        quitItem.image = NSImage(systemSymbolName: "rectangle.portrait.and.arrow.right", accessibilityDescription: nil)
        for entry in menu.items where entry.action != nil { entry.target = self }
        item.menu = menu
        renderMenu()
    }

    func menuWillOpen(_ menu: NSMenu) { poll(); renderMenu() }

    private func renderMenu() {
        let running = daemon?.isRunning == true && !stoppingDaemon
        let paused = current["paused"] as? Bool == true
        let active = current["active_operations"] as? Int ?? 0
        let fresh = Date().timeIntervalSince1970 - (current["updated_at"] as? Double ?? 0) < 5
        let online = running && fresh && current["connection"] as? String == "online"
        let bound = boundServerAddress() != nil
        menuStatus.title = !bound ? "尚未绑定这台 Mac" : paused ? "访问已暂停" : online ? "已连接 · \(current["owner_name"] as? String ?? "这台 Mac")" : "当前离线"
        menuActivity.title = running && fresh && active > 0 ? "正在执行 \(active) 项操作" : "当前没有执行中的操作"
        pauseItem.title = paused ? "恢复访问" : "暂停访问"
        pauseItem.image = NSImage(systemSymbolName: paused ? "play.circle" : "pause.circle", accessibilityDescription: nil)
        pauseItem.isEnabled = running && fresh
        stopItem.isEnabled = running && fresh && active > 0
        reconnectItem.isEnabled = bound && !stoppingDaemon && !authorizationCommitting
        pauseButton?.isEnabled = running && fresh
        unbindButton?.isHidden = !bound
        unbindButton?.isEnabled = !authorizationCommitting
        connectButton?.title = authorizationProcess != nil ? "正在绑定…"
            : bindingMethod?.indexOfSelectedItem == 1 ? "验证并连接"
            : bound && sameServer(urlField.stringValue, boundServerAddress()) ? "重新连接" : "在浏览器授权"
        connectButton?.isEnabled = authorizationProcess == nil && !stoppingDaemon
        bindingMethod?.isEnabled = authorizationProcess == nil && !stoppingDaemon
        deviceTokenField.isEnabled = authorizationProcess == nil
        visibleTokenField.isEnabled = authorizationProcess == nil
        revealToken?.isEnabled = authorizationProcess == nil
        authorizationCancelButton?.isHidden = authorizationProcess == nil
        authorizationCancelButton?.isEnabled = !authorizationCommitting
        authorizationOpenButton?.isHidden = authorizationURL == nil
        authorizationOpenButton?.isEnabled = authorizationURL != nil && !authorizationCommitting
        urlField.isEditable = !authorizationCommitting
        deviceNameField.isEditable = bound && !savingDeviceName && !authorizationCommitting
        saveNameButton?.isEnabled = online && deviceNameDirty && !savingDeviceName && !authorizationCommitting
        let requested = current["requested_capabilities"] as? [String: Bool] ?? [:]
        for (key, entry) in menuCapabilities {
            entry.state = requested[key] == true ? .on : .off
            entry.isEnabled = running && fresh && !pendingCapabilities.contains(key)
        }
        item.button?.appearsDisabled = !online || paused
        item.button?.toolTip = "aBridge · \(menuStatus.title) · \(menuActivity.title)"
    }

    @objc private func menuCapabilityChanged(_ sender: NSMenuItem) {
        guard let capability = sender.representedObject as? String else { return }
        setCapability(capability, enabled: sender.state != .on)
    }

    @objc private func reconnectFromMenu() {
        guard !stoppingDaemon, !authorizationCommitting else { return }
        stopDaemon { [weak self] in self?.startDaemon(); self?.renderMenu() }
    }

    @objc private func openLogs() {
        if FileManager.default.fileExists(atPath: logURL.path) { NSWorkspace.shared.open(logURL) }
        else { NSWorkspace.shared.open(logURL.deletingLastPathComponent()) }
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 580),
            styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false
        )
        window.title = "aBridge 设置"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.12, alpha: 1) : NSColor(calibratedWhite: 0.96, alpha: 1)
        }
        let root = verticalStack(spacing: 14)
        settingsRoot = root
        window.contentView?.addSubview(root)
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 20),
            root.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -20),
            root.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 18),
        ])

        let identity = verticalStack(spacing: 5)
        if let wordmark = NSImage(named: "Wordmark") {
            let heading = NSImageView(image: wordmark)
            heading.imageScaling = .scaleProportionallyUpOrDown
            heading.setAccessibilityLabel("aBridge")
            heading.widthAnchor.constraint(equalToConstant: 84).isActive = true
            heading.heightAnchor.constraint(equalToConstant: 23).isActive = true
            identity.addArrangedSubview(heading)
        } else {
            let heading = NSTextField(labelWithString: "aBridge")
            heading.font = NSFont(name: "Helvetica-Bold", size: 24) ?? .boldSystemFont(ofSize: 24)
            heading.textColor = .systemBlue
            identity.addArrangedSubview(heading)
        }
        statusLabel.font = .systemFont(ofSize: 11)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.allowsExpansionToolTips = true
        statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        addFullWidth(statusLabel, to: identity)
        pauseButton = actionButton("暂停访问", action: #selector(togglePause))
        let header = NSStackView(views: [identity, pauseButton])
        header.distribution = .fill
        header.alignment = .centerY
        header.spacing = 12
        identity.setHuggingPriority(.defaultLow, for: .horizontal)
        pauseButton.setContentHuggingPriority(.required, for: .horizontal)
        addFullWidth(header, to: root)

        let connection = addSettingsGroup("连接", to: root)
        let addressLabel = textLabel("服务地址")
        addressLabel.widthAnchor.constraint(equalToConstant: 66).isActive = true
        urlField.placeholderString = "https://…"
        urlField.font = .systemFont(ofSize: 13)
        urlField.bezelStyle = .roundedBezel
        urlField.delegate = self
        urlField.setAccessibilityLabel("服务地址")
        urlField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let addressRow = NSStackView(views: [addressLabel, urlField])
        addressRow.distribution = .fill
        addressRow.spacing = 12
        addressRow.alignment = .centerY
        addressRow.heightAnchor.constraint(greaterThanOrEqualToConstant: 28).isActive = true
        addFullWidth(addressRow, to: connection)
        let nameLabel = textLabel("设备名称")
        nameLabel.widthAnchor.constraint(equalToConstant: 66).isActive = true
        deviceNameField.placeholderString = "这台 Mac 的名称"
        deviceNameField.font = .systemFont(ofSize: 13)
        deviceNameField.bezelStyle = .roundedBezel
        deviceNameField.delegate = self
        deviceNameField.setAccessibilityLabel("设备名称")
        deviceNameField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        saveNameButton = actionButton("保存名称", action: #selector(saveDeviceName))
        let nameRow = NSStackView(views: [nameLabel, deviceNameField, saveNameButton])
        nameRow.distribution = .fill
        nameRow.spacing = 12
        nameRow.alignment = .centerY
        nameRow.heightAnchor.constraint(greaterThanOrEqualToConstant: 28).isActive = true
        addFullWidth(nameRow, to: connection)
        deviceNameMessage.font = .systemFont(ofSize: 12)
        deviceNameMessage.textColor = .secondaryLabelColor
        deviceNameMessage.isSelectable = true
        deviceNameMessage.isHidden = true
        addFullWidth(deviceNameMessage, to: connection)
        authorizationLabel.font = .systemFont(ofSize: 12)
        authorizationLabel.textColor = .secondaryLabelColor
        authorizationLabel.isSelectable = true
        authorizationLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        addFullWidth(authorizationLabel, to: connection)
        authorizationLabel.isHidden = true
        connectButton = actionButton("在浏览器授权", action: #selector(connect))
        connectButton.keyEquivalent = "\r"
        connectButton.bezelColor = NSColor(srgbRed: 0, green: 0.4, blue: 0.867, alpha: 1)
        unbindButton = actionButton("解除绑定…", action: #selector(unbindDevice))
        unbindButton.isBordered = false
        unbindButton.contentTintColor = .secondaryLabelColor
        authorizationCancelButton = actionButton("取消", action: #selector(cancelAuthorization))
        authorizationOpenButton = actionButton("重新打开授权页", action: #selector(openAuthorization))
        authorizationCancelButton.isHidden = true
        authorizationOpenButton.isHidden = true
        let connectionActions = NSStackView(views: [unbindButton, NSView(), authorizationOpenButton, authorizationCancelButton, connectButton])
        connectionActions.distribution = .fill
        connectionActions.alignment = .centerY
        connectionActions.spacing = 8
        addFullWidth(connectionActions, to: connection)

        bindingMethod = NSPopUpButton(frame: .zero, pullsDown: false)
        bindingMethod.addItems(withTitles: ["浏览器授权", "Device Token"])
        bindingMethod.target = self
        bindingMethod.action = #selector(bindingMethodChanged)
        let methodLabel = textLabel("绑定方式")
        methodLabel.widthAnchor.constraint(equalToConstant: 66).isActive = true
        let methodRow = NSStackView(views: [methodLabel, bindingMethod, NSView()])
        methodRow.alignment = .centerY
        methodRow.spacing = 12
        connection.insertArrangedSubview(methodRow, at: 2)
        tokenFields = verticalStack(spacing: 6)
        deviceTokenField.placeholderString = "abr_device_…"
        visibleTokenField.placeholderString = "abr_device_…"
        deviceTokenField.setAccessibilityLabel("Device Token")
        visibleTokenField.setAccessibilityLabel("Device Token（可见）")
        visibleTokenField.isHidden = true
        revealToken = NSButton(checkboxWithTitle: "显示 Token", target: self, action: #selector(toggleTokenVisibility))
        let tokenRow = NSStackView(views: [deviceTokenField, visibleTokenField, revealToken])
        tokenRow.alignment = .centerY
        tokenRow.spacing = 8
        addFullWidth(tokenRow, to: tokenFields)
        let tokenHint = textLabel("从管理台生成电脑设备的 Device Token，不能使用 Agent Key。")
        tokenHint.font = .systemFont(ofSize: 11)
        tokenHint.textColor = .secondaryLabelColor
        addFullWidth(tokenHint, to: tokenFields)
        connection.insertArrangedSubview(tokenFields, at: 3)
        tokenFields.widthAnchor.constraint(equalTo: connection.widthAnchor).isActive = true
        tokenFields.isHidden = true

        let capabilities = addSettingsGroup("本机能力", to: root)
        let capabilityRows = [
            [("screen", "屏幕截图", "viewfinder"), ("input", "键鼠操作", "cursorarrow")],
            [("shell", "Shell 命令", "terminal"), ("files", "文件访问", "folder")],
        ]
        for (index, entries) in capabilityRows.enumerated() {
            if index > 0 { addDivider(to: capabilities) }
            let row = NSStackView()
            row.distribution = .fillEqually
            row.spacing = 28
            row.alignment = .centerY
            for (key, title, symbol) in entries {
                let icon = NSImageView(image: NSImage(systemSymbolName: symbol, accessibilityDescription: nil)!)
                icon.contentTintColor = .secondaryLabelColor
                icon.widthAnchor.constraint(equalToConstant: 18).isActive = true
                let toggle = NSSwitch()
                toggle.target = self
                toggle.action = #selector(capabilityChanged(_:))
                toggle.identifier = NSUserInterfaceItemIdentifier(key)
                toggle.setAccessibilityLabel(title)
                toggle.controlSize = .small
                toggle.setContentHuggingPriority(.required, for: .horizontal)
                capabilityButtons[key] = toggle
                let control = NSStackView(views: [icon, textLabel(title), NSView(), toggle])
                control.distribution = .fill
                control.alignment = .centerY
                control.spacing = 8
                control.heightAnchor.constraint(greaterThanOrEqualToConstant: 30).isActive = true
                row.addArrangedSubview(control)
            }
            addFullWidth(row, to: capabilities)
        }

        let access = addSettingsGroup("系统权限", to: root)
        permissionButtons["screen"] = addEnvironmentRow("screen", title: "屏幕录制", action: "前往设置", selector: #selector(requestScreen), to: access)
        addDivider(to: access)
        permissionButtons["input"] = addEnvironmentRow("input", title: "辅助功能", action: "前往设置", selector: #selector(requestInput), to: access)
        addDivider(to: access)
        let appIcon = ApplicationDragIcon(frame: .zero)
        appIcon.image = NSWorkspace.shared.icon(forFile: Bundle.main.bundleURL.path)
        appIcon.imageScaling = .scaleProportionallyUpOrDown
        appIcon.toolTip = Bundle.main.bundleURL.path
        appIcon.setAccessibilityLabel("aBridge 应用，可拖入系统设置的权限列表")
        NSLayoutConstraint.activate([
            appIcon.widthAnchor.constraint(equalToConstant: 32),
            appIcon.heightAnchor.constraint(equalToConstant: 32),
        ])
        let dragInstructions = verticalStack(spacing: 2)
        dragInstructions.addArrangedSubview(textLabel("拖入系统设置的权限列表"))
        let permissionHint = textLabel("再开启对应权限")
        permissionHint.font = .systemFont(ofSize: 11)
        permissionHint.textColor = .secondaryLabelColor
        dragInstructions.addArrangedSubview(permissionHint)
        let revealApp = actionButton("在 Finder 中显示", action: #selector(revealApplication))
        revealApp.setContentHuggingPriority(.required, for: .horizontal)
        let dragRow = NSStackView(views: [appIcon, dragInstructions, NSView(), revealApp])
        dragRow.spacing = 10
        dragRow.alignment = .centerY
        addFullWidth(dragRow, to: access)

        let updates = addSettingsGroup("软件更新", to: root)
        updateLabel.stringValue = "当前版本 \(appVersion)"
        updateLabel.font = .systemFont(ofSize: 12)
        updateLabel.textColor = .secondaryLabelColor
        updateButton = actionButton("检查更新", action: #selector(updateAction))
        let updateRow = NSStackView(views: [updateLabel, NSView(), updateButton])
        updateRow.alignment = .centerY
        updateRow.spacing = 12
        updateRow.heightAnchor.constraint(greaterThanOrEqualToConstant: 30).isActive = true
        updateLabel.lineBreakMode = .byTruncatingTail
        updateLabel.allowsExpansionToolTips = true
        updateLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        updateButton.setContentHuggingPriority(.required, for: .horizontal)
        addFullWidth(updateRow, to: updates)

        let diagnostics = verticalStack(spacing: 10)
        diagnosticsDisclosure = NSButton(title: "运行诊断", target: self, action: #selector(toggleDiagnostics))
        diagnosticsDisclosure.setButtonType(.onOff)
        diagnosticsDisclosure.bezelStyle = .inline
        diagnosticsDisclosure.isBordered = false
        diagnosticsDisclosure.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)
        diagnosticsDisclosure.imagePosition = .imageLeading
        diagnosticsDisclosure.font = .systemFont(ofSize: 12)
        diagnosticsDisclosure.contentTintColor = .secondaryLabelColor
        diagnosticsDisclosure.setAccessibilityLabel("展开运行诊断")
        diagnostics.addArrangedSubview(diagnosticsDisclosure)
        diagnosticsContent = verticalStack(spacing: 10)
        diagnosticsBox = settingsBox(diagnosticsContent)
        addFullWidth(diagnosticsBox, to: diagnostics)
        diagnosticsContent.isHidden = true
        diagnosticsBox.isHidden = true
        addEnvironmentRow("runtime", title: "原生客户端", to: diagnosticsContent)
        addEnvironmentRow("driver", title: "Cua Driver", to: diagnosticsContent)
        addEnvironmentRow("execution", title: "执行权限", to: diagnosticsContent)
        addDivider(to: diagnosticsContent)
        let refresh = actionButton("重新检查", action: #selector(checkEnvironment))
        let details = actionButton("连接诊断", action: #selector(showDiagnostics))
        let logs = actionButton("查看日志", action: #selector(openLogs))
        let diagnosticActions = NSStackView(views: [refresh, NSView(), details, logs])
        diagnosticActions.distribution = .fill
        diagnosticActions.alignment = .centerY
        diagnosticActions.spacing = 8
        addFullWidth(diagnosticActions, to: diagnosticsContent)
        addFullWidth(diagnostics, to: root)
        resizeSettingsWindow()
        window.center()
        window.initialFirstResponder = window.contentView
        window.makeFirstResponder(window)
    }

    private func verticalStack(spacing: CGFloat) -> NSStackView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = spacing
        stack.translatesAutoresizingMaskIntoConstraints = false
        return stack
    }

    private func textLabel(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 13)
        return label
    }

    private func actionButton(_ title: String, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        button.controlSize = .small
        button.font = .systemFont(ofSize: 12)
        return button
    }

    private func addFullWidth(_ view: NSView, to stack: NSStackView) {
        stack.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    private func settingsBox(_ content: NSStackView) -> NSBox {
        let box = NSBox()
        box.boxType = .custom
        box.titlePosition = .noTitle
        box.borderColor = .clear
        box.borderWidth = 0
        box.isTransparent = false
        box.fillColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.18, alpha: 1) : NSColor(calibratedWhite: 1, alpha: 1)
        }
        box.cornerRadius = 10
        box.contentViewMargins = .zero
        let container = box.contentView!
        container.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            content.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            content.topAnchor.constraint(equalTo: container.topAnchor, constant: 10),
            content.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10),
            box.heightAnchor.constraint(equalTo: content.heightAnchor, constant: 20),
        ])
        return box
    }

    private func addSettingsGroup(_ title: String, to root: NSStackView) -> NSStackView {
        let section = verticalStack(spacing: 6)
        let heading = textLabel(title)
        heading.font = .systemFont(ofSize: 11, weight: .medium)
        heading.textColor = .secondaryLabelColor
        let titleRow = NSStackView(views: [heading, NSView()])
        titleRow.edgeInsets = NSEdgeInsets(top: 0, left: 3, bottom: 0, right: 0)
        addFullWidth(titleRow, to: section)
        let content = verticalStack(spacing: 8)
        addFullWidth(settingsBox(content), to: section)
        addFullWidth(section, to: root)
        return content
    }

    private func addDivider(to root: NSStackView) {
        let separator = NSBox()
        separator.boxType = .separator
        addFullWidth(separator, to: root)
    }

    @discardableResult
    private func addEnvironmentRow(
        _ key: String, title: String, action: String? = nil, selector: Selector? = nil, to root: NSStackView
    ) -> NSButton? {
        let name = textLabel(title)
        name.widthAnchor.constraint(equalToConstant: 82).isActive = true
        let value = textLabel("检查中…")
        value.font = .systemFont(ofSize: 12)
        value.textColor = .secondaryLabelColor
        value.alignment = .right
        value.lineBreakMode = .byTruncatingTail
        value.allowsExpansionToolTips = true
        value.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        environmentLabels[key] = value
        let row = NSStackView(views: [name, value])
        row.distribution = .fill
        row.alignment = .centerY
        row.spacing = 10
        row.heightAnchor.constraint(greaterThanOrEqualToConstant: 26).isActive = true
        var button: NSButton?
        if let action, let selector {
            button = actionButton(action, action: selector)
            button!.setContentHuggingPriority(.required, for: .horizontal)
            row.addArrangedSubview(button!)
        }
        addFullWidth(row, to: root)
        return button
    }

    @objc private func toggleDiagnostics() {
        let expanded = diagnosticsDisclosure.state == .on
        diagnosticsDisclosure.setAccessibilityLabel(expanded ? "收起运行诊断" : "展开运行诊断")
        diagnosticsDisclosure.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)
        diagnosticsContent.isHidden = !expanded
        diagnosticsBox.isHidden = !expanded
        resizeSettingsWindow()
    }

    private func resizeSettingsWindow() {
        guard let root = settingsRoot else { return }
        window.contentView?.layoutSubtreeIfNeeded()
        let height = ceil(root.fittingSize.height) + 36
        let previousTop = window.frame.maxY
        window.setContentSize(NSSize(width: 520, height: height))
        var frame = window.frame
        frame.origin.y = previousTop - frame.height
        window.setFrame(frame, display: true)
    }

    private func boundServerAddress() -> String? {
        let configURL = stateDirectory.appendingPathComponent("config.json")
        let credentialURL = stateDirectory.appendingPathComponent("credentials/device.json")
        guard let data = try? Data(contentsOf: configURL),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              config["revoked"] as? Bool != true,
              let address = config["url"] as? String,
              let attributes = try? FileManager.default.attributesOfItem(atPath: credentialURL.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              let credentialData = try? Data(contentsOf: credentialURL),
              let credential = try? JSONSerialization.jsonObject(with: credentialData) as? [String: Any],
              credential["server_url"] as? String == address,
              let key = credential["device_key"] as? String,
              key.hasPrefix("abr_device_"), key.count <= 4096 else { return nil }
        return address
    }

    private func normalizedServerAddress(_ value: String) -> String? {
        guard var parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let rawScheme = parts.scheme, let rawHost = parts.host,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil else { return nil }
        let scheme = rawScheme.lowercased()
        let host = rawHost.lowercased()
        guard scheme == "https" || scheme == "http" else { return nil }
        parts.scheme = scheme
        parts.host = host
        if parts.port == (scheme == "https" ? 443 : 80) { parts.port = nil }
        guard var address = parts.url?.absoluteString else { return nil }
        if address.hasSuffix("/") { address.removeLast() }
        return address
    }

    private func sameServer(_ value: String, _ expected: String?) -> Bool {
        guard let expected, let normalized = normalizedServerAddress(value),
              let bound = normalizedServerAddress(expected) else { return false }
        return normalized == bound
    }

    private func validAuthorizationOrigin(_ destination: URL, server: String) -> Bool {
        guard let normalized = normalizedServerAddress(server), let expected = URL(string: normalized),
              let scheme = destination.scheme?.lowercased(), let host = destination.host?.lowercased(),
              destination.user == nil, destination.password == nil, destination.fragment == nil else { return false }
        let port = destination.port ?? (scheme == "https" ? 443 : 80)
        let expectedPort = expected.port ?? (expected.scheme == "https" ? 443 : 80)
        return scheme == expected.scheme && host == expected.host?.lowercased() && port == expectedPort
    }

    func controlTextDidChange(_ notification: Notification) {
        if notification.object as? NSTextField === deviceNameField {
            deviceNameDirty = true
            deviceNameMessage.isHidden = true
            renderMenu()
            resizeSettingsWindow()
            return
        }
        guard notification.object as? NSTextField === urlField else { return }
        httpConfirmedOrigin = nil
        if authorizationProcess != nil && !sameServer(urlField.stringValue, authorizationServer) {
            cancelAuthorization()
        } else if authorizationProcess == nil && !authorizationLabel.isHidden {
            authorizationLabel.isHidden = true
            resizeSettingsWindow()
        }
        renderMenu()
    }

    @objc private func connect() {
        guard authorizationProcess == nil, !stoppingDaemon else { return }
        if bindingMethod.indexOfSelectedItem == 0 && sameServer(urlField.stringValue, boundServerAddress()) {
            authorizationLabel.isHidden = true
            stopDaemon { [weak self] in self?.startDaemon(); self?.renderMenu() }
            return
        }
        beginAuthorization()
    }

    private func sendAuthorization(_ value: [String: Any]) {
        guard let handle = authorizationInput else { return }
        do {
            var data = try JSONSerialization.data(withJSONObject: value)
            data.append(0x0a)
            try handle.write(contentsOf: data)
        } catch {
            // 子进程可能已在 stdout 写出启动或提交错误，让同一个读取任务消费最终结果。
            try? handle.close()
            authorizationInput = nil
        }
    }

    @objc private func bindingMethodChanged() {
        deviceTokenField.stringValue = ""
        visibleTokenField.stringValue = ""
        tokenFields.isHidden = bindingMethod.indexOfSelectedItem == 0
        authorizationLabel.isHidden = true
        renderMenu()
        resizeSettingsWindow()
    }

    @objc private func toggleTokenVisibility() {
        let show = revealToken.state == .on
        if show { visibleTokenField.stringValue = deviceTokenField.stringValue }
        else { deviceTokenField.stringValue = visibleTokenField.stringValue }
        deviceTokenField.isHidden = show
        visibleTokenField.isHidden = !show
    }

    private func confirmHttp(_ server: String) -> Bool {
        guard let url = URL(string: server), url.scheme == "http",
              let host = url.host, !["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) else { return true }
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        parts.path = ""
        let origin = parts.string!
        if httpConfirmedOrigin == origin { return true }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "连接未加密的 Server？"
        alert.informativeText = "\(origin)\n\n此连接使用 HTTP，设备 Token、操作内容和截图可能被网络中的其他人读取。建议使用 HTTPS。"
        alert.addButton(withTitle: "取消")
        alert.addButton(withTitle: "仍然连接")
        guard alert.runModal() == .alertSecondButtonReturn else { return false }
        httpConfirmedOrigin = origin
        return true
    }

    private func beginAuthorization() {
        guard let address = normalizedServerAddress(urlField.stringValue) else {
            finishAuthorization("请填写完整的 HTTP 或 HTTPS 服务地址，例如 http://主机:端口。")
            return
        }
        let tokenMode = bindingMethod.indexOfSelectedItem == 1
        let token = (revealToken.state == .on ? visibleTokenField.stringValue : deviceTokenField.stringValue).trimmingCharacters(in: .whitespacesAndNewlines)
        if tokenMode && (!token.hasPrefix("abr_device_") || token.count > 4096) {
            finishAuthorization("请输入电脑设备的 Device Token，不能使用 Agent Key 或管理员 Token。")
            return
        }
        guard confirmHttp(address) else { return }
        guard let process = runtimeProcess(arguments: clientArguments(["authorize", "--stdin"])) else {
            finishAuthorization("找不到 aBridge 的设备客户端，请重新安装完整的 Mac 应用。")
            return
        }
        let output = Pipe()
        let input = Pipe()
        process.standardOutput = output
        process.standardInput = input
        process.standardError = errorLog()
        authorizationProcess = process
        authorizationInput = input.fileHandleForWriting
        _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
        authorizationServer = address
        authorizationURL = nil
        authorizationCommitting = false
        authorizationLabel.stringValue = tokenMode ? "正在验证设备 Token…" : "正在获取授权链接…"
        authorizationLabel.isHidden = false
        do { try process.run() } catch {
            finishAuthorization("无法启动本机授权进程，请重新打开 aBridge 后重试。")
            return
        }
        var request: [String: Any] = ["url": address]
        if tokenMode { request["device_key"] = token }
        if let origin = httpConfirmedOrigin { request["http_confirmed_origin"] = origin }
        sendAuthorization(request)
        renderMenu()
        resizeSettingsWindow()
        DispatchQueue.global().async { [weak self] in
            var pending = Data()
            while true {
                let data = output.fileHandleForReading.availableData
                if data.isEmpty { break }
                pending.append(data)
                if pending.count > 65536 { process.terminate(); break }
                while let end = pending.firstIndex(of: 0x0a) {
                    let line = Data(pending[..<end])
                    pending.removeSubrange(...end)
                    guard let event = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                    DispatchQueue.main.async { self?.handleAuthorization(event, from: process) }
                }
            }
            process.waitUntilExit()
            DispatchQueue.main.async {
                guard let self, self.authorizationProcess === process else { return }
                self.finishAuthorization(Self.exitMessage(process, name: "本机授权进程") + "，请重新发起绑定。")
            }
        }
    }

    private func handleAuthorization(_ event: [String: Any], from process: Process) {
        guard authorizationProcess === process else { return }
        if let failure = Self.clientFailure(event) {
            finishAuthorization(failure)
            return
        }
        switch event["event"] as? String {
        case "authorization":
            guard let address = event["authorization_url"] as? String,
                  let destination = URL(string: address),
                  validAuthorizationOrigin(destination, server: authorizationServer ?? "") else {
                finishAuthorization("授权页面与填写的服务地址不一致，请检查服务地址和反向代理的对外地址。")
                return
            }
            authorizationURL = destination
            authorizationLabel.stringValue = "请在浏览器中登录并确认授权"
            renderMenu()
            openAuthorization()
        case "ready":
            authorizationCommitting = true
            authorizationLabel.stringValue = "正在完成绑定…"
            renderMenu()
            stopDaemon { [weak self] in
                guard let self, self.authorizationProcess === process else { return }
                self.sendAuthorization(["command": "commit", "capabilities": self.capabilityButtons.mapValues { $0.state == .on }])
            }
        case "complete":
            deviceTokenField.stringValue = ""
            visibleTokenField.stringValue = ""
            guard event["ok"] as? Bool == true else {
                finishAuthorization("绑定未完成，请重试")
                return
            }
            authorizationProcess = nil
            try? authorizationInput?.close()
            authorizationInput = nil
            authorizationURL = nil
            authorizationServer = nil
            authorizationCommitting = false
            authorizationLabel.isHidden = true
            loadConfig()
            renderMenu()
            resizeSettingsWindow()
            startDaemon()
            showWindow()
        case "error":
            finishAuthorization(event["error"] as? String ?? "浏览器授权失败，请重试")
        default:
            finishAuthorization("授权运行时返回无效结果")
        }
    }

    @objc private func openAuthorization() {
        guard let address = authorizationURL else { return }
        if !NSWorkspace.shared.open(address) {
            authorizationLabel.stringValue = "macOS 未能打开默认浏览器，请检查默认浏览器设置，再点「重新打开授权页」。"
            resizeSettingsWindow()
        }
    }

    @objc private func cancelAuthorization() {
        guard authorizationProcess != nil else { return }
        finishAuthorization("授权已取消")
    }

    private func finishAuthorization(_ message: String) {
        let process = authorizationProcess
        let wasCommitting = authorizationCommitting
        authorizationProcess = nil
        try? authorizationInput?.close()
        authorizationInput = nil
        authorizationURL = nil
        authorizationServer = nil
        authorizationCommitting = false
        if process?.isRunning == true { process?.terminate() }
        authorizationLabel.stringValue = message
        authorizationLabel.isHidden = false
        renderMenu()
        resizeSettingsWindow()
        if wasCommitting { startDaemon() }
    }

    @objc private func togglePause() {
        guard current["paused"] as? Bool == true else {
            control(["command": "pause"])
            return
        }
        runClient(["control", "resume"]) { [weak self] result in
            guard let self else { return }
            guard result["ok"] as? Bool == true else {
                self.statusLabel.stringValue = result["error"] as? String ?? "恢复访问失败"
                return
            }
            self.render(result)

        }
    }

    @objc private func stop() { control(["command": "stop"]) }

    @objc private func saveDeviceName() {
        guard !savingDeviceName else { return }
        let name = deviceNameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, (name as NSString).length <= 120 else {
            deviceNameMessage.stringValue = "设备名称需为 1–120 个字符"
            deviceNameMessage.isHidden = false
            resizeSettingsWindow()
            return
        }
        savingDeviceName = true
        deviceNameMessage.isHidden = true
        renderMenu()
        runClient(["control", "rename", "--name", name]) { [weak self] result in
            guard let self else { return }
            self.savingDeviceName = false
            if result["ok"] as? Bool == true {
                self.deviceNameDirty = false
                self.render(result)
                self.deviceNameMessage.stringValue = "名称已保存"
                self.deviceNameMessage.textColor = .secondaryLabelColor
            } else {
                self.deviceNameMessage.stringValue = result["error"] as? String ?? "名称保存失败，请重试"
                self.deviceNameMessage.textColor = .systemRed
                self.renderMenu()
            }
            self.deviceNameMessage.isHidden = false
            self.resizeSettingsWindow()
        }
    }

    @objc private func capabilityChanged(_ sender: NSSwitch) {
        guard let capability = sender.identifier?.rawValue else { return }
        setCapability(capability, enabled: sender.state == .on)
    }

    private func setCapability(_ capability: String, enabled: Bool) {
        guard !pendingCapabilities.contains(capability) else { return }
        pendingCapabilities.insert(capability)
        capabilityButtons[capability]?.isEnabled = false
        renderMenu()
        runClient(["control", "capability", "--capability", capability, "--enabled", enabled ? "true" : "false"]) { [weak self] result in
            guard let self else { return }
            self.pendingCapabilities.remove(capability)
            self.capabilityButtons[capability]?.isEnabled = true
            if result["ok"] as? Bool == true { self.render(result) }
            else {
                self.render(self.current)
                self.statusLabel.stringValue = result["error"] as? String ?? "能力设置失败"
            }
        }
    }

    @objc private func unbindDevice() {
        let alert = NSAlert()
        alert.messageText = "解除这台 Mac 的绑定？"
        alert.informativeText = "当前执行会停止，设备凭据将从本机删除。"
        alert.addButton(withTitle: "解除绑定")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn {
            cancelAuthorization()
            control(["command": "unbind"])
        }
    }

    @objc private func requestScreen() {
        guard !CGPreflightScreenCaptureAccess() else { return }
        CGRequestScreenCaptureAccess()
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
    }

    @objc private func revealApplication() {
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    }

    @objc private func requestInput() {
        guard !AXIsProcessTrusted() else { return }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }

    @objc private func showDiagnostics() {
        let alert = NSAlert()
        alert.messageText = "aBridge 诊断"
        var details = ["设备连接：\(statusLabel.stringValue)"]
        if !authorizationLabel.isHidden { details.append("设备绑定：\(authorizationLabel.stringValue)") }
        if !deviceNameMessage.isHidden { details.append("设备名称：\(deviceNameMessage.stringValue)") }
        if let failure = lastControlFailure, failure != statusLabel.stringValue,
           deviceNameMessage.isHidden || failure != deviceNameMessage.stringValue {
            details.append("本机操作：\(failure)")
        }
        alert.informativeText = details.joined(separator: "\n\n")
        alert.addButton(withTitle: "查看运行日志")
        alert.addButton(withTitle: "关闭")
        alert.buttons[0].isEnabled = FileManager.default.fileExists(atPath: logURL.path)
        if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(logURL) }
    }


    private var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0" }

    private func updateStatus(_ text: String, busy: Bool) {
        updateBusy = busy
        updateLabel.stringValue = text
        let action = updatePlan != nil ? "安装并重启" : updateVersion != nil ? "下载更新" : "检查更新"
        updateButton.title = action
        updateButton.isEnabled = !busy
        updateItem.title = busy ? text : action + "…"
        updateItem.isEnabled = !busy
        resizeSettingsWindow()
    }

    @objc private func updateAction() {
        guard !updateBusy else { return }
        showWindow()
        if let plan = updatePlan {
            let alert = NSAlert()
            alert.messageText = "安装更新并重启 aBridge？"
            alert.informativeText = "当前执行会结束，设备绑定和设置会保留。"
            alert.addButton(withTitle: "安装并重启")
            alert.addButton(withTitle: "取消")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            cancelAuthorization()
            updateStatus("正在停止当前执行…", busy: true)
            stopDaemon { [weak self] in
                guard let self else { return }
                self.runUpdater(["install", plan, String(ProcessInfo.processInfo.processIdentifier)]) { result in
                    if result["ready"] as? Bool == true {
                        self.installingUpdate = true
                        NSApp.terminate(nil)
                    } else {
                        self.updateStatus(result["error"] as? String ?? "无法开始安装", busy: false)
                        self.startDaemon()
                    }
                }
            }
        } else if let version = updateVersion {
            updateStatus("正在下载并校验 \(version)…", busy: true)
            runUpdater(["download", Bundle.main.bundleURL.path, appVersion, version, stateDirectory.path]) { [weak self] result in
                guard let self else { return }
                if let plan = result["plan"] as? String {
                    self.updatePlan = plan
                    self.updateStatus("\(version) 已就绪", busy: false)
                } else {
                    self.updateVersion = nil
                    self.updateStatus(result["error"] as? String ?? "下载失败，请重试", busy: false)
                }
            }
        } else {
            updateStatus("正在检查更新…", busy: true)
            runUpdater(["check", appVersion]) { [weak self] result in
                guard let self else { return }
                if let error = result["error"] as? String {
                    self.updateStatus(error, busy: false)
                } else if let update = result["update"] as? [String: Any], let version = update["version"] as? String {
                    self.updateVersion = version
                    self.updateStatus("发现新版本 \(version)", busy: false)
                } else {
                    self.updateStatus("已是最新版本 \(self.appVersion)", busy: false)
                }
            }
        }
    }

    private func runUpdater(_ arguments: [String], completion: @escaping ([String: Any]) -> Void) {
        let process = Process(), output = Pipe()
        process.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/abridge-updater")
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = errorLog()
        updateProcess = process
        do { try process.run() } catch {
            updateProcess = nil
            completion(["error": "无法启动更新程序"]); return
        }
        DispatchQueue.global().async {
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let result = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? ["error": "更新程序异常，请查看日志"]
            DispatchQueue.main.async { [weak self] in
                self?.updateProcess = nil
                completion(result)
            }
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    private func loadConfig() {
        let location = stateDirectory.appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: location),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        urlField.stringValue = config["url"] as? String ?? urlField.stringValue
        httpConfirmedOrigin = config["http_confirmed_origin"] as? String
        let capabilities = config["capabilities"] as? [String: Bool] ?? [:]
        for (key, button) in capabilityButtons { button.state = capabilities[key] == true ? .on : .off }
        connectButton.title = "重新连接"
        unbindButton.isHidden = false
    }

    private func startDaemon() {
        guard !stoppingDaemon,
              boundServerAddress() != nil,
              daemon?.isRunning != true else { return }
        guard let process = runtimeProcess(arguments: clientArguments(["run"])) else {
            statusLabel.stringValue = "运行时文件缺失"
            environmentLabels["runtime"]?.stringValue = "未安装 / 路径失效"
            return
        }
        daemon = process
        let log = errorLog()
        let output = Pipe()
        process.standardOutput = output
        process.standardError = log
        do {
            try process.run()
            statusLabel.stringValue = "正在连接"
        } catch {
            daemon = nil
            statusLabel.stringValue = "无法启动设备客户端，请重新打开 aBridge。若再次失败，请检查 Mac 应用是否安装完整。"
            return
        }
        DispatchQueue.global().async { [weak self] in
            // run 只在退出失败时写一行回执。持续排空 stdout，仅保留末尾用于读取错误码。
            var tail = Data()
            while true {
                let chunk = output.fileHandleForReading.availableData
                if chunk.isEmpty { break }
                tail.append(chunk)
                if tail.count > 8192 { tail = Data(tail.suffix(8192)) }
            }
            process.waitUntilExit()
            let reply = tail.split(separator: 10).last.flatMap { try? JSONSerialization.jsonObject(with: Data($0)) as? [String: Any] }
            DispatchQueue.main.async { [weak self] in
                let exit = Self.exitMessage(process, name: "设备客户端")
                let failure = reply.flatMap(Self.clientFailure)
                try? log.write(contentsOf: Data(((failure.map { exit + "。" + $0 } ?? exit) + "\n").utf8))
                guard let self, self.daemon === process else { return }
                self.daemon = nil
                self.current["connection"] = "offline"
                if let failure { self.statusLabel.stringValue = failure }
                else if process.terminationStatus == 0 && self.boundServerAddress() == nil { self.statusLabel.stringValue = "尚未绑定这台 Mac" }
                else { self.statusLabel.stringValue = exit + "，可重新连接或查看运行日志。" }
                self.renderMenu()
            }
        }
    }

    private func stopDaemon(completion: (() -> Void)? = nil) {
        if let completion { daemonStopActions.append(completion) }
        guard !stoppingDaemon else { return }
        guard let process = daemon, process.isRunning else {
            daemon = nil
            let actions = daemonStopActions
            daemonStopActions.removeAll()
            actions.forEach { $0() }
            return
        }
        stoppingDaemon = true
        daemon = nil
        current["connection"] = "offline"
        process.terminate()
        Task { @MainActor in
            for _ in 0..<20 {
                if !process.isRunning { break }
                try? await Task.sleep(for: .milliseconds(100))
            }
            if process.isRunning { _ = Darwin.kill(process.processIdentifier, SIGKILL) }
            for _ in 0..<10 {
                if !process.isRunning { break }
                try? await Task.sleep(for: .milliseconds(100))
            }
            stoppingDaemon = false
            let actions = daemonStopActions
            daemonStopActions.removeAll()
            if process.isRunning {
                statusLabel.stringValue = "客户端未能停止，请查看日志"
                if updateBusy && updatePlan != nil { updateStatus("客户端未能停止，尚未安装更新", busy: false) }
            } else {
                actions.forEach { $0() }
            }
        }
    }

    private func runtimeProcess(arguments: [String]) -> Process? {
        guard let cli = runtime["cli_path"], cli.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: cli)
        else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: cli)
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: cli).deletingLastPathComponent()
        var environment = ProcessInfo.processInfo.environment
        environment["ABRIDGE_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        process.environment = environment
        return process
    }

    private func clientArguments(_ arguments: [String]) -> [String] {
        ["--state-dir", stateDirectory.path] + arguments
    }

    /// 只解析失败回执。成功的状态快照也有 error 字段，内容属于设备连接状态。
    private static func clientFailure(_ reply: [String: Any]) -> String? {
        guard reply["ok"] as? Bool == false else { return nil }
        let error = reply["error"] as? [String: Any]
        switch error?["code"] as? String {
        case "invalid_contract": return "无法读取 aBridge 随附的协议文件，请重新安装完整的 Mac 应用。"
        case "control_timeout": return "本机设备客户端响应超时。请先检查当前状态，再决定是否重试。"
        case "control_failed", "runtime_error": return "本机设备客户端未能完成操作，请打开「运行诊断」查看运行日志。"
        case "already_running": return "已有 aBridge 设备客户端正在运行，请检查是否同时打开了两份应用。"
        case "credential_permissions": return "本机绑定文件的所有者或权限不正确，请使用创建绑定的 macOS 账户打开 aBridge，并检查数据目录权限。"
        case "credential_invalid", "credential_mismatch", "configuration_invalid": return "本机绑定记录无效或与服务地址不匹配，请检查地址并重新绑定这台 Mac。"
        case "status_write_failed", "journal_failed": return "设备客户端无法保存本机状态，请检查磁盘可用空间和 aBridge 数据目录的写入权限。"
        case "invalid_url": return "本机绑定记录的服务地址无效或缺少 HTTP 确认，设备连接已停止。请检查已有的本机绑定配置。"
        case "device_offline", "rename_failed", "control_unavailable":
            if let message = error?["message"] as? String, !message.isEmpty { return message }
        default: break
        }
        return "本机设备客户端拒绝了请求，请检查当前连接并查看运行日志。"
    }

    private static func exitMessage(_ process: Process, name: String) -> String {
        process.terminationReason == .uncaughtSignal
            ? "\(name)被系统信号 \(process.terminationStatus) 中断"
            : "\(name)已退出（退出码 \(process.terminationStatus)）"
    }

    private func runClient(
        _ arguments: [String],
        completion: @escaping ([String: Any]) -> Void
    ) {
        // 状态每秒刷新，诊断保留用户最近一次本机控制的失败原因。
        let complete: ([String: Any]) -> Void = { result in
            if arguments.first == "control", !arguments.contains("--if-desktop-active") {
                self.lastControlFailure = result["ok"] as? Bool == true ? nil : result["error"] as? String
            }
            completion(result)
        }
        guard let process = runtimeProcess(arguments: clientArguments(arguments)) else {
            complete(["error": "找不到设备客户端，请重新安装完整的 Mac 应用。"])
            return
        }
        let output = Pipe()
        process.standardOutput = output
        process.standardError = errorLog()
        do { try process.run() } catch {
            complete(["error": "无法启动本机设备客户端，请重新打开 aBridge 后重试。"])
            return
        }
        DispatchQueue.global().async {
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let reply = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            DispatchQueue.main.async {
                if let reply, let failure = Self.clientFailure(reply) { complete(["error": failure]) }
                else if let reply, process.terminationStatus == 0 { complete(reply) }
                else { complete(["error": Self.exitMessage(process, name: "本机设备客户端") + "，未收到有效结果，请查看运行日志。"]) }
            }
        }
    }

    private func control(_ request: [String: Any]) {
        guard let command = request["command"] as? String else { return }
        var arguments = ["control", command]
        if command == "capability", let capability = request["capability"] as? String,
           let enabled = request["enabled"] as? Bool {
            arguments += ["--capability", capability, "--enabled", enabled ? "true" : "false"]
        }
        if command == "pause", request["if_desktop_active"] as? Bool == true {
            arguments.append("--if-desktop-active")
        }
        runClient(arguments) { [weak self] result in
            if result["ok"] as? Bool == true { self?.render(result) }
            else { self?.statusLabel.stringValue = result["error"] as? String ?? "本机控制暂不可用" }
        }
    }

    private func desktopInputIsActive() -> Bool {
        // Input may finish between UI polls; use the latest state, then let the
        // client check its live operations again before applying an automatic pause.
        let location = stateDirectory.appendingPathComponent("status.json")
        guard let data = try? Data(contentsOf: location),
              let latest = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return (latest["desktop_active_until"] as? Double ?? 0) > Date().timeIntervalSince1970
    }

    private func poll() {
        guard !stoppingDaemon else { return }
        guard daemon?.isRunning == true else {
            if daemon != nil { statusLabel.stringValue = "客户端已退出，可重试连接或查看诊断" }
            renderMenu()
            return
        }
        let location = stateDirectory.appendingPathComponent("status.json")
        if let data = try? Data(contentsOf: location),
           let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            render(status)
        }
    }

    @objc private func checkEnvironment() {
        guard !checkingEnvironment, !stoppingDaemon else { return }
        checkingEnvironment = true
        if daemon?.isRunning == true {
            runClient(["control", "status"]) { [weak self] result in
                guard let self else { return }
                self.checkingEnvironment = false
                if result["ok"] as? Bool == true { self.render(result) }
                else { self.statusLabel.stringValue = result["error"] as? String ?? "环境检查失败" }
            }
        } else {
            runClient(["diagnose", "--json"]) { [weak self] result in
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
        let deviceId = status["device_id"] as? String ?? ""
        if !deviceId.isEmpty && deviceId != renderedDeviceId {
            renderedDeviceId = deviceId
            deviceNameDirty = false
            deviceNameMessage.isHidden = true
        }
        if !deviceNameDirty && !savingDeviceName {
            let assignedName = status["device_name"] as? String ?? ""
            deviceNameField.stringValue = assignedName.isEmpty
                ? String((Host.current().localizedName ?? ProcessInfo.processInfo.hostName).prefix(80))
                : assignedName
        }
        let paused = status["paused"] as? Bool == true
        let connection = status["connection"] as? String ?? "offline"
        let active = status["active_operations"] as? Int ?? 0
        let controllers = status["active_controllers"] as? [String] ?? []
        if paused {
            statusLabel.stringValue = status["pause_reason"] as? String == "desktop_input"
                ? "本机输入触发暂停"
                : "已暂停"
        } else if active > 0 {
            statusLabel.stringValue = "\(controllers.isEmpty ? "Agent" : controllers.joined(separator: "、")) 正在执行 \(active) 项操作"
        } else if connection == "online" {
            statusLabel.stringValue = "已连接 \(status["owner_name"] as? String ?? "")"
        } else {
            statusLabel.stringValue = connection == "connecting" ? "正在连接" : "连接已断开"
        }
        if connection == "revoked" && authorizationProcess != nil {
            statusLabel.stringValue = "正在重新绑定这台 Mac"
        } else if let error = status["error"] as? String, !error.isEmpty {
            statusLabel.stringValue = error
        } else if connection == "revoked" {
            statusLabel.stringValue = "设备授权已失效，请重新绑定这台 Mac。"
        }
        let pauseTitle = paused ? "恢复访问" : "暂停访问"
        pauseItem.title = pauseTitle
        pauseButton.title = pauseTitle
        pauseButton.isEnabled = daemon?.isRunning == true && !stoppingDaemon
        let requested = status["requested_capabilities"] as? [String: Bool] ?? [:]
        for (key, button) in capabilityButtons { button.state = requested[key] == true ? .on : .off }
        renderEnvironment(status)
        renderMenu()
    }

    private func renderEnvironment(_ report: [String: Any]) {
        guard !report.isEmpty else { return }
        let native = report["runtime"] as? [String: Any] ?? [:]
        let version = native["version"] as? String ?? appVersion
        environmentLabels["runtime"]?.stringValue = native["ready"] as? Bool == true
            ? "\(version) · 已就绪" : "原生客户端不可用"
        let driver = report["driver"] as? [String: Any] ?? [:]
        if driver["installed"] == nil {
            environmentLabels["driver"]?.stringValue = "尚未检查"
        } else if driver["installed"] as? Bool != true {
            environmentLabels["driver"]?.stringValue = "未安装"
        } else if driver["ready"] as? Bool == true {
            environmentLabels["driver"]?.stringValue = "\(driver["version"] as? String ?? "") · 内嵌已就绪"
        } else {
            environmentLabels["driver"]?.stringValue = "已安装，尚未就绪"
            environmentLabels["driver"]?.toolTip = driver["error"] as? String
        }
        let permissionReport = report["permissions"] as? [String: Any] ?? current["permissions"] as? [String: Any] ?? [:]
        // App authorization and SDK execution readiness are different facts.
        // Native preflight probes never request or reset system permissions.
        let appPermissions = permissions()
        let checked = permissionReport["checked"] as? Bool == true
        let missing = [("screen", "屏幕"), ("input", "键鼠")]
            .filter { permissionReport[$0.0] as? Bool != true }.map { $0.1 }
        environmentLabels["execution"]?.stringValue = !checked
            ? "尚未检查" : missing.isEmpty ? "已就绪" : "\(missing.joined(separator: "、"))未就绪"
        environmentLabels["execution"]?.toolTip = !checked ? "驱动执行权限尚未检查"
            : missing.isEmpty ? "驱动屏幕与键鼠执行权限均已就绪" : "驱动\(missing.joined(separator: "、"))执行权限尚未就绪"
        for key in ["screen", "input"] {
            let allowed = appPermissions[key] as? Bool == true
            permissionButtons[key]?.isEnabled = !allowed
            permissionButtons[key]?.isHidden = allowed
            environmentLabels[key]?.stringValue = allowed ? "已允许" : "未允许"
            environmentLabels[key]?.toolTip = allowed
                ? "实际安装的 aBridge 已获系统授权；驱动执行状态见运行诊断"
                : "请在系统设置中允许实际安装的 aBridge"
        }

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
