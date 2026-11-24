import Foundation
import CryptoKit
import Darwin
import SQLite3

private let desktopCapabilities: Set<String> = ["screen", "input", "shell", "files"]

struct ClientConfig: Codable, Sendable {
    var url: String
    var capabilities: [String: Bool]
    var paused: Bool
    var pauseReason: String? = nil
    var revoked: Bool? = nil
    var httpConfirmedOrigin: String? = nil

    enum CodingKeys: String, CodingKey {
        case url, capabilities, paused, revoked
        case pauseReason = "pause_reason"
        case httpConfirmedOrigin = "http_confirmed_origin"
    }
}

func serverOrigin(_ url: URL) -> String? {
    guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
    let formattedHost = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    let standardPort = scheme == "https" ? 443 : 80
    return "\(scheme)://\(formattedHost)" + (url.port.map { $0 == standardPort ? "" : ":\($0)" } ?? "")
}

func normalizeServerURL(_ value: String, confirmedHttpOrigin: String? = nil) throws -> String {
    let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var components = URLComponents(string: text),
          let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
          let host = components.host, !host.isEmpty,
          components.user == nil, components.password == nil,
          components.query == nil, components.fragment == nil,
          let url = components.url, let origin = serverOrigin(url) else {
        throw DesktopError(code: "invalid_url", message: "Server 地址仅支持完整的 HTTP 或 HTTPS，不能包含凭据、查询或片段")
    }
    if let port = components.port, !(1...65535).contains(port) {
        throw DesktopError(code: "invalid_url", message: "Server 端口无效")
    }
    components.scheme = scheme
    components.host = host.lowercased()
    if components.port == (scheme == "https" ? 443 : 80) { components.port = nil }
    if DeviceServerTransport(server: url) == .confirmedHTTP, confirmedHttpOrigin != origin {
        throw DesktopError(code: "invalid_url", message: "请先确认此 Server 使用未加密的 HTTP 连接")
    }
    guard var normalized = components.url?.absoluteString else {
        throw DesktopError(code: "invalid_url", message: "请填写完整的 Server 地址")
    }
    if normalized.hasSuffix("/") { normalized.removeLast() }
    return normalized
}

func posixFailure(_ operation: String, code: Int32 = errno) -> NSError {
    NSError(domain: NSPOSIXErrorDomain, code: Int(code), userInfo: [NSLocalizedDescriptionKey: "\(operation): \(String(cString: strerror(code)))"])
}

func isMissingFile(_ error: Error) -> Bool {
    let value = error as NSError
    return (value.domain == NSPOSIXErrorDomain && value.code == Int(ENOENT)) ||
        (value.domain == NSCocoaErrorDomain && value.code == NSFileNoSuchFileError)
}

func privateDirectory(_ path: String, create: Bool = true) throws {
    if create {
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    var info = stat()
    guard lstat(path, &info) == 0 else { throw posixFailure("Read state directory") }
    guard info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid() else {
        throw DesktopError(code: "credential_permissions", message: "Local state must be an owner-only directory")
    }
    if create {
        guard chmod(path, 0o700) == 0 else { throw posixFailure("Secure state directory") }
    } else if info.st_mode & 0o777 != 0o700 {
        throw DesktopError(code: "credential_permissions", message: "Local state requires mode 0700")
    }
}

func writePrivateData(_ path: String, data: Data) throws {
    let temporary = path + "." + UUID().uuidString + ".tmp"
    let fd = Darwin.open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw posixFailure("Create private file") }
    var closed = false
    defer {
        if !closed { Darwin.close(fd) }
        unlink(temporary)
    }
    try data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if count < 0 {
                if errno == EINTR { continue }
                throw posixFailure("Write private file")
            }
            guard count > 0 else { throw posixFailure("Write private file", code: EIO) }
            offset += count
        }
    }
    guard fsync(fd) == 0 else { throw posixFailure("Sync private file") }
    guard Darwin.close(fd) == 0 else { closed = true; throw posixFailure("Close private file") }
    closed = true
    guard rename(temporary, path) == 0 else { throw posixFailure("Commit private file") }
    let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
    let directory = Darwin.open(parent, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard directory >= 0 else { throw posixFailure("Open private directory") }
    defer { Darwin.close(directory) }
    guard fsync(directory) == 0 else { throw posixFailure("Sync private directory") }
}

func readPrivateData(_ path: String, maxBytes: Int = 8192) throws -> Data {
    let fd = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { throw posixFailure("Open private file") }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0 else { throw posixFailure("Read private file metadata") }
    guard info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o777 == 0o600, info.st_uid == getuid() else {
        throw DesktopError(code: "credential_permissions", message: "Local state requires an owner-only regular file")
    }
    guard info.st_size <= maxBytes else { throw DesktopError(code: "credential_invalid", message: "Stored local state is too large") }
    var result = Data(), bytes = [UInt8](repeating: 0, count: min(maxBytes + 1, 16384))
    while true {
        let count = Darwin.read(fd, &bytes, min(bytes.count, maxBytes + 1 - result.count))
        if count < 0 { if errno == EINTR { continue }; throw posixFailure("Read private file") }
        if count == 0 { return result }
        result.append(contentsOf: bytes.prefix(count))
        if result.count > maxBytes { throw DesktopError(code: "credential_invalid", message: "Stored local state is too large") }
    }
}

struct NativeStorage: Sendable {
    let stateDir: String

    init(stateDir: String) { self.stateDir = URL(fileURLWithPath: stateDir).standardized.path }
    private func path(_ name: String) -> String { URL(fileURLWithPath: stateDir).appendingPathComponent(name).path }

    func loadConfig() throws -> ClientConfig {
        try privateDirectory(stateDir, create: false)
        let config = try JSONDecoder().decode(ClientConfig.self, from: readPrivateData(path("config.json")))
        _ = try normalizeServerURL(config.url, confirmedHttpOrigin: config.httpConfirmedOrigin)
        guard Set(config.capabilities.keys).isSubset(of: desktopCapabilities) else {
            throw DesktopError(code: "configuration_invalid", message: "Unknown desktop capability")
        }
        return config
    }
    func saveConfig(_ config: ClientConfig) throws {
        try privateDirectory(stateDir)
        try writePrivateData(path("config.json"), data: JSONEncoder().encode(config))
    }
    func saveCredential(url: String, key: String) throws {
        guard key.hasPrefix("abr_device_"), key.utf8.count <= 4096 else {
            throw DesktopError(code: "credential_invalid", message: "Use a Device Key when binding this Mac")
        }
        try privateDirectory(stateDir)
        try privateDirectory(path("credentials"))
        try writePrivateData(path("credentials/device.json"), data: JSONValue.object(["server_url": .string(url), "device_key": .string(key)]).encoded())
    }
    func loadCredential(url: String) throws -> String {
        try privateDirectory(stateDir, create: false)
        try privateDirectory(path("credentials"), create: false)
        guard let value = try JSONValue.decode(readPrivateData(path("credentials/device.json"))).object,
              let key = value.string("device_key"), key.hasPrefix("abr_device_"), key.utf8.count <= 4096 else {
            throw DesktopError(code: "credential_invalid", message: "Rebind this device")
        }
        guard value.string("server_url") == url else { throw DesktopError(code: "credential_mismatch", message: "Credential belongs to another server") }
        return key
    }
    func deleteCredential() throws {
        if unlink(path("credentials/device.json")) != 0 && errno != ENOENT { throw posixFailure("Remove credential") }
    }
    func writeStatus(_ value: JSONObject) throws {
        try privateDirectory(stateDir)
        try writePrivateData(path("status.json"), data: JSONValue.object(value).encoded())
    }
    func readStatus() throws -> JSONObject {
        guard let value = try JSONValue.decode(readPrivateData(path("status.json"), maxBytes: 131072)).object else {
            throw DesktopError(code: "configuration_invalid", message: "Invalid status data")
        }
        return value
    }
    func configure(url: String, key: String, httpConfirmedOrigin: String? = nil, capabilities: [String: Bool]? = nil) throws -> ClientConfig {
        let normalized = try normalizeServerURL(url, confirmedHttpOrigin: httpConfirmedOrigin)
        if let capabilities, !Set(capabilities.keys).isSubset(of: desktopCapabilities) {
            throw DesktopError(code: "invalid_arguments", message: "Invalid desktop capabilities")
        }
        var previous: ClientConfig?
        do { previous = try loadConfig() } catch { if !isMissingFile(error) { throw error } }
        let config = ClientConfig(url: normalized, capabilities: Dictionary(uniqueKeysWithValues: desktopCapabilities.map { ($0, capabilities?[$0] ?? false) }), paused: previous?.paused ?? false, pauseReason: previous?.pauseReason, httpConfirmedOrigin: httpConfirmedOrigin == URL(string: normalized).flatMap(serverOrigin) ? httpConfirmedOrigin : nil)
        try saveCredential(url: normalized, key: key)
        try saveConfig(config)
        return config
    }
}

struct JournalEntry: Sendable {
    let requestHash: String
    let status: String
}

final class OperationJournal: @unchecked Sendable {
    private var db: OpaquePointer?
    private let lock = NSLock()
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(path: String) throws {
        let fd = Darwin.open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw posixFailure("Open operation journal") }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), fchmod(fd, 0o600) == 0 else {
            Darwin.close(fd)
            throw DesktopError(code: "credential_permissions", message: "Journal must be an owner-only regular file")
        }
        Darwin.close(fd)
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            if let db { sqlite3_close(db) }; db = nil
            throw DesktopError(code: "journal_failed", message: "Cannot open operation journal")
        }
        do {
            try exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,status TEXT NOT NULL,updated_at REAL NOT NULL); UPDATE operations SET status='outcome_unknown' WHERE status='executing'")
        } catch { close(); throw error }
    }
    deinit { close() }
    private func exec(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw failure() }
    }
    private func failure() -> DesktopError { DesktopError(code: "journal_failed", message: "Operation journal could not be persisted") }
    private func statement(_ sql: String) throws -> OpaquePointer {
        guard let db else { throw failure() }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw failure() }
        return statement
    }
    private func bind(_ value: String, to statement: OpaquePointer, at index: Int32) throws {
        guard sqlite3_bind_text(statement, index, value, -1, transient) == SQLITE_OK else { throw failure() }
    }
    func get(_ id: String) throws -> JournalEntry? {
        lock.lock(); defer { lock.unlock() }
        let query = try statement("SELECT request_hash,status FROM operations WHERE id=?")
        defer { sqlite3_finalize(query) }
        try bind(id, to: query, at: 1)
        let status = sqlite3_step(query)
        if status == SQLITE_DONE { return nil }
        guard status == SQLITE_ROW, let hash = sqlite3_column_text(query, 0), let value = sqlite3_column_text(query, 1) else { throw failure() }
        return JournalEntry(requestHash: String(cString: hash), status: String(cString: value))
    }
    func start(id: String, hash: String) throws {
        lock.lock(); defer { lock.unlock() }
        let query = try statement("INSERT INTO operations VALUES(?,?,?,?)")
        defer { sqlite3_finalize(query) }
        try bind(id, to: query, at: 1); try bind(hash, to: query, at: 2); try bind("executing", to: query, at: 3)
        sqlite3_bind_double(query, 4, Date().timeIntervalSince1970)
        guard sqlite3_step(query) == SQLITE_DONE else { throw failure() }
    }
    func finish(id: String, status: String) throws {
        lock.lock(); defer { lock.unlock() }
        let query = try statement("UPDATE operations SET status=?,updated_at=? WHERE id=?")
        defer { sqlite3_finalize(query) }
        try bind(status, to: query, at: 1)
        sqlite3_bind_double(query, 2, Date().timeIntervalSince1970)
        try bind(id, to: query, at: 3)
        guard sqlite3_step(query) == SQLITE_DONE else { throw failure() }
    }
    func close() {
        lock.lock(); defer { lock.unlock() }
        if let db { sqlite3_close_v2(db); self.db = nil }
    }
}
