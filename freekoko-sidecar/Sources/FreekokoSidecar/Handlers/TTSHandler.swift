// Handlers/TTSHandler.swift
//
// POST /tts — validate → chunk → generate → concatenate → encode WAV → respond.

import Foundation
import HTTPTypes
import Hummingbird
import KokoroVoiceShared
import NIOCore

struct TTSRequest: Codable {
    let text: String
    let voice: String?
    let speed: Float?
}

enum TTSHandler {

    /// Silence inserted between chunks (~0.15s at 24 kHz).
    private static let interChunkSilenceSamples = Int(Double(24000) * 0.15)

    /// Hard input ceiling (per ARCHITECTURE §2.3).
    private static let maxTextLength = 8000

    static func handle(
        request: Request,
        context: some RequestContext
    ) async throws -> Response {
        let engine = EngineWrapper.shared

        // Decode body up front as JSON.
        let payload: TTSRequest
        do {
            let bodyBuffer = try await request.body.collect(upTo: 64 * 1024)
            let bodyData = Data(buffer: bodyBuffer)
            payload = try JSONDecoder().decode(TTSRequest.self, from: bodyData)
        } catch {
            return errorResponse(
                .badRequest,
                code: "invalid_json",
                message: "Request body must be valid JSON: \(error.localizedDescription)"
            )
        }

        // Is the engine ready? If not, 503.
        guard await engine.isReady() else {
            return errorResponse(
                .serviceUnavailable,
                code: "model_not_loaded",
                message: "Model is still loading, retry shortly."
            )
        }

        // Validate text.
        let text = payload.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            return errorResponse(
                .badRequest,
                code: "text_empty",
                message: "Text field is required and must not be empty."
            )
        }
        if text.count > maxTextLength {
            return errorResponse(
                .badRequest,
                code: "text_too_long",
                message: "Text exceeds \(maxTextLength) character limit.",
                details: ["length": text.count]
            )
        }

        // Validate voice.
        let voice = payload.voice ?? Constants.defaultVoice
        if !(await engine.isVoiceAvailable(voice)) {
            return errorResponse(
                .badRequest,
                code: "voice_not_found",
                message: "Voice '\(voice)' is not available.",
                details: ["voice": voice]
            )
        }

        // Validate speed.
        let speed = payload.speed ?? 1.0
        if speed < 0.5 || speed > 2.0 {
            return errorResponse(
                .badRequest,
                code: "invalid_speed",
                message: "Speed must be between 0.5 and 2.0.",
                details: ["speed": Double(speed)]
            )
        }

        // Chunk + generate.
        let chunks = TextChunker.chunk(text)
        if chunks.isEmpty {
            return errorResponse(
                .badRequest,
                code: "text_empty",
                message: "Text produced no usable chunks."
            )
        }

        let startedAt = Date()
        var combined: [Float] = []
        combined.reserveCapacity(chunks.count * 24_000)  // rough pre-size

        for (i, chunk) in chunks.enumerated() {
            do {
                let samples = try await engine.generate(
                    text: chunk,
                    voice: voice,
                    speed: speed
                )
                if i > 0 {
                    combined.append(contentsOf: repeatElement(0.0, count: interChunkSilenceSamples))
                }
                combined.append(contentsOf: samples)
            } catch {
                JSONLogger.error("tts_error", [
                    "voice": voice,
                    "chunk_index": i,
                    "total_chunks": chunks.count,
                    "error": String(describing: error),
                ])
                return errorResponse(
                    .internalServerError,
                    code: "synthesis_failed",
                    message: "Engine error: \(error.localizedDescription)"
                )
            }
        }

        let wav = WAVEncoder.encode(samples: combined, sampleRate: 24000, channels: 1)
        let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)

        JSONLogger.info("tts_done", [
            "voice": voice,
            "speed": Double(speed),
            "chunks": chunks.count,
            "samples": combined.count,
            "bytes": wav.count,
            "text_length": text.count,
            "duration_ms": durationMs,
        ])

        let buffer = ByteBuffer(data: wav)
        var headers: HTTPFields = [:]
        headers[.contentType] = "audio/wav"
        headers[.contentLength] = String(wav.count)
        headers[HTTPField.Name("x-freekoko-voice")!] = voice
        headers[HTTPField.Name("x-freekoko-duration-ms")!] = String(durationMs)
        headers[HTTPField.Name("x-freekoko-sample-count")!] = String(combined.count)
        return Response(
            status: .ok,
            headers: headers,
            body: .init(byteBuffer: buffer)
        )
    }

    // MARK: - Error response helper

    private static func errorResponse(
        _ status: HTTPResponse.Status,
        code: String,
        message: String,
        details: [String: Any] = [:]
    ) -> Response {
        var payload: [String: Any] = [
            "error": code,
            "message": message,
        ]
        if !details.isEmpty {
            payload["details"] = details
        }
        let data = (try? JSONSerialization.data(
            withJSONObject: payload,
            options: [.sortedKeys]
        )) ?? Data("{\"error\":\"\(code)\"}".utf8)
        let buffer = ByteBuffer(data: data)
        return Response(
            status: status,
            headers: [.contentType: "application/json"],
            body: .init(byteBuffer: buffer)
        )
    }
}
