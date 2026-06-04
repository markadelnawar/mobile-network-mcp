/**
 * mobile-network-mcp — iOS interceptor
 *
 * Drop this file into your Xcode project and call in AppDelegate or App init:
 *   #if DEBUG
 *   NetworkInterceptor.start()
 *   #endif
 *
 * Captures all URLSession traffic and forwards to the MCP ingest API.
 * Adjust `ingestURL` below if using a different port.
 */

import Foundation

final class NetworkInterceptor: URLProtocol {
    private static let ingestURL = URL(string: "http://localhost:7890/flows")!
    private static let handledKey = "NetworkInterceptorHandled"

    static func start() {
        URLProtocol.registerClass(NetworkInterceptor.self)
    }

    override class func canInit(with request: URLRequest) -> Bool {
        // Skip already-handled and our own ingest requests
        if URLProtocol.property(forKey: handledKey, in: request) != nil { return false }
        if request.url?.host == "localhost" && request.url?.port == 7890 { return false }
        return true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        return request
    }

    override func startLoading() {
        let mutableRequest = (request as NSURLRequest).mutableCopy() as! NSMutableURLRequest
        URLProtocol.setProperty(true, forKey: Self.handledKey, in: mutableRequest)

        let startTime = Date()

        let task = URLSession.shared.dataTask(with: mutableRequest as URLRequest) { [weak self] data, response, error in
            guard let self = self else { return }
            let duration = Date().timeIntervalSince(startTime) * 1000

            if let httpResponse = response as? HTTPURLResponse {
                self.client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
                if let data = data {
                    self.client?.urlProtocol(self, didLoad: data)
                }
                self.client?.urlProtocolDidFinishLoading(self)

                self.sendToIngest(
                    request: self.request,
                    status: httpResponse.statusCode,
                    responseHeaders: httpResponse.allHeaderFields as? [String: String] ?? [:],
                    responseBody: data.flatMap { String(data: $0, encoding: .utf8) },
                    duration: duration
                )
            } else if let error = error {
                self.client?.urlProtocol(self, didFailWithError: error)
            }
        }
        task.resume()
    }

    override func stopLoading() {}

    private func sendToIngest(
        request: URLRequest,
        status: Int,
        responseHeaders: [String: String],
        responseBody: String?,
        duration: Double
    ) {
        var headers: [String: String] = [:]
        request.allHTTPHeaderFields?.forEach { headers[$0.key.lowercased()] = $0.value }

        let flow: [String: Any] = [
            "request": [
                "url": request.url?.absoluteString ?? "",
                "method": request.httpMethod ?? "GET",
                "headers": headers,
                "body": request.httpBody.flatMap { String(data: $0, encoding: .utf8) } as Any,
            ],
            "response": [
                "status": status,
                "statusText": "",
                "headers": responseHeaders,
                "body": responseBody as Any,
            ],
            "duration": duration,
        ]

        guard let body = try? JSONSerialization.data(withJSONObject: flow) else { return }

        var ingestRequest = URLRequest(url: Self.ingestURL)
        ingestRequest.httpMethod = "POST"
        ingestRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        ingestRequest.httpBody = body
        URLProtocol.setProperty(true, forKey: Self.handledKey, in: ingestRequest as! NSMutableURLRequest)
        URLSession.shared.dataTask(with: ingestRequest).resume()
    }
}
