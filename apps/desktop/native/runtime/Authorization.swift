import Foundation
import CryptoKit
import Security
import Darwin

private actor AuthorizationInput {
    private var lines: [JSONObject] = []
    private var failure: Error?
    private var ended = false
    private var reader: Task<Void, Never>?
    func begin() {
        reader = Task {
            var buffer = Data(), bytes = [UInt8](repeating: 0, count: 4096)
            while !Task.isCancelled {
                var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
                let ready = poll(&descriptor, 1, 0)
                if ready < 0 && errno != EINTR { failure = posixFailure("Read authorization input"); break }
                if ready > 0 {
                    let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
                    if count == 0 { ended = true; break }
                    if count < 0 { if errno == EINTR { continue }; failure = posixFailure("Read authorization input"); break }
                    buffer.append(contentsOf: bytes.prefix(count))
                    do {
                        while let end = buffer.firstIndex(of: 10) {
                            let line = buffer.prefix(upTo: end)
                            guard line.count <= 65536, let object = try JSONValue.decode(Data(line)).object, lines.count < 2 else { throw DesktopError(code: "invalid_arguments", message: "授权输入无效") }
                            lines.append(object)
                            buffer.removeSubrange(...end)
                        }
                        guard buffer.count <= 65536 else { throw DesktopError(code: "invalid_arguments", message: "授权输入无效") }
                    } catch { failure = error; break }
                }
                try? await sleepMilliseconds(10)
            }
        }
    }
    func next() async throws -> JSONObject {
        while true {
            try Task.checkCancellation()
            if let failure { throw failure }
            if !lines.isEmpty { return lines.removeFirst() }
            if ended { throw DesktopError(code: "authorization_cancelled", message: "授权输入已关闭") }
            try await sleepMilliseconds(10)
        }
    }
    var isClosed: Bool { ended || failure != nil }
    func stop() async { reader?.cancel(); await reader?.value; reader = nil }
}

private struct AuthorizationCallback: Sendable {
    let fd: Int32
    let redirect: String
    static func listen() throws -> AuthorizationCallback {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        do {
            try prepareSocket(fd)
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
            let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
            guard result == 0, Darwin.listen(fd, 8) == 0 else { throw posixFailure("Listen for authorization") }
            var length = socklen_t(MemoryLayout<sockaddr_in>.size)
            guard withUnsafeMutablePointer(to: &address, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }) == 0 else { throw posixFailure("Read authorization listener") }
            return AuthorizationCallback(fd: fd, redirect: "http://127.0.0.1:\(UInt16(bigEndian: address.sin_port))/abridge/callback")
        } catch {
            if fd >= 0 { Darwin.close(fd) }
            let failure = error as NSError
            guard failure.domain == NSPOSIXErrorDomain else { throw error }
            let reason = String(cString: strerror(Int32(failure.code)))
            throw DesktopError(code: "authorization_failed", message: "无法开启本机授权回调（\(reason)），请重试")
        }
    }
    func receive(state: String, expires: Double) async throws -> String {
        guard let expected = URLComponents(string: redirect), let expectedHost = expected.host, let expectedPort = expected.port else { throw DesktopError(code: "authorization_failed", message: "授权回调地址无效") }
        while epochSeconds() < expires {
            try Task.checkCancellation()
            let client = accept(fd, nil, nil)
            if client < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { try await sleepMilliseconds(10); continue }
                throw posixFailure("Accept authorization callback")
            }
            defer { Darwin.close(client) }
            do {
                try prepareSocket(client)
                let bytes = try await socketReadUntil(client, separator: Data("\r\n\r\n".utf8), maxBytes: 16384, deadline: min(monotonicSeconds() + 5, monotonicSeconds() + expires - epochSeconds()))
                guard let request = String(data: bytes, encoding: .utf8) else { throw DesktopError(code: "callback_invalid", message: "Invalid callback") }
                let lines = request.components(separatedBy: "\r\n"), start = lines[0].split(separator: " ", omittingEmptySubsequences: false)
                let hosts = lines.dropFirst().compactMap { line -> String? in
                    guard let colon = line.firstIndex(of: ":"), line[..<colon].lowercased() == "host" else { return nil }
                    return line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                }
                guard start.count == 3, start[0] == "GET", start[2] == "HTTP/1.1", hosts == ["\(expectedHost):\(expectedPort)"], start[1].hasPrefix("/"), !start[1].hasPrefix("//"),
                      let target = URLComponents(string: "http://\(hosts[0])\(start[1])"), target.path == expected.path, target.fragment == nil else { throw DesktopError(code: "callback_invalid", message: "Invalid callback") }
                let query = target.queryItems ?? [], states = query.filter { $0.name == "state" }, codes = query.filter { $0.name == "code" }, errors = query.filter { $0.name == "error" }
                guard states.count == 1, let received = states[0].value, constantTimeEqual(received, state),
                      (codes.count == 1 && errors.isEmpty) || (errors.count == 1 && codes.isEmpty) else { throw DesktopError(code: "callback_invalid", message: "Invalid callback") }
                if let code = codes.first?.value, code.range(of: "^[A-Za-z0-9_-]{16,256}$", options: .regularExpression) != nil {
                    try await respond(client, status: 200, message: "已收到授权，请返回 aBridge 查看绑定结果。")
                    return code
                }
                if errors.count == 1, errors[0].value != nil {
                    try await respond(client, status: 200, message: "授权已取消，可以关闭此页面。")
                    throw DesktopError(code: "access_denied", message: "浏览器授权已取消。如需绑定，请重新发起")
                }
                throw DesktopError(code: "callback_invalid", message: "Invalid callback")
            } catch {
                if (error as? DesktopError)?.code == "access_denied" || error is CancellationError { throw error }
                try? await respond(client, status: 400, message: "无效的授权回调。")
            }
        }
        throw DesktopError(code: "authorization_expired", message: "授权已过期，请重新发起")
    }
    private func respond(_ fd: Int32, status: Int, message: String) async throws {
        let body = Data(message.utf8)
        let headers = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Bad Request")\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nConnection: close\r\n\r\n"
        try await socketWrite(fd, data: Data(headers.utf8) + body, deadline: monotonicSeconds() + 1)
    }
}

private func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
    let left = Array(lhs.utf8), right = Array(rhs.utf8)
    guard left.count == right.count else { return false }
    return zip(left, right).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
}
private func base64URL(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
private func randomAuthorizationValue() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw DesktopError(code: "authorization_failed", message: "无法生成安全授权信息") }
    return base64URL(Data(bytes))
}

enum NativeAuthorization {
    private enum Stage: String {
        case start = "发起浏览器授权"
        case redeem = "兑换设备凭证"
        case cancel = "取消浏览器授权"
        case verify = "验证设备凭证"

        func failure(_ reason: String) -> DesktopError {
            DesktopError(code: "authorization_failed", message: "\(rawValue)失败。\(reason)")
        }
    }

    private static func fetch(_ url: String, stage: Stage, method: String = "GET", body: JSONObject? = nil, key: String? = nil, timeout: Double = 10) async throws -> JSONObject {
        guard let url = URL(string: url) else { throw stage.failure("Server 地址无效，请检查所填地址") }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let key { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try body.encoded(); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let session = deviceServerSession(timeout: timeout)
        defer { session.invalidateAndCancel() }
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let response = response as? HTTPURLResponse else {
                throw stage.failure("Server 返回了无效响应，请检查 Server 地址")
            }
            guard (200..<300).contains(response.statusCode) else {
                // 错误正文和重定向地址可能包含敏感信息，提示只使用阶段和状态码。
                let status = response.statusCode
                let reason: String
                switch status {
                case 400 where stage == .redeem: reason = "授权码无效或已过期，请重新发起浏览器授权"
                case 401 where stage == .verify: reason = "设备凭证无效或已撤销，请使用此 Server 的 Device Key"
                case 422: reason = "Server 无法识别此请求，请检查 Server 和客户端版本"
                default: throw stage.failure(deviceServerHTTPFailure(status))
                }
                throw stage.failure("\(reason)（HTTP \(status)）")
            }
            var data = Data()
            for try await byte in bytes {
                guard data.count < 65536 else { throw stage.failure("Server 响应过大，请检查 Server 地址") }
                data.append(byte)
            }
            if method == "DELETE", data.isEmpty { return [:] }
            guard let object = (try? JSONValue.decode(data))?.object else {
                throw stage.failure("Server 返回了无效的 JSON 响应，请检查 Server 地址和版本")
            }
            return object
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            throw stage.failure(deviceServerNetworkFailure(error))
        }
    }

    private static func validateServerResponse(_ value: JSONObject, schema: String, contract: NativeContract, stage: Stage) throws -> JSONObject {
        guard let result = try? contract.validate(schema, value) else {
            throw stage.failure("Server 响应与当前客户端不兼容，请检查 Server 地址和版本")
        }
        return result
    }

    static func verifyToken(server: String, key: String, confirmedHttpOrigin: String? = nil) async throws -> JSONObject {
        let normalized = try normalizeServerURL(server, confirmedHttpOrigin: confirmedHttpOrigin)
        guard key.hasPrefix("abr_device_"), key.utf8.count <= 4096 else { throw DesktopError(code: "invalid_arguments", message: "请输入 Device Key") }
        let value = try await fetch(normalized + "/api/device", stage: .verify, key: key)
        let identity = try validateServerResponse(value, schema: "deviceIdentity", contract: NativeContract.load(), stage: .verify)
        guard identity.string("kind") == "computer" else {
            throw Stage.verify.failure("此 Device Key 不属于电脑设备，请换用电脑设备的 Device Key")
        }
        return identity
    }
    private static func authorize(server: String) async throws -> String {
        let contract = try NativeContract.load()
        let verifier = try randomAuthorizationValue(), state = try randomAuthorizationValue()
        let callback = try AuthorizationCallback.listen()
        defer { Darwin.close(callback.fd) }
        let challenge = base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        let name = String((Host.current().localizedName ?? ProcessInfo.processInfo.hostName).trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        let response = try await fetch(server + "/api/device-authorizations", stage: .start, method: "POST", body: [
            "kind": .string("computer"), "name": .string(name.isEmpty ? "Computer" : name),
            "capabilities": .array(["screen", "input", "shell", "files"].map(JSONValue.string)),
            "redirect_uri": .string(callback.redirect), "code_challenge": .string(challenge),
            "code_challenge_method": .string("S256"), "state": .string(state),
        ])
        let start = try validateServerResponse(response, schema: "deviceAuthorizationStart", contract: contract, stage: .start)
        guard let id = start.string("id") else { throw Stage.start.failure("Server 未返回授权编号，请检查 Server 版本") }
        do {
            guard let authorization = start.string("authorization_url"), let url = URL(string: authorization),
                  let selected = URL(string: server), serverOrigin(url) == serverOrigin(selected),
                  url.user == nil, url.password == nil, url.fragment == nil else {
                throw Stage.start.failure("Server 返回的授权链接无法用于此地址，请检查所填地址及 Server 对外地址设置")
            }
            guard let expires = start.number("expires_at"), expires > epochSeconds() else {
                throw DesktopError(code: "authorization_expired", message: "授权已过期，请重新发起")
            }
            emitJSON(["event": .string("authorization"), "authorization_url": .string(authorization), "expires_at": .number(expires)])
            let deadline = min(expires, epochSeconds() + 300)
            let code = try await callback.receive(state: state, expires: deadline)
            guard epochSeconds() < deadline else { throw DesktopError(code: "authorization_expired", message: "授权已过期，请重新发起") }
            let response = try await fetch(server + "/api/device-authorizations/token", stage: .redeem, method: "POST", body: [
                "code": .string(code), "code_verifier": .string(verifier), "redirect_uri": .string(callback.redirect),
            ], timeout: min(10, max(0.1, deadline - epochSeconds())))
            let token = try validateServerResponse(response, schema: "deviceAuthorizationToken", contract: contract, stage: .redeem)
            guard token.string("kind") == "computer", let key = token.string("key"),
                  let capabilities = token.array("capabilities"),
                  capabilities.allSatisfy({ ["screen", "input", "shell", "files"].contains($0.string ?? "") }) else {
                throw Stage.redeem.failure("Server 返回的设备类型或能力与 Mac 客户端不匹配，请检查 Server 版本")
            }
            guard epochSeconds() < deadline else { throw DesktopError(code: "authorization_expired", message: "授权已过期，请重新发起") }
            return key
        } catch {
            // A detached bounded cancellation also runs when the command task was cancelled.
            let cleanup = Task.detached { _ = try? await fetch(server + "/api/device-authorizations/\(id)", stage: .cancel, method: "DELETE", body: ["code_verifier": .string(verifier)], timeout: 1) }
            await cleanup.value
            throw error
        }
    }
    static func command(stateDir: String) async -> Int32 {
        let input = AuthorizationInput()
        await input.begin()
        let operation = Task<Int32, Never> {
            do {
                let start = try NativeContract.load().validate("deviceBindingInput", await input.next())
                guard let rawURL = start.string("url") else { throw DesktopError(code: "invalid_arguments", message: "Server 地址无效") }
                let confirmed = start.string("http_confirmed_origin")
                let url = try normalizeServerURL(rawURL, confirmedHttpOrigin: confirmed)
                let key: String
                if let supplied = start.string("device_key") {
                    _ = try await verifyToken(server: url, key: supplied, confirmedHttpOrigin: confirmed)
                    key = supplied
                } else { key = try await authorize(server: url) }
                try Task.checkCancellation()
                emitJSON(["event": .string("ready")])
                let commit = try await input.next()
                guard Set(commit.keys) == ["command", "capabilities"], commit.string("command") == "commit", let values = commit.object("capabilities"), values.values.allSatisfy({ $0.bool != nil }), Set(values.keys).isSubset(of: ["screen", "input", "shell", "files"]) else { throw DesktopError(code: "invalid_arguments", message: "授权提交无效") }
                try Task.checkCancellation()
                do {
                    _ = try NativeStorage(stateDir: stateDir).configure(url: url, key: key, httpConfirmedOrigin: confirmed, capabilities: values.compactMapValues(\.bool))
                } catch {
                    let reason: String
                    if let failure = error as? DesktopError {
                        reason = failure.code == "credential_permissions"
                            ? "请检查 aBridge 数据目录和绑定文件的所有者与访问权限"
                            : "请检查已有的本机绑定配置和服务地址"
                    } else if error is DecodingError {
                        reason = "请检查已有的本机绑定配置是否完整"
                    } else {
                        reason = "请检查磁盘可用空间和 aBridge 数据目录的写入权限"
                    }
                    throw DesktopError(code: "binding_save_failed", message: "已取得设备凭据，但未能保存本机绑定。\(reason)。")
                }
                emitJSON(["event": .string("complete"), "ok": .bool(true), "url": .string(url)])
                return 0
            } catch {
                let message: String
                if Task.isCancelled || error is CancellationError {
                    message = "授权已取消或过期，请重新发起"
                } else if let failure = error as? DesktopError {
                    message = failure.message
                } else {
                    let failure = error as NSError
                    message = "设备授权失败（\(failure.domain) \(failure.code)）"
                }
                emitJSON(["event": .string("error"), "error": .string(message)])
                return 1
            }
        }
        let parent = ProcessInfo.processInfo.environment["ABRIDGE_PARENT_PID"].flatMap(Int32.init)
        let watchdog = Task {
            let deadline = monotonicSeconds() + 300
            while !Task.isCancelled {
                let inputClosed = await input.isClosed
                if monotonicSeconds() >= deadline || (parent.map { $0 > 0 && getppid() != $0 } ?? false) || inputClosed { operation.cancel(); break }
                try? await sleepMilliseconds(50)
            }
        }
        signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
        let signals = [SIGTERM, SIGINT].map { number in
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { operation.cancel() }; source.resume(); return source
        }
        let result = await withTaskCancellationHandler { await operation.value } onCancel: { operation.cancel() }
        watchdog.cancel(); await watchdog.value
        await input.stop()
        for source in signals { source.cancel() }
        return result
    }
}
