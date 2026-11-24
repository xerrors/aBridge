import Foundation
import Security

func requireDeviceServerTransport(_ normalizedServer: String) throws {
    guard let server = URL(string: normalizedServer) else {
        throw DesktopError(code: "invalid_url", message: "Server 地址无效")
    }
    let transport = DeviceServerTransport(server: server)
    #if ABRIDGE_CONFIRMED_HTTP
    guard transport == .confirmedHTTP else {
        throw DesktopError(code: "transport_mismatch", message: "此设备客户端仅用于明确确认的远端 HTTP Server。请使用 abridge-desktop 连接 HTTPS 或回环地址。")
    }
    #else
    guard transport == .standard else {
        throw DesktopError(code: "transport_mismatch", message: "连接已确认的远端 HTTP Server 需要使用 abridge-desktop-http。")
    }
    #endif
}

/// 设备授权请求、改名和 WebSocket 都只连接已选 Server，不随重定向传递凭据。
private final class DeviceNetworkDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

func deviceServerSession(timeout: TimeInterval? = nil) -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCredentialStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
    if let timeout {
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
    }
    return URLSession(configuration: configuration, delegate: DeviceNetworkDelegate(), delegateQueue: nil)
}

/// 仅根据系统错误码说明故障，避免显示请求地址和底层诊断原文。
func deviceServerNetworkFailure(_ error: URLError) -> String {
    switch error.code {
    case .badURL, .unsupportedURL:
        return "Server 地址无效，请检查地址是否使用 HTTP 或 HTTPS"
    case .cannotConnectToHost:
        return "无法连接 Server，请检查地址、端口及 Server 是否运行"
    case .cannotFindHost, .dnsLookupFailed:
        return "无法解析 Server 域名，请检查地址和 DNS 设置"
    case .notConnectedToInternet:
        return "此 Mac 无法访问网络，请检查网络。若使用局域网，请在「隐私与安全性 → 本地网络」中允许 aBridge"
    case .networkConnectionLost, .cancelled:
        return "与 Server 的连接中断，请检查网络及 Server 是否运行"
    case .timedOut:
        return "连接 Server 超时，请检查网络、地址和防火墙"
    case .appTransportSecurityRequiresSecureConnection:
        return "macOS 拒绝了未加密连接（-1022），请确认当前使用支持 HTTP 的 aBridge 客户端"
    case .secureConnectionFailed:
        return "无法建立 HTTPS 连接，请检查 Server 地址的协议和 TLS 配置"
    case .serverCertificateHasBadDate, .serverCertificateNotYetValid:
        return "Server 的 HTTPS 证书已过期或尚未生效，请检查证书有效期及此 Mac 的日期与时间"
    case .serverCertificateUntrusted, .serverCertificateHasUnknownRoot:
        return "此 Mac 无法信任 Server 的 HTTPS 证书，请检查证书域名和证书链"
    case .clientCertificateRejected, .clientCertificateRequired:
        return "Server 要求客户端证书或拒绝了证书，请检查反向代理的 TLS 认证设置"
    case .badServerResponse, .cannotParseResponse:
        return "Server 返回了无法识别的响应，请检查地址及反向代理设置"
    default:
        return "与 Server 通信失败（网络错误 \(error.code.rawValue)），请检查网络及 Server 状态"
    }
}

/// HTTP 失败只显示状态码和固定排查建议。
func deviceServerHTTPFailure(_ status: Int) -> String {
    let message: String
    switch status {
    case 300..<400:
        message = "Server 返回了重定向，请填写最终的 Server 地址"
    case 401, 403:
        message = "Server 拒绝访问，请检查 Server 和反向代理的访问规则"
    case 404, 405:
        message = "Server 未提供此接口，请检查地址、反向代理路由和 Server 版本"
    case 421:
        message = "Server 拒绝了请求的 Host，请检查 Server 对外地址和反向代理的 Host 转发设置"
    case 429:
        message = "请求过于频繁，请稍后重试"
    case 500..<600:
        message = "Server 或反向代理暂时无法处理请求，请检查服务状态后重试"
    default:
        message = "Server 返回了意外的 HTTP 状态，请检查地址和 Server 配置"
    }
    return "\(message)（HTTP \(status)）"
}
