import Foundation

actor AdmissionDriver: DesktopNativeDriver {
    private var gates: [String] = []
    private var observationGate: String?
    private var heldAfterCancel: String?
    private var heldContinuation: CheckedContinuation<Void, Never>?
    private var nextAction: (id: String, confirm: Bool)?
    func simulateAction(_ id: String, confirm: Bool) { nextAction = (id, confirm) }
    private var failure: String?
    func fail(_ mode: String) { failure = mode }
    private var waiting = Set<String>()
    private var released = Set<String>()
    func arm(_ id: String, observation: Bool, holdAfterCancel: Bool) {
        if observation { observationGate = id } else { gates.append(id) }
        if holdAfterCancel { heldAfterCancel = id }
    }
    func releaseGate(_ id: String) {
        released.insert(id)
        if id == heldAfterCancel { heldContinuation?.resume(); heldContinuation = nil; heldAfterCancel = nil }
    }
    func releaseAll() { for id in gates + Array(waiting) { releaseGate(id) }; gates.removeAll() }
    private func waitAtGate(_ id: String) async throws {
        waiting.insert(id); defer { waiting.remove(id) }
        emitJSON(["event": .string("entered"), "id": .string(id)])
        do { while !released.contains(id) { try await sleepMilliseconds(5) } }
        catch {
            if heldAfterCancel == id {
                emitJSON(["event": .string("cancelling"), "id": .string(id)])
                await withCheckedContinuation { heldContinuation = $0 }
            }
            throw error
        }
    }
    func diagnostics(initialize: Bool) async -> JSONObject {
        if initialize, !gates.isEmpty { try? await waitAtGate(gates.removeFirst()) }
        return ["driver": .object(["ready": .bool(true)]), "permissions": .object(["screen": .bool(true), "input": .bool(true)])]
    }
    private func throwFailure() throws {
        guard let failure else { return }
        emitJSON(["event": .string("effect"), "id": .string(failure)])
        if failure == "generic" {
            throw NSError(domain: "fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "private fixture command"])
        }
        if failure == "permission_denied" {
            _ = try NativeDriver.decodeReply(["isError": .bool(true), "structuredContent": .object([
                "code": .string(failure), "message": .string("private fixture driver detail")
            ])].encoded())
        }
        throw DesktopError(code: failure, message: "private fixture driver detail", outcome: "outcome_unknown")
    }
    func apps() async throws -> [JSONObject] { try throwFailure(); return [] }
    func windows(pid: Double?) async throws -> [JSONObject] { try throwFailure(); return [] }
    func focusedWindow(pid: Double, candidates: [JSONObject]) async throws -> Double? { nil }
    func open(bundleID: String) async throws { throw DesktopError(code: "fixture_forbidden", message: "No real applications in fixture") }
    func observe(session: String, target: JSONObject, screenshot: Bool) async throws -> JSONObject {
        if let id = observationGate { observationGate = nil; try await waitAtGate(id) }
        try throwFailure()
        return [
            "elements": .array([.object(["token": .string("fixture-token"), "role": .string("AXButton"), "actions": .array([.string("AXPress")])])]),
            "background_input": .object(["routes": .array([.object(["route": .string("accessibility"), "status": .string("available")])])])
        ]
    }
    func act(session: String, action: JSONObject) async throws -> JSONObject {
        try throwFailure()
        if let simulation = nextAction {
            nextAction = nil
            if !simulation.confirm { try await waitAtGate(simulation.id) }
            emitJSON(["event": .string("delivered"), "id": .string(simulation.id)])
            return ["action_executed": .bool(true), "business_verified": .bool(false), "summary": .string("private action summary")]
        }
        throw DesktopError(code: "fixture_forbidden", message: "No real input in fixture")
    }
    func release(session: String) async {}
    func shutdown() async { releaseAll() }
}

@main struct AdmissionFixture {
    static func main() async throws {
        let storage = NativeStorage(stateDir: CommandLine.arguments[1])
        let config = try storage.configure(url: CommandLine.arguments[2], key: "abr_device_fixture", capabilities: ["files": true, "screen": true, "input": true])
        let driver = AdmissionDriver()
        // Use a dedicated injected driver so no real desktop SDK is initialized.
        let client = DeviceClient(storage: storage, config: config, key: "abr_device_fixture", contract: try NativeContract.load(), executor: NativeExecutor(native: driver))
        let running = Task.detached { try await client.run() }
        while let line = readLine() {
            guard let command = try JSONValue.decode(Data(line.utf8)).object else { continue }
            let id = command.string("id") ?? ""
            switch command.string("command") {
            case "fail": await driver.fail(id); emitJSON(["event": .string("failed"), "id": .string(id)])
            case "arm": await driver.arm(id, observation: command.bool("observation") == true, holdAfterCancel: command.bool("holdAfterCancel") == true); emitJSON(["event": .string("armed"), "id": .string(id)])
            case "action": await driver.simulateAction(id, confirm: command.bool("confirm") == true); emitJSON(["event": .string("armed"), "id": .string(id)])
            case "release": await driver.releaseGate(id); emitJSON(["event": .string("released"), "id": .string(id)])
            case "control":
                do { emitJSON(["event": .string("control"), "id": .string(id), "result": .object(try await client.control(command.object("request") ?? [:]))]) }
                catch { emitJSON(["event": .string("control"), "id": .string(id), "error": .object(jsonError(error))]) }
            case "snapshot": emitJSON(["event": .string("snapshot"), "id": .string(id), "result": .object(await client.snapshot())])
            case "stop": await driver.releaseAll(); await client.stop(); try await running.value; return
            default: break
            }
        }
        await driver.releaseAll(); await client.stop(); try await running.value
    }
}
