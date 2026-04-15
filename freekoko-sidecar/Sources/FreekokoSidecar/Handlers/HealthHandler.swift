// Handlers/HealthHandler.swift
//
// GET /health — returns process + model status. Electron polls this at
// 2-second intervals to decide when the sidecar is ready to serve TTS.

import Foundation
import Hummingbird

enum HealthHandler {

    static func handle(
        request: Request,
        context: some RequestContext
    ) async throws -> Response {
        let engine = EngineWrapper.shared
        let ready = await engine.isReady()
        let voiceCount = await engine.voiceCount()
        let uptime = await engine.uptimeSeconds()

        let status: String = ready ? "ok" : "loading"
        let httpStatus: HTTPResponse.Status = ready ? .ok : .serviceUnavailable

        let body: [String: Any] = [
            "status": status,
            "model_loaded": ready,
            "voice_count": voiceCount,
            "uptime_seconds": Double(round(uptime * 100) / 100),
        ]

        return try JSONResponse.make(body, status: httpStatus)
    }
}
