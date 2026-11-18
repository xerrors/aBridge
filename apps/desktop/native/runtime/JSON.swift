import Foundation
import CryptoKit

/// Explicit values at all device, storage and native-library boundaries.
enum JSONValue: Codable, Sendable, Equatable {
    case object(JSONObject), array([JSONValue]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self), n.isFinite { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode(JSONObject.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    static func decode(_ data: Data) throws -> JSONValue { try JSONDecoder().decode(Self.self, from: data) }
    func encoded() throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
    var string: String? { if case .string(let v) = self { return v }; return nil }
    var bool: Bool? { if case .bool(let v) = self { return v }; return nil }
    var number: Double? { if case .number(let v) = self { return v }; return nil }
    var object: JSONObject? { if case .object(let v) = self { return v }; return nil }
    var array: [JSONValue]? { if case .array(let v) = self { return v }; return nil }
}
typealias JSONObject = [String: JSONValue]
extension Dictionary where Key == String, Value == JSONValue {
    func string(_ key: String) -> String? { self[key]?.string }
    func bool(_ key: String) -> Bool? { self[key]?.bool }
    func number(_ key: String) -> Double? { self[key]?.number }
    func object(_ key: String) -> JSONObject? { self[key]?.object }
    func array(_ key: String) -> [JSONValue]? { self[key]?.array }
    func encoded() throws -> Data { try JSONValue.object(self).encoded() }
}
struct DesktopError: Error, LocalizedError, Sendable {
    let code: String
    let message: String
    let outcome: String
    let hint: String?
    let desktop: JSONObject?
    init(code: String, message: String, outcome: String = "refused", hint: String? = nil, desktop: JSONObject? = nil) {
        self.code = code; self.message = message; self.outcome = outcome; self.hint = hint; self.desktop = desktop
    }
    var errorDescription: String? { message }
    var json: JSONObject {
        var result: JSONObject = ["code": .string(code), "message": .string(message)]
        if let hint { result["hint"] = .string(hint) }
        if let desktop { result["desktop"] = .object(desktop) }
        return result
    }
}
func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func sleepMilliseconds(_ ms: Double) async throws { try await Task.sleep(nanoseconds: UInt64(max(0, ms) * 1_000_000)) }
func monotonicSeconds() -> Double { ProcessInfo.processInfo.systemUptime }
func epochSeconds() -> Double { Date().timeIntervalSince1970 }
func jsonError(_ error: Error) -> JSONObject {
    if let e = error as? DesktopError { return e.json }
    return ["code": .string("runtime_error"), "message": .string("Native client operation failed")]
}
func emitJSON(_ value: JSONObject) {
    if let data = try? value.encoded() { FileHandle.standardOutput.write(data + Data([10])) }
}
