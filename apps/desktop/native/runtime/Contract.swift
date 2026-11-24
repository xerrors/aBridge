import Foundation

/// A deliberately bounded JSON Schema interpreter for the generated protocol contract.
/// Semantic refinements use the same portable expression tree as the TypeScript validators.
struct NativeContract: Sendable {
    let data: JSONObject
    static func load(path: String? = nil) throws -> NativeContract {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        let url = path.map { URL(fileURLWithPath: $0) } ?? executable.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources/desktop-contract.json")
        guard let bytes = try? Data(contentsOf: url), let data = (try? JSONValue.decode(bytes))?.object,
              data.string("version") != nil, data.object("schemas") != nil else {
            throw DesktopError(code: "invalid_contract", message: "无法读取 aBridge 随附的协议文件，请重新安装完整的 Mac 应用。")
        }
        return NativeContract(data: data)
    }
    var version: String { data.string("version")! }
    var protocolVersion: String { data.string("protocol")! }
    var desktopCapabilities: [String] { data.array("desktopCapabilities")!.compactMap(\.string) }
    var capabilities: [String] { data.array("capabilities")!.compactMap(\.string) }
    func isDeviceKeyRejection(_ response: HTTPURLResponse) -> Bool {
        guard response.statusCode == 401, let rejection = data.object("deviceKeyRejection"),
              let header = rejection.string("header"), let value = rejection.string("value") else { return false }
        return response.value(forHTTPHeaderField: header) == value
    }
    func limit(_ name: String) -> Double { data.object("limits")!.number(name)! }
    func requiredCapabilities(_ tool: String, _ arguments: JSONObject) -> Set<String> {
        guard let capability = data.object("toolCapabilities")?.string(tool) else { return [] }
        var result: Set<String> = [capability]
        if tool == "computer_open" || (tool == "computer_act" && (arguments.bool("observe_after") != false || arguments.bool("screenshot") == true)) { result.insert("screen") }
        return result
    }
    func validate(_ name: String, _ value: JSONObject) throws -> JSONObject {
        guard let schema = data.object("schemas")?.object(name),
              let result = try check(.object(value), schema).object else {
            throw DesktopError(code: "invalid_arguments", message: "Unknown native protocol schema")
        }
        return result
    }
    private func invalid() -> DesktopError { DesktopError(code: "invalid_arguments", message: "Arguments do not match the device protocol") }
    private func check(_ input: JSONValue, _ schema: JSONObject) throws -> JSONValue {
        var value = input
        if schema.bool("x-trim") == true, let s = value.string { value = .string(s.trimmingCharacters(in: .whitespacesAndNewlines)) }
        for union in ["anyOf", "oneOf"] {
            if let variants = schema.array(union) {
                let matches = variants.compactMap { branch -> JSONValue? in
                    guard let object = branch.object else { return nil }
                    return try? check(value, object)
                }
                guard let match = matches.first, union != "oneOf" || matches.count == 1 else { throw invalid() }
                value = match
            }
        }
        if let constant = schema["const"], constant != value { throw invalid() }
        if let allowed = schema.array("enum"), !allowed.contains(value) { throw invalid() }
        switch schema.string("type") {
        case "object":
            guard var object = value.object else { throw invalid() }
            let properties = schema.object("properties") ?? [:]
            for (key, specification) in properties {
                guard let child = specification.object else { throw invalid() }
                if let supplied = object[key] { object[key] = try check(supplied, child) }
                else if let fallback = child["default"] { object[key] = try check(fallback, child) }
            }
            for required in schema.array("required") ?? [] { guard let key = required.string, object[key] != nil else { throw invalid() } }
            for key in object.keys where properties[key] == nil {
                if let keySchema = schema.object("propertyNames") { _ = try check(.string(key), keySchema) }
                if schema.bool("additionalProperties") == false { throw invalid() }
                if let extra = schema.object("additionalProperties") { object[key] = try check(object[key]!, extra) }
            }
            value = .object(object)
        case "array":
            guard var items = value.array else { throw invalid() }
            if let min = schema.number("minItems"), Double(items.count) < min { throw invalid() }
            if let max = schema.number("maxItems"), Double(items.count) > max { throw invalid() }
            if let child = schema.object("items") { items = try items.map { try check($0, child) } }
            value = .array(items)
        case "string":
            guard let string = value.string else { throw invalid() }
            // JSON Schema and the pinned Zod version measure Unicode code points.
            if let min = schema.number("minLength"), Double(string.unicodeScalars.count) < min { throw invalid() }
            if let max = schema.number("maxLength"), Double(string.unicodeScalars.count) > max { throw invalid() }
            if let pattern = schema.string("pattern") {
                let regex = try NSRegularExpression(pattern: pattern)
                guard regex.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)) != nil else { throw invalid() }
            }
            if let format = schema.string("format"), ["uri", "url"].contains(format), URL(string: string)?.scheme == nil { throw invalid() }
        case "number", "integer":
            guard let number = value.number, number.isFinite else { throw invalid() }
            if schema.string("type") == "integer", number.rounded() != number { throw invalid() }
            if let min = schema.number("minimum"), number < min { throw invalid() }
            if let max = schema.number("maximum"), number > max { throw invalid() }
            if let min = schema.number("exclusiveMinimum"), number <= min { throw invalid() }
            if let max = schema.number("exclusiveMaximum"), number >= max { throw invalid() }
        case "boolean": guard value.bool != nil else { throw invalid() }
        case "null": guard value == .null else { throw invalid() }
        case nil: break
        default: throw DesktopError(code: "invalid_contract", message: "Unsupported contract type")
        }
        if let rule = schema.array("x-rule"), !evaluate(rule, value) { throw invalid() }
        return value
    }
    private func evaluate(_ rule: [JSONValue], _ value: JSONValue) -> Bool {
        guard let op = rule.first?.string else { return false }
        let args = Array(rule.dropFirst())
        func sub(_ expression: JSONValue) -> Bool { evaluate(expression.array ?? [], value) }
        func field() -> JSONValue? { args.first?.string == "" ? value : value.object?[args.first?.string ?? ""] }
        switch op {
        case "and": return args.allSatisfy(sub)
        case "or": return args.contains(where: sub)
        case "not": return !sub(args[0])
        case "exists": return field() != nil
        case "truthy":
            guard let v = field() else { return false }
            if let b = v.bool { return b }; if let n = v.number { return n != 0 }; if let s = v.string { return !s.isEmpty }; return v != .null
        case "noNul": return value.string.map { !$0.contains("\0") } ?? false
        case "nonblank": return value.string.map { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? false
        case "unicode": return value.string != nil // Swift decoding rejects unpaired surrogates.
        case "utf8Max": return value.string.map { Double($0.utf8.count) <= (args.first?.number ?? 0) } ?? false
        case "unique": guard let array = value.array else { return false }; return array.enumerated().allSatisfy { index, item in !array.prefix(index).contains(item) }
        default: return false
        }
    }
}
