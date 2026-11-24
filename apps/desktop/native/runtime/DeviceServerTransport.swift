import Foundation

enum DeviceServerTransport: Equatable {
    case standard, confirmedHTTP

    init(server: URL) {
        if server.scheme?.lowercased() == "http",
           let host = server.host?.lowercased(),
           !["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) {
            self = .confirmedHTTP
        } else {
            self = .standard
        }
    }

    var executableName: String {
        switch self {
        case .standard: "abridge-desktop"
        case .confirmedHTTP: "abridge-desktop-http"
        }
    }
}
