import Foundation
import Darwin

func expect(_ value: Bool, _ message: String) throws { if !value { throw DesktopError(code:"test_failed", message:message) } }
func refuses(_ body: () throws -> Void) throws { do { try body() } catch { return }; throw DesktopError(code:"test_failed",message:"Expected refusal") }
@main struct Harness {
    static func main() async throws {
        if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "authorize" {
            exit(await NativeAuthorization.command(stateDir: CommandLine.arguments[2]))
        }
        let root = NSTemporaryDirectory() + "abridge-native-fixture-" + UUID().uuidString
        defer { try? FileManager.default.removeItem(atPath:root) }
        try privateDirectory(root)
        let storage = NativeStorage(stateDir: root)
        var config = try storage.configure(url:"https://EXAMPLE.com:443/bridge/",key:"abr_device_fixture")
        try expect(config.url == "https://example.com/bridge", "URL normalization")
        try expect(config.capabilities.values.allSatisfy { !$0 }, "Capabilities default denied")
        try expect(try storage.loadCredential(url:config.url) == "abr_device_fixture", "Credential roundtrip")
        try refuses { _ = try storage.loadCredential(url:"https://different.invalid") }
        config.paused = true; config.pauseReason = "user"; try storage.saveConfig(config)
        let rebound = try storage.configure(url:config.url,key:"abr_device_fixture2",capabilities:["files":true])
        try expect(rebound.paused && rebound.pauseReason == "user" && rebound.capabilities["files"] == true, "Preserve pause")
        try storage.writeStatus(["online": .bool(true)])
        try expect(try storage.readStatus().bool("online") == true, "Status roundtrip")
        try refuses { _ = try normalizeServerURL("http://example.com") }
        try expect(try normalizeServerURL("http://example.com/",confirmedHttpOrigin:"http://example.com") == "http://example.com", "HTTP consent")
        try refuses { _ = try normalizeServerURL("https://user:secret@example.com") }
        try refuses { _ = try normalizeServerURL("https://example.com/?secret=1") }
        let privatePath = root + "/private.json"
        try writePrivateData(privatePath,data:Data("{}".utf8))
        chmod(privatePath,0o644)
        try refuses { _ = try readPrivateData(privatePath) }
        chmod(privatePath,0o600)
        try FileManager.default.createSymbolicLink(atPath:root + "/linked.json",withDestinationPath:privatePath)
        try refuses { _ = try readPrivateData(root + "/linked.json") }
        let journal = try OperationJournal(path:root + "/operations.sqlite3")
        try journal.start(id:"write1",hash:"request1")
        try refuses { try journal.start(id:"write1",hash:"request1") }
        journal.close()
        let recovered = try OperationJournal(path:root + "/operations.sqlite3")
        try expect(try recovered.get("write1")?.status == "outcome_unknown", "No replay after restart")
        try recovered.finish(id:"write1",status:"succeeded")
        try expect(try recovered.get("write1")?.requestHash == "request1", "Keep request identity")
        recovered.close()
        let server = try await LocalControlServer.start(stateDir:root) { input in ["value":input["value"] ?? .null] }
        let result = try await LocalControlServer.request(stateDir:root,request:["value":.string("fixture")])
        try expect(result.bool("ok") == true && result.string("value") == "fixture","Local socket response")
        do { _ = try await LocalControlServer.start(stateDir:root) { _ in [:] }; throw DesktopError(code:"test_failed",message:"Duplicate listener allowed") } catch { try expect((error as? DesktopError)?.code == "already_running","Duplicate listener refused") }
        await server.close()
        try expect(!FileManager.default.fileExists(atPath:controlSocketPath(root)),"Socket cleanup")
        do {
            _ = try await LocalControlServer.request(stateDir: root, request: ["command": .string("status")])
            throw DesktopError(code: "test_failed", message: "Expected control socket to be unavailable")
        } catch { try expect((error as? DesktopError)?.code == "control_unavailable", "Report missing device process") }
        do {
            _ = try NativeContract.load(path: root + "/missing-contract.json")
            throw DesktopError(code: "test_failed", message: "Expected missing bundled contract")
        } catch { try expect((error as? DesktopError)?.code == "invalid_contract", "Identify missing app resource") }
        let restarted = try await LocalControlServer.start(stateDir:root) { _ in [:] }
        await restarted.close()
        try storage.deleteCredential()
        try refuses { _ = try storage.loadCredential(url:config.url) }
        print("native lifecycle storage/socket: checks passed")
    }
}
