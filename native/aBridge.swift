import AppKit
import ApplicationServices
import CoreGraphics
import ScreenCaptureKit
import Security

let bridgeEventTag: Int64 = 0x61427269646765

// One executable owns the menu bar, privacy permissions, desktop adapter and Keychain.
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

func activeWindow() -> [String: Any] {
    guard let app = NSWorkspace.shared.frontmostApplication else { return [:] }
    var result: [String: Any] = ["pid": Int(app.processIdentifier), "application": app.localizedName ?? "", "bundle_id": app.bundleIdentifier ?? ""]
    if AXIsProcessTrusted() {
        let application = AXUIElementCreateApplication(app.processIdentifier)
        var windowValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &windowValue) == .success, let windowValue {
            let window = unsafeBitCast(windowValue, to: AXUIElement.self)
            var title: CFTypeRef?
            if AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &title) == .success {
                result["title"] = title as? String ?? ""
            }
        }
    }
    return result
}

@available(macOS 14.0, *)
func observe() async throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else { return failure("screen_permission_missing", "Enable screen recording for aBridge in System Settings") }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
        return failure("display_unavailable", "The main display is unavailable")
    }
    let bounds = CGDisplayBounds(display.displayID)
    let config = SCStreamConfiguration()
    let pixelWidth = Int(CGDisplayPixelsWide(display.displayID))
    let pixelHeight = Int(CGDisplayPixelsHigh(display.displayID))
    config.width = min(pixelWidth, 1920)
    config.height = max(1, pixelHeight * config.width / pixelWidth)
    config.showsCursor = true
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        return failure("capture_failed", "Screenshot encoding failed")
    }
    return ["image_base64": png.base64EncodedString(), "mime_type": "image/png", "width": image.width, "height": image.height,
            "display_id": display.displayID, "bounds": ["x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height],
            "scale": Double(image.width) / bounds.width, "window": activeWindow(), "coordinate_space": "screenshot_pixels", "available_displays": content.displays.count]
}

func act(_ request: [String: Any]) -> [String: Any] {
    guard AXIsProcessTrusted() else { return failure("input_permission_missing", "Enable Accessibility for aBridge in System Settings") }
    guard let observation = request["observation"] as? [String: Any], let action = request["input"] as? [String: Any], let kind = action["type"] as? String else {
        return failure("invalid_arguments", "An observation and action are required")
    }
    let window = observation["window"] as? [String: Any] ?? [:]
    let currentWindow = activeWindow()
    if let observedPID = window["pid"] as? Int, observedPID != currentWindow["pid"] as? Int {
        return failure("focus_changed", "The foreground application changed; observe again")
    }
    if let oldTitle = window["title"] as? String, let newTitle = currentWindow["title"] as? String, oldTitle != newTitle {
        return failure("focus_changed", "The foreground window changed; observe again")
    }
    guard let source = CGEventSource(stateID: .hidSystemState) else { return failure("input_unavailable", "Cannot create an input source") }
    let modifiers: [String]
    if let supplied = action["modifiers"] {
        guard let names = supplied as? [String] else { return failure("invalid_arguments", "modifiers must be an array of supported key names") }
        modifiers = names
    } else { modifiers = [] }
    guard let flags = modifierFlags(modifiers) else { return failure("invalid_arguments", "Unsupported modifier name") }
    let buttonName: String
    if let supplied = action["button"] {
        guard let name = supplied as? String, ["left", "right"].contains(name) else { return failure("invalid_arguments", "button must be left or right") }
        buttonName = name
    } else { buttonName = "left" }
    switch kind {
    case "click", "double_click", "move", "drag":
        guard let point = coordinate(action, observation: observation, xKey: "x", yKey: "y") else {
            return failure("invalid_coordinates", "Coordinates must lie inside the observed screenshot")
        }
        let right = buttonName == "right"
        let button: CGMouseButton = right ? .right : .left
        if kind == "move" {
            postMouse(source, .mouseMoved, point, button, flags, 0)
        } else if kind == "drag" {
            guard buttonName == "left" else { return failure("invalid_arguments", "Dragging supports only the left mouse button") }
            guard let target = coordinate(action, observation: observation, xKey: "to_x", yKey: "to_y") else {
                return failure("invalid_coordinates", "The drag target must lie inside the observed screenshot")
            }
            postMouse(source, .leftMouseDown, point, .left, flags, 1)
            postMouse(source, .leftMouseDragged, target, .left, flags, 1)
            postMouse(source, .leftMouseUp, target, .left, flags, 1)
        } else {
            let count = kind == "double_click" ? 2 : 1
            for click in 1...count {
                postMouse(source, right ? .rightMouseDown : .leftMouseDown, point, button, flags, Int64(click))
                postMouse(source, right ? .rightMouseUp : .leftMouseUp, point, button, flags, Int64(click))
            }
        }
    case "scroll":
        for key in ["delta_y", "delta_x"] {
            if let value = action[key] {
                guard let number = value as? NSNumber,
                      CFGetTypeID(number) != CFBooleanGetTypeID(),
                      ["c", "s", "i", "l", "q", "C", "S", "I", "L", "Q"].contains(String(cString: number.objCType)),
                      value is Int else {
                    return failure("invalid_arguments", "Scroll deltas must be integers")
                }
            }
        }
        let dy = action["delta_y"] as? Int ?? 0
        let dx = action["delta_x"] as? Int ?? 0
        guard dy >= -10_000 && dy <= 10_000 && dx >= -10_000 && dx <= 10_000 else { return failure("invalid_arguments", "Scroll delta is too large") }
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else {
            return failure("input_failed", "Cannot create a scroll event")
        }
        event.flags = flags
        event.setIntegerValueField(.eventSourceUserData, value: bridgeEventTag)
        event.post(tap: .cghidEventTap)
    case "key":
        guard let key = action["key"] as? String, let code = keyCodes[key.lowercased()] else {
            return failure("invalid_arguments", "Unsupported key name")
        }
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: down)
            event?.flags = flags
            event?.setIntegerValueField(.eventSourceUserData, value: bridgeEventTag)
            event?.post(tap: .cghidEventTap)
        }
    case "type":
        guard let text = action["text"] as? String, text.utf16.count <= 10_000 else {
            return failure("invalid_arguments", "Text must contain at most 10000 UTF-16 units")
        }
        // Unicode events do not replace the clipboard or depend on the active IME.
        let allUnits = Array(text.utf16)
        for chunk in stride(from: 0, to: allUnits.count, by: 100) {
            let units = Array(allUnits[chunk..<min(chunk + 100, allUnits.count)])
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                units.withUnsafeBufferPointer { pointer in event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: pointer.baseAddress!) }
                event?.setIntegerValueField(.eventSourceUserData, value: bridgeEventTag)
                event?.post(tap: .cghidEventTap)
            }
        }
    default:
        return failure("invalid_arguments", "Unsupported input action")
    }
    return ["executed": true, "action": kind, "business_verified": false]
}

func coordinate(_ action: [String: Any], observation: [String: Any], xKey: String, yKey: String) -> CGPoint? {
    guard let x = action[xKey] as? Double, let y = action[yKey] as? Double, let width = observation["width"] as? Double, let height = observation["height"] as? Double,
          let bounds = observation["bounds"] as? [String: Double], let originX = bounds["x"], let originY = bounds["y"], let logicalWidth = bounds["width"], let logicalHeight = bounds["height"],
          x.isFinite, y.isFinite, x >= 0, y >= 0, x < width, y < height else { return nil }
    return CGPoint(x: originX + x * logicalWidth / width, y: originY + y * logicalHeight / height)
}

func postMouse(_ source: CGEventSource, _ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, _ flags: CGEventFlags, _ count: Int64) {
    let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
    event?.flags = flags
    event?.setIntegerValueField(.eventSourceUserData, value: bridgeEventTag)
    event?.setIntegerValueField(.mouseEventClickState, value: count)
    event?.post(tap: .cghidEventTap)
}

func modifierFlags(_ names: [String]) -> CGEventFlags? {
    var flags: CGEventFlags = []
    for name in names {
        switch name.lowercased() {
        case "command", "cmd", "meta": flags.insert(.maskCommand)
        case "control", "ctrl": flags.insert(.maskControl)
        case "option", "alt": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: return nil
        }
    }
    return flags
}

let keyCodes: [String: Int] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,
    "]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"return":36,"enter":36,"l":37,"j":38,"'":39,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47,"tab":48,"space":49,"`":50,"backspace":51,"delete":51,"escape":53,"esc":53,"home":115,"pageup":116,"end":119,"pagedown":121,"left":123,"right":124,"down":125,"up":126]

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
    private var urlField = NSTextField(string: "http://127.0.0.1:8765")
    private var keyField = NSSecureTextField(string: "")
    private var statusLabel = NSTextField(labelWithString: "尚未连接")
    private var permissionLabel = NSTextField(labelWithString: "")
    private var buttons: [String: NSButton] = [:]
    private var pauseItem: NSMenuItem!
    private var daemon: Process?
    private var runtime: [String: String] = [:]
    private var current: [String: Any] = [:]
    private var polling = false
    private var monitor: Any?
    private let stateDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/aBridge")

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        if let path = Bundle.main.url(forResource: "runtime", withExtension: "json"), let data = try? Data(contentsOf: path), let value = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            runtime = value
        }
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
        buildWindow()
        loadConfig()
        startDaemon()
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in Task { @MainActor in self?.poll() } }
        // Tag our input explicitly; an event-source PID is not a hardware contract.
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .mouseMoved, .keyDown]) { [weak self] event in
            guard event.cgEvent?.getIntegerValueField(.eventSourceUserData) != bridgeEventTag else { return }
            Task { @MainActor in
                guard let self, (self.current["desktop_active_until"] as? Double ?? 0) > Date().timeIntervalSince1970 else { return }
                self.control(["command": "pause"])
            }
        }
        if !FileManager.default.fileExists(atPath: stateDirectory.appendingPathComponent("config.json").path) { showWindow() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let daemon, daemon.isRunning {
            daemon.terminate()
            daemon.waitUntilExit()
        }
        if let monitor { NSEvent.removeMonitor(monitor) }
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 452, height: 460), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "aBridge"
        window.center()
        window.isReleasedWhenClosed = false
        window.delegate = self
        let root = NSStackView()
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 15
        root.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(root)
        NSLayoutConstraint.activate([root.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 28), root.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -28), root.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 26)])
        let title = NSTextField(labelWithString: "连接这台 Mac")
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        root.addArrangedSubview(title)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 2
        root.addArrangedSubview(statusLabel)
        for (label, field) in [("服务地址", urlField), ("设备 Key", keyField)] {
            let group = NSStackView(views: [NSTextField(labelWithString: label), field])
            group.orientation = .vertical
            group.alignment = .leading
            group.spacing = 5
            field.placeholderString = label == "设备 Key" ? "粘贴管理台生成的设备 Key" : "https://…"
            field.widthAnchor.constraint(equalToConstant: 396).isActive = true
            root.addArrangedSubview(group)
        }
        let capRow = NSStackView()
        capRow.orientation = .horizontal
        capRow.spacing = 20
        for (key, title) in [("screen", "截图"), ("input", "桌面输入"), ("shell", "Shell"), ("files", "文件")] {
            let button = NSButton(checkboxWithTitle: title, target: self, action: #selector(capabilityChanged(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(key)
            buttons[key] = button
            capRow.addArrangedSubview(button)
        }
        root.addArrangedSubview(capRow)
        let access = NSTextField(wrappingLabelWithString: "启用后，已授权的 Agent 可持续使用这些能力，权限限于当前 macOS 用户。")
        access.font = .systemFont(ofSize: 12)
        access.textColor = .secondaryLabelColor
        root.addArrangedSubview(access)
        let connect = NSButton(title: "连接", target: self, action: #selector(connect))
        connect.bezelStyle = .rounded
        connect.keyEquivalent = "\r"
        connect.contentTintColor = NSColor(calibratedRed: 0, green: 0.39, blue: 0.88, alpha: 1)
        let unbind = NSButton(title: "解除绑定", target: self, action: #selector(unbindDevice))
        unbind.bezelStyle = .rounded
        root.addArrangedSubview(NSStackView(views: [connect, unbind]))
        let separator = NSBox()
        separator.boxType = .separator
        root.addArrangedSubview(separator)
        permissionLabel.font = .systemFont(ofSize: 12)
        permissionLabel.textColor = .secondaryLabelColor
        root.addArrangedSubview(permissionLabel)
        let screen = NSButton(title: "屏幕录制权限", target: self, action: #selector(requestScreen))
        let input = NSButton(title: "辅助功能权限", target: self, action: #selector(requestInput))
        screen.bezelStyle = .rounded
        input.bezelStyle = .rounded
        root.addArrangedSubview(NSStackView(views: [screen, input]))
    }

    @objc func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }

    @objc private func connect() {
        guard !keyField.stringValue.isEmpty else { statusLabel.stringValue = "请输入设备 Key"; return }
        daemon?.terminate()
        daemon?.waitUntilExit()
        let capabilities = buttons.mapValues { $0.state == .on }
        runClient(["configure", "--stdin"], input: ["url": urlField.stringValue, "device_key": keyField.stringValue, "capabilities": capabilities]) { [weak self] result in
            guard let self else { return }
            if result["ok"] as? Bool == true {
                self.keyField.stringValue = ""
                self.startDaemon()
            } else { self.statusLabel.stringValue = result["error"] as? String ?? "连接配置失败" }
        }
    }

    @objc private func togglePause() { control(["command": (current["paused"] as? Bool == true) ? "resume" : "pause"]) }
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

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func loadConfig() {
        guard let data = try? Data(contentsOf: stateDirectory.appendingPathComponent("config.json")), let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        urlField.stringValue = config["url"] as? String ?? urlField.stringValue
        let caps = config["capabilities"] as? [String: Bool] ?? [:]
        for (key, button) in buttons { button.state = caps[key] == true ? .on : .off }
    }

    private func startDaemon() {
        guard FileManager.default.fileExists(atPath: stateDirectory.appendingPathComponent("config.json").path), daemon?.isRunning != true else { return }
        guard let process = clientProcess(["run"]) else { statusLabel.stringValue = "客户端运行环境未配置"; return }
        daemon = process
        do { try process.run() } catch { statusLabel.stringValue = "无法启动设备连接" }
    }

    private func clientProcess(_ arguments: [String]) -> Process? {
        guard let python = runtime["python_path"], let project = runtime["project_path"] else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = ["-m", "abridge.client", "--helper", Bundle.main.executablePath!, "--state-dir", stateDirectory.path] + arguments
        process.currentDirectoryURL = URL(fileURLWithPath: project)
        var environment = ProcessInfo.processInfo.environment
        environment["PYTHONPATH"] = project
        environment["ABRIDGE_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        process.environment = environment
        process.standardError = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        return process
    }

    private func runClient(_ arguments: [String], input: [String: Any]? = nil, completion: @escaping ([String: Any]) -> Void) {
        guard let process = clientProcess(arguments) else { completion(["error": "客户端运行环境未配置"]); return }
        let output = Pipe()
        process.standardOutput = output
        if let input, let data = try? JSONSerialization.data(withJSONObject: input) {
            let pipe = Pipe()
            process.standardInput = pipe
            do { try process.run() } catch { completion(["error": "无法启动设备连接"]); return }
            pipe.fileHandleForWriting.write(data)
            try? pipe.fileHandleForWriting.close()
        } else {
            do { try process.run() } catch { completion(["error": "无法启动设备连接"]); return }
        }
        DispatchQueue.global().async {
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let result = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? ["error": "客户端没有返回有效状态"]
            DispatchQueue.main.async { completion(result) }
        }
    }

    private func control(_ request: [String: Any]) {
        guard let command = request["command"] as? String else { return }
        var arguments = ["control", command]
        if command == "capability", let capability = request["capability"] as? String, let enabled = request["enabled"] as? Bool {
            arguments += ["--capability", capability, "--enabled", enabled ? "true" : "false"]
        }
        runClient(arguments) { [weak self] result in
            if result["ok"] as? Bool == true { self?.render(result) }
            else { self?.statusLabel.stringValue = result["error"] as? String ?? "本机控制暂不可用" }
        }
    }

    private func poll() {
        guard !polling else { return }
        polling = true
        runClient(["control", "status"]) { [weak self] result in
            guard let self else { return }
            self.polling = false
            if result["ok"] as? Bool == true { self.render(result) }
            else if self.daemon?.isRunning != true { self.statusLabel.stringValue = "尚未连接" }
        }
    }

    private func render(_ status: [String: Any]) {
        current = status
        let paused = status["paused"] as? Bool == true
        let state = status["connection"] as? String ?? "offline"
        let active = status["active_operations"] as? [String] ?? []
        let controllers = status["active_controllers"] as? [String] ?? []
        let labels = ["online": "已连接", "connecting": "正在连接", "offline": "连接已断开", "revoked": "设备 Key 已失效"]
        if paused {
            statusLabel.stringValue = "已暂停，需在本机恢复"
        } else if !active.isEmpty {
            let controller = controllers.isEmpty ? "Agent" : controllers.joined(separator: "、")
            statusLabel.stringValue = "\(controller) 正在执行 \(active.count) 项操作"
        } else if state == "online", let owner = status["owner_name"] as? String, !owner.isEmpty {
            statusLabel.stringValue = "已连接 \(owner)"
        } else {
            statusLabel.stringValue = labels[state] ?? state
        }
        if let error = status["error"] as? String, !error.isEmpty { statusLabel.stringValue = error }
        pauseItem.title = paused ? "恢复访问" : "暂停访问"
        item.button?.title = paused ? "aB ‖" : (active.isEmpty ? "aB" : "aB ●")
        let allowed = status["permissions"] as? [String: Bool] ?? [:]
        permissionLabel.stringValue = "屏幕录制：\(allowed["screen"] == true ? "已允许" : "未允许")    辅助功能：\(allowed["input"] == true ? "已允许" : "未允许")"
        let requested = status["requested_capabilities"] as? [String: Bool] ?? [:]
        for (key, button) in buttons { button.state = requested[key] == true ? .on : .off }
    }
}

if CommandLine.arguments.contains("--helper") {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let request = try? JSONSerialization.jsonObject(with: input) as? [String: Any], let action = request["action"] as? String else {
        response(failure("invalid_arguments", "Expected a JSON request"))
        exit(0)
    }
    if action == "observe" {
        if #available(macOS 14.0, *) {
            Task { @MainActor in
                do { response(try await observe()) }
                catch { response(failure("capture_failed", error.localizedDescription)) }
                exit(0)
            }
            dispatchMain()
        } else { response(failure("unsupported_macos", "Desktop capture requires macOS 14 or newer")) }
    } else if action == "act" { response(act(request)) }
    else if action == "permissions" { response(permissions()) }
    else if action == "release_inputs" {
        if AXIsProcessTrusted(), let source = CGEventSource(stateID: .hidSystemState) {
            for code in Set(keyCodes.values).union([54, 55, 56, 57, 58, 59, 60, 61, 62]) {
                let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: false)
                event?.setIntegerValueField(.eventSourceUserData, value: bridgeEventTag)
                event?.post(tap: .cghidEventTap)
            }
            let point = CGEvent(source: nil)?.location ?? .zero
            postMouse(source, .leftMouseUp, point, .left, [], 0)
            postMouse(source, .rightMouseUp, point, .right, [], 0)
        }
        response(["ok": true])
    }
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
