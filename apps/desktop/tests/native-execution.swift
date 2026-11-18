import Foundation
import Darwin

actor FixtureDriver: DesktopNativeDriver {
    var applicationList: [JSONObject] = [["pid": .number(10), "name": .string("Fixture"), "bundle_id": .string("dev.abridge.fixture"), "running": .bool(true), "active": .bool(true)]]
    var windowList: [JSONObject] = [["pid": .number(10), "window_id": .number(20), "layer": .number(0), "z_index": .number(1), "is_on_screen": .bool(true), "bounds": .object(["x": .number(0), "y": .number(0), "width": .number(100), "height": .number(80)])]]
    var actions: [JSONObject] = [], targets: [JSONObject] = [], released: [String] = []
    var captures = 0, appQueries = 0, windowQueries = 0
    var frameValid = true, failObservation = false, failAction = false, failApps = false, failWindows = false
    var moveDuringCapture = false, focusReported = true, keyboardAvailable = true, windowDelay: UInt64 = 0
    var showsMenuOnClick = false
    var focusedWindowID: Double?, mainWindowID: Double?
    var editableControl = true
    func configure(_ key: String, _ value: Bool = true) {
        switch key {
        case "noApps": if value { applicationList = [] }
        case "ambiguousApps": applicationList.append(applicationList[0])
        case "ambiguousWindows": var extra = windowList[0]; extra["window_id"] = .number(21); windowList.append(extra)
        case "missingFocusProof": focusReported = !value
        case "keyboardUnavailable": keyboardAvailable = !value
        case "layer": windowList[0]["layer"] = .number(1)
        case "move": windowList[0]["window_id"] = .number(21)
        case "emptyWindows": windowList = []
        case "wrongOwner": windowList[0]["pid"] = .number(11)
        case "offscreen": windowList[0]["is_on_screen"] = .bool(false); windowList[0]["layer"] = .number(1)
        case "moveDuringCapture": moveDuringCapture = value
        case "invalidFrame": frameValid = !value
        case "failObservation": failObservation = value
        case "failAction": failAction = value
        case "failApps": failApps = value
        case "failWindows": failWindows = value
        case "slowWindows": windowDelay = value ? 500_000_000 : 0
        case "menuOnClick": showsMenuOnClick = value
        case "noEditor": editableControl = !value
        case "watermark": var overlay = windowList[0]; overlay["window_id"] = .number(21); overlay["title"] = .string("WatermarkWidget"); overlay["bounds"] = .object(["x": .number(0), "y": .number(0), "width": .number(500), "height": .number(500)]); windowList.insert(overlay, at: 0)
        default: fatalError("Unknown fixture setting")
        }
    }
    func select(focused: Double? = nil, main: Double? = nil) { focusedWindowID = focused; mainWindowID = main }
    func diagnostics(initialize: Bool) async -> JSONObject { [:] }
    func apps() async throws -> [JSONObject] { appQueries += 1; if failApps { throw DesktopError(code: "fixture", message: "fixture") }; return applicationList }
    func windows(pid: Double?) async throws -> [JSONObject] { windowQueries += 1; if windowDelay > 0 { try await Task.sleep(nanoseconds: windowDelay) }; if failWindows { throw DesktopError(code: "fixture", message: "fixture") }; return windowList }
    func focusedWindow(pid: Double, candidates: [JSONObject]) async throws -> Double? {
        guard focusReported else { return nil }
        if let focusedWindowID, candidates.contains(where: { $0.number("window_id") == focusedWindowID }) { return focusedWindowID }
        return candidates.count == 1 ? candidates[0].number("window_id") : nil
    }
    func mainWindow(pid: Double, candidates: [JSONObject]) async throws -> Double? { mainWindowID }
    func open(bundleID: String) async throws {}
    func observe(session: String, target: JSONObject, screenshot: Bool) async throws -> JSONObject {
        captures += 1; targets.append(target)
        if failObservation { throw DesktopError(code: "fixture", message: "fixture") }
        if moveDuringCapture { windowList[0]["window_id"] = .number(21) }
        var raw: JSONObject = ["elements": .array([.object(["token": .string("private-native-token"), "role": .string("AXButton"), "label": .string("Continue"), "depth": .number(1), "actions": .array([.string("AXPress")])]), .object(["token": .string("private-text-token"), "role": .string("AXStaticText"), "label": .string("Read only")]), .object(["token": .string("private-password-token"), "role": .string("AXSecureTextField"), "label": .string("Password"), "value": .string("protected-value"), "depth": .number(1)])]), "width": .number(100), "height": .number(80), "window_bounds": windowList.first?["bounds"] ?? .null, "frame_valid": .bool(frameValid), "capture_id": .string("fixture-capture")]
        raw["background_input"] = .object(["routes": .array(
            ["accessibility", "window_pointer", "pid_keyboard"].map { route in
                .object(["route": .string(route), "status": .string(route == "pid_keyboard" && !keyboardAvailable ? "refused" : "available")])
            }
        )])
        raw["keyboard_focus"] = .object(["status": .string(keyboardAvailable ? (editableControl ? "control" : "window") : "unverified"), "editable": .bool(keyboardAvailable && editableControl)])
        raw["window_pixel_target"] = .bool(true)
        if screenshot { raw["image_base64"] = .string(Data("fixture-image".utf8).base64EncodedString()); raw["mime_type"] = .string("image/png") }
        return raw
    }
    func act(session: String, action: JSONObject) async throws -> JSONObject {
        actions.append(action)
        if failAction { throw DesktopError(code: "outcome_unknown", message: "fixture", outcome: "outcome_unknown") }
        if showsMenuOnClick && windowList.count == 1 && action.string("action") == "click" {
            var menu = windowList[0]
            menu["window_id"] = .number(21)
            menu["layer"] = .number(101)
            menu["z_index"] = .number(2)
            windowList.append(menu)
        }
        return ["action_executed": .bool(true), "business_verified": .bool(false)]
    }
    func release(session: String) async { released.append(session) }
    func shutdown() async {}
    func counts() -> (Int, Int, Int, Int) { (actions.count, captures, appQueries, windowQueries) }
    func lastAction() -> JSONObject { actions.last ?? [:] }
    func lastTarget() -> JSONObject { targets.last ?? [:] }
}
final class TestClock: @unchecked Sendable {
    private let lock = NSLock(); private var value = 0.0
    func read() -> Double { lock.lock(); defer { lock.unlock() }; return value }
    func advance() { lock.lock(); value += 121; lock.unlock() }
}
actor OutputCollector {
    var text: [String: String] = [:]
    func append(_ stream: String, _ chunk: String) { text[stream, default: ""] += chunk }
    func value(_ stream: String) -> String { text[stream] ?? "" }
}
func check(_ condition: Bool, _ label: String) { precondition(condition, label) }
func refusal(_ code: String, _ action: () async throws -> JSONObject) async throws {
    do { _ = try await action(); fatalError("Expected \(code)") }
    catch let error as DesktopError { check(error.code == code, "Expected \(code), got \(error.code)") }
}
func cancelled(_ action: () async throws -> JSONObject) async throws {
    do { _ = try await action(); fatalError("Expected cancellation") } catch is CancellationError {}
}
func fixturePID(_ path: String) async throws -> pid_t {
    let deadline = monotonicSeconds() + 2
    while monotonicSeconds() < deadline {
        // Redirection creates the file before echo writes the PID.
        if let text = try? String(contentsOfFile: path, encoding: .utf8),
           let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 { return pid }
        try await Task.sleep(nanoseconds: 1_000_000)
    }
    throw NSError(domain: "NativeExecutionFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Fixture did not publish a complete positive PID"])
}
func actArgs(_ observation: JSONObject, _ action: JSONObject = ["type": .string("click"), "x": .number(1), "y": .number(2)], follow: Bool = false, wait: Double? = nil) -> JSONObject {
    var result: JSONObject = ["observation_id": observation["observation_id"]!, "action": .object(action), "observe_after": .bool(follow)]
    if let wait { result["wait_after_ms"] = .number(wait) }; return result
}
@main struct NativeExecutionTests {
    static func main() async throws {
        try await sdkObservationRecoveryTest()
        try await computerTests(); try await fileTests(); try await shellTests()
        let smoke = try await NativeDriver.smoke()
        check(smoke.bool("embedded") == true && smoke.number("desktop_actions") == 0 && smoke.number("authorizations") == 0, "ABI read-only smoke")
        let closedDriver = NativeDriver(); await closedDriver.shutdown()
        let closedDiagnostics = await closedDriver.diagnostics(initialize: true)
        check(closedDiagnostics.object("driver")?.bool("ready") == false, "Closed driver never initializes on diagnostics")
        do { _ = try await closedDriver.apps(); fatalError("Closed driver must refuse construction") }
        catch let error as DesktopError { check(error.code == "driver_closed", "Closed driver refuses subsequent calls") }
        print("PASS native execution: focus, references, window selection, cancellation, observation waits, files, shell groups, UTF-8, bounded output, SDK ABI")
    }
    static func sdkObservationRecoveryTest() async throws {
        let driver = NativeDriver()
        let session = "sdk-observation-recovery"
        let sdkSession: JSONObject = ["session": .string(session)]
        let target: JSONObject = ["desktop": .bool(true)]
        let missingWindow: JSONObject = ["pid": .number(Double(Int32.max)), "window_id": .number(Double(UInt32.max))]
        // An absent frame prevents this synthetic click from reaching the SDK even on regression.
        let action: JSONObject = [
            "action": .string("click"), "target": .object(missingWindow),
            "capture_id": .string("nonexistent-capture"), "x": .number(0), "y": .number(0)
        ]

        _ = try await driver.observe(session: session, target: target, screenshot: false)
        _ = try await driver.invoke("end_session", sdkSession)
        try await refusal("session_ended") { try await driver.invoke("get_session", sdkSession) }

        _ = try await driver.observe(session: session, target: target, screenshot: false)
        let active = try await driver.invoke("get_session", sdkSession)
        check(active.object("structuredContent")?.string("state") == "active", "A fresh observation revives the independently ended SDK session")

        _ = try await driver.invoke("end_session", sdkSession)
        try await refusal("window_id_not_found") {
            try await driver.observe(session: session, target: missingWindow, screenshot: false)
        }
        try await refusal("stale_observation") { try await driver.act(session: session, action: action) }
        let failedReadSession = try await driver.invoke("get_session", sdkSession)
        check(failedReadSession.object("structuredContent")?.string("state") == "active", "A failed read leaves the recovered SDK session available for cleanup")
        await driver.release(session: session)
        try await refusal("session_ended") { try await driver.invoke("get_session", sdkSession) }

        let unusedSession = "sdk-action-without-observation"
        try await refusal("stale_observation") { try await driver.act(session: unusedSession, action: action) }
        do {
            _ = try await driver.invoke("get_session", ["session": .string(unusedSession)])
            fatalError("Input must not create an SDK session")
        } catch let error as DesktopError {
            check(error.code == "session_not_started" && error.outcome == "refused", "A structured SDK refusal confirms the session was never started")
        }
        await driver.shutdown()
    }
    static func computerTests() async throws {
        let menuDriver = FixtureDriver()
        await menuDriver.configure("menuOnClick")
        let menuComputer = NativeComputer(native: menuDriver)
        let main = try await menuComputer.execute(session: "menu", tool: "computer_observe", arguments: ["pid": .number(10), "window_id": .number(20)])
        let opened = try await menuComputer.execute(session: "menu", tool: "computer_act", arguments: actArgs(main, follow: true, wait: 0))
        check(opened.object("observation")?.object("window")?.number("window_id") == 21, "Follow-up observes the menu rather than its underlying window")
        try await refusal("stale_observation") { try await menuComputer.execute(session: "menu", tool: "computer_act", arguments: actArgs(main)) }
        let menuRefresh = try await menuComputer.execute(session: "menu", tool: "computer_observe", arguments: ["pid": .number(10)])
        check(menuRefresh.object("window")?.number("window_id") == 21, "PID refresh follows the selected menu even while its parent window exists")
        let refusalReply: JSONObject = ["isError": .bool(true), "structuredContent": .object(["code": .string("action_refused"), "message": .string("sensitive native detail")])]
        do { _ = try NativeDriver.decodeReply(refusalReply.encoded()); fatalError("Expected typed refusal") }
        catch let error as DesktopError { check(error.code == "action_refused" && error.outcome == "refused" && !error.message.contains("sensitive"), "Typed refusal preserves code and sanitizes native detail") }
        do { _ = try NativeDriver.decodeReply(["isError": .bool(true)].encoded()); fatalError("Expected unknown outcome") }
        catch let error as DesktopError { check(error.code == "outcome_unknown" && error.outcome == "outcome_unknown", "Unstructured SDK errors use the shared unknown-outcome contract") }
        let explicitRefusals: [(String, JSONObject)] = [
            ("element_disabled", ["code": .string("element_disabled"), "effect": .string("refused")]),
            ("fixture_policy_denied", ["status": .string("refused"), "refusal": .object(["code": .string("fixture_policy_denied")])])
        ]
        for (code, structured) in explicitRefusals {
            do {
                _ = try NativeDriver.decodeReply(["isError": .bool(true), "structuredContent": .object(structured)].encoded())
                fatalError("Expected explicit SDK refusal")
            } catch let error as DesktopError {
                check(error.code == code && error.outcome == "refused", "An explicit refusal stays distinct from an unknown input outcome")
            }
        }
        let shared: JSONObject = ["target": .object(["pid": .number(10), "window_id": .number(20)]), "native_ref": .string("fixture-token"), "capture_id": .string("fixture-capture"), "modifiers": .array([.string("cmd")])]
        let (typeTool, typeWire) = try NativeDriver.actionRequest(session: "wire", action: shared.merging(["action": .string("type"), "text": .string("fixture")]) { _, new in new })
        check(typeTool == "type_text" && Set(typeWire.keys) == ["session", "target", "element_token", "text"], "Element typing only sends its tool fields")
        let (_, clickWire) = try NativeDriver.actionRequest(session: "wire", action: shared.merging(["action": .string("double_click")]) { _, new in new })
        check(clickWire.string("delivery_mode") == "background" && clickWire.number("count") == 2 && clickWire["capture_id"] == nil, "Element clicks never send capture_id or implicitly use foreground")
        let (_, pixelWire) = try NativeDriver.actionRequest(session: "wire", action: shared.filter { $0.key != "native_ref" }.merging(["action": .string("click"), "x": .number(3), "y": .number(4)]) { _, new in new })
        check(pixelWire.string("delivery_mode") == "background" && pixelWire.string("capture_id") == "fixture-capture", "Window pixel clicks default to background and carry the capture")
        for fault in ["noApps", "ambiguousApps", "ambiguousWindows", "missingFocusProof", "layer", "failApps", "failWindows", "moveDuringCapture"] {
            let driver = FixtureDriver(); await driver.configure(fault)
            let computer = NativeComputer(native: driver)
            let observed = try await computer.execute(session: "focus", tool: "computer_observe", arguments: ["desktop": .bool(true)])
            check(observed.string("focus_status") == "unconfirmed" && observed.bool("pixel_actions") == false && observed.string("image_base64") != nil, "Uncertain focus preserves capture")
            for kind in ["click", "double_click", "move", "drag", "scroll", "type", "key"] {
                try await refusal("focus_unavailable") { try await computer.execute(session: "focus", tool: "computer_act", arguments: actArgs(observed, ["type": .string(kind)])) }
            }
            check(await driver.counts().0 == 0, "Unconfirmed focus never dispatches")
        }
        for fault in ["move", "noApps"] {
            let driver = FixtureDriver()
            let focusComputer = NativeComputer(native: driver)
            let observed = try await focusComputer.execute(session: "focus", tool: "computer_observe", arguments: ["desktop": .bool(true)])
            check(observed.bool("pixel_actions") == true && observed.string("focus_status") == "confirmed", "Confirmed focus")
            await driver.configure(fault)
            try await refusal(fault == "move" ? "focus_changed" : "focus_unavailable") { try await focusComputer.execute(session: "focus", tool: "computer_act", arguments: actArgs(observed, ["type": .string("key"), "key": .string("Enter")])) }
        }
        for fault in ["invalidFrame", "noScreenshot"] {
            let driver = FixtureDriver(); if fault == "invalidFrame" { await driver.configure(fault) }
            let computer = NativeComputer(native: driver)
            let observed = try await computer.execute(session: "frame", tool: "computer_observe", arguments: ["pid": .number(10), "window_id": .number(20), "screenshot": .bool(fault != "noScreenshot")])
            check(observed.bool("pixel_actions") == false, "Invalid frame never grounds pixels")
            try await refusal("screenshot_required") { try await computer.execute(session: "frame", tool: "computer_act", arguments: actArgs(observed)) }
        }
        let driver = FixtureDriver(), clock = TestClock()
        let computer = NativeComputer(native: driver, now: { clock.read() })
        await driver.configure("failApps")
        await driver.configure("keyboardUnavailable")
        let observed = try await computer.execute(session: "window", tool: "computer_observe", arguments: ["pid": .number(10), "window_id": .number(20)])
        let encoded = String(decoding: try observed.encoded(), as: UTF8.self)
        check(!encoded.contains("protected-value") && !encoded.contains("private-native-token"), "No protected values or SDK tokens escape")
        check(observed.string("observation_id")?.count == 12, "Shared observation reference format")
        try await refusal("invalid_reference") { try await computer.execute(session: "window", tool: "computer_act", arguments: actArgs(observed, ["type": .string("click"), "element_ref": .string("e999")])) }
        try await refusal("invalid_arguments") { try await computer.execute(session: "window", tool: "computer_act", arguments: actArgs(observed, ["type": .string("click"), "x": .number(100), "y": .number(2)])) }
        check(observed.array("available_actions")?.contains(.string("element_click")) == true && observed.array("elements")?[1].object?["element_ref"] == nil, "Advertise supported actions without turning static text into an action")
        check(observed.array("available_actions")?.contains(.string("key")) == false, "Do not advertise ambiguous background keyboard input")
        try await refusal("keyboard_target_unverified") {
            try await computer.execute(session: "window", tool: "computer_act", arguments: actArgs(observed, ["type": .string("key"), "key": .string("cmd+a")]))
        }
        try await refusal("element_action_unavailable") {
            try await computer.execute(session: "window", tool: "computer_act", arguments: actArgs(observed, ["type": .string("type"), "element_ref": .string("e1"), "text": .string("should not type into a button")]))
        }
        check(await driver.counts().0 == 0, "Unavailable actions never reach the driver")
        let click: JSONObject = ["type": .string("click"), "element_ref": .string("e1")]
        _ = try await computer.execute(session: "window", tool: "computer_act", arguments: actArgs(observed, click))
        let delivered = await driver.lastAction()
        check(delivered.string("native_ref") == "private-native-token" && delivered["capture_id"] == nil, "Resolve reference without capture_id")
        try await refusal("stale_observation") { try await computer.execute(session: "window", tool: "computer_act", arguments: actArgs(observed, click)) }
        let another = try await computer.execute(session: "window", tool: "computer_observe", arguments: [:])
        clock.advance()
        try await refusal("stale_observation") { try await computer.execute(session: "window", tool: "computer_act", arguments: actArgs(another, click)) }
        let queried = try await computer.execute(session: "window", tool: "computer_observe", arguments: ["query": .string("protected-value")])
        check(queried.array("elements") == [], "Protected values cannot match queries")
        let failureObservation = try await computer.execute(session: "unknown", tool: "computer_observe", arguments: ["pid": .number(10), "window_id": .number(20)])
        await driver.configure("failAction")
        try await refusal("outcome_unknown") { try await computer.execute(session: "unknown", tool: "computer_act", arguments: actArgs(failureObservation, click)) }
        try await refusal("stale_observation") { try await computer.execute(session: "unknown", tool: "computer_act", arguments: actArgs(failureObservation, click)) }
        await driver.configure("failAction", false)

        let beforeFailedRefresh = try await computer.execute(session: "window", tool: "computer_observe", arguments: [:])
        let actionsBeforeRefresh = await driver.counts().0
        await driver.configure("failObservation")
        try await refusal("fixture") { try await computer.execute(session: "window", tool: "computer_observe", arguments: [:]) }
        try await refusal("stale_observation") { try await computer.execute(session: "window", tool: "computer_act", arguments: actArgs(beforeFailedRefresh, click)) }
        check(await driver.counts().0 == actionsBeforeRefresh, "A failed observation never permits writes with prior references")
        await driver.configure("failObservation", false)
        let refreshed = try await computer.execute(session: "window", tool: "computer_observe", arguments: [:])
        check(refreshed.string("observation_id") != nil && refreshed["observation_id"] != beforeFailedRefresh["observation_id"], "Read recovery issues a fresh observation ID")
        check(await driver.counts().0 == actionsBeforeRefresh, "Read recovery does not replay the rejected write")

        await computer.closeSession("window")
        try await refusal("session_closed") { try await computer.execute(session: "window", tool: "computer_observe", arguments: ["pid": .number(10)]) }
        try await foregroundTests(); try await windowTests(); try await waitTests()
    }
    static func foregroundTests() async throws {
        let window: JSONObject = ["pid": .number(10), "window_id": .number(20)]
        let point: JSONObject = ["type": .string("click"), "x": .number(10), "y": .number(30)]
        let foreground = point.merging(["delivery_mode": .string("foreground"), "modifiers": .array([.string("command")])]) { _, new in new }
        for fault in ["noApps", "moveDuringCapture", "move"] {
            let driver = FixtureDriver()
            let computer = NativeComputer(native: driver)
            if fault != "move" { await driver.configure(fault) }
            let observation = try await computer.execute(session: "fg", tool: "computer_observe", arguments: window)
            if fault == "move" { await driver.configure(fault) }
            try await refusal(fault == "move" ? "focus_changed" : "focus_unavailable") {
                try await computer.execute(session: "fg", tool: "computer_act", arguments: actArgs(observation, foreground))
            }
            check(await driver.counts().0 == 0, "Unverified foreground click never dispatches")
        }
        let driver = FixtureDriver()
        let computer = NativeComputer(native: driver)
        let observation = try await computer.execute(session: "fg", tool: "computer_observe", arguments: window)
        check(observation.array("available_actions")?.contains(.string("pixel_click_foreground")) == true, "Focused screenshot advertises foreground click")
        try await refusal("foreground_required") {
            try await computer.execute(session: "fg", tool: "computer_act", arguments: actArgs(observation, foreground.filter { $0.key != "delivery_mode" }))
        }
        _ = try await computer.execute(session: "fg", tool: "computer_act", arguments: actArgs(observation, foreground))
        let delivered = await driver.lastAction()
        check(delivered.string("delivery_mode") == "foreground" && delivered.array("modifiers") == [.string("cmd")] && delivered.string("capture_id") == "fixture-capture", "Explicit foreground preserves capture and modifier identity")
    }
    static func windowTests() async throws {
        let openArgs: JSONObject = ["bundle_id": .string("dev.abridge.fixture")]
        for caseName in ["focus", "main", "ambiguous"] {
            let openDriver = FixtureDriver()
            await openDriver.configure("watermark")
            if caseName == "focus" { await openDriver.select(focused: 20, main: 21) }
            if caseName == "main" { await openDriver.select(main: 20) }
            let result = try await NativeComputer(native: openDriver).execute(session: "open", tool: "computer_open", arguments: openArgs)
            if caseName == "ambiguous" {
                check(result.object("observation_error")?.string("code") == "window_selection_required", "Ambiguous launch asks the caller to choose")
                check(result.array("window_candidates")?.count == 2 && result["observation"] == nil, "Ambiguous launch returns both window identities")
            } else {
                check(result.object("observation")?.object("window")?.number("window_id") == 20, "Focus or main-window proof outranks a larger overlay")
            }
        }
        let driver = FixtureDriver()
        let targetComputer = NativeComputer(native: driver)
        await driver.configure("offscreen")
        let observed = try await targetComputer.execute(session: "single", tool: "computer_observe", arguments: ["pid": .number(10)])
        check(observed.object("window")?.number("window_id") == 20, "PID-only includes offscreen nonordinary windows")
        await driver.configure("ambiguousWindows")
        let refreshed = try await targetComputer.execute(session: "single", tool: "computer_observe", arguments: ["pid": .number(10)])
        check(refreshed.object("window")?.number("window_id") == 20, "PID-only refresh keeps the already selected window when another appears")
        try await refusal("window_selection_required") { try await targetComputer.execute(session: "new", tool: "computer_observe", arguments: ["pid": .number(10)]) }
        _ = try await targetComputer.execute(session: "single", tool: "computer_observe", arguments: [:])
        check(await driver.lastTarget().number("window_id") == 20, "Refreshing with or without the same PID preserves the complete target")
        let count = await driver.counts().3
        _ = try await targetComputer.execute(session: "explicit", tool: "computer_observe", arguments: ["pid": .number(10), "window_id": .number(21), "screenshot": .bool(false)])
        check(await driver.counts().3 == count, "Explicit target bypasses enumeration")
        await driver.configure("emptyWindows")
        try await refusal("window_unavailable") { try await targetComputer.execute(session: "empty", tool: "computer_observe", arguments: ["pid": .number(10)]) }
        let replaced = FixtureDriver()
        let replacementComputer = NativeComputer(native: replaced)
        let original = try await replacementComputer.execute(session: "replaced", tool: "computer_observe", arguments: ["pid": .number(10)])
        await replaced.configure("move")
        try await refusal("window_id_not_found") { try await replacementComputer.execute(session: "replaced", tool: "computer_observe", arguments: ["pid": .number(10)]) }
        check(await replaced.counts().1 == 1, "A different sole window cannot silently replace a closed selected window")
        try await refusal("stale_observation") { try await replacementComputer.execute(session: "replaced", tool: "computer_act", arguments: actArgs(original)) }
        check(await replaced.counts().0 == 0, "References to the missing window cannot reach the driver")
        let slow = FixtureDriver(); await slow.configure("slowWindows")
        let slowComputer = NativeComputer(native: slow)
        let pending = Task { try await slowComputer.execute(session: "cancel", tool: "computer_observe", arguments: ["pid": .number(10)]) }
        try await Task.sleep(nanoseconds: 20_000_000); pending.cancel()
        try await cancelled { try await pending.value }
        check(await slow.counts().1 == 0, "Cancel during enumeration prevents capture")
        let serial = FixtureDriver()
        let c = NativeComputer(native: serial)
        let obs = try await c.execute(session: "serial", tool: "computer_observe", arguments: ["pid": .number(10), "window_id": .number(20)])
        let a = Task { try await c.execute(session: "serial", tool: "computer_act", arguments: actArgs(obs)) }
        let b = Task { try await c.execute(session: "serial", tool: "computer_act", arguments: actArgs(obs)) }
        let results = await [a.result, b.result]
        let actionCount = await serial.counts().0
        check(results.filter { if case .success = $0 { return true }; return false }.count == 1 && actionCount == 1, "Same-session actions serialize and consume exactly once")
    }
    static func waitTests() async throws {
        for wait in [0.0, 80.0, -1.0] {
            let driver = FixtureDriver()
            let c = NativeComputer(native: driver)
            let obs = try await c.execute(session: "wait", tool: "computer_observe", arguments: ["pid": .number(10), "window_id": .number(20)])
            let start = monotonicSeconds()
            let result = try await c.execute(session: "wait", tool: "computer_act", arguments: actArgs(obs, follow: true, wait: wait < 0 ? nil : wait))
            check(result.object("observation") != nil, "Nested post-act observation")
            check(monotonicSeconds() - start >= (wait < 0 ? 1.9 : wait / 1000 * 0.9), "Configured/default wait after delivery")
        }
        for close in [false, true] {
            let driver = FixtureDriver(); let c = NativeComputer(native: driver)
            let obs = try await c.execute(session: "wait", tool: "computer_observe", arguments: ["pid": .number(10), "window_id": .number(20)])
            let pending = Task { try await c.execute(session: "wait", tool: "computer_act", arguments: actArgs(obs, follow: true, wait: 5000)) }
            while await driver.counts().0 == 0 { try await Task.sleep(nanoseconds: 1_000_000) }
            if close { await c.closeSession("wait") } else { pending.cancel() }
            let result = try await pending.value
            check(result.bool("action_executed") == true && result.object("observation_error") != nil, "Cancelled followup retains delivery evidence")
            let counts = await driver.counts()
            check(counts.0 == 1 && counts.1 == 1, "No repeat action or late capture")
        }
    }
    static func fileTests() async throws {
        let directory = NSTemporaryDirectory() + "abridge-native-files-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let executor = NativeExecutor(native: FixtureDriver())
        func run(_ tool: String, _ args: JSONObject) async throws -> JSONObject { try await executor.execute(id: UUID().uuidString, session: "files", tool: tool, arguments: args) }
        let path = directory + "/b"
        try await refusal("execution_failed") { try await run("file_read", ["path": .string(directory + "/missing")]) }
        try await refusal("invalid_cwd") { try await run("command_execute", ["command": .string("echo must-not-run"), "cwd": .string(directory + "/missing")]) }
        _ = try await run("file_write", ["path": .string(path), "content": .string("😀 中文")])
        check(try await run("file_read", ["path": .string(path)]).string("content") == "😀 中文", "Strict UTF8 roundtrip")
        try await refusal("execution_failed") { try await run("file_write", ["path": .string(path), "content": .string("bad")]) }
        try Data([0xff]).write(to: URL(fileURLWithPath: directory + "/binary"))
        try await refusal("unsupported_encoding") { try await run("file_read", ["path": .string(directory + "/binary")]) }
        try await refusal("file_too_large") { try await run("file_read", ["path": .string(path), "max_bytes": .number(1)]) }
        try await refusal("unsupported_file_type") { try await run("file_read", ["path": .string(directory)]) }
        let link = directory + "/a"; check(symlink(path, link) == 0, "Create fixture symlink")
        _ = try await run("file_write", ["path": .string(link), "content": .string("replacement"), "overwrite": .bool(true)])
        check(try await run("file_read", ["path": .string(path)]).string("content") == "replacement", "Regular symlink overwrite")
        let list = try await run("files_list", ["path": .string(directory), "limit": .number(2)])
        check(list.bool("truncated") == true && list.array("entries")?.count == 2, "Bounded listings")
        let fifo = directory + "/fifo"; check(mkfifo(fifo, 0o600) == 0, "Create fixture FIFO")
        try await refusal("unsupported_file_type") { try await run("file_read", ["path": .string(fifo)]) }
        try await refusal("execution_failed") { try await run("file_write", ["path": .string(fifo), "content": .string("bad"), "overwrite": .bool(true)]) }
        let peer = Darwin.open(fifo, O_RDWR | O_NONBLOCK); defer { Darwin.close(peer) }
        try await refusal("unsupported_file_type") { try await run("file_write", ["path": .string(fifo), "content": .string("bad"), "overwrite": .bool(true)]) }
        await executor.shutdown()
    }
    static func shellTests() async throws {
        let collector = OutputCollector()
        let executor = NativeExecutor(native: FixtureDriver(), output: { _, stream, text in await collector.append(stream, text) })
        setenv("ABRIDGE_TEST_PARENT_SECRET", "must-not-inherit", 1)
        defer { unsetenv("ABRIDGE_TEST_PARENT_SECRET") }
        let unicode = try await executor.execute(id: "unicode", session: "shell", tool: "command_execute", arguments: ["command": .string("printf '\\360\\237'; sleep 0.02; printf '\\230\\200 中文'; printf error >&2; printf \"${ABRIDGE_TEST_PARENT_SECRET-unset}\" >&2")])
        check(unicode.string("stdout") == "😀 中文" && unicode.string("stderr") == "errorunset", "Shell UTF8 and restricted environment")
        check(await collector.value("stdout") == "😀 中文", "Streaming decoder preserves split UTF8")
        let bounded = try await executor.execute(id: "bounded", session: "shell", tool: "command_execute", arguments: ["command": .string("head -c 180000 /dev/zero | tr '\\0' x; head -c 180000 /dev/zero | tr '\\0' y >&2")])
        check(bounded.string("stdout")?.utf8.count == 131072 && bounded.string("stderr")?.utf8.count == 131072 && bounded.bool("truncated") == true, "Both streams bounded")
        let directory = NSTemporaryDirectory() + "abridge-native-shell-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        for mode in ["timeout", "cancel", "normal"] {
            let pidFile = directory + "/" + mode
            let cmd = "sleep 30 & echo $! > '" + pidFile + "'; " + (mode == "normal" ? "exit 0" : "wait")
            let pending = Task { try await executor.execute(id: mode, session: "shell", tool: "command_execute", arguments: ["command": .string(cmd), "timeout": .number(0.2)]) }
            let pid = try await fixturePID(pidFile)
            if mode == "cancel" { pending.cancel(); try await cancelled { try await pending.value } }
            else { let result = try await pending.value; check(result.bool("timed_out") == (mode == "timeout"), "Timeout distinguished from ordinary completion") }
            var alive = true
            for _ in 0..<50 { alive = Darwin.kill(pid, 0) == 0; if !alive { break }; try await Task.sleep(nanoseconds: 20_000_000) }
            check(!alive, "Descendant process group cleaned: \(mode)")
        }
        let shell = Task { try await executor.execute(id: "independent", session: "independent", tool: "command_execute", arguments: ["command": .string("sleep 0.1; printf survived")]) }
        await executor.stopComputer()
        check(try await shell.value.string("stdout") == "survived", "Disabling computer does not cancel independent shell")
        await executor.shutdown()
    }
}
