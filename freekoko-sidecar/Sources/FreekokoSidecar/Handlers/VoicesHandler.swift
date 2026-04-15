// Handlers/VoicesHandler.swift
//
// GET /voices — returns the catalog of voices with an `available` flag
// indicating whether the voice's embedding was loaded at startup.

import Foundation
import Hummingbird
import KokoroVoiceShared

enum VoicesHandler {

    static func handle(
        request: Request,
        context: some RequestContext
    ) async throws -> Response {
        let engine = EngineWrapper.shared
        let loaded = await engine.availableVoices()
        let loadedIDs = Set(loaded.map(\.id))

        let voices: [[String: Any]] = Constants.availableVoices.map { v in
            [
                "id": v.id,
                "name": v.name,
                "language": v.language,
                "gender": v.gender.rawValue,
                "quality": v.quality.rawValue,
                "available": loadedIDs.contains(v.id),
            ]
        }

        return try JSONResponse.make(voices)
    }
}
