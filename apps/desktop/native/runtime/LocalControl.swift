import Foundation
import CryptoKit
import Darwin

func controlSocketPath(_ stateDir: String) -> String {
    let local = URL(fileURLWithPath: stateDir).appendingPathComponent("control.sock").path
    if local.utf8.count < 100 { return local }
    return "/tmp/abridge-\(getuid())-\(sha256(Data(stateDir.utf8)).prefix(24)).sock"
}

func prepareSocket(_ fd: Int32) throws {
    guard fd >= 0 else { throw posixFailure("Create socket") }
    guard fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) == 0,
          fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else { throw posixFailure("Configure socket") }
    var yes: Int32 = 1
    guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size)) == 0 else { throw posixFailure("Configure socket") }
}

private func withUnixAddress<T>(_ path: String, _ body: (UnsafePointer<sockaddr>, socklen_t) throws -> T) throws -> T {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw DesktopError(code: "control_failed", message: "Local socket path is too long") }
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    return try withUnsafePointer(to: &address) { pointer in
        try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { try body($0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
}

func socketWrite(_ fd: Int32, data: Data, deadline: Double) async throws {
    var offset = 0
    while offset < data.count {
        try Task.checkCancellation()
        guard monotonicSeconds() < deadline else { throw DesktopError(code: "control_timeout", message: "Local connection timed out") }
        let count = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: offset), data.count - offset) }
        if count > 0 { offset += count; continue }
        if count < 0, errno == EINTR { continue }
        if count < 0, errno == EAGAIN || errno == EWOULDBLOCK { try await sleepMilliseconds(10); continue }
        throw posixFailure("Write socket")
    }
}

func socketReadUntil(_ fd: Int32, separator: Data, maxBytes: Int, deadline: Double) async throws -> Data {
    var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
    while true {
        try Task.checkCancellation()
        guard monotonicSeconds() < deadline else { throw DesktopError(code: "control_timeout", message: "Local connection timed out") }
        let count = Darwin.read(fd, &buffer, min(buffer.count, maxBytes + 1 - data.count))
        if count > 0 {
            data.append(contentsOf: buffer.prefix(count))
            guard data.count <= maxBytes else { throw DesktopError(code: "control_failed", message: "Local message is too large") }
            if let range = data.range(of: separator) { return data.subdata(in: 0..<range.lowerBound) }
            continue
        }
        if count == 0 { throw DesktopError(code: "control_failed", message: "Local connection closed") }
        if errno == EINTR { continue }
        if errno == EAGAIN || errno == EWOULDBLOCK { try await sleepMilliseconds(10); continue }
        throw posixFailure("Read socket")
    }
}

private func connectUnix(_ path: String, deadline: Double) async throws -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    do {
        try prepareSocket(fd)
        let result = try withUnixAddress(path) { Darwin.connect(fd, $0, $1) }
        if result == 0 { return fd }
        guard errno == EINPROGRESS || errno == EAGAIN else { throw posixFailure("Connect local socket") }
        while monotonicSeconds() < deadline {
            try Task.checkCancellation()
            var descriptor = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
            if poll(&descriptor, 1, 0) > 0 {
                var socketError: Int32 = 0, length = socklen_t(MemoryLayout<Int32>.size)
                guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &socketError, &length) == 0 else { throw posixFailure("Read socket status") }
                guard socketError == 0 else { throw posixFailure("Connect local socket", code: socketError) }
                return fd
            }
            try await sleepMilliseconds(10)
        }
        throw DesktopError(code: "control_timeout", message: "Local connection timed out")
    } catch { if fd >= 0 { Darwin.close(fd) }; throw error }
}

actor LocalControlServer {
    private let fd: Int32
    private let path: String
    private let inode: ino_t
    private let handler: @Sendable (JSONObject) async throws -> JSONObject
    private var listener: Task<Void, Never>?
    private var clients: [UUID: Task<Void, Never>] = [:]
    private var closed = false

    private init(fd: Int32, path: String, inode: ino_t, handler: @escaping @Sendable (JSONObject) async throws -> JSONObject) {
        self.fd = fd; self.path = path; self.inode = inode; self.handler = handler
    }
    static func start(stateDir: String, handler: @escaping @Sendable (JSONObject) async throws -> JSONObject) async throws -> LocalControlServer {
        try privateDirectory(stateDir)
        let path = controlSocketPath(stateDir)
        var info = stat()
        if lstat(path, &info) == 0 {
            guard info.st_mode & S_IFMT == S_IFSOCK, info.st_uid == getuid() else { throw DesktopError(code: "control_failed", message: "Unsafe local socket path") }
            do {
                let active = try await connectUnix(path, deadline: monotonicSeconds() + 0.5)
                Darwin.close(active)
                throw DesktopError(code: "already_running", message: "aBridge is already running")
            } catch {
                let failure = error as NSError
                guard failure.domain == NSPOSIXErrorDomain, [Int(ECONNREFUSED), Int(ENOENT)].contains(failure.code) else { throw error }
            }
            var current = stat()
            if lstat(path, &current) == 0 {
                guard current.st_ino == info.st_ino, current.st_uid == getuid(), unlink(path) == 0 else { throw DesktopError(code: "control_failed", message: "Local socket changed during startup") }
            }
        } else if errno != ENOENT { throw posixFailure("Read local socket") }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var bound = false
        do {
            try prepareSocket(fd)
            guard try withUnixAddress(path, { Darwin.bind(fd, $0, $1) }) == 0 else { throw posixFailure("Bind local socket") }
            bound = true
            guard chmod(path, 0o600) == 0, listen(fd, 16) == 0, lstat(path, &info) == 0 else { throw posixFailure("Listen on local socket") }
            let server = LocalControlServer(fd: fd, path: path, inode: info.st_ino, handler: handler)
            await server.begin()
            return server
        } catch { if fd >= 0 { Darwin.close(fd) }; if bound { unlink(path) }; throw error }
    }
    private func begin() { listener = Task { await self.acceptConnections() } }
    private func acceptConnections() async {
        while !Task.isCancelled {
            let client = accept(fd, nil, nil)
            if client < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { try? await sleepMilliseconds(10); continue }
                break
            }
            do { try prepareSocket(client) } catch { Darwin.close(client); continue }
            let id = UUID(), callback = handler
            clients[id] = Task {
                defer { Darwin.close(client) }
                do {
                    let data = try await socketReadUntil(client, separator: Data([10]), maxBytes: 8192, deadline: monotonicSeconds() + 3)
                    guard let request = try JSONValue.decode(data).object else { throw DesktopError(code: "invalid_arguments", message: "Invalid local command") }
                    var response = try await callback(request)
                    response["ok"] = .bool(true)
                    try await socketWrite(client, data: try response.encoded() + Data([10]), deadline: monotonicSeconds() + 15)
                } catch {
                    let safe = error as? DesktopError ?? DesktopError(code: "control_failed", message: "Local control operation failed")
                    if let data = try? JSONValue.object(["ok": .bool(false), "error": .object(safe.json)]).encoded() {
                        try? await socketWrite(client, data: data + Data([10]), deadline: monotonicSeconds() + 1)
                    }
                }
                self.finished(id)
            }
        }
    }
    private func finished(_ id: UUID) { clients.removeValue(forKey: id) }
    func close() async {
        guard !closed else { return }; closed = true
        listener?.cancel(); await listener?.value; listener = nil
        Darwin.close(fd)
        let active = Array(clients.values)
        for task in active { task.cancel() }
        for task in active { await task.value }
        clients.removeAll()
        var info = stat()
        if lstat(path, &info) == 0, info.st_ino == inode, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFSOCK { unlink(path) }
    }
    static func request(stateDir: String, request: JSONObject, timeout: Double = 15) async throws -> JSONObject {
        let deadline = monotonicSeconds() + timeout
        let path = controlSocketPath(stateDir)
        var info = stat()
        guard lstat(path, &info) == 0 else {
            if errno == ENOENT { throw DesktopError(code: "control_unavailable", message: "本机设备客户端尚未启动，请在 aBridge 设置中检查绑定和连接状态。") }
            throw posixFailure("Read local socket")
        }
        guard info.st_mode & S_IFMT == S_IFSOCK, info.st_uid == getuid(), info.st_mode & 0o777 == 0o600 else { throw DesktopError(code: "control_failed", message: "Unsafe local socket permissions") }
        let fd = try await connectUnix(path, deadline: deadline)
        defer { Darwin.close(fd) }
        let data = try request.encoded()
        guard data.count <= 8192 else { throw DesktopError(code: "invalid_arguments", message: "Local command is too large") }
        try await socketWrite(fd, data: data + Data([10]), deadline: deadline)
        guard let response = try JSONValue.decode(await socketReadUntil(fd, separator: Data([10]), maxBytes: 131072, deadline: deadline)).object else { throw DesktopError(code: "control_failed", message: "Invalid local response") }
        if response.bool("ok") == false {
            let failure = response.object("error")
            throw DesktopError(code: failure?.string("code") ?? "control_failed", message: failure?.string("message") ?? "Local control operation failed")
        }
        return response
    }
}
