import Foundation
import Darwin

@main struct DesktopMain {
    static func main() async {
        do { try await run(Array(CommandLine.arguments.dropFirst())) }
        catch { emitJSON(["ok": .bool(false), "error": .object(jsonError(error))]); exit(1) }
    }
    static func run(_ arguments: [String]) async throws {
        var options: [String: String] = [:], positionals: [String] = []
        let flags: Set<String> = ["stdin", "json", "if-desktop-active", "help"]
        let values: Set<String> = ["state-dir", "capability", "enabled", "name"]
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]; index += 1
            if argument == "-h" { options["help"] = "true"; continue }
            if argument.hasPrefix("--") {
                let name = String(argument.dropFirst(2))
                if flags.contains(name) { options[name] = "true" }
                else if values.contains(name), index < arguments.count { options[name] = arguments[index]; index += 1 }
                else { throw DesktopError(code: "invalid_arguments", message: "Unknown or incomplete command option") }
            } else { positionals.append(argument) }
        }
        if options["help"] != nil {
            print("Usage: abridge-desktop <run|authorize --stdin|configure --stdin|startup-check|status|control <command>|diagnose|smoke> [--state-dir <dir>]"); return
        }
        let contract = try NativeContract.load()
        let defaultState = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/aBridge").path
        let storage = NativeStorage(stateDir: options["state-dir"] ?? defaultState)
        switch positionals.first ?? "status" {
        case "startup-check": emitJSON(["ready": .bool(true), "native": .bool(true), "version": .string(contract.version)])
        case "run":
            let config = try storage.loadConfig()
            try requireDeviceServerTransport(config.url)
            let key = try storage.loadCredential(url: config.url)
            let parent = ProcessInfo.processInfo.environment["ABRIDGE_PARENT_PID"].flatMap(Int32.init)
            let client = DeviceClient(storage: storage, config: config, key: key, contract: contract, parentPid: parent.flatMap { $0 > 0 ? $0 : nil })
            let signals = [SIGINT, SIGTERM].map { value -> DispatchSourceSignal in
                signal(value, SIG_IGN)
                let source = DispatchSource.makeSignalSource(signal: value, queue: .global())
                source.setEventHandler { Task { await client.stop() } }; source.resume(); return source
            }
            defer { for source in signals { source.cancel() } }
            try await client.run()
        case "authorize":
            guard options["stdin"] != nil else { throw DesktopError(code: "invalid_arguments", message: "Use authorize --stdin") }
            let result = await NativeAuthorization.command(stateDir: storage.stateDir); if result != 0 { exit(result) }
        case "configure":
            guard options["stdin"] != nil else { throw DesktopError(code: "invalid_arguments", message: "Use configure --stdin; credentials must not be command-line arguments") }
            var bytes = Data()
            while let chunk = try FileHandle.standardInput.read(upToCount: min(8192, 65537 - bytes.count)), !chunk.isEmpty {
                bytes.append(chunk)
                if bytes.count > 65536 { throw DesktopError(code: "invalid_arguments", message: "Input exceeds 64 KiB") }
            }
            guard let value = try JSONValue.decode(bytes).object,
                  let url = value.string("url"), let key = value.string("device_key") else { throw DesktopError(code: "invalid_arguments", message: "Invalid desktop binding") }
            let confirmed = value.string("http_confirmed_origin")
            var caps: [String: Bool]?
            if let raw = value["capabilities"] {
                guard let object = raw.object, object.allSatisfy({ contract.desktopCapabilities.contains($0.key) && $0.value.bool != nil }) else { throw DesktopError(code: "invalid_arguments", message: "Invalid capabilities") }
                caps = object.mapValues { $0.bool! }
            }
            _ = try await NativeAuthorization.verifyToken(server: url, key: key, confirmedHttpOrigin: confirmed)
            let config = try storage.configure(url: url, key: key, httpConfirmedOrigin: confirmed, capabilities: caps)
            var result = try JSONValue.decode(JSONEncoder().encode(config)).object!; result["ok"] = .bool(true); emitJSON(result)
        case "status":
            if let status = try? await LocalControlServer.request(stateDir: storage.stateDir, request: ["command": .string("status")]) { emitJSON(status) }
            else {
                var value = (try? storage.readStatus()) ?? [:]
                value["connection"] = .string("offline"); value["active_operations"] = .number(0); value["active_controllers"] = .array([]); value["desktop_active_until"] = .number(0)
                emitJSON(value)
            }
        case "control":
            guard positionals.count == 2 else { throw DesktopError(code: "invalid_arguments", message: "A local control command is required") }
            var request: JSONObject = ["command": .string(positionals[1])]
            for name in ["capability", "name"] { if let value = options[name] { request[name] = .string(value) } }
            if let enabled = options["enabled"] {
                guard ["true", "false"].contains(enabled) else { throw DesktopError(code: "invalid_arguments", message: "--enabled must be true or false") }
                request["enabled"] = .bool(enabled == "true")
            }
            if options["if-desktop-active"] != nil { request["if_desktop_active"] = .bool(true) }
            var result = try await LocalControlServer.request(stateDir: storage.stateDir, request: request)
            result["ok"] = .bool(true); emitJSON(result)
        case "diagnose":
            let executor = NativeExecutor(); emitJSON(await executor.diagnostics()); await executor.shutdown()
        case "smoke":
            let executor = NativeExecutor()
            do { emitJSON(try await executor.smoke()); await executor.shutdown() }
            catch { await executor.shutdown(); throw error }
        default: throw DesktopError(code: "invalid_arguments", message: "Unknown client command")
        }
    }
}
