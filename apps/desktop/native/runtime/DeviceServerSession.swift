import Foundation
import Security

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
