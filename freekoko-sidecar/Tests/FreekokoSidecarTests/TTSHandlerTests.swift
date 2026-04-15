// Tests/FreekokoSidecarTests/TTSHandlerTests.swift
//
// Integration tests for POST /tts (the non-streaming WAV endpoint). The
// streaming endpoint has its own dedicated coverage in
// TTSStreamHandlerTests.swift — this file locks in the /tts wire contract:
//
//   - Returns a valid RIFF/WAVE response (24 kHz, mono, 16-bit PCM) for a
//     multi-chunk input.
//   - The WAV contains exactly `sum(chunk_samples) + (chunks - 1) * 3600`
//     samples. That `(chunks - 1) * 3600` term is the inter-chunk silence
//     padding from the root CLAUDE.md wire-protocol invariant — it's what
//     keeps /tts byte-identical to a client-side-assembled /tts/stream WAV.
//     This test is the belt-and-suspenders on that rule.
//
// Model dependency is handled the same way TTSStreamHandlerTests does it:
// gated on the shared `EngineState` actor (FREEKOKO_TEST_RUN_ENGINE=1,
// FREEKOKO_TEST_RESOURCES_DIR overridable).

import Foundation
import KokoroVoiceShared
import XCTest

@testable import FreekokoSidecar

final class TTSHandlerTests: XCTestCase {

    /// Skip if the Kokoro model couldn't be loaded for the suite. Matches the
    /// pattern in `TTSStreamHandlerTests.ensureEngine()`.
    private func ensureEngine() async throws {
        let status = await EngineState.shared.ensureLoaded()
        if let err = status.error {
            throw XCTSkip("Engine failed to load: \(err)")
        }
        if !status.loaded {
            throw XCTSkip("""
                Kokoro engine not loaded. Engine-backed tests are gated behind \
                FREEKOKO_TEST_RUN_ENGINE=1 because MLX-Swift's static linkage \
                produces duplicate-symbol crashes under `swift test`. Run via \
                Xcode (or `xcodebuild test`) with FREEKOKO_TEST_RUN_ENGINE=1 \
                and FREEKOKO_TEST_RESOURCES_DIR=/abs/path/to/kokoro/Resources \
                (default: ../upstream-kokoro/Resources) to exercise these tests.
                """)
        }
    }

    // MARK: - Model-independent checks

    /// The non-streaming endpoint must return 503 `model_not_loaded` JSON
    /// before the engine has initialized. Sibling of the /tts/stream version.
    /// Runs under plain `swift test` — no MLX required.
    func testReturnsModelNotLoadedWhenEngineUnavailable() async throws {
        let isEngineReady = await EngineWrapper.shared.isReady()
        try XCTSkipIf(
            isEngineReady,
            "Engine already loaded by another test in this process; can't probe model_not_loaded path."
        )
        try await TestServer.withServer { port in
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/tts")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["text": "hi"])
            let (data, response) = try await URLSession.shared.data(for: request)
            let httpResp = try XCTUnwrap(response as? HTTPURLResponse)
            XCTAssertEqual(httpResp.statusCode, 503)
            let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(json["error"] as? String, "model_not_loaded")
        }
    }

    // MARK: - Engine-backed: WAV shape + silence-padding invariant

    /// Drive /tts with a multi-chunk input. Assert the response is a valid
    /// 24 kHz / mono / 16-bit PCM WAV, and that its total sample count
    /// matches the wire-protocol invariant:
    ///
    ///   total_samples == sum(per_chunk_samples) + (chunks - 1) * 3600
    ///
    /// The `3600 = 0.15 s × 24000` silence gap comes from
    /// `TTSHandler.interChunkSilenceSamples` and is the exact value the
    /// renderer/main process re-insert when reassembling a /tts/stream
    /// response so that saved WAVs are byte-identical between the two paths.
    func testTTSRespondsWithValidWAVAndInterChunkSilence() async throws {
        try await ensureEngine()

        // Long enough to force multiple chunks through `TextChunker`.
        let text = String(repeating: "The quick brown fox jumps over the lazy dog. ", count: 20)
        let chunks = TextChunker.chunk(text)
        XCTAssertGreaterThan(chunks.count, 1, "Test input must produce >1 chunk")

        let voice = Constants.defaultVoice
        let speed: Float = 1.0

        // Reference: drive the same engine path /tts uses to predict the
        // per-chunk speech-sample counts. The handler's actor-serialised
        // `generate` path is deterministic given the same text/voice/speed,
        // so the reference totals match what /tts will concatenate.
        var referenceChunkSampleCounts: [Int] = []
        for chunk in chunks {
            let samples = try await EngineWrapper.shared.generate(
                text: chunk, voice: voice, speed: speed
            )
            referenceChunkSampleCounts.append(samples.count)
        }
        let expectedSpeechSamples = referenceChunkSampleCounts.reduce(0, +)
        let expectedSilenceSamples = (chunks.count - 1) * TTSHandler.interChunkSilenceSamples
        let expectedTotalSamples = expectedSpeechSamples + expectedSilenceSamples

        try await TestServer.withServer { port in
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/tts")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "text": text,
                "voice": voice,
                "speed": Double(speed),
            ])
            request.timeoutInterval = 600

            let (data, response) = try await URLSession.shared.data(for: request)
            let httpResp = try XCTUnwrap(response as? HTTPURLResponse)
            XCTAssertEqual(httpResp.statusCode, 200)
            XCTAssertEqual(
                httpResp.value(forHTTPHeaderField: "Content-Type"),
                "audio/wav"
            )

            // --- RIFF/WAVE header ---
            // Layout lives in Audio/WAVEncoder.swift. Header is always 44 bytes
            // for 16-bit PCM with no "fact" chunk.
            XCTAssertGreaterThanOrEqual(data.count, 44, "Response too short to be a WAV")
            XCTAssertEqual(WAVHeader.asciiSlice(data, 0..<4), "RIFF")
            XCTAssertEqual(WAVHeader.asciiSlice(data, 8..<12), "WAVE")
            XCTAssertEqual(WAVHeader.asciiSlice(data, 12..<16), "fmt ")
            XCTAssertEqual(WAVHeader.asciiSlice(data, 36..<40), "data")

            // fmt chunk
            XCTAssertEqual(WAVHeader.readU32LE(data, 16), 16, "fmt chunk size")
            XCTAssertEqual(WAVHeader.readU16LE(data, 20), 1, "PCM format")
            XCTAssertEqual(WAVHeader.readU16LE(data, 22), 1, "channel count (mono)")
            XCTAssertEqual(WAVHeader.readU32LE(data, 24), 24000, "sample rate")
            XCTAssertEqual(WAVHeader.readU16LE(data, 34), 16, "bits per sample")

            // data chunk size == sampleCount * 2 (16-bit mono)
            let dataSize = Int(WAVHeader.readU32LE(data, 40))
            XCTAssertEqual(data.count, 44 + dataSize, "File length matches RIFF data size")
            let actualSampleCount = dataSize / 2
            XCTAssertEqual(
                actualSampleCount,
                expectedTotalSamples,
                """
                WAV sample-count mismatch.
                expected = speech(\(expectedSpeechSamples)) + silence((\(chunks.count) - 1) * \(TTSHandler.interChunkSilenceSamples)) = \(expectedTotalSamples)
                got      = \(actualSampleCount)
                This almost certainly means the inter-chunk 0.15s silence padding \
                was dropped or duplicated — see root CLAUDE.md "Streaming wire protocol".
                """
            )

            // Sanity: response headers echo the same sample count (and voice).
            XCTAssertEqual(
                httpResp.value(forHTTPHeaderField: "x-freekoko-voice"),
                voice
            )
            if let hdrSampleCount = httpResp.value(forHTTPHeaderField: "x-freekoko-sample-count"),
               let hdrInt = Int(hdrSampleCount)
            {
                XCTAssertEqual(hdrInt, expectedTotalSamples, "x-freekoko-sample-count header")
            } else {
                XCTFail("Missing or malformed x-freekoko-sample-count header")
            }
        }
    }

}

/// Sendable-friendly static helpers for reading a RIFF/WAVE header out of a
/// `Data`. Kept outside `TTSHandlerTests` so they can be used from inside a
/// `@Sendable` closure without dragging `self` along.
private enum WAVHeader {
    static func readU32LE(_ data: Data, _ offset: Int) -> UInt32 {
        data.withUnsafeBytes { ptr in
            ptr.loadUnaligned(fromByteOffset: offset, as: UInt32.self).littleEndian
        }
    }

    static func readU16LE(_ data: Data, _ offset: Int) -> UInt16 {
        data.withUnsafeBytes { ptr in
            ptr.loadUnaligned(fromByteOffset: offset, as: UInt16.self).littleEndian
        }
    }

    static func asciiSlice(_ data: Data, _ range: Range<Int>) -> String {
        String(data: data.subdata(in: range), encoding: .ascii) ?? ""
    }
}
