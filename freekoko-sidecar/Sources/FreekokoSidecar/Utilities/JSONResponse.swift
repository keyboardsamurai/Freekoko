// Utilities/JSONResponse.swift
//
// Small helper that encodes a JSON body with `.sortedKeys` and builds a
// Hummingbird `Response` with `application/json`. Used by `VoicesHandler`
// and `HealthHandler` so both endpoints share a single canonical shape.

import Foundation
import Hummingbird

enum JSONResponse {

    /// Build a JSON `Response` from any `JSONSerialization`-compatible value.
    ///
    /// - Parameters:
    ///   - object: The value to encode. Must be a `JSONSerialization`-valid
    ///     top-level object (typically `[String: Any]` or `[[String: Any]]`).
    ///   - status: HTTP status code. Defaults to `.ok`.
    /// - Returns: A `Response` with `Content-Type: application/json` and a
    ///   `ByteBuffer` body containing the `.sortedKeys`-encoded JSON.
    static func make(
        _ object: Any,
        status: HTTPResponse.Status = .ok
    ) throws -> Response {
        let data = try JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys]
        )
        let buffer = ByteBuffer(data: data)
        return Response(
            status: status,
            headers: [.contentType: "application/json"],
            body: .init(byteBuffer: buffer)
        )
    }
}
