// Logging/JSONLogger.swift
//
// Newline-delimited JSON logger that writes to stdout. Electron reads each
// line and parses it as a single structured log event. All sidecar events
// should flow through this logger so the supervisor has a uniform schema.

import Foundation

enum JSONLogLevel: String, Sendable {
    case debug
    case info
    case warn
    case error
}

enum JSONLogger {

    /// Global lock to serialize stdout writes across concurrent tasks.
    private static let lock = NSLock()

    /// Sendable ISO-8601 format style with millisecond precision in UTC.
    /// Replaces `ISO8601DateFormatter` (non-Sendable) under strict concurrency.
    private static let timestampStyle = Date.ISO8601FormatStyle(
        includingFractionalSeconds: true,
        timeZone: .gmt
    )

    /// Emit a log event at the given level.
    static func log(
        _ event: String,
        level: JSONLogLevel = .info,
        _ fields: [String: Any] = [:]
    ) {
        lock.lock()
        defer { lock.unlock() }

        var payload: [String: Any] = [
            "ts": Date().formatted(timestampStyle),
            "level": level.rawValue,
            "msg": event,
        ]
        // Merge caller-supplied fields without overwriting the fixed keys.
        for (key, value) in fields where payload[key] == nil {
            payload[key] = sanitize(value)
        }

        guard let data = try? JSONSerialization.data(
            withJSONObject: payload,
            options: [.sortedKeys]
        ),
              let line = String(data: data, encoding: .utf8)
        else {
            return
        }

        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }

    static func info(_ event: String, _ fields: [String: Any] = [:]) {
        log(event, level: .info, fields)
    }

    static func warn(_ event: String, _ fields: [String: Any] = [:]) {
        log(event, level: .warn, fields)
    }

    static func error(_ event: String, _ fields: [String: Any] = [:]) {
        log(event, level: .error, fields)
    }

    static func debug(_ event: String, _ fields: [String: Any] = [:]) {
        log(event, level: .debug, fields)
    }

    /// Convert values that JSONSerialization cannot handle (URL, UUID, etc.)
    /// into JSON-safe primitives.
    private static func sanitize(_ value: Any) -> Any {
        switch value {
        case let url as URL: return url.path
        case let uuid as UUID: return uuid.uuidString
        case let err as Error: return String(describing: err)
        default:
            if JSONSerialization.isValidJSONObject([value]) {
                return value
            }
            return String(describing: value)
        }
    }
}
