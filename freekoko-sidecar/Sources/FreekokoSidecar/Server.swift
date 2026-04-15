// Server.swift
//
// Hummingbird 2 Application wrapper. Registers all 3 routes and a JSON
// request-logging middleware.

import Foundation
import Hummingbird
import NIOCore

struct Server {

    let host: String
    let port: Int

    func run() async throws {
        let router = Router()

        // Per-request JSON access log.
        router.add(middleware: JSONLoggingMiddleware())

        router.post("/tts") { request, context in
            try await TTSHandler.handle(request: request, context: context)
        }
        router.post("/tts/stream") { request, context in
            try await TTSHandler.handleStream(request: request, context: context)
        }
        router.get("/voices") { request, context in
            try await VoicesHandler.handle(request: request, context: context)
        }
        router.get("/health") { request, context in
            try await HealthHandler.handle(request: request, context: context)
        }

        let app = Application(
            router: router,
            configuration: .init(
                address: .hostname(host, port: port),
                serverName: "freekoko-sidecar"
            )
        )

        JSONLogger.info("server_started", [
            "host": host,
            "port": port,
        ])

        try await app.runService()
    }
}

/// Simple request-logging middleware that emits `request_complete` JSON
/// lines with method, path, status, and latency in ms.
struct JSONLoggingMiddleware<Context: RequestContext>: RouterMiddleware {
    func handle(
        _ request: Request,
        context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {
        let started = Date()
        do {
            let response = try await next(request, context)
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            JSONLogger.info("request_complete", [
                "method": "\(request.method)",
                "path": request.uri.path,
                "status": Int(response.status.code),
                "duration_ms": ms,
            ])
            return response
        } catch {
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            JSONLogger.warn("request_error", [
                "method": "\(request.method)",
                "path": request.uri.path,
                "error": String(describing: error),
                "duration_ms": ms,
            ])
            throw error
        }
    }
}
