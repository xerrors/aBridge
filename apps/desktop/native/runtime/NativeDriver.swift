import Foundation
import AppKit
import ApplicationServices
import Darwin
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

protocol DesktopNativeDriver: Sendable {
    func diagnostics(initialize: Bool) async -> JSONObject
    func apps() async throws -> [JSONObject]
    func windows(pid: Double?) async throws -> [JSONObject]
    func visibleWindows(pid: Double) async throws -> [JSONObject]
    func focusedWindow(pid: Double, candidates: [JSONObject]) async throws -> Double?
    func mainWindow(pid: Double, candidates: [JSONObject]) async throws -> Double?
    func open(bundleID: String) async throws
    func observe(session: String, target: JSONObject, screenshot: Bool) async throws -> JSONObject
    func act(session: String, action: JSONObject) async throws -> JSONObject
    func release(session: String) async
    func shutdown() async
}

extension DesktopNativeDriver {
    func visibleWindows(pid: Double) async throws -> [JSONObject] {
        try await windows(pid: pid).filter { $0.number("pid") == pid && $0.bool("is_on_screen") == true }
    }
    func mainWindow(pid: Double, candidates: [JSONObject]) async throws -> Double? { nil }
}

private func consumeDriverBuffer(_ buffer: inout CuaDriverBuffer) -> Data {
    defer { cua_driver_buffer_free_v1(&buffer) }
    guard let p = buffer.data else { return Data() }
    return Data(bytes: p, count: buffer.len)
}

/// Owns the callback and operation token across cancellation and a synchronous callback race.
private final class DriverOperation: @unchecked Sendable {
    private let lock = NSLock()
    private var operation: OpaquePointer?
    private var installed = false
    private var completed = false
    private var cancelled = false
    private var timedOut = false
    private var continuation: CheckedContinuation<Data, Error>?
    func begin(_ continuation: CheckedContinuation<Data, Error>) -> Bool {
        lock.lock()
        if cancelled {
            completed = true; let timeout = timedOut; lock.unlock()
            continuation.resume(throwing: timeout ? DesktopError(code: "driver_timeout", message: "Desktop driver operation timed out", outcome: "outcome_unknown") : CancellationError())
            return false
        }
        self.continuation = continuation; lock.unlock(); return true
    }
    func install(_ value: OpaquePointer?) {
        lock.lock(); installed = true; operation = value
        if cancelled, let operation { cua_driver_operation_cancel_v1(operation) }
        if completed { cua_driver_operation_release_v1(&operation) }
        lock.unlock()
    }
    func cancel(timeout: Bool = false) {
        lock.lock(); cancelled = true; timedOut = timedOut || timeout
        if let operation { cua_driver_operation_cancel_v1(operation) }; lock.unlock()
    }
    func finish(status: Int32, result: Data, error: Data) {
        lock.lock()
        guard !completed else { lock.unlock(); return }
        completed = true
        let continuation = self.continuation; self.continuation = nil
        let cancelled = cancelled, timedOut = timedOut
        if installed { cua_driver_operation_release_v1(&operation) }
        lock.unlock()
        if timedOut { continuation?.resume(throwing: DesktopError(code: "driver_timeout", message: "Desktop driver operation timed out", outcome: "outcome_unknown")) }
        else if cancelled { continuation?.resume(throwing: CancellationError()) }
        else if status != 0 {
            continuation?.resume(throwing: DesktopError(code: "driver_error", message: "Desktop driver operation failed", outcome: "outcome_unknown"))
        } else { continuation?.resume(returning: result) }
    }
}
private let nativeDriverCompletion: CuaDriverCompletionV1 = { context, status, result, error in
    guard let context else { return }
    let operation = Unmanaged<DriverOperation>.fromOpaque(context).takeRetainedValue()
    var result = result, error = error
    operation.finish(status: status, result: consumeDriverBuffer(&result), error: consumeDriverBuffer(&error))
}

// Keep borrowed C pointers in one synchronous, nonisolated scope. The nested
// buffer closures capture no actor state and keep their bytes alive through entry.
private func startDriverOperation(_ driver: OpaquePointer?, nameBytes: [UInt8], arguments: Data, operation: DriverOperation) {
    let context = Unmanaged.passRetained(operation).toOpaque()
    var token: OpaquePointer?, error = CuaDriverBuffer()
    let status = nameBytes.withUnsafeBufferPointer { nameBuffer in
        arguments.withUnsafeBytes { argBuffer in
            cua_driver_invoke_v1(driver, nameBuffer.baseAddress, nameBuffer.count, argBuffer.bindMemory(to: UInt8.self).baseAddress, argBuffer.count, nativeDriverCompletion, context, &token, &error)
        }
    }
    let errorData = consumeDriverBuffer(&error)
    operation.install(token)
    if status != 0 {
        Unmanaged<DriverOperation>.fromOpaque(context).release()
        operation.finish(status: status, result: Data(), error: errorData)
    }
}

actor NativeDriver: DesktopNativeDriver {
    private struct ScreenWindow {
        let id: Double
        let pid: Double
        let frame: CGRect
        let layer: Int32?
        let transparent: Bool
        let app: String?
        let title: String?

        init?(_ entry: [String: Any]) {
            guard let id = entry[kCGWindowNumber as String] as? NSNumber,
                  let owner = entry[kCGWindowOwnerPID as String] as? NSNumber,
                  let bounds = entry[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
            self.id = id.doubleValue
            pid = owner.doubleValue
            self.frame = frame
            layer = (entry[kCGWindowLayer as String] as? NSNumber)?.int32Value
            transparent = (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue == 0
            app = entry[kCGWindowOwnerName as String] as? String
            title = entry[kCGWindowName as String] as? String
        }

        func diagnostic(includeTitle: Bool) -> JSONObject {
            var result: JSONObject = ["window_id": .number(id), "pid": .number(pid)]
            if let app { result["app_name"] = .string(String(decoding: app.utf16.prefix(120), as: UTF16.self)) }
            if includeTitle, let title { result["title"] = .string(String(decoding: title.utf16.prefix(120), as: UTF16.self)) }
            return result
        }
    }

    private struct SiblingCover: Equatable {
        let id: Double
        let frame: CGRect
    }

    private struct WindowInput {
        let target: JSONObject
        let wasVisible: Bool
        let covers: [SiblingCover]
        let captureCovers: [SiblingCover]
        let focusedWindow: AXUIElement?
        let focusedControl: AXUIElement?
        let editable: Bool
    }

    private var driver: OpaquePointer?
    private var closed = false
    private enum SessionState { case observing, observed }
    private var sessions: [String: SessionState] = [:]
    private var windowInputs: [String: WindowInput] = [:]
    private var operations: [UUID: DriverOperation] = [:]
    private var lastDiagnostics: JSONObject = ["driver": .object(["loaded": .bool(false), "ready": .bool(false)]), "permissions": .object(["checked": .bool(false), "screen": .bool(false), "input": .bool(false)])]

    static func smoke() async throws -> JSONObject {
        let driver = NativeDriver()
        do {
            let result = try await driver.smokeCheck()
            await driver.shutdown()
            return result
        } catch { await driver.shutdown(); throw error }
    }
    private func smokeCheck() async throws -> JSONObject {
        try ready()
        var inventory = CuaDriverBuffer(), error = CuaDriverBuffer()
        let status = cua_driver_list_tools_json_v1(driver, &inventory, &error)
        _ = consumeDriverBuffer(&error)
        guard status == 0, let tools = try JSONValue.decode(consumeDriverBuffer(&inventory)).object?.array("tools"), !tools.isEmpty else {
            throw DesktopError(code: "driver_unavailable", message: "Desktop driver tool inventory unavailable")
        }
        _ = try await invoke("list_sessions", [:])
        // This check invokes only inventory and session listing, never input or TCC requests.
        return ["embedded": .bool(true), "desktop_actions": .number(0), "authorizations": .number(0), "sdk_version": .string("0.47.8"), "tools": .number(Double(tools.count))]
    }

    private func ready() throws {
        guard !closed else { throw DesktopError(code: "driver_closed", message: "Desktop driver is closed") }
        if driver != nil { return }
        guard cua_driver_abi_is_compatible_v1(1, 1) else { throw DesktopError(code: "driver_unavailable", message: "Unsupported desktop driver ABI") }
        let options: JSONObject = ["claude_code_compatibility": .bool(false), "authorization": .object(["allowed_modes": .array([.string("standard")]), "compatibility_mode": .string("standard"), "unrestricted_acknowledged": .bool(false), "max_session_ttl_seconds": .number(28800), "max_idle_ttl_seconds": .number(1800)])]
        let data = try options.encoded()
        var error = CuaDriverBuffer(), created: OpaquePointer?
        let status = data.withUnsafeBytes { cua_driver_create_v1($0.bindMemory(to: UInt8.self).baseAddress, $0.count, &created, &error) }
        driver = created
        _ = consumeDriverBuffer(&error)
        guard status == 0, driver != nil else { throw DesktopError(code: "driver_unavailable", message: "Desktop driver unavailable") }
        var metadata = CuaDriverBuffer()
        let metadataStatus = cua_driver_metadata_json_v1(driver, &metadata, &error)
        _ = consumeDriverBuffer(&error)
        let info = try? JSONValue.decode(consumeDriverBuffer(&metadata)).object
        guard metadataStatus == 0, info?.bool("embedded") == true, info?.number("pid") == Double(getpid()), info?.string("driver_version") == "0.47.8" else {
            cua_driver_destroy_v1(&driver)
            throw DesktopError(code: "driver_unavailable", message: "Desktop driver must run embedded in this process")
        }
    }
    func invoke(_ name: String, _ arguments: JSONObject, timeout: Double = 30000) async throws -> JSONObject {
        try Task.checkCancellation(); try ready()
        let id = UUID(), operation = DriverOperation()
        operations[id] = operation
        defer { operations.removeValue(forKey: id) }
        let args = try arguments.encoded(), nameBytes = Array(name.utf8)
        let timer = Task { try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000)); if !Task.isCancelled { operation.cancel(timeout: true) } }
        defer { timer.cancel() }
        let data = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard operation.begin(continuation) else { return }
                startDriverOperation(driver, nameBytes: nameBytes, arguments: args, operation: operation)
            }
        } onCancel: { operation.cancel() }
        try Task.checkCancellation()
        return try Self.decodeReply(data)
    }
    nonisolated static func decodeReply(_ data: Data) throws -> JSONObject {
        guard let result = try JSONValue.decode(data).object else { throw DesktopError(code: "driver_error", message: "Invalid desktop driver response", outcome: "outcome_unknown") }
        if result.bool("isError") == true || result.bool("is_error") == true {
            let structured = result.object("structuredContent") ?? [:]
            let nestedRefusal = structured.object("refusal")?.string("code")
            let rawCode = structured.string("code") ?? nestedRefusal ?? structured.object("error")?.string("code") ?? result.string("errorCode")
            let code = rawCode.flatMap { value in
                value.utf8.count <= 64 && value.wholeMatch(of: /[a-z][a-z0-9_]*/) != nil ? value : nil
            } ?? "outcome_unknown"
            let recovery = actionRecovery(code)
            let known = ["action_refused", "permission_denied", "permission_required", "accessibility_permission_required", "screen_recording_permission_required", "invalid_arguments", "session_not_found", "session_closed", "unsupported"]
            let explicitRefusal = structured.string("effect") == "refused" ||
                (structured.string("status") == "refused" && nestedRefusal == code && structured["effect"] == nil)
            let refused = code != "outcome_unknown" && (explicitRefusal || recovery != nil || known.contains(code))
            throw DesktopError(code: code, message: recovery ?? "Desktop driver could not complete the requested operation", outcome: refused ? "refused" : "outcome_unknown", hint: recovery)
        }
        return result
    }
    nonisolated static func actionRecovery(_ code: String) -> String? {
        switch code {
        case "stale_capture", "capture_id_invalid", "capture_not_found", "capture_expired", "capture_generation_mismatch", "capture_target_mismatch", "capture_frame_mismatch", "capture_coordinate_invalid", "px_capture_unavailable", "px_frame_mismatch":
            return "Refresh the same window with computer_observe and use coordinates from the new screenshot."
        case "stale_element", "stale_element_token", "element_outside_target_window":
            return "Refresh the same window with computer_observe and use an element_ref from the new observation."
        case "target_not_found", "window_not_found", "window_id_not_found", "window_owner_pid_mismatch", "owner_pid_mismatch", "px_window_not_found":
            return "Use computer_windows to find the intended window, then observe it again."
        case "off_space_or_ax_unresolved", "minimized_or_hidden_window":
            return "Make the intended window available on the current space, then observe it again."
        case "screen_locked":
            return "Unlock the Mac and refresh the same target."
        case "same_pid_keyboard_ambiguity":
            return "Use a supported element action in the intended window."
        case "window_not_key":
            return "Observe the window that currently receives keyboard input."
        case "no_focused_text_input":
            return "Focus an editable control and refresh the observation, or use a supported element reference."
        case "session_ended", "session_not_started":
            return "The native desktop session is inactive. Refresh the target with computer_observe to obtain new references."
        case "background_unavailable":
            return "Observe the same window and try a supported element action. A foreground click requires an explicit request and verified focus."
        default:
            return nil
        }
    }
    func diagnostics(initialize: Bool = true) async -> JSONObject {
        if !initialize { return lastDiagnostics }
        do {
            try ready()
            lastDiagnostics = ["driver": .object(["installed": .bool(true), "loaded": .bool(true), "ready": .bool(true), "version": .string("0.47.8")]), "permissions": .object(["checked": .bool(true), "screen": .bool(CGPreflightScreenCaptureAccess()), "input": .bool(AXIsProcessTrusted())])]
        } catch { lastDiagnostics = ["driver": .object(["installed": .bool(false), "ready": .bool(false), "error": .string("Desktop driver unavailable")]), "permissions": .object(["checked": .bool(false), "screen": .bool(false), "input": .bool(false)])] }
        return lastDiagnostics
    }
    func apps() async throws -> [JSONObject] {
        let result = try await invoke("list_apps", [:])
        return (result.object("structuredContent")?.array("apps") ?? []).compactMap { value in
            guard let app = value.object else { return nil }
            var row = app.filter { ["pid", "name", "bundle_id", "running", "active"].contains($0.key) }
            if app.bool("running") == true, let pid = app.number("pid").flatMap(pid_t.init(exactly:)), pid > 0,
               let running = NSRunningApplication(processIdentifier: pid), let bundleID = running.bundleIdentifier,
               bundleID == app.string("bundle_id"), let name = running.localizedName, !name.isEmpty, name != app.string("name") {
                row["localized_name"] = .string(String(name.prefix(200)))
            }
            return row
        }
    }
    func windows(pid: Double? = nil) async throws -> [JSONObject] {
        var args: JSONObject = ["on_screen_only": .bool(false)]; if let pid { args["pid"] = .number(pid) }
        let result = try await invoke("list_windows", args)
        return (result.object("structuredContent")?.array("windows") ?? []).compactMap { value in
            guard let window = value.object, let id = window.number("window_id"), id > 0, id <= 9_007_199_254_740_991, id.rounded() == id else { return nil }
            return window.filter { ["pid", "window_id", "app_name", "title", "bounds", "is_on_screen", "layer", "z_index"].contains($0.key) }
        }
    }
    func visibleWindows(pid: Double) async throws -> [JSONObject] {
        let stack = onScreenWindows()
        return stack.enumerated().compactMap { index, window in
            guard window.pid == pid, !window.transparent, window.frame.width > 0, window.frame.height > 0 else { return nil }
            var row = window.diagnostic(includeTitle: true)
            row["bounds"] = .object([
                "x": .number(window.frame.minX), "y": .number(window.frame.minY),
                "width": .number(window.frame.width), "height": .number(window.frame.height)
            ])
            row["is_on_screen"] = .bool(true)
            row["layer"] = window.layer.map { .number(Double($0)) }
            row["z_index"] = .number(Double(stack.count - index))
            return row
        }
    }
    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    private func focusedElement(pid: Double, system: AXUIElement) -> AXUIElement? {
        guard let application = attribute(system, kAXFocusedApplicationAttribute),
              CFGetTypeID(application) == AXUIElementGetTypeID() else { return nil }
        var activePid: pid_t = 0
        let app = application as! AXUIElement
        guard AXUIElementGetPid(app, &activePid) == .success, Double(activePid) == pid,
              let window = attribute(app, kAXFocusedWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID() else { return nil }
        return (window as! AXUIElement)
    }
    func focusedWindow(pid: Double, candidates: [JSONObject]) async throws -> Double? {
        guard let focused = focusedElement(pid: pid, system: AXUIElementCreateSystemWide()) else { return nil }
        return matchWindow(focused, candidates: candidates)
    }
    func mainWindow(pid: Double, candidates: [JSONObject]) async throws -> Double? {
        guard let process = pid_t(exactly: pid), let window = elementAttribute(AXUIElementCreateApplication(process), kAXMainWindowAttribute) else { return nil }
        return matchWindow(window, candidates: candidates)
    }
    private func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }
    private func axFrame(_ window: AXUIElement) -> CGRect? {
        guard let position = attribute(window, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
              let size = attribute(window, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero, dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
              AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
              dimensions.width > 0, dimensions.height > 0 else { return nil }
        return CGRect(origin: origin, size: dimensions)
    }
    private func matchWindow(_ window: AXUIElement, candidates: [JSONObject]) -> Double? {
        guard let frame = axFrame(window) else { return nil }
        let matching = candidates.filter { Self.windowFrame($0.object("bounds")) == frame }
        if matching.count == 1 { return matching[0].number("window_id") }
        guard let title = attribute(window, kAXTitleAttribute) as? String, !title.isEmpty else { return nil }
        let titled = matching.filter { $0.string("title") == title }
        return titled.count == 1 ? titled[0].number("window_id") : nil
    }
    func open(bundleID: String) async throws {
        let result = try await NativeShell.run(executable: "/usr/bin/open", arguments: ["-b", bundleID], cwd: NSHomeDirectory(), environment: ProcessInfo.processInfo.environment, timeout: 5000, output: nil)
        guard result.number("exit_code") == 0, result.bool("timed_out") != true else { throw DesktopError(code: "app_launch_failed", message: "Application launch failed") }
    }
    func observe(session id: String, target: JSONObject, screenshot: Bool) async throws -> JSONObject {
        // A named SDK session can idle out while its outer control session is active.
        // A fresh read may revive it. Input must never revive it using previous references.
        sessions[id] = .observing  // Also owns cleanup if start is cancelled after SDK activation.
        windowInputs.removeValue(forKey: id)
        _ = try await invoke("start_session", ["session": .string(id)])
        let observation = try await readState(session: id, target: target, screenshot: screenshot)
        sessions[id] = .observed
        return observation
    }
    private func readState(session id: String, target: JSONObject, screenshot: Bool) async throws -> JSONObject {
        let desktop = target.bool("desktop") == true
        if desktop && !screenshot { return ["elements": .array([])] }
        var args = target
        args.removeValue(forKey: "desktop")
        args["session"] = .string(id); args["max_image_dimension"] = .number(1920)
        if !desktop {
            args["include_screenshot"] = .bool(screenshot); args["include_accessibility_tree"] = .bool(true)
            args["tree_format"] = .string("elements"); args["max_elements"] = .number(500); args["max_depth"] = .number(12)
            args["verbose"] = .bool(true)
        }
        let beforeCapture = desktop ? [] : onScreenWindows()
        let result = try await invoke(desktop ? "get_desktop_state" : "get_window_state", args)
        let data = result.object("structuredContent") ?? [:]
        let stack = desktop ? [] : onScreenWindows()
        var observation: JSONObject = [:]
        for key in ["app_name", "window_title", "truncated", "capture_id", "window_bounds", "background_input"] { observation[key] = data[key] }
        observation["frame_valid"] = data["screenshot_frame_valid"]
        observation["elements"] = .array(desktop ? [] : (data.array("elements") ?? []).compactMap { value in
            guard let element = value.object else { return nil }
            var mapped = element.filter { ["role", "label", "enabled", "selected", "depth", "actions"].contains($0.key) }
            mapped["token"] = element["element_token"]; mapped["value"] = element["value"] ?? element["value_description"]
            return .object(mapped)
        })
        if let image = result.array("content")?.compactMap(\.object).first(where: { $0.string("type") == "image" }), let base64 = image.string("data") {
            observation["image_base64"] = .string(base64); observation["mime_type"] = image["mimeType"]
            observation["width"] = data["screenshot_width"] ?? data["width"]
            observation["height"] = data["screenshot_height"] ?? data["height"]
            if let png = Data(base64Encoded: base64), png.count >= 24, Array(png.prefix(8)) == [137,80,78,71,13,10,26,10] {
                func uint32(_ offset: Int) -> Double { Double(png[offset..<offset+4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }) }
                if observation.number("width") == nil { observation["width"] = .number(uint32(16)) }
                if observation.number("height") == nil { observation["height"] = .number(uint32(20)) }
            }
        }
        if screenshot, let pid = target.number("pid"), let id = target.number("window_id"),
           let index = stack.firstIndex(where: { $0.id == id && $0.pid == pid }),
           stack.suffix(from: index + 1).contains(where: {
               let frame = stack[index].frame
               return $0.pid == pid && $0.frame.intersects(frame) && $0.frame.width * $0.frame.height >= frame.width * frame.height
           }) {
            let frame = stack[index].frame
            // The driver's independent-window capture can return a miniature of
            // the parent for same-app popup windows. Keep its coordinate binding
            // only if the visible, window-filtered capture has the same geometry.
            let dimensionsMatch = Self.windowFrame(observation.object("window_bounds")) == frame
            let pixels: Data?
            if dimensionsMatch, let width = observation.number("width"), let height = observation.number("height") {
                pixels = try? await captureVisibleWindow(id: id, pid: pid, frame: frame, width: width, height: height)
            } else { pixels = nil }
            try Task.checkCancellation()
            if let pixels {
                observation["image_base64"] = .string(pixels.base64EncodedString())
                observation["mime_type"] = .string("image/png")
            } else {
                for key in ["image_base64", "mime_type", "capture_id"] { observation.removeValue(forKey: key) }
                observation["capture_issue"] = .string("Capture of the overlapping window could not be verified. Refresh this window or use a supported element action.")
            }
        }
        if let pid = target.number("pid"), let windowID = target.number("window_id") {
            let frame = Self.windowFrame(observation.object("window_bounds"))
            observation["window_pixel_target"] = .bool(stack.contains { $0.pid == pid && $0.id == windowID && !$0.transparent && $0.frame == frame })
            let input = windowInput(target: target, pid: pid, windowID: windowID, state: data, stack: stack, beforeCapture: beforeCapture)
            windowInputs[id] = input
            var keyboard: JSONObject = ["status": .string(input.focusedWindow == nil ? "unverified" : input.focusedControl == nil ? "window" : "control"), "editable": .bool(input.editable)]
            if let control = input.focusedControl {
                for (key, attributeName) in [("role", kAXRoleAttribute), ("label", kAXTitleAttribute)] {
                    if let value = attribute(control, attributeName) as? String { keyboard[key] = .string(String(value.prefix(120))) }
                }
            }
            observation["keyboard_focus"] = .object(keyboard)
        }
        return observation
    }

    private func captureVisibleWindow(id: Double, pid: Double, frame: CGRect, width: Double, height: Double) async throws -> Data? {
        guard (1...1920).contains(width), (1...1920).contains(height),
              abs(width / height - frame.width / frame.height) <= 2 / height else { return nil }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { Double($0.windowID) == id && $0.owningApplication.map { Double($0.processID) } == pid && $0.frame == frame }),
              let display = content.displays.first(where: { $0.frame.contains(frame) }) else { return nil }
        let filter = SCContentFilter(display: display, including: [window])
        let configuration = SCStreamConfiguration()
        configuration.sourceRect = frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
        configuration.width = Int(width)
        configuration.height = Int(height)
        configuration.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        guard image.width == configuration.width, image.height == configuration.height else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination), data.length <= 4 * 1024 * 1024 else { return nil }
        return data as Data
    }
    nonisolated static func actionRequest(session id: String, action: JSONObject) throws -> (String, JSONObject) {
        guard let kind = action.string("action"), let target = action.object("target") else { throw DesktopError(code: "invalid_arguments", message: "Missing desktop action target") }
        var wire: JSONObject = [:]
        wire["session"] = .string(id)
        wire["target"] = .object(target.bool("desktop") == true ? ["kind": .string("desktop"), "display_id": .string("primary")] : target.merging(["kind": .string("window")]) { _, new in new })
        var tool: String
        switch kind {
        case "click", "double_click":
            tool = "click"; wire["element_token"] = action["native_ref"]
            if wire["element_token"] == nil {
                for key in ["x", "y", "capture_id"] { wire[key] = action[key] }
            }
            wire["button"] = action["button"]
            wire["modifier"] = action["modifiers"]; wire["count"] = .number(kind == "double_click" ? 2 : 1)
            wire["delivery_mode"] = action["delivery_mode"] ?? .string("background")
        case "type": tool = "type_text"; wire["element_token"] = action["native_ref"]; wire["text"] = action["text"]
        case "key": tool = "press_key"; wire["modifiers"] = action["modifiers"]; wire["key"] = action["key"]
        case "move": tool = "move_cursor"; wire["x"] = action["x"]; wire["y"] = action["y"]
        case "drag":
            tool = "drag"; wire["from_x"] = action["x"]; wire["from_y"] = action["y"]; wire["modifier"] = action["modifiers"]
            wire["to_x"] = action["to_x"]; wire["to_y"] = action["to_y"]
        case "scroll":
            tool = "scroll"; let dy = action.number("delta_y") ?? 0, d = dy != 0 ? dy : action.number("delta_x") ?? 0
            wire.removeValue(forKey: "delta_x"); wire.removeValue(forKey: "delta_y")
            wire["direction"] = .string(dy != 0 ? (d < 0 ? "up" : "down") : (d < 0 ? "left" : "right"))
            wire["amount"] = .number(max(1, min(50, (abs(d)/40).rounded())))
            wire["x"] = action["x"]; wire["y"] = action["y"]
        default: throw DesktopError(code: "invalid_arguments", message: "Unsupported desktop action")
        }
        return (tool, wire)
    }

    nonisolated static func windowFrame(_ bounds: JSONObject?) -> CGRect? {
        guard let bounds, let x = bounds.number("x"), let y = bounds.number("y"),
              let width = bounds.number("width"), let height = bounds.number("height"), width > 0, height > 0 else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    private func pointHitsFocusedElement(_ point: CGPoint, pid: Double) -> Bool {
        let system = AXUIElementCreateSystemWide()
        guard let focused = focusedElement(pid: pid, system: system) else { return false }
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success,
              let hit else { return false }
        if CFEqual(focused, hit) { return true }
        guard let hitWindow = attribute(hit, kAXWindowAttribute) else { return false }
        return CFEqual(focused, hitWindow)
    }

    private func onScreenWindows() -> [ScreenWindow] {
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        return (windows as? [[String: Any]] ?? []).compactMap(ScreenWindow.init)
    }

    private func siblingCovers(stack: [ScreenWindow], pid: Double, id: Double) -> [SiblingCover] {
        guard let index = stack.firstIndex(where: { $0.id == id && $0.pid == pid }) else { return [] }
        let frame = stack[index].frame
        return stack.prefix(index).filter { $0.pid == pid && !$0.transparent && $0.frame.intersects(frame) }
            .map { SiblingCover(id: $0.id, frame: $0.frame) }
    }

    private func windowInput(target: JSONObject, pid: Double, windowID: Double, state: JSONObject, stack: [ScreenWindow], beforeCapture: [ScreenWindow]) -> WindowInput {
        let windows = stack.filter { $0.pid == pid }
        let window = windows.first { $0.id == windowID }
        let covers = siblingCovers(stack: stack, pid: pid, id: windowID)
        let captureCovers = siblingCovers(stack: beforeCapture, pid: pid, id: windowID)
        let wasVisible = window != nil || beforeCapture.contains { $0.id == windowID && $0.pid == pid }
        let unverified = WindowInput(target: target, wasVisible: wasVisible, covers: covers, captureCovers: captureCovers, focusedWindow: nil, focusedControl: nil, editable: false)
        guard let process = pid_t(exactly: pid), let frame = window?.frame else { return unverified }
        let app = AXUIElementCreateApplication(process)
        guard let focused = elementAttribute(app, kAXFocusedWindowAttribute), axFrame(focused) == frame else { return unverified }
        let sameFrame = windows.filter { $0.frame == frame }
        guard sameFrame.count == 1 || matchesWindowRoot(focused, app: app, target: target, state: state, frame: frame) else { return unverified }
        let control = receivingControl(app, window: focused)
        return WindowInput(target: target, wasVisible: true, covers: covers, captureCovers: captureCovers, focusedWindow: focused, focusedControl: control, editable: isEditable(control))
    }

    private func matchesWindowRoot(_ focused: AXUIElement, app: AXUIElement, target: JSONObject, state: JSONObject, frame: CGRect) -> Bool {
        // Electron dialogs can share a WindowServer frame with their parent.
        // Correlate the exact target's AX root with a unique focused AX window.
        guard let exact = state.object("background_input")?.object("exact_window"),
              exact.string("status") == "matched", exact.number("pid") == target.number("pid"),
              exact.number("window_id") == target.number("window_id"),
              let title = attribute(focused, kAXTitleAttribute) as? String, !title.isEmpty,
              let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] else { return false }
        let roots = (state.array("elements") ?? []).compactMap(\.object).filter { $0.number("depth") == 0 && $0.string("role") == "AXWindow" }
        guard roots.count == 1, roots[0].string("label") == title else { return false }
        let plausible = windows.filter { axFrame($0) == frame && (attribute($0, kAXTitleAttribute) as? String) == title }
        return plausible.count == 1 && CFEqual(plausible[0], focused)
    }

    private func receivingControl(_ app: AXUIElement, window: AXUIElement) -> AXUIElement? {
        guard let control = elementAttribute(app, kAXFocusedUIElementAttribute), !CFEqual(control, window) else { return nil }
        var ancestor = control
        for _ in 0..<12 {
            if CFEqual(ancestor, window) { return control }
            if let owner = elementAttribute(ancestor, kAXWindowAttribute) { return CFEqual(owner, window) ? control : nil }
            guard let parent = elementAttribute(ancestor, kAXParentAttribute) else { return nil }
            ancestor = parent
        }
        return nil
    }

    private func isEditable(_ control: AXUIElement?) -> Bool {
        guard let control, let role = attribute(control, kAXRoleAttribute) as? String,
              ["AXTextField", "AXTextArea", "AXComboBox", "AXSecureTextField", "AXSearchField"].contains(role) else { return false }
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(control, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
    }

    private func checkWindowInput(_ input: WindowInput, target: JSONObject, keyboardAction: String?) throws {
        guard let pid = target.number("pid"), let process = pid_t(exactly: pid), let windowID = target.number("window_id") else { return }
        let hint = "Observe the intended window again and verify its focused control before acting."
        let stack = onScreenWindows()
        guard input.target == target, !input.wasVisible || stack.contains(where: {
            $0.id == windowID && $0.pid == pid
        }) else {
            throw DesktopError(code: "window_unavailable", message: "The observed window is no longer visible", hint: hint)
        }
        guard siblingCovers(stack: stack, pid: pid, id: windowID) == input.covers else {
            throw DesktopError(code: "stale_observation", message: "The windows covering the observed target have changed", hint: "Observe the current window or its covering window again before acting.")
        }
        guard let expected = input.focusedWindow else { return }
        let app = AXUIElementCreateApplication(process)
        guard let current = elementAttribute(app, kAXFocusedWindowAttribute), CFEqual(expected, current) else {
            throw DesktopError(code: "focus_changed", message: "The application's focused window changed after observation", hint: hint)
        }
        if let keyboardAction {
            let receiver = receivingControl(app, window: current)
            let sameControl = if let expected = input.focusedControl, let receiver { CFEqual(expected, receiver) } else { input.focusedControl == nil && receiver == nil }
            if !sameControl { throw DesktopError(code: "keyboard_focus_changed", message: "The receiving control changed after observation", hint: hint) }
            if keyboardAction == "type_text" && !isEditable(receiver) {
                throw DesktopError(code: "keyboard_target_unverified", message: "The focused control is no longer editable", hint: hint)
            }
        }
    }

    private func checkWindowPoint(_ action: JSONObject, target: JSONObject, foreground: Bool, covers: [SiblingCover]) throws {
        let hint = "Observe the intended window again and use coordinates from the new screenshot."
        guard let frame = Self.windowFrame(action.object("window_bounds")),
              let position = action.object("window_position"),
              let x = position.number("x"), let y = position.number("y"),
              let pid = target.number("pid"), let id = target.number("window_id") else {
            throw DesktopError(code: "window_frame_unavailable", message: "Cannot verify the screen position of the target", hint: hint)
        }
        let windows = onScreenWindows()
        guard let window = windows.first(where: { $0.id == id && $0.pid == pid }) else {
            throw DesktopError(code: "window_unavailable", message: "The observed window is no longer on screen", hint: hint)
        }
        guard window.frame == frame else {
            throw DesktopError(code: "window_frame_changed", message: "The target window moved or resized after observation", hint: hint)
        }
        let point = CGPoint(x: frame.minX + x * frame.width, y: frame.minY + y * frame.height)
        // Cua maps capture pixels through the original bitmap and a discrete
        // backing scale, with up to 3% frame tolerance. Check that entire
        // possible destination stays inside the window and clear of blockers.
        let toleranceX = 1 + x * frame.width * 0.03
        let toleranceY = 1 + y * frame.height * 0.03
        let destination = CGRect(x: point.x - toleranceX, y: point.y - toleranceY,
                                 width: 2 * toleranceX, height: 2 * toleranceY)
        var display: CGDirectDisplayID = 0, displays: UInt32 = 0
        if foreground {
            guard frame.contains(destination) else {
                throw DesktopError(code: "window_point_near_edge", message: "The screenshot point is too close to the window edge", hint: "Call computer_observe with screenshot=true and omit both pid and window_id to refresh this window. Use the new observation_id and choose a point farther inside the intended control.")
            }
            guard CGGetDisplaysWithPoint(point, 1, &display, &displays) == .success, displays > 0,
                  CGDisplayBounds(display).contains(destination) else {
                throw DesktopError(code: "window_point_offscreen", message: "The screenshot point is outside the visible displays", hint: hint)
            }
        }
        let hits = windows.filter { $0.pid != Double(getpid()) && !$0.transparent && $0.frame.intersects(destination) }
        // Other apps do not receive window-targeted background events. A sibling
        // surface can still make the point ambiguous within the same process.
        let blockers = hits.prefix { $0.id != id }.filter { foreground || $0.pid == pid }
        // Dock can publish a full-screen WindowServer frame for an overlay. Require
        // a separate AX hit on the focused window before disregarding that frame.
        func isDockOverlay(_ window: ScreenWindow) -> Bool {
            guard foreground, let owner = pid_t(exactly: window.pid) else { return false }
            return window.layer == CGWindowLevelForKey(.dockWindow)
                && window.frame == CGDisplayBounds(display)
                && NSRunningApplication(processIdentifier: owner)?.bundleIdentifier == "com.apple.dock"
        }
        let onlyDockOverlay = !blockers.isEmpty && blockers.allSatisfy(isDockOverlay)
        guard hits.contains(where: { $0.id == id }),
              blockers.isEmpty || (onlyDockOverlay && pointHitsFocusedElement(point, pid: pid)) else {
            let blocker = blockers.first { !isDockOverlay($0) } ?? blockers.first
            let sameApp = blocker?.pid == pid
            var details: JSONObject = ["target": .object(window.diagnostic(includeTitle: true)), "recovery": .string(sameApp ? "observe_blocker" : "clear_occlusion")]
            if let blocker, blocker.pid > 0 { details["blocker"] = .object(blocker.diagnostic(includeTitle: sameApp)) }
            let recovery = sameApp
                ? "Observe the covering window using its PID and window ID before acting."
                : "Clear the obstruction and observe the intended window again."
            throw DesktopError(code: "window_point_occluded", message: "The screenshot point is covered by another surface", hint: recovery, desktop: details)
        }
        if covers.contains(where: { $0.frame.intersects(destination) }) {
            throw DesktopError(code: "stale_observation", message: "A same-application surface covered this point when it was observed", hint: hint)
        }
    }

    func act(session id: String, action: JSONObject) async throws -> JSONObject {
        guard sessions[id] == .observed else {
            throw DesktopError(code: "stale_observation", message: "No observed desktop session is available", hint: "Call computer_observe before acting.")
        }
        let (tool, wire) = try Self.actionRequest(session: id, action: action)
        let input = windowInputs.removeValue(forKey: id)
        if tool == "click", wire["capture_id"] != nil,
           let target = action.object("target"), target.number("pid") != nil {
            let covers = input.map { $0.captureCovers + $0.covers } ?? []
            try checkWindowPoint(action, target: target, foreground: wire.string("delivery_mode") == "foreground", covers: covers)
        }
        if let target = action.object("target"), let input {
            let keyboard = tool == "press_key" || (tool == "type_text" && wire["element_token"] == nil)
            try checkWindowInput(input, target: target, keyboardAction: keyboard ? tool : nil)
        }
        let reply = try await invoke(tool, wire)
        let result = reply.object("structuredContent") ?? [:]
        if result.object("error") != nil || result.string("effect") == "refused" {
            let code = result.object("error")?.string("code") ?? result.string("code") ?? "action_refused"
            throw DesktopError(code: code, message: "Desktop action was refused", hint: Self.actionRecovery(code))
        }
        var output: JSONObject = ["action_executed": .bool(true), "business_verified": .bool(false)]
        for key in ["effect", "route", "delivery"] { output[key] = result[key] }
        if ["unverifiable", "partial", "suspected_noop"].contains(result.string("effect") ?? "") {
            output["hint"] = .string("Verify the expected change in the follow-up observation or refresh the same target before continuing.")
        }
        if let summary = result.string("summary") { output["summary"] = .string(String(summary.prefix(500))) }
        return output
    }
    func release(session id: String) async {
        windowInputs.removeValue(forKey: id)
        guard sessions.removeValue(forKey: id) != nil, !closed else { return }
        _ = try? await invoke("end_session", ["session": .string(id)], timeout: 5000)
    }
    func shutdown() async {
        guard !closed else { return }; closed = true
        for operation in operations.values { operation.cancel() }
        while !operations.isEmpty { await Task.detached { try? await Task.sleep(nanoseconds: 10_000_000) }.value }
        sessions.removeAll()
        if driver != nil {
            let operation = DriverOperation()
            let timer = Task { try? await Task.sleep(nanoseconds: 10_000_000_000); if !Task.isCancelled { operation.cancel(timeout: true) } }
            _ = try? await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
                guard operation.begin(continuation) else { return }
                let context = Unmanaged.passRetained(operation).toOpaque()
                var token: OpaquePointer?, error = CuaDriverBuffer()
                let status = cua_driver_shutdown_v1(driver, nativeDriverCompletion, context, &token, &error)
                let errorData = consumeDriverBuffer(&error); operation.install(token)
                if status != 0 { Unmanaged<DriverOperation>.fromOpaque(context).release(); operation.finish(status: status, result: Data(), error: errorData) }
            }
            timer.cancel(); cua_driver_destroy_v1(&driver)
        }
        lastDiagnostics["driver"] = .object(["loaded": .bool(false), "ready": .bool(false)])
    }
}
