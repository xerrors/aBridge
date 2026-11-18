import Foundation
import Darwin

actor NativeComputer {
    private struct Observation {
        struct ElementReference {
            let token: String
            let actions: [String]
        }
        let id: String
        let created: Double
        let target: JSONObject
        var refs: [String: ElementReference] = [:]
        var available = Set<String>()
        var width: Double?
        var height: Double?
        let captureID: String?
        let windowBounds: JSONObject?
        let focus: String?
    }
    private let native: any DesktopNativeDriver
    private let now: @Sendable () -> Double
    private var observations: [String: Observation] = [:]
    private var targets: [String: JSONObject] = [:]
    private var closed = Set<String>()
    private var queues: [String: (UUID, Task<JSONObject, Error>)] = [:]
    private var sessions = Set<String>()
    private var referenceSequence = UInt64.random(in: 0..<(1 << 48))
    init(native: any DesktopNativeDriver, now: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime }) { self.native = native; self.now = now }
    func execute(session: String, tool: String, arguments: JSONObject) async throws -> JSONObject {
        if tool == "computer_apps" { return try await apps(arguments) }
        if tool == "computer_windows" { return try await windows(arguments) }
        guard !session.isEmpty else { throw DesktopError(code: "session_required", message: "Desktop operation requires a session") }
        sessions.insert(session)
        let previous = queues[session]?.1, key = UUID()
        let task = Task {
            _ = try? await previous?.value
            try Task.checkCancellation()
            switch tool {
            case "computer_open": return try await self.open(session, arguments)
            case "computer_observe": return try await self.observe(session, arguments)
            case "computer_act": return try await self.act(session, arguments)
            default: throw DesktopError(code: "unsupported_tool", message: "Unsupported desktop tool")
            }
        }
        queues[session] = (key, task)
        defer { if queues[session]?.0 == key { queues.removeValue(forKey: session) } }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
    private func assertOpen(_ session: String) throws {
        try Task.checkCancellation()
        if closed.contains(session) { throw DesktopError(code: "session_closed", message: "Desktop session has closed") }
    }
    private func referenceID() throws -> String {
        guard referenceSequence < (1 << 48) else { throw DesktopError(code: "reference_exhausted", message: "Reference IDs exhausted; restart the client") }
        var value = referenceSequence; referenceSequence += 1
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        var suffix = ""
        for _ in 0..<8 { suffix.insert(alphabet[Int(value % 64)], at: suffix.startIndex); value /= 64 }
        return "obs_" + suffix
    }
    private func apps(_ args: JSONObject) async throws -> JSONObject {
        let query = args.string("query")?.lowercased()
        let apps = try await native.apps().filter { app in
            if let query {
                return ["name", "localized_name", "bundle_id"].contains { app.string($0)?.lowercased().contains(query) == true }
            }
            return app.bool("running") == true && (app.number("pid") ?? 0) > 0
        }
        var rows: [JSONValue] = []
        for app in apps.prefix(200) {
            rows.append(.object(app))
            if try JSONValue.array(rows).encoded().count > 6000 { rows.removeLast(); break }
        }
        return ["apps": .array(rows), "matches_total": .number(Double(apps.count)), "truncated": .bool(rows.count < apps.count)]
    }
    private func windows(_ args: JSONObject) async throws -> JSONObject {
        let pid = args.number("pid"), windows = try await native.windows(pid: args.number("pid"))
        var running: Bool?
        if let pid { running = Darwin.kill(pid_t(pid), 0) == 0 || errno == EPERM }
        var result: JSONObject = ["windows": .array(windows.prefix(200).map(JSONValue.object)), "requested_pid": pid.map(JSONValue.number) ?? .null, "process_running": running.map(JSONValue.bool) ?? .null, "on_screen_only": .bool(false), "truncated": .bool(windows.count > 200), "empty_reason": windows.isEmpty ? .string(running == false ? "process_not_running" : "no_windows_reported") : .null]
        if windows.isEmpty { result["guidance"] = .string("Refresh computer_apps/windows and observe a returned pid/window_id; off-screen windows are included") }
        return result
    }
    private func focus(ordinaryOnly: Bool) async throws -> String? {
        do {
            let active = try await native.apps().filter { $0.bool("active") == true && $0.bool("running") == true }
            guard active.count == 1, let pid = active[0].number("pid") else { return nil }
            let windows = try await visibleWindows(pid).filter { !ordinaryOnly || $0.number("layer") == 0 }
            guard !windows.isEmpty, let windowID = try await native.focusedWindow(pid: pid, candidates: windows) else { return nil }
            return "\(pid):\(windowID)"
        } catch { try Task.checkCancellation(); return nil }
    }
    private func visibleWindows(_ pid: Double) async throws -> [JSONObject] {
        try await native.visibleWindows(pid: pid).filter {
            NativeDriver.windowFrame($0.object("bounds")) != nil
        }
    }
    private func followUpTarget(_ target: JSONObject, before: [JSONObject], focusedBefore: Double?) async throws -> JSONObject {
        guard let pid = target.number("pid"), let id = target.number("window_id") else { return target }
        let windows = try await visibleWindows(pid)
        let focused = try await native.focusedWindow(pid: pid, candidates: windows)
        if let focused, focused != focusedBefore {
            return ["pid": .number(pid), "window_id": .number(focused)]
        }
        let current = windows.first { $0.number("window_id") == id }
        let previous = before.first { $0.number("window_id") == id }
        if let source = current ?? previous, let frame = NativeDriver.windowFrame(source.object("bounds")) {
            let appearedAbove = windows.filter {
                guard let candidateID = $0.number("window_id"), candidateID != id,
                      let bounds = NativeDriver.windowFrame($0.object("bounds")), bounds.intersects(frame) else { return false }
                let oldCandidate = before.first { $0.number("window_id") == candidateID }
                if current == nil { return oldCandidate == nil }
                guard let order = source.number("z_index"), let depth = $0.number("z_index"), depth > order else { return false }
                guard let oldCandidate else { return true }
                guard let previousOrder = previous?.number("z_index"), let previousDepth = oldCandidate.number("z_index") else { return false }
                return previousDepth <= previousOrder
            }
            if appearedAbove.count == 1, let nextID = appearedAbove[0]["window_id"] {
                return ["pid": .number(pid), "window_id": nextID]
            }
            if appearedAbove.count > 1 {
                throw DesktopError(code: "window_selection_required", message: "Multiple windows appeared above the previous target", hint: "Use computer_windows for the same PID and observe the intended window explicitly.")
            }
        }
        if current == nil, previous != nil {
            if let focused { return ["pid": .number(pid), "window_id": .number(focused)] }
            throw DesktopError(code: "window_unavailable", message: "The previous target is no longer visible", hint: "Use computer_windows for the same PID and observe the intended window explicitly.")
        }
        return target
    }
    private func open(_ session: String, _ args: JSONObject) async throws -> JSONObject {
        guard let bundle = args.string("bundle_id"), try await native.apps().contains(where: { $0.string("bundle_id") == bundle }) else { throw DesktopError(code: "app_not_found", message: "Application is not installed") }
        try assertOpen(session)
        observations.removeValue(forKey: session); targets.removeValue(forKey: session)
        try await native.open(bundleID: bundle)
        var base: JSONObject = ["launch_requested": .bool(true), "bundle_id": .string(bundle)]
        let followUp = Task { try await self.openObservation(session, args, bundle) }
        let timer = Task { try? await Task.sleep(nanoseconds: 8_000_000_000); if !Task.isCancelled { followUp.cancel() } }
        defer { timer.cancel() }
        do {
            let window = try await withTaskCancellationHandler { try await followUp.value } onCancel: { followUp.cancel() }
            base.merge(window) { _, new in new }
        } catch {
            try Task.checkCancellation()
            base["observation_error"] = .object(["code": .string((error as? DesktopError)?.code ?? "window_unavailable"), "message": .string("Application launch requested; follow-up window observation unavailable")])
        }
        return base
    }
    private func openObservation(_ session: String, _ args: JSONObject, _ bundle: String) async throws -> JSONObject {
        for attempt in 0..<16 {
            try assertOpen(session)
            if let app = try await native.apps().first(where: { $0.string("bundle_id") == bundle && $0.bool("running") == true && ($0.number("pid") ?? 0) > 0 }), let pid = app.number("pid") {
                let windows = try await visibleWindows(pid)
                let ordinary = windows.filter { $0.number("layer") == 0 }
                var id = try await native.focusedWindow(pid: pid, candidates: windows)
                if id == nil { id = try await native.mainWindow(pid: pid, candidates: ordinary) }
                if id == nil && attempt == 15 && windows.count == 1 && ordinary.count == 1 { id = ordinary[0].number("window_id") }
                if let id {
                    let observation = try await observe(session, ["pid": .number(pid), "window_id": .number(id), "screenshot": .bool(args.bool("screenshot") ?? false)])
                    return ["observation": .object(observation)]
                }
                if attempt == 15 && !windows.isEmpty {
                    return [
                        "observation_error": .object(DesktopError(code: "window_selection_required", message: "Cannot identify the application's focused or main window", hint: "Choose a window candidate and call computer_observe with its PID and window ID.").json),
                        "window_candidates": .array(windows.prefix(16).map { .object($0.filter { ["pid", "window_id", "title", "layer"].contains($0.key) }) })
                    ]
                }
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw DesktopError(code: "window_unavailable", message: "Application launched but no ordinary window appeared")
    }
    private func observe(_ session: String, _ args: JSONObject) async throws -> JSONObject {
        try assertOpen(session)
        var target: JSONObject
        if let pid = args.number("pid") {
            if let id = args.number("window_id") { target = ["pid": .number(pid), "window_id": .number(id)] }
            else {
                let windows = try await native.windows(pid: pid).filter { $0.number("pid") == pid && ($0.number("window_id") ?? 0) > 0 }
                try assertOpen(session)
                if let selected = targets[session], selected.number("pid") == pid {
                    guard windows.contains(where: { $0["window_id"] == selected["window_id"] }) else {
                        observations.removeValue(forKey: session)
                        throw DesktopError(code: "window_id_not_found", message: "The selected window is no longer listed", hint: "Use computer_windows and select the intended replacement explicitly.")
                    }
                    target = selected
                } else if windows.isEmpty {
                    throw DesktopError(code: "window_unavailable", message: "No window is available; refresh computer_windows")
                } else if windows.count == 1 {
                    target = ["pid": .number(pid), "window_id": windows[0]["window_id"]!]
                } else {
                    throw DesktopError(code: "window_selection_required", message: "Multiple windows are available for this PID", hint: "Call computer_windows for this PID, then pass the selected pid and window_id to computer_observe.")
                }
            }
        } else if args.bool("desktop") == true { target = ["desktop": .bool(true)] }
        else if let previous = targets[session], previous.number("pid") != nil { target = previous }
        else { throw DesktopError(code: "target_required", message: "Provide pid and window_id, or set desktop=true") }
        observations.removeValue(forKey: session)
        let screenshot = args.bool("screenshot") != false
        let desktop = target.bool("desktop") == true
        let windowFocus = target.number("pid").flatMap { pid in target.number("window_id").map { "\(pid):\($0)" } }
        let before = desktop || screenshot ? try await focus(ordinaryOnly: desktop) : nil
        try assertOpen(session)
        let raw = try await native.observe(session: session, target: target, screenshot: screenshot)
        try assertOpen(session)
        let after = before != nil && (desktop || before == windowFocus) ? try await focus(ordinaryOnly: desktop) : nil
        try assertOpen(session)
        var observation = Observation(id: try referenceID(), created: now(), target: target, width: raw.number("width"), height: raw.number("height"), captureID: raw.string("capture_id"), windowBounds: raw.object("window_bounds"), focus: before == after ? before : nil)
        let result = try compact(raw, &observation, query: args.string("query"))
        observations[session] = observation; targets[session] = target
        return result
    }
    private func compact(_ raw: JSONObject, _ observation: inout Observation, query: String?) throws -> JSONObject {
        var result: JSONObject = ["observation_id": .string(observation.id), "elements": .array([])]
        for key in ["app_name", "window_title"] { if let value = raw.string(key) { result[key] = .string(String(value.prefix(200))) } }
        result["keyboard_focus"] = raw["keyboard_focus"]
        if observation.target.number("pid") != nil { result["window"] = .object(observation.target) }
        else { result["desktop"] = .bool(true) }
        result["focus_status"] = .string(observation.focus != nil ? "confirmed" : "unconfirmed")
        var rows: [JSONValue] = [], matches = 0, truncated = raw.bool("truncated") ?? false
        var elementActions = Set<String>()
        for element in (raw.array("elements") ?? []).compactMap(\.object) {
            let role = element.string("role") ?? "", lower = role.lowercased(), label = element.string("label") ?? ""
            let value = ["secure", "password", "protected"].contains(where: lower.contains) ? nil : element.string("value")
            if let query, !query.isEmpty, !"\(label)\n\(value ?? "")".lowercased().contains(query.lowercased()) { continue }
            let advertised = Set((element.array("actions") ?? []).compactMap(\.string))
            var supported: [String] = []
            if element.string("token") != nil && element.bool("enabled") != false {
                if advertised.contains("AXPress") { supported.append("click") }
                if advertised.contains("AXShowMenu") { supported.append("right_click") }
                if ["AXTextField", "AXTextArea", "AXComboBox", "AXSecureTextField"].contains(role) { supported.append("type") }
            }
            let actionable = !supported.isEmpty
            if label.isEmpty && (value ?? "").isEmpty && !actionable { continue }
            matches += 1
            let ref = "e\(rows.count + 1)"
            var row: JSONObject = ["role": .string(role), "label": .string(String(label.prefix(query == nil ? 240 : 2000)))]
            row["depth"] = element["depth"]
            if let value { row["value"] = .string(String(value.prefix(query == nil ? 384 : 4500))) }
            if actionable {
                row["element_ref"] = .string(ref)
                row["actions"] = .array(supported.map(JSONValue.string))
            }
            if element.bool("enabled") == false { row["enabled"] = .bool(false) }
            if element.bool("selected") == true { row["selected"] = .bool(true) }
            rows.append(.object(row)); result["elements"] = .array(rows)
            if try result.encoded().count > 7000 { rows.removeLast(); truncated = true; continue }
            if actionable, let token = element.string("token") {
                observation.refs[ref] = .init(token: token, actions: supported)
                elementActions.formUnion(supported)
            }
        }
        result["elements"] = .array(rows); result["elements_total"] = .number(Double(matches)); result["truncated"] = .bool(truncated)
        if let image = raw.string("image_base64"), let mime = raw.string("mime_type"), ["image/png", "image/jpeg", "image/webp"].contains(mime), image.utf8.count <= 5_592_408, let bytes = Data(base64Encoded: image), !bytes.isEmpty, bytes.count <= 4 * 1024 * 1024 {
            result["image_base64"] = .string(image); result["mime_type"] = .string(mime)
        }
        let pixel = result["image_base64"] != nil && (observation.width ?? 0) > 0 && (observation.height ?? 0) > 0 && raw.bool("frame_valid") != false
        let desktop = observation.target.bool("desktop") == true
        let bound = pixel && observation.captureID != nil && (desktop || raw.bool("window_pixel_target") == true)
        let foreground = bound && observation.focus != nil && (desktop || NativeDriver.windowFrame(observation.windowBounds) != nil)
        let routes = raw.object("background_input")?.array("routes")?.compactMap(\.object) ?? []
        func allowed(_ route: String) -> Bool {
            routes.first { $0.string("route") == route }?.string("status") == "available"
        }
        let background = bound && !desktop && allowed("window_pointer")
        var available: [String] = []
        if allowed("accessibility") {
            available += elementActions.sorted().map { "element_" + $0 }
        }
        if background { available.append("pixel_click_background") }
        if foreground { available.append("pixel_click_foreground") }
        if desktop {
            if observation.focus != nil { available += ["key", "type"] }
        } else if allowed("pid_keyboard"), let keyboard = raw.object("keyboard_focus"), ["window", "control"].contains(keyboard.string("status") ?? "") {
            available.append("key")
            if keyboard.bool("editable") == true { available.append("type") }
        }
        if pixel && (desktop ? observation.focus != nil : raw.bool("window_pixel_target") == true && allowed("window_pointer")) {
            available += ["move", "drag", "scroll"]
        }
        observation.available = Set(available)
        result["available_actions"] = .array(available.map(JSONValue.string))
        result["pixel_actions"] = .bool(background || foreground)
        if desktop && observation.focus == nil {
            result["hint"] = .string("Focus is unconfirmed. Observe again or select the intended window.")
        } else if let issue = raw.string("capture_issue") {
            result["hint"] = .string(issue)
        } else if pixel && !background && !foreground {
            result["hint"] = .string("Coordinate clicks are unavailable for this observation. Use a supported element action or refresh the same target.")
        } else if truncated {
            result["hint"] = .string("Use query to narrow the accessibility tree.")
        } else if !pixel {
            result["hint"] = .string("For coordinate clicks, refresh the same target with screenshot=true.")
        }
        if pixel {
            result["coordinate_space"] = .string("screenshot_pixels")
            result["geometry"] = .object(["width": .number(observation.width!), "height": .number(observation.height!)])
        } else { observation.width = nil; observation.height = nil }
        return result
    }
    private func act(_ session: String, _ args: JSONObject) async throws -> JSONObject {
        try assertOpen(session)
        guard let observation = observations[session], args.string("observation_id") == observation.id else {
            throw DesktopError(code: "stale_observation", message: "The observation is no longer current", hint: "Observe the intended target again and use its new observation_id and references.")
        }
        if now() - observation.created > 120 {
            observations.removeValue(forKey: session)
            let target = observation.target.bool("desktop") == true ? "with desktop=true" : "on the same window"
            throw DesktopError(code: "stale_observation", message: "The observation exceeded its 120-second lifetime", hint: "Call computer_observe \(target) and use its new observation_id and references.")
        }
        let desktop = observation.target.bool("desktop") == true
        let focusHint = "Bring the intended window to the front, then refresh it with computer_observe."
        if desktop && observation.focus == nil { throw DesktopError(code: "focus_unavailable", message: "Desktop focus is unconfirmed", hint: focusHint) }
        guard let action = args.object("action"), let kind = action.string("type") else { throw DesktopError(code: "invalid_arguments", message: "Missing desktop action") }
        var request: JSONObject = ["action": .string(kind), "target": .object(observation.target)]
        var checkFocus = desktop
        if let ref = action.string("element_ref") {
            guard let element = observation.refs[ref] else {
                throw DesktopError(code: "invalid_reference", message: "Element reference is not in this observation", hint: "Use an element_ref from the current observation with the requested action listed.")
            }
            let actionName = kind == "type" ? "type" : action.string("button") == "right" ? "right_click" : "click"
            guard element.actions.contains(actionName), observation.available.contains("element_" + actionName) else {
                throw DesktopError(code: "element_action_unavailable", message: "The selected element does not support this action", hint: "Use a reference from the current observation that advertises the requested action.")
            }
            request["native_ref"] = .string(element.token)
        }
        func point(_ x: Double?, _ y: Double?) throws -> (x: JSONValue, y: JSONValue, position: JSONObject) {
            guard let width = observation.width, let height = observation.height else { throw DesktopError(code: "screenshot_required", message: "A valid screenshot is required", hint: "Refresh the same target with computer_observe and screenshot=true.") }
            guard let x, let y, x.isFinite, y.isFinite, x >= 0, y >= 0, x < width, y < height else { throw DesktopError(code: "invalid_arguments", message: "Coordinates must be inside the observed screenshot") }
            return (.number(x), .number(y), ["x": .number(x / width), "y": .number(y / height)])
        }
        switch kind {
        case "click", "double_click":
            let foreground = action.string("delivery_mode") == "foreground"
            if !foreground && (desktop || !(action.array("modifiers") ?? []).isEmpty) {
                throw DesktopError(code: "foreground_required", message: "Desktop or modified clicks require explicit foreground delivery", hint: "Use screenshot coordinates and set action.delivery_mode to foreground once the intended window has verified focus.")
            }
            if foreground && action.string("element_ref") != nil {
                throw DesktopError(code: "foreground_coordinates_required", message: "Foreground clicks require screenshot coordinates", hint: "Use x and y from a fresh screenshot, or use an element_ref with background delivery.")
            }
            if action.string("element_ref") == nil {
                let click = try point(action.number("x"), action.number("y"))
                request["x"] = click.x; request["y"] = click.y
                guard let capture = observation.captureID else {
                    throw DesktopError(code: "screenshot_required", message: "The screenshot has no actionable capture reference", hint: "Refresh the same target with computer_observe and screenshot=true.")
                }
                request["capture_id"] = .string(capture)
                if !desktop {
                    request["window_bounds"] = observation.windowBounds.map(JSONValue.object)
                    request["window_position"] = .object(click.position)
                }
                if !foreground && !observation.available.contains("pixel_click_background") {
                    throw DesktopError(code: "background_unavailable", message: "The observation does not support background coordinate clicks", hint: "Use a supported element action or an explicitly available foreground click.")
                }
                if foreground && observation.focus != nil && !observation.available.contains("pixel_click_foreground") {
                    throw DesktopError(code: "foreground_unavailable", message: "The observation does not support foreground coordinate clicks", hint: "Refresh the intended window and inspect its available actions.")
                }
            }
            request["delivery_mode"] = .string(foreground ? "foreground" : "background")
            checkFocus = checkFocus || foreground
            request["button"] = action["button"]
        case "type": request["text"] = action["text"]
        case "key": request["key"] = action["key"]
        case "move":
            let location = try point(action.number("x"), action.number("y"))
            request["x"] = location.x; request["y"] = location.y
        case "drag":
            let start = try point(action.number("x"), action.number("y"))
            let end = try point(action.number("to_x"), action.number("to_y"))
            request["x"] = start.x; request["y"] = start.y
            request["to_x"] = end.x; request["to_y"] = end.y
        case "scroll":
            guard let width = observation.width, let height = observation.height else { throw DesktopError(code: "screenshot_required", message: "Observe with a screenshot before scrolling") }
            request["x"] = .number(floor(width/2)); request["y"] = .number(floor(height/2)); request["delta_x"] = action["delta_x"]; request["delta_y"] = action["delta_y"]
        default: throw DesktopError(code: "invalid_arguments", message: "Unsupported desktop action")
        }
        if (kind == "key" || kind == "type"), request["native_ref"] == nil, !observation.available.contains(kind) {
            throw DesktopError(code: "keyboard_target_unverified", message: "Keyboard input is not available for the observed target", hint: "Refresh the intended window and confirm keyboard focus, or type with a supported element reference.")
        }
        if ["move", "drag", "scroll"].contains(kind), !observation.available.contains(kind) {
            throw DesktopError(code: "pointer_action_unavailable", message: "The observation does not support this pointer action", hint: "Refresh the intended target with a screenshot and inspect available_actions.")
        }
        if let modifiers = action.array("modifiers") {
            let aliases = ["command": "cmd", "control": "ctrl", "alt": "option"]
            request["modifiers"] = .array(modifiers.compactMap(\.string).map { .string(aliases[$0] ?? $0) })
        }
        try assertOpen(session)
        if checkFocus {
            guard let expected = observation.focus, let current = try await focus(ordinaryOnly: desktop) else {
                throw DesktopError(code: "focus_unavailable", message: "Cannot verify focus on the observed target", hint: focusHint)
            }
            try assertOpen(session)
            if current != expected { throw DesktopError(code: "focus_changed", message: "The front window changed after observation", hint: focusHint) }
        }
        let shouldObserve = args.bool("observe_after") != false || args.bool("screenshot") == true
        var before: [JSONObject]?
        var focusedBefore: Double?
        if shouldObserve, let pid = observation.target.number("pid") {
            do {
                let windows = try await visibleWindows(pid)
                focusedBefore = try await native.focusedWindow(pid: pid, candidates: windows)
                before = windows
            } catch { try Task.checkCancellation() }
        }
        try assertOpen(session)
        // Consume before delivery: failed/unknown writes are never replayed with an old reference.
        observations.removeValue(forKey: session)
        var result = try await native.act(session: session, action: request)
        if !shouldObserve { return result }
        do {
            try assertOpen(session)
            try await Task.sleep(nanoseconds: UInt64(max(0, args.number("wait_after_ms") ?? 2000) * 1_000_000))
            if observation.target.number("pid") != nil && before == nil {
                throw DesktopError(code: "window_tracking_unavailable", message: "Could not track windows across the action", hint: "Refresh the intended window before acting again.")
            }
            var next = try await followUpTarget(observation.target, before: before ?? [], focusedBefore: focusedBefore)
            next["screenshot"] = .bool(args.bool("screenshot") == true)
            result["observation"] = .object(try await observe(session, next))
        } catch {
            result["observation_error"] = .object((error as? DesktopError)?.json ?? ["code": .string("observation_failed"), "message": .string("Action delivered; follow-up observation unavailable")])
        }
        return result
    }
    func closeSession(_ session: String) async {
        closed.insert(session); observations.removeValue(forKey: session); targets.removeValue(forKey: session)
        let pending = queues[session]?.1; pending?.cancel(); _ = try? await pending?.value
        await native.release(session: session); sessions.remove(session)
    }
    func stop() async { for session in Array(sessions) { await closeSession(session) } }
    func shutdown() async { await stop(); await native.shutdown() }
}
