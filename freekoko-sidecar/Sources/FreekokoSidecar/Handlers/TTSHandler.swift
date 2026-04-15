// Handlers/TTSHandler.swift
//
// POST /tts        — validate → chunk → generate → concatenate → encode WAV → respond.
// POST /tts/stream — validate → chunk → stream PCM frames as each chunk completes.

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
    static let interChunkSilenceSamples = Int(Double(24000) * 0.15)

    /// Hard input ceiling for the legacy `/tts` endpoint (per ARCHITECTURE §2.3).
    /// `/tts/stream` deliberately drops this cap — see plan §"Phase 1".
    private static let maxTextLength = 8000

    /// Output sample rate (mono, 24 kHz). Single source of truth for both endpoints
    /// and the wire-protocol preamble.
    static let sampleRate: UInt32 = 24000

    /// 4-byte ASCII magic prefix for `/tts/stream` responses ("FKST" = FreeKoko STream).
    static let streamMagic: [UInt8] = [0x46, 0x4B, 0x53, 0x54]

    // MARK: - /tts (unchanged behavior — byte-identical responses)

    static func handle(
        request: Request,
        context: some RequestContext
    ) async throws -> Response {
        let engine = EngineWrapper.shared

        let validated: ValidatedRequest
        switch await validate(request: request, engine: engine, enforceMaxLength: true) {
        case .ok(let v): validated = v
        case .err(let r): return r
        }

        let chunks = TextChunker.chunk(validated.text)
        if chunks.isEmpty {
            return errorResponse(
                .badRequest,
                code: "text_empty",
                message: "Text produced no usable chunks."
            )
        }

        let startedAt = Date()
        var combined: [Float] = []
        combined.reserveCapacity(chunks.count * 24_000)

        for (i, chunk) in chunks.enumerated() {
            do {
                let samples = try await engine.generate(
                    text: chunk,
                    voice: validated.voice,
                    speed: validated.speed
                )
                if i > 0 {
                    combined.append(contentsOf: repeatElement(0.0, count: interChunkSilenceSamples))
                }
                combined.append(contentsOf: samples)
            } catch {
                JSONLogger.error("tts_error", [
                    "voice": validated.voice,
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

        let wav = WAVEncoder.encode(samples: combined, sampleRate: Int(sampleRate), channels: 1)
        let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)

        JSONLogger.info("tts_done", [
            "voice": validated.voice,
            "speed": Double(validated.speed),
            "chunks": chunks.count,
            "samples": combined.count,
            "bytes": wav.count,
            "text_length": validated.text.count,
            "duration_ms": durationMs,
        ])

        let buffer = ByteBuffer(data: wav)
        var headers: HTTPFields = [:]
        headers[.contentType] = "audio/wav"
        headers[.contentLength] = String(wav.count)
        headers[HTTPField.Name("x-freekoko-voice")!] = validated.voice
        headers[HTTPField.Name("x-freekoko-duration-ms")!] = String(durationMs)
        headers[HTTPField.Name("x-freekoko-sample-count")!] = String(combined.count)
        return Response(
            status: .ok,
            headers: headers,
            body: .init(byteBuffer: buffer)
        )
    }

    // MARK: - /tts/stream

    /// Streaming endpoint. Wire format:
    ///
    ///   Preamble (16 B): ["FKST"][u32 BE sampleRate][u32 BE totalChunks][u32 BE 0]
    ///   Per chunk:       [u32 BE chunkIndex][u32 BE pcmByteLen][Float32 LE PCM bytes]
    ///
    /// Frames carry **speech-only** PCM; the 0.15 s inter-chunk silence is re-inserted
    /// client-side during WAV assembly and playback scheduling so saved WAVs remain
    /// byte-identical to `/tts`. See plan §"Inter-chunk silence (parity rule)".
    static func handleStream(
        request: Request,
        context: some RequestContext
    ) async throws -> Response {
        let engine = EngineWrapper.shared

        // The streaming endpoint intentionally drops the 8k character cap — long
        // inputs are precisely the case streaming exists to serve.
        let validated: ValidatedRequest
        switch await validate(request: request, engine: engine, enforceMaxLength: false) {
        case .ok(let v): validated = v
        case .err(let r): return r
        }

        let chunks = TextChunker.chunk(validated.text)
        if chunks.isEmpty {
            return errorResponse(
                .badRequest,
                code: "text_empty",
                message: "Text produced no usable chunks."
            )
        }

        let voice = validated.voice
        let speed = validated.speed
        let textLength = validated.text.count
        let totalChunks = chunks.count
        let sampleRate = Self.sampleRate

        var headers: HTTPFields = [:]
        headers[.contentType] = "application/octet-stream"
        headers[HTTPField.Name("x-freekoko-voice")!] = voice
        headers[HTTPField.Name("x-freekoko-total-chunks")!] = String(totalChunks)
        headers[HTTPField.Name("x-freekoko-sample-rate")!] = String(sampleRate)

        let body = ResponseBody { writer in
            let startedAt = Date()
            JSONLogger.info("tts_stream_start", [
                "voice": voice,
                "speed": Double(speed),
                "text_length": textLength,
                "total_chunks": totalChunks,
                "sample_rate": Int(sampleRate),
            ])

            // Preamble — 16 B, sent up front so the client can size buffers and
            // know how many chunk frames to expect.
            var preamble = ByteBuffer()
            preamble.reserveCapacity(16)
            preamble.writeBytes(Self.streamMagic)
            preamble.writeInteger(sampleRate, endianness: .big, as: UInt32.self)
            preamble.writeInteger(UInt32(totalChunks), endianness: .big, as: UInt32.self)
            preamble.writeInteger(UInt32(0), endianness: .big, as: UInt32.self) // reserved
            try await writer.write(preamble)

            var sentChunks = 0
            do {
                for (i, chunk) in chunks.enumerated() {
                    // Between-chunk cancellation point. The actor serialises
                    // `generate`, so this fires before kicking off the next inference.
                    try Task.checkCancellation()

                    let samples = try await engine.generate(
                        text: chunk,
                        voice: voice,
                        speed: speed
                    )

                    let pcmByteLen = samples.count * MemoryLayout<Float32>.size
                    var frame = ByteBuffer()
                    frame.reserveCapacity(8 + pcmByteLen)
                    frame.writeInteger(UInt32(i), endianness: .big, as: UInt32.self)
                    frame.writeInteger(UInt32(pcmByteLen), endianness: .big, as: UInt32.self)
                    // Float32 little-endian on every supported Apple Silicon host;
                    // the array's storage layout matches the wire format directly.
                    samples.withUnsafeBufferPointer { ptr in
                        _ = frame.writeBytes(UnsafeRawBufferPointer(ptr))
                    }

                    try await writer.write(frame)
                    sentChunks += 1

                    JSONLogger.info("tts_stream_chunk", [
                        "voice": voice,
                        "chunk_index": i,
                        "total_chunks": totalChunks,
                        "sample_count": samples.count,
                        "ms_since_start": Int(Date().timeIntervalSince(startedAt) * 1000),
                    ])
                }

                try await writer.finish(nil)

                JSONLogger.info("tts_stream_complete", [
                    "voice": voice,
                    "total_chunks": totalChunks,
                    "sent_chunks": sentChunks,
                    "total_ms": Int(Date().timeIntervalSince(startedAt) * 1000),
                ])
            } catch is CancellationError {
                JSONLogger.info("tts_stream_cancelled", [
                    "voice": voice,
                    "total_chunks": totalChunks,
                    "sent_chunks": sentChunks,
                    "total_ms": Int(Date().timeIntervalSince(startedAt) * 1000),
                ])
                // Re-throw so Hummingbird tears down the response — we don't
                // try to write a trailer because the connection is gone.
                throw CancellationError()
            } catch {
                JSONLogger.error("tts_stream_error", [
                    "voice": voice,
                    "total_chunks": totalChunks,
                    "sent_chunks": sentChunks,
                    "error": String(describing: error),
                    "total_ms": Int(Date().timeIntervalSince(startedAt) * 1000),
                ])
                throw error
            }
        }

        return Response(status: .ok, headers: headers, body: body)
    }

    // MARK: - Shared validation

    struct ValidatedRequest {
        let text: String
        let voice: String
        let speed: Float
    }

    enum ValidationResult {
        case ok(ValidatedRequest)
        case err(Response)
    }

    private static func validate(
        request: Request,
        engine: EngineWrapper,
        enforceMaxLength: Bool
    ) async -> ValidationResult {
        // Decode body up front as JSON. The legacy `/tts` endpoint keeps its tight
        // 64 KB ceiling (paired with the 8k character cap); `/tts/stream` allows
        // larger bodies because the streaming path exists precisely to serve them.
        let bodyLimit = enforceMaxLength ? 64 * 1024 : 4 * 1024 * 1024
        let payload: TTSRequest
        do {
            let bodyBuffer = try await request.body.collect(upTo: bodyLimit)
            let bodyData = Data(buffer: bodyBuffer)
            payload = try JSONDecoder().decode(TTSRequest.self, from: bodyData)
        } catch {
            return .err(errorResponse(
                .badRequest,
                code: "invalid_json",
                message: "Request body must be valid JSON: \(error.localizedDescription)"
            ))
        }

        // Is the engine ready? If not, 503.
        guard await engine.isReady() else {
            return .err(errorResponse(
                .serviceUnavailable,
                code: "model_not_loaded",
                message: "Model is still loading, retry shortly."
            ))
        }

        // Validate text.
        let text = payload.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            return .err(errorResponse(
                .badRequest,
                code: "text_empty",
                message: "Text field is required and must not be empty."
            ))
        }
        if enforceMaxLength, text.count > maxTextLength {
            return .err(errorResponse(
                .badRequest,
                code: "text_too_long",
                message: "Text exceeds \(maxTextLength) character limit.",
                details: ["length": text.count]
            ))
        }

        // Validate voice.
        let voice = payload.voice ?? Constants.defaultVoice
        if !(await engine.isVoiceAvailable(voice)) {
            return .err(errorResponse(
                .badRequest,
                code: "voice_not_found",
                message: "Voice '\(voice)' is not available.",
                details: ["voice": voice]
            ))
        }

        // Validate speed.
        let speed = payload.speed ?? 1.0
        if speed < 0.5 || speed > 2.0 {
            return .err(errorResponse(
                .badRequest,
                code: "invalid_speed",
                message: "Speed must be between 0.5 and 2.0.",
                details: ["speed": Double(speed)]
            ))
        }

        return .ok(ValidatedRequest(text: text, voice: voice, speed: speed))
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
