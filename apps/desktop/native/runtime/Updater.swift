import Foundation
import CryptoKit
import CoreFoundation
import Darwin

struct UpdateFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}
struct RecoveryRequired: Error { let message: String }
struct NativeUpdate: Codable {
    let version: String
    let url: String
    let digest: String
    let size: Int
}
struct UpdatePlan: Codable {
    let app: String
    let candidate: String
    let work: String
    let version: String
    let current: String
    var parent: Int32
    let stateDir: String
}
private var updaterFiles: FileManager { FileManager.default }
private let maximumUpdateSize = 300 * 1024 * 1024
private func childPath(_ base: String, _ relative: String) -> String { URL(fileURLWithPath: base).appendingPathComponent(relative).path }
private func parentPath(_ path: String) -> String { URL(fileURLWithPath: path).deletingLastPathComponent().path }
private func privateWrite(_ data: Data, _ path: String) throws {
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    guard chmod(path, 0o600) == 0 else { throw UpdateFailure("无法保护更新文件") }
}
private func privateDirectory(_ path: String) throws {
    try updaterFiles.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
}
@discardableResult
func updaterRun(_ executable: String, _ arguments: [String]) throws -> String {
    let process = Process(), output = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = output
    process.standardError = output
    try process.run()
    let bytes = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let text = String(data: bytes, encoding: .utf8) ?? ""
    guard process.terminationStatus == 0 else { throw UpdateFailure(text.isEmpty ? "更新工具执行失败" : text) }
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
}
func compareUpdateVersions(_ a: String, _ b: String) throws -> Int {
    func parse(_ value: String) throws -> [Int] {
        guard value.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil else { throw UpdateFailure("仅支持正式版本更新") }
        let parts = value.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 3 else { throw UpdateFailure("版本号无效") }
        return parts
    }
    let left = try parse(a), right = try parse(b)
    for index in 0..<3 where left[index] != right[index] { return left[index] > right[index] ? 1 : -1 }
    return 0
}
private func updateBoolean(_ value: Any?) -> Bool? {
    guard let value, CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() else { return nil }
    return value as? Bool
}
private func updateSize(_ value: Any?) -> Int? {
    guard let value, CFGetTypeID(value as CFTypeRef) != CFBooleanGetTypeID(), let number = value as? NSNumber,
          number.doubleValue > 0, number.doubleValue <= Double(maximumUpdateSize),
          number.doubleValue == Double(number.intValue) else { return nil }
    return number.intValue
}
func selectNativeUpdate(_ release: [String: Any], current: String) throws -> NativeUpdate? {
    guard updateBoolean(release["draft"]) == false, updateBoolean(release["prerelease"]) == false, let tag = release["tag_name"] as? String else { throw UpdateFailure("更新源没有提供正式版本") }
    let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
    guard try compareUpdateVersions(version, current) > 0 else { return nil }
    guard let assets = release["assets"] as? [[String: Any]] else { throw UpdateFailure("更新缺少下载文件") }
    for suffix in ["notarized", "unsigned"] {
        let name = "aBridge-\(version)-macos-arm64-\(suffix).zip"
        guard let asset = assets.first(where: { $0["name"] as? String == name }) else { continue }
        let expected = "https://github.com/xerrors/aBridge/releases/download/v\(version)/\(name)"
        guard asset["browser_download_url"] as? String == expected,
              let digest = asset["digest"] as? String, digest.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil,
              let size = updateSize(asset["size"]) else { throw UpdateFailure("更新文件缺少有效校验信息") }
        return NativeUpdate(version: version, url: expected, digest: String(digest.dropFirst(7)), size: size)
    }
    throw UpdateFailure("这个版本没有可用的 Apple Silicon 安装包")
}
private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
func checkNativeUpdate(_ current: String) async throws -> NativeUpdate? {
    let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var request = URLRequest(url: URL(string: "https://api.github.com/repos/xerrors/aBridge/releases/latest")!, timeoutInterval: 20)
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    request.setValue("aBridge-updater", forHTTPHeaderField: "User-Agent")
    let (bytes, response) = try await session.bytes(for: request)
    guard let response = response as? HTTPURLResponse, response.statusCode == 200 else { throw UpdateFailure("检查更新失败") }
    var data = Data()
    for try await byte in bytes {
        data.append(byte)
        if data.count > 2 * 1024 * 1024 { throw UpdateFailure("更新信息过大") }
    }
    guard let release = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw UpdateFailure("更新信息无效") }
    return try selectNativeUpdate(release, current: current)
}
func assertNativeApp(_ app: String, version: String? = nil) throws {
    let attributes = try updaterFiles.attributesOfItem(atPath: app)
    guard app.hasSuffix(".app"), attributes[.type] as? FileAttributeType == .typeDirectory,
          let info = try PropertyListSerialization.propertyList(from: Data(contentsOf: URL(fileURLWithPath: childPath(app, "Contents/Info.plist"))), format: nil) as? [String: Any],
          info["CFBundleIdentifier"] as? String == "dev.abridge.client",
          version == nil || info["CFBundleShortVersionString"] as? String == version else { throw UpdateFailure("安装包的应用身份或版本不匹配") }
    try updaterRun("/usr/bin/codesign", ["--verify", "--deep", "--strict", app])
}
private func signingTeam(_ app: String) throws -> String? {
    let output = try updaterRun("/usr/bin/codesign", ["-dv", "--verbose=4", app])
    guard let line = output.split(separator: "\n").first(where: { $0.hasPrefix("TeamIdentifier=") }) else { return nil }
    let value = String(line.dropFirst("TeamIdentifier=".count))
    return value == "not set" ? nil : value
}
private func verifyTeam(_ app: String, _ candidate: String) throws {
    if let team = try signingTeam(app), team != (try signingTeam(candidate)) { throw UpdateFailure("更新的签名团队与当前应用不同") }
}
func validateNativeArchivePaths(_ names: [String]) throws {
    guard !names.isEmpty, names.allSatisfy({ name in
        name.hasPrefix("aBridge.app/") && !name.contains("\\") && !name.split(separator: "/").contains(where: { $0 == "." || $0 == ".." })
    }) else { throw UpdateFailure("安装包包含无效路径") }
}
private func rejectSymlinks(_ directory: String) throws {
    guard let enumerator = updaterFiles.enumerator(at: URL(fileURLWithPath: directory), includingPropertiesForKeys: [.isSymbolicLinkKey]) else { throw UpdateFailure("安装包不可读") }
    for case let url as URL in enumerator {
        if try url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true { throw UpdateFailure("安装包包含符号链接") }
    }
}
private func downloadNativeUpdate(_ update: NativeUpdate, to file: String) async throws {
    let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var url = URL(string: update.url)!
    let deadline = Date().addingTimeInterval(180)
    for _ in 0...5 {
        guard url.scheme == "https", url.user == nil, url.password == nil,
              ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].contains(url.host ?? "") else { throw UpdateFailure("下载地址不受信任") }
        let (bytes, response) = try await session.bytes(for: URLRequest(url: url, timeoutInterval: max(1, deadline.timeIntervalSinceNow)))
        guard let response = response as? HTTPURLResponse else { throw UpdateFailure("下载失败") }
        if [301, 302, 303, 307, 308].contains(response.statusCode) {
            guard let location = response.value(forHTTPHeaderField: "Location"), let redirect = URL(string: location, relativeTo: url)?.absoluteURL else { throw UpdateFailure("下载重定向无效") }
            url = redirect
            continue
        }
        guard response.statusCode == 200 else { throw UpdateFailure("下载失败（HTTP \(response.statusCode)）") }
        guard updaterFiles.createFile(atPath: file, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw UpdateFailure("无法创建下载文件") }
        let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: file))
        defer { try? handle.close() }
        var count = 0, hash = SHA256(), buffer = Data()
        for try await byte in bytes {
            count += 1
            if count > update.size || count > maximumUpdateSize || (count % 65536 == 0 && Date() > deadline) { throw UpdateFailure("下载大小不匹配或超时") }
            buffer.append(byte)
            if buffer.count >= 65536 { hash.update(data: buffer); try handle.write(contentsOf: buffer); buffer.removeAll(keepingCapacity: true) }
        }
        hash.update(data: buffer); try handle.write(contentsOf: buffer)
        let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
        guard count == update.size, digest == update.digest else { throw UpdateFailure("安装包校验失败，请重新下载") }
        return
    }
    throw UpdateFailure("下载重定向过多")
}
func prepareNativeUpdate(app: String, current: String, version: String, stateDir: String) async throws -> String {
    let app = URL(fileURLWithPath: app).standardizedFileURL.path
    guard !app.contains("/AppTranslocation/"), !app.hasPrefix("/Volumes/") else { throw UpdateFailure("请先将 aBridge 移到 Applications 后再更新") }
    try assertNativeApp(app, version: current)
    guard updaterFiles.isWritableFile(atPath: parentPath(app)) else { throw UpdateFailure("应用目录不可写") }
    guard let update = try await checkNativeUpdate(current), update.version == version else { throw UpdateFailure("可用版本已变化，请重新检查更新") }
    let work = childPath(parentPath(app), ".abridge-update-" + UUID().uuidString)
    try privateDirectory(work)
    signal(SIGTERM, SIG_IGN)
    let cancellation = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    cancellation.setEventHandler { try? updaterFiles.removeItem(atPath: work); exit(1) }
    cancellation.resume()
    defer { cancellation.cancel(); signal(SIGTERM, SIG_DFL) }
    do {
        let archive = childPath(work, "update.zip"), candidate = childPath(work, "aBridge.app")
        try await downloadNativeUpdate(update, to: archive)
        try validateNativeArchivePaths(try updaterRun("/usr/bin/unzip", ["-Z", "-1", archive]).split(separator: "\n").map(String.init))
        try updaterRun("/usr/bin/ditto", ["-x", "-k", archive, work])
        try rejectSymlinks(candidate)
        try assertNativeApp(candidate, version: version)
        try verifyTeam(app, candidate)
        let binaries = ["abridge-desktop", "abridge-desktop-http", "abridge-updater"].map { childPath(candidate, "Contents/MacOS/" + $0) }
        guard binaries.allSatisfy({ updaterFiles.isExecutableFile(atPath: $0) }) else { throw UpdateFailure("更新缺少原生运行时") }
        let smokeState = childPath(work, "smoke-state")
        for runtime in binaries.dropLast() {
            _ = try JSONSerialization.jsonObject(with: Data(updaterRun(runtime, ["status", "--state-dir", smokeState]).utf8))
        }
        try? updaterFiles.removeItem(atPath: smokeState)
        try updaterFiles.copyItem(atPath: CommandLine.arguments[0], toPath: childPath(work, "abridge-updater"))
        guard chmod(childPath(work, "abridge-updater"), 0o700) == 0 else { throw UpdateFailure("更新程序不可执行") }
        let plan = UpdatePlan(app: app, candidate: candidate, work: work, version: version, current: current, parent: 0, stateDir: URL(fileURLWithPath: stateDir).standardizedFileURL.path)
        let path = childPath(work, "plan.json")
        try privateWrite(JSONEncoder().encode(plan), path)
        try updaterFiles.removeItem(atPath: archive)
        return path
    } catch { try? updaterFiles.removeItem(atPath: work); throw error }
}
private func readUpdatePlan(_ file: String) throws -> UpdatePlan {
    let plan = try JSONDecoder().decode(UpdatePlan.self, from: Data(contentsOf: URL(fileURLWithPath: file)))
    guard file.hasPrefix("/"), plan.app.hasPrefix("/"), plan.stateDir.hasPrefix("/"), parentPath(file) == plan.work,
          plan.candidate == childPath(plan.work, "aBridge.app"), parentPath(plan.work) == parentPath(plan.app),
          URL(fileURLWithPath: plan.work).lastPathComponent.hasPrefix(".abridge-update-") else { throw UpdateFailure("更新计划无效") }
    return plan
}
func installNativeUpdate(_ file: String, parent: Int32) throws {
    guard parent > 1 else { throw UpdateFailure("更新计划无效") }
    var plan = try readUpdatePlan(file)
    try assertNativeApp(plan.app, version: plan.current)
    try assertNativeApp(plan.candidate, version: plan.version)
    try verifyTeam(plan.app, plan.candidate)
    let helper = childPath(plan.work, "abridge-updater")
    guard updaterFiles.isExecutableFile(atPath: helper) else { throw UpdateFailure("更新程序缺失") }
    plan.parent = parent
    try privateWrite(JSONEncoder().encode(plan), file)
    try privateDirectory(childPath(plan.stateDir, "logs"))
    let log = childPath(plan.stateDir, "logs/update-helper.log")
    try privateWrite(Data(), log)
    let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: log))
    defer { try? handle.close() }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: helper)
    process.arguments = ["apply", file]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = handle
    process.standardError = handle
    var environment = ProcessInfo.processInfo.environment
    environment.removeValue(forKey: "ABRIDGE_PARENT_PID")
    process.environment = environment
    try process.run()
}
private func launchNativeApp(_ app: String, arguments: [String]) throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: childPath(app, "Contents/MacOS/aBridge"))
    process.arguments = arguments
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    return process
}
private func stopFailedLaunch(_ child: Process) async throws {
    for signal in [SIGTERM, SIGKILL] {
        if !child.isRunning { return }
        _ = kill(child.processIdentifier, signal)
        for _ in 0..<30 {
            if !child.isRunning { return }
            try await Task.sleep(for: .milliseconds(100))
        }
    }
    if child.isRunning { throw RecoveryRequired(message: "新版本未能退出，已保留旧版备份，请退出应用后恢复") }
}
private func launchUpdatedApp(_ plan: UpdatePlan) async throws {
    let receipt = childPath(plan.work, "startup.json")
    try? updaterFiles.removeItem(atPath: receipt)
    let child = try launchNativeApp(plan.app, arguments: ["--state-dir", plan.stateDir, "--update-receipt", receipt])
    do {
        for _ in 0..<150 {
            guard child.isRunning else { throw UpdateFailure("新版本启动退出，已恢复旧版") }
            if updaterFiles.fileExists(atPath: receipt) {
                let status = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: receipt))) as? [String: Any]
                if status?["version"] as? String == plan.version, status?["ready"] as? Bool == true, status?["pid"] as? Int32 == child.processIdentifier { return }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw UpdateFailure("新版本未确认启动，已恢复旧版")
    } catch { try await stopFailedLaunch(child); throw error }
}
func applyNativeUpdate(_ file: String) async throws {
    let plan = try readUpdatePlan(file)
    guard plan.parent > 1 else { throw UpdateFailure("更新计划无效") }
    var parentExited = false, preserveRecovery = false
    do {
        for attempt in 0...300 {
            if kill(plan.parent, 0) != 0 {
                guard errno == ESRCH else { throw UpdateFailure("无法确认应用退出") }
                parentExited = true
                break
            }
            if attempt == 300 { throw UpdateFailure("应用未退出，已取消安装") }
            try await Task.sleep(for: .milliseconds(100))
        }
        try assertNativeApp(plan.app, version: plan.current)
        try assertNativeApp(plan.candidate, version: plan.version)
        try verifyTeam(plan.app, plan.candidate)
        let backup = plan.app + ".previous-update"
        guard !updaterFiles.fileExists(atPath: backup) else { throw RecoveryRequired(message: "发现上次更新备份，请先恢复或移走它") }
        try updaterFiles.moveItem(atPath: plan.app, toPath: backup)
        do {
            try updaterFiles.moveItem(atPath: plan.candidate, toPath: plan.app)
            try await launchUpdatedApp(plan)
        } catch {
            if error is RecoveryRequired { throw error }
            do {
                if updaterFiles.fileExists(atPath: plan.app) { try updaterFiles.moveItem(atPath: plan.app, toPath: plan.candidate) }
                try updaterFiles.moveItem(atPath: backup, toPath: plan.app)
            } catch { throw RecoveryRequired(message: "恢复旧版失败，已保留备份，请手动恢复") }
            throw error
        }
        try? updaterFiles.removeItem(atPath: backup)
    } catch {
        preserveRecovery = error is RecoveryRequired
        try? privateDirectory(childPath(plan.stateDir, "logs"))
        let message = (error as? RecoveryRequired)?.message ?? error.localizedDescription
        try? privateWrite(Data(message.utf8), childPath(plan.stateDir, "logs/update-error.log"))
        if parentExited && !preserveRecovery { _ = try? launchNativeApp(plan.app, arguments: ["--state-dir", plan.stateDir]) }
    }
    if !preserveRecovery { try? updaterFiles.removeItem(atPath: plan.work) }
}
