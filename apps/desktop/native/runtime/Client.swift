import Foundation
import Darwin

private let deviceCredentialRejected = "设备凭证无效或已撤销，请重新绑定这台 Mac"

private func systemDetails() -> JSONObject {
    let info = ProcessInfo.processInfo
    let version = info.operatingSystemVersion
    var fields = [
        "os": "macos",
        "os_version": "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
        "runtime_user": NSUserName(),
    ]
    #if arch(arm64)
    fields["architecture"] = "arm64"
    #elseif arch(x86_64)
    fields["architecture"] = "x86_64"
    #endif
    // Read the kernel hostname without resolving it during the handshake.
    var hostname = [CChar](repeating: 0, count: Int(MAXHOSTNAMELEN) + 1)
    if gethostname(&hostname, hostname.count) == 0, hostname.last == 0 {
        fields["hostname"] = hostname.withUnsafeBufferPointer { String(validatingCString: $0.baseAddress!) }
    }
    var model = [CChar](repeating: 0, count: 129)
    var size = model.count
    if sysctlbyname("hw.model", &model, &size, nil, 0) == 0, size > 0, size <= model.count, model[size - 1] == 0 {
        fields["model"] = model.withUnsafeBufferPointer { String(validatingCString: $0.baseAddress!) }
    }
    return fields.compactMapValues { value in
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= 128, text.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        return .string(text)
    }
}

actor DeviceClient {
    private enum ConnectionFailure: Error {
        case revoked(String)
        case unavailable(String)
    }
    private enum CancellationSource { case caller, stop }
    private struct Admission {
        let hash: String, session: String
        let capabilities: Set<String>
        let connection: UUID
        var cancelled = false
    }
    private struct Running {
        let session: String, client: String
        let capabilities: Set<String>
        let task: Task<Void, Never>
        var cancellation: CancellationSource?
    }
    private let storage: NativeStorage
    private let contract: NativeContract
    private var config: ClientConfig
    private var key: String
    private let parentPid: Int32?
    private var executor: NativeExecutor!
    private var journal: OperationJournal?
    private var controlServer: LocalControlServer?
    private var socket: URLSessionWebSocketTask?
    private var connection = UUID()
    private var epoch = 0.0, sequence = 0.0, lastAck = 0.0, lease = 30.0
    private var deviceId = "", deviceName = "", owner = "", status = "offline", error = ""
    private var serverCapabilities: Set<String> = [], closedSessions: Set<String> = []
    private var admissions: [String: Admission] = [:], operations: [String: Running] = [:]
    private var stopping = false, unbindAcknowledged = false
    private var maintenance: Task<Void, Never>?
    private var statusWrite: Task<Void, Error>?

    init(storage: NativeStorage, config: ClientConfig, key: String, contract: NativeContract, parentPid: Int32? = nil, executor: NativeExecutor? = nil) {
        self.storage = storage; self.config = config; self.key = key; self.contract = contract; self.parentPid = parentPid; self.executor = executor
    }
    func run() async throws {
        if executor == nil { executor = NativeExecutor(output: { [weak self] id, stream, data in await self?.output(id, stream, data) }) }
        controlServer = try await LocalControlServer.start(stateDir: storage.stateDir) { [weak self] request in
            guard let self else { throw DesktopError(code: "device_offline", message: "Client stopped") }
            return try await self.control(request)
        }
        do {
            journal = try OperationJournal(path: storage.stateDir + "/operations.sqlite3")
            maintenance = Task { [weak self] in
                while !Task.isCancelled {
                    try? await sleepMilliseconds(500)
                    guard !Task.isCancelled, let self else { return }
                    await self.maintain()
                }
            }
            var backoff = 1.0
            while !stopping {
                if config.revoked == true { try? await sleepMilliseconds(100); continue }
                do { try await connect(); backoff = 1 }
                catch {
                    if !stopping && status != "revoked" {
                        switch error as? ConnectionFailure {
                        case .revoked(let message)?:
                            config.revoked = true; try storage.saveConfig(config); status = "revoked"
                            self.error = message
                        case .unavailable(let message)?:
                            status = "offline"; self.error = message
                        case nil:
                            status = "offline"; self.error = "设备连接失败，请检查 Server 地址、网络及服务状态"
                        }
                    }
                }
                await stopOperations(); await executor.stop(); try await writeStatus()
                let deadline = monotonicSeconds() + backoff
                while !stopping && config.revoked != true && monotonicSeconds() < deadline { try? await sleepMilliseconds(100) }
                backoff = min(backoff * 2, 15)
            }
        } catch { await cleanup(); throw error }
        await cleanup()
    }
    private func cleanup() async {
        stopping = true; maintenance?.cancel(); socket?.cancel(with: .goingAway, reason: nil)
        await maintenance?.value; maintenance = nil
        await stopOperations(); status = "offline"; try? await writeStatus()
        await executor.shutdown(); await controlServer?.close(); journal?.close()
    }
    func stop() { stopping = true; socket?.cancel(with: .goingAway, reason: nil) }
    private func maintain() async {
        if let parentPid, getppid() != parentPid { stop() }
        if status == "online", monotonicSeconds() - lastAck >= lease { socket?.cancel(with: .goingAway, reason: nil) }
        do { try await writeStatus() } catch { socket?.cancel(with: .goingAway, reason: nil) }
    }
    private func capabilities() async -> JSONObject {
        let needsNative = config.capabilities["screen"] == true || config.capabilities["input"] == true
        let diagnostics = needsNative ? await executor.diagnostics() : [:]
        let ready = diagnostics.object("driver")?.bool("ready") == true
        return Dictionary(uniqueKeysWithValues: contract.capabilities.map { capability in
            var enabled = contract.desktopCapabilities.contains(capability) && config.capabilities[capability] == true
            if capability == "screen" || capability == "input" { enabled = enabled && ready && diagnostics.object("permissions")?.bool(capability) == true }
            return (capability, .bool(enabled))
        })
    }
    private func connect() async throws {
        var components = URLComponents(string: config.url)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path += "/ws/device"
        var request = URLRequest(url: components.url!); request.timeoutInterval = 10
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let session = deviceServerSession()
        let ws = session.webSocketTask(with: request)
        ws.maximumMessageSize = Int(contract.limit("messageBytes"))
        let identity = UUID(); connection = identity; socket = ws; status = "connecting"
        defer { ws.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel(); if connection == identity { socket = nil } }
        do {
            try await writeStatus(); ws.resume()
            let caps = await capabilities()
            try await send(["type": .string("hello"), "protocol": .string(contract.protocolVersion), "platform": .string("darwin"), "version": .string(contract.version), "capabilities": .object(caps), "paused": .bool(config.paused), "details": .object(systemDetails())])
            let frame = try await next(ws, timeout: 10)
            guard let welcome = try? contract.validate("welcome", frame) else {
                throw ConnectionFailure.unavailable("Server 返回了不兼容的设备握手响应，请检查 Server 和 Mac 客户端版本")
            }
            epoch = welcome.number("connection_epoch")!; deviceId = welcome.string("device_id")!
            deviceName = welcome.string("device_name") ?? ""; owner = welcome.string("owner_name")!
            sequence = 0; closedSessions.removeAll(); lastAck = monotonicSeconds()
            lease = min(contract.limit("leaseSeconds"), max(1, welcome.number("lease_seconds")!))
            serverCapabilities = Set(welcome.array("capabilities")!.compactMap(\.string))
            status = "online"; error = ""; try await writeStatus()
            let heartbeat = Task { [weak self] in
                while !Task.isCancelled {
                    try? await sleepMilliseconds((self?.contract.limit("heartbeatSeconds") ?? 10) * 1000)
                    guard !Task.isCancelled, let self else { return }
                    do { try await self.heartbeat(identity) } catch { ws.cancel(with: .goingAway, reason: nil); return }
                }
            }
            defer { heartbeat.cancel() }
            while !stopping && config.revoked != true {
                let frame = try await next(ws, timeout: lease)
                try await receive(frame)
            }
        } catch {
            throw connectionFailure(error, socket: ws)
        }
    }
    /// 连接状态只发布本机定义的诊断，HTTP 响应正文和 WebSocket 关闭原因始终留在传输层。
    private func connectionFailure(_ cause: Error, socket ws: URLSessionWebSocketTask) -> ConnectionFailure {
        if let failure = cause as? ConnectionFailure { return failure }
        if let failure = cause as? DesktopError, failure.code == "status_write_failed" {
            return .unavailable(failure.message)
        }
        let responseStatus = (ws.response as? HTTPURLResponse)?.statusCode
        let message: String
        if responseStatus == 401 { return .revoked("\(deviceCredentialRejected)（HTTP 401）") }
        if responseStatus == 403 {
            return .revoked("Server 拒绝了设备连接（HTTP 403），请检查 Server 和反向代理的访问规则后重新绑定这台 Mac")
        }
        if status == "connecting", let code = responseStatus, code != 101 {
            switch code {
            case 200..<300, 400, 404, 426:
                message = "Server 未建立 WebSocket 连接，请检查 Server 地址和反向代理的 WebSocket 转发（HTTP \(code)）"
            default:
                message = deviceServerHTTPFailure(code)
            }
        } else if status == "online", monotonicSeconds() - lastAck >= lease {
            message = "等待 Server 心跳确认超时，请检查网络及 Server 是否运行"
        } else if let network = cause as? URLError, network.code != .cancelled {
            if status == "connecting", [.badServerResponse, .cannotParseResponse].contains(network.code) {
                message = "Server 返回了无效的 WebSocket 握手响应，请检查 Server 地址和反向代理的 WebSocket 转发"
            } else {
                message = deviceServerNetworkFailure(network)
            }
        } else if status == "connecting" {
            message = "设备连接握手未完成，请检查 Server 及反向代理的 WebSocket 配置"
        } else {
            message = "与 Server 的设备连接中断，请检查网络及 Server 是否运行"
        }
        return .unavailable(message)
    }
    private func next(_ ws: URLSessionWebSocketTask, timeout: Double) async throws -> JSONObject {
        let timer = Task { try await sleepMilliseconds(timeout * 1000); ws.cancel(with: .goingAway, reason: nil) }
        defer { timer.cancel() }
        let message = try await ws.receive()
        let bytes: Data
        let invalid = ConnectionFailure.unavailable("Server 发送了无效的设备消息，请检查 Server 和 Mac 客户端版本")
        switch message {
        case .data(let data): bytes = data
        case .string(let text): bytes = Data(text.utf8)
        @unknown default: throw invalid
        }
        guard bytes.count <= Int(contract.limit("messageBytes")), let frame = (try? JSONValue.decode(bytes))?.object else { throw invalid }
        return frame
    }
    private func send(_ value: JSONObject) async throws {
        guard let ws = socket else { throw DesktopError(code: "device_offline", message: "Device is offline") }
        let timer = Task { try await sleepMilliseconds(5000); ws.cancel(with: .goingAway, reason: nil) }; defer { timer.cancel() }
        try await ws.send(.string(String(decoding: try value.encoded(), as: UTF8.self)))
    }
    private func output(_ id: String, _ stream: String, _ data: String) async {
        guard operations[id] != nil else { return }
        do { try await send(["type": .string("output"), "operation_id": .string(id), "connection_epoch": .number(epoch), "stream": .string(stream), "data": .string(data)]) }
        catch { socket?.cancel(with: .goingAway, reason: nil) }
    }
    private func heartbeat(_ identity: UUID? = nil) async throws {
        let caps = await capabilities()
        if let identity, identity != connection { return }
        try await send(["type": .string("heartbeat"), "connection_epoch": .number(epoch), "capabilities": .object(caps), "paused": .bool(config.paused)])
    }
    private func receive(_ frame: JSONObject) async throws {
        guard frame.number("connection_epoch") == epoch else { return }
        switch frame.string("type") {
        case "heartbeat_ack":
            lastAck = monotonicSeconds()
            if let name = try? contract.validate("deviceRename", ["name": frame["device_name"] ?? .null]).string("name") { deviceName = name }
        case "dispatch":
            let identity = connection
            Task { do { try await self.dispatch(frame) } catch { self.failConnection(identity) } }
        case "cancel":
            let caller = try? contract.validate("cancel", frame).string("caller_operation_id")
            await stopOperations(Set((frame.array("operation_ids") ?? []).compactMap(\.string)), callerOperationID: caller, wait: false)
        case "session_close":
            if let id = frame.string("session_id") {
                closedSessions.insert(id)
                await stopOperations(Set(operations.filter { $0.value.session == id }.keys).union(admissions.filter { $0.value.session == id }.keys))
                await executor.closeSession(id)
            }
        case "stop": await stopOperations(); await executor.stop()
        case "revoke":
            config.revoked = true; try storage.saveConfig(config); status = "revoked"
            error = "设备授权已撤销，请重新绑定这台 Mac"; unbindAcknowledged = true
            await stopOperations(); socket?.cancel(with: .goingAway, reason: nil)
        default: break
        }
    }
    private func failConnection(_ identity: UUID) { if connection == identity { socket?.cancel(with: .goingAway, reason: nil) } }
    private func refuse(_ id: String, _ code: String, _ message: String) async throws {
        try await send(["type": .string("result"), "operation_id": .string(id), "connection_epoch": .number(epoch), "status": .string("refused"), "result": .object([:]), "error": .object(["code": .string(code), "message": .string(message)])])
    }
    private func dispatch(_ raw: JSONObject) async throws {
        guard let frame = try? contract.validate("operation", raw) else {
            if let id = raw.string("operation_id") { try await refuse(id, "invalid_dispatch", "Invalid operation frame") }; return
        }
        let id = frame.string("operation_id")!, session = frame.string("session_id")!, tool = frame.string("tool")!, arguments = frame.object("arguments")!
        let identityPattern = "^[A-Za-z0-9_-]{1,100}$"
        guard id.range(of: identityPattern, options: .regularExpression) != nil, session.range(of: identityPattern, options: .regularExpression) != nil else { try await refuse(id, "invalid_dispatch", "Invalid operation identity"); return }
        guard frame.number("connection_epoch") == epoch, frame.string("device_id") == deviceId else { return }
        guard status == "online", monotonicSeconds() - lastAck < lease else { socket?.cancel(with: .goingAway, reason: nil); return }
        let expires = frame.number("expires_at")!
        guard expires >= epochSeconds(), expires <= epochSeconds() + contract.limit("operationStartSeconds") + contract.limit("operationGraceSeconds") else { try await refuse(id, "dispatch_expired", "Operation start deadline expired"); return }
        guard !tool.hasPrefix("browser_") else { try await refuse(id, "capability_unavailable", "Use an independent browser device"); return }
        let hash = sha256(try ["tool": JSONValue.string(tool), "arguments": .object(arguments), "session_id": .string(session)].encoded())
        let prior = try journal!.get(id)
        let pending = admissions[id]
        if let priorHash = prior?.requestHash ?? pending?.hash {
            let priorStatus = prior?.status ?? "executing", conflict = priorHash != hash
            try await send(["type": .string("result"), "operation_id": .string(id), "connection_epoch": .number(epoch), "status": .string(conflict ? "refused" : priorStatus == "executing" ? "outcome_unknown" : priorStatus), "result": .object(["deduplicated": .bool(true), "prior_status": .string(priorStatus)]), "error": .object(["code": .string(conflict ? "idempotency_conflict" : "duplicate_operation"), "message": .string("Operation identity was already accepted; its effect will not be replayed")])]); return
        }
        guard frame.number("sequence")! > sequence else { try await refuse(id, "stale_sequence", "Operation sequence is stale"); return }
        sequence = frame.number("sequence")!
        guard !config.paused, config.revoked != true else { try await refuse(id, "device_paused", "Local access is paused"); return }
        guard !closedSessions.contains(session) else { try await refuse(id, "session_closed", "This session is closed"); return }
        guard Double(operations.count + admissions.count) < contract.limit("operations") else { try await refuse(id, "device_busy", "Device operation limit reached"); return }
        let required = contract.requiredCapabilities(tool, arguments), identity = connection
        admissions[id] = Admission(hash: hash, session: session, capabilities: required, connection: identity)
        defer { if admissions[id]?.connection == identity { admissions.removeValue(forKey: id) } }
        let caps = await capabilities()
        guard identity == connection, frame.number("connection_epoch") == epoch else { return }
        guard admissions[id]?.cancelled == false else { try await refuse(id, "operation_cancelled", "Operation stopped before execution"); return }
        let sessionCaps = Set(frame.array("session_capabilities")!.compactMap(\.string))
        guard required.allSatisfy({ caps.bool($0) == true && serverCapabilities.contains($0) && sessionCaps.contains($0) && config.capabilities[$0] == true }) else { try await refuse(id, "capability_unavailable", "Required capability is unavailable"); return }
        guard !config.paused, config.revoked != true, !closedSessions.contains(session), status == "online", monotonicSeconds() - lastAck < lease else { try await refuse(id, "device_paused", "Local access stopped during admission"); return }
        guard expires > epochSeconds() else { try await refuse(id, "dispatch_expired", "Operation start deadline expired during admission"); return }
        let parsed: JSONObject
        do { parsed = try contract.validate(tool, arguments) } catch { try await refuse(id, "invalid_arguments", "Arguments do not match the device protocol"); return }
        try journal!.start(id: id, hash: hash)
        let task = Task { await self.execute(frame, arguments: parsed, connection: identity) }
        operations[id] = Running(session: session, client: frame.string("client_name") ?? "MCP Agent", capabilities: required, task: task)
        admissions.removeValue(forKey: id)
        try await writeStatus()
    }
    private func execute(_ frame: JSONObject, arguments: JSONObject, connection identity: UUID) async {
        let id = frame.string("operation_id")!, tool = frame.string("tool")!
        var result: JSONObject = [:], outcome = "executed", failure: JSONObject?
        do {
            try Task.checkCancellation()
            result = try await executor.execute(id: id, session: frame.string("session_id")!, tool: tool, arguments: arguments)
            guard let running = operations[id], !config.paused, config.revoked != true, !stopping,
                  status == "online", socket != nil, identity == self.connection, monotonicSeconds() - lastAck < lease,
                  !closedSessions.contains(running.session), running.capabilities.allSatisfy({ config.capabilities[$0] == true && serverCapabilities.contains($0) }) else { throw CancellationError() }
            if Task.isCancelled {
                guard running.cancellation == .caller, tool == "computer_act", result.bool("action_executed") == true else { throw CancellationError() }
                result = ["action_executed": .bool(true), "business_verified": .bool(false)]
                if arguments.bool("observe_after") != false || arguments.bool("screenshot") == true {
                    result["observation_error"] = .object(["code": .string("operation_cancelled"), "message": .string("Action delivered; follow-up observation unavailable after cancellation")])
                }
            }
        } catch {
            let nativeFailure = error as? DesktopError
            let cancelled = Task.isCancelled || error is CancellationError || nativeFailure?.code == "operation_cancelled"
            let timedOut = nativeFailure?.code == "driver_timeout"
            let screenRead = operations[id]?.capabilities == ["screen"]
            if cancelled && screenRead {
                outcome = "cancelled"
                failure = ["code": .string("operation_cancelled"), "message": .string("The desktop read was cancelled")]
            } else if let nativeFailure, !cancelled, ["refused", "failed"].contains(nativeFailure.outcome), nativeFailure.code != "outcome_unknown" {
                outcome = nativeFailure.outcome
                failure = nativeFailure.json
            } else if screenRead {
                outcome = "failed"
                failure = [
                    "code": .string(timedOut ? "driver_timeout" : "driver_error"),
                    "message": .string(timedOut ? "The desktop driver timed out while reading desktop state" : "The desktop driver could not read desktop state"),
                ]
            } else {
                outcome = "outcome_unknown"
                let causeCode = cancelled ? "operation_cancelled" : timedOut ? "execution_timeout" : nativeFailure != nil ? "execution_unconfirmed" : "execution_error"
                failure = ["code": .string(cancelled ? "operation_cancelled" : "outcome_unknown"), "message": .string("Execution result is unknown; the operation will not be replayed"), "cause": .object(["code": .string(causeCode), "message": .string(cancelled ? "Execution was interrupted by cancellation" : "The device could not confirm execution")])]
            }
            result = [:]
        }
        do {
            try journal!.finish(id: id, status: outcome)
            operations.removeValue(forKey: id)
            guard identity == connection, frame.number("connection_epoch") == epoch else { return }
            var response: JSONObject = ["type": .string("result"), "operation_id": .string(id), "connection_epoch": .number(epoch), "status": .string(outcome), "result": .object(result)]
            if let failure { response["error"] = .object(failure) }
            try await send(response)
            try await writeStatus()
        } catch { operations.removeValue(forKey: id); failConnection(identity) }
    }
    private func stopOperations(_ ids: Set<String>? = nil, callerOperationID: String? = nil, wait: Bool = true) async {
        for id in admissions.keys where ids == nil || ids!.contains(id) { admissions[id]?.cancelled = true }
        let selected = operations.filter { ids == nil || ids!.contains($0.key) }
        for (id, operation) in selected {
            if operation.cancellation != .stop { operations[id]?.cancellation = id == callerOperationID ? .caller : .stop }
            operation.task.cancel()
        }
        if wait { for operation in selected.values { await operation.task.value } }
    }
    func control(_ request: JSONObject) async throws -> JSONObject {
        switch request.string("command") {
        case "status": return await snapshot()
        case "pause":
            if request.bool("if_desktop_active") == true && !operations.values.contains(where: { $0.capabilities.contains("input") }) { return ["ignored": .bool(true)] }
            config.paused = true; config.pauseReason = request.bool("if_desktop_active") == true || request.string("reason") == "desktop_input" ? "desktop_input" : "manual"
            try storage.saveConfig(config); await stopOperations(); await executor.stop()
        case "resume":
            var next = config; next.paused = false; next.pauseReason = nil; try storage.saveConfig(next); config = next
        case "stop": await stopOperations(); await executor.stop(); try? await send(["type": .string("local_stop"), "connection_epoch": .number(epoch)])
        case "capability":
            guard let cap = request.string("capability"), contract.desktopCapabilities.contains(cap), let enabled = request.bool("enabled") else { throw DesktopError(code: "invalid_arguments", message: "Unknown desktop capability") }
            var next = config; next.capabilities[cap] = enabled
            if !enabled { config = next }; try storage.saveConfig(next); config = next
            if !enabled {
                await stopOperations(Set(operations.filter { $0.value.capabilities.contains(cap) }.keys).union(admissions.filter { $0.value.capabilities.contains(cap) }.keys))
                // Close desktop sessions without cancelling independent shell/file work.
                if cap == "screen" || cap == "input" { await executor.stopComputer() }
            }
        case "rename":
            try await rename(request["name"] ?? .null)
        case "unbind":
            config.paused = true; config.revoked = true; try storage.saveConfig(config); try storage.deleteCredential(); await stopOperations()
            unbindAcknowledged = false
            if socket != nil {
                try? await send(["type": .string("unbind"), "connection_epoch": .number(epoch)])
                let deadline = monotonicSeconds() + 5
                while !unbindAcknowledged && socket != nil && monotonicSeconds() < deadline { try? await sleepMilliseconds(50) }
            }
            key = ""; stop(); return ["unbound": .bool(true), "cloud_revoked": .bool(unbindAcknowledged)]
        default: throw DesktopError(code: "invalid_arguments", message: "Unknown local command")
        }
        try await writeStatus(); if status == "online" { try? await heartbeat() }
        return await snapshot()
    }
    /// 改名请求的网络和响应错误只通过本机定义的消息返回给 UI。
    private func rename(_ name: JSONValue) async throws {
        let body = try contract.validate("deviceRename", ["name": name])
        guard status == "online", !key.isEmpty, !deviceId.isEmpty, config.revoked != true else {
            throw DesktopError(code: "device_offline", message: "请连接 Server 后再修改设备名称")
        }
        var request = URLRequest(url: URL(string: config.url + "/api/device")!, timeoutInterval: 10)
        request.httpMethod = "PATCH"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try body.encoded()
        let session = deviceServerSession()
        defer { session.invalidateAndCancel() }
        let failure = { (detail: String) in DesktopError(code: "rename_failed", message: "修改设备名称失败。\(detail)") }
        do {
            let (stream, response) = try await session.bytes(for: request)
            guard let code = (response as? HTTPURLResponse)?.statusCode else {
                throw failure("Server 返回了无效响应，请检查 Server 地址")
            }
            guard code == 200 else {
                throw failure(code == 401 ? "\(deviceCredentialRejected)（HTTP 401）" : deviceServerHTTPFailure(code))
            }
            var bytes = Data()
            for try await byte in stream {
                guard bytes.count < 65536 else { throw failure("Server 响应过大，请检查 Server 地址和版本") }
                bytes.append(byte)
            }
            guard let value = (try? JSONValue.decode(bytes))?.object,
                  let result = try? contract.validate("deviceRenameResult", value) else {
                throw failure("Server 返回了无效的设备名称响应，请检查 Server 版本")
            }
            guard result.string("id") == deviceId else {
                throw failure("Server 返回了其他设备的响应，请确认绑定的 Server 地址")
            }
            deviceName = result.string("name")!
        } catch let error as URLError {
            throw failure(deviceServerNetworkFailure(error))
        } catch let error as DesktopError {
            throw error
        } catch {
            throw failure("无法与 Server 通信，请检查网络及 Server 是否运行")
        }
    }
    func snapshot() async -> JSONObject {
        let caps = await capabilities(), diagnostics = await executor.diagnostics(initialize: false)
        let active = Array(operations.values)
        var result: JSONObject = ["connection": .string(status), "paused": .bool(config.paused), "pause_reason": .string(config.pauseReason ?? ""), "capabilities": .object(caps), "requested_capabilities": .object(config.capabilities.mapValues(JSONValue.bool)), "active_operations": .number(Double(active.count)), "active_controllers": .array(Set(active.map(\.client)).sorted().map(JSONValue.string)), "desktop_active_until": .number(active.contains { $0.capabilities.contains("input") } ? epochSeconds() + 30 : 0), "url": .string(config.url), "error": .string(error), "device_id": .string(deviceId), "device_name": .string(deviceName), "owner_name": .string(owner), "updated_at": .number(epochSeconds())]
        result.merge(diagnostics) { _, new in new }; return result
    }
    private func writeStatus() async throws {
        let previous = statusWrite
        let next = Task { [self] in _ = try? await previous?.value; try storage.writeStatus(await snapshot()) }
        statusWrite = next
        do { try await next.value } catch {
            throw DesktopError(code: "status_write_failed", message: "无法保存本机连接状态，请确认 aBridge 数据目录可写且磁盘空间充足。")
        }
    }
}
