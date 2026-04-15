// Tests/FreekokoSidecarTests/TTSStreamHandlerTests.swift
//
// Integration tests for POST /tts/stream:
//   - Wire-protocol parsing (preamble + frame headers + Float32 PCM).
//   - Parity vs. /tts: the per-chunk speech-only PCM that streams over the wire
//     must match what /tts produces. We compare directly against
//     EngineWrapper.generate (the same code path both endpoints use), avoiding
//     the WAV decode/silence-split dance entirely.
//   - Cancellation: client closes mid-stream → handler exits without leaking
//     the inference Task or hanging the engine actor.
//
// Tests skip cleanly when the Kokoro model can't be located. Override the
// search path with FREEKOKO_TEST_RESOURCES_DIR; default looks alongside the
// freekoko-sidecar package at ../upstream-kokoro/Resources.

import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdCore
import KokoroVoiceShared
import Logging
import NIOCore
import NIOPosix
import ServiceLifecycle
import XCTest

@testable import FreekokoSidecar

// MARK: - Engine bootstrap (one-time, shared across the suite)

/// Engine load is async + ~2–5 s; load it once and gate every test on the
/// resulting state. Actor isolation keeps Swift 6 strict-concurrency happy
/// while serialising the one-time load.
///
/// Shared across test files (see `TTSHandlerTests`) so the underlying
/// `EngineWrapper.shared` is only initialized once per test process.
actor EngineState {
    static let shared = EngineState()

    struct Status: Sendable {
        let loaded: Bool
        let error: Error?
    }

    private var didAttempt = false
    private var loaded = false
    private var error: Error?

    func ensureLoaded() async -> Status {
        if didAttempt {
            return Status(loaded: loaded, error: error)
        }
        // MLX-Swift is statically linked into both `libMisakiSwift.dylib` and
        // the xctest binary, which produces objc duplicate-class warnings and
        // a hard process-level abort during model load under `swift test`.
        // Engine-backed tests therefore opt in via env var — set
        // `FREEKOKO_TEST_RUN_ENGINE=1` (typically in a dedicated CI job that
        // runs through Xcode/`xcodebuild test` where the symbol layout works).
        // Without the flag, we report not-loaded and the tests XCTSkip.
        guard ProcessInfo.processInfo.environment["FREEKOKO_TEST_RUN_ENGINE"] == "1" else {
            didAttempt = true
            return Status(loaded: false, error: nil)
        }
        guard let resourcesURL = Self.locateResources() else {
            didAttempt = true
            return Status(loaded: false, error: nil)
        }
        // MLX looks for `mlx.metallib` colocated with the running binary. SwiftPM
        // builds drop it into `.build/<triple>/<config>/mlx.metallib` instead of
        // a SwiftPM bundle, so place the file next to the xctest binary's MacOS
        // executable before triggering MLX init.
        if !Self.ensureMetallibColocated() {
            didAttempt = true
            return Status(loaded: false, error: nil)
        }
        do {
            if !(await EngineWrapper.shared.isReady()) {
                try await EngineWrapper.shared.initialize(resourcesURL: resourcesURL)
            }
            didAttempt = true
            loaded = true
            return Status(loaded: true, error: nil)
        } catch {
            didAttempt = true
            self.error = error
            return Status(loaded: false, error: error)
        }
    }

    /// Ensure `mlx.metallib` is colocated with the running xctest binary. MLX
    /// looks for `mlx.metallib` next to its loading binary; SwiftPM places it
    /// at `.build/<triple>/<config>/mlx.metallib`, but the xctest binary lives
    /// inside `.../Contents/MacOS/`. Symlink/copy the file into place if the
    /// binary's directory doesn't already have it. Returns false if no source
    /// metallib could be located.
    private static func ensureMetallibColocated() -> Bool {
        let fm = FileManager.default
        // Find our xctest bundle. Bundle.main is the xctest *agent*, not us.
        let xctestDir: URL = {
            for bundle in Bundle.allBundles where bundle.bundlePath.hasSuffix(".xctest") {
                return bundle.bundleURL.appendingPathComponent("Contents/MacOS")
            }
            return Bundle.main.bundleURL
        }()
        let target = xctestDir.appendingPathComponent("mlx.metallib")
        if fm.fileExists(atPath: target.path) {
            return true
        }
        // Walk up looking for `.build/<triple>/<config>/mlx.metallib`.
        var cursor = xctestDir
        for _ in 0..<8 {
            let candidate = cursor.appendingPathComponent("mlx.metallib")
            if fm.fileExists(atPath: candidate.path),
               candidate.path != target.path
            {
                do {
                    try fm.createSymbolicLink(at: target, withDestinationURL: candidate)
                    return true
                } catch {
                    do {
                        try fm.copyItem(at: candidate, to: target)
                        return true
                    } catch {
                        return false
                    }
                }
            }
            let parent = cursor.deletingLastPathComponent()
            if parent.path == cursor.path { break }
            cursor = parent
        }
        return false
    }

    private static func locateResources() -> URL? {
        let fm = FileManager.default
        var candidates: [String] = []
        if let envPath = ProcessInfo.processInfo.environment["FREEKOKO_TEST_RESOURCES_DIR"] {
            candidates.append(envPath)
        }
        // Default: ../upstream-kokoro/Resources relative to the package root.
        let pkgRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // FreekokoSidecarTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // freekoko-sidecar
        candidates.append(
            pkgRoot.appendingPathComponent("../upstream-kokoro/Resources")
                .standardizedFileURL.path
        )
        for path in candidates {
            let url = URL(fileURLWithPath: path, isDirectory: true)
            let model = url.appendingPathComponent("kokoro-v1_0.safetensors")
            if fm.fileExists(atPath: model.path) {
                return url
            }
        }
        return nil
    }
}

// MARK: - Wire-protocol decoder (Sendable, free of XCTestCase coupling)

enum StreamHarness {

    struct Preamble: Equatable, Sendable {
        let sampleRate: UInt32
        let totalChunks: UInt32
        let reserved: UInt32
    }

    struct DecodedFrame: Sendable {
        let index: UInt32
        let pcm: [Float]
    }

    struct StreamReader: Sendable {
        let response: HTTPURLResponse
        let preamble: Preamble
        let frames: AsyncThrowingStream<DecodedFrame, Error>
    }

    enum HarnessError: Error, CustomStringConvertible {
        case notHTTPResponse
        case truncatedPreamble
        case badMagic([UInt8])
        case truncatedFrameHeader
        case truncatedFrameBody
        case misalignedPcmLength(Int)

        var description: String {
            switch self {
            case .notHTTPResponse: return "Response was not HTTPURLResponse"
            case .truncatedPreamble: return "Server closed before sending 16-byte preamble"
            case .badMagic(let b): return "Preamble magic mismatch: \(b)"
            case .truncatedFrameHeader: return "Server closed mid-frame-header"
            case .truncatedFrameBody: return "Server closed mid-frame-body"
            case .misalignedPcmLength(let n): return "PCM byte length not multiple of 4: \(n)"
            }
        }
    }

    /// Open POST /tts/stream and parse the chunked body lazily as it arrives.
    /// The preamble is delivered before this function returns; subsequent
    /// frames are decoded inside an `AsyncThrowingStream` driven by a single
    /// detached Task that owns the URLSession bytes iterator.
    static func openStream(port: Int, body: [String: any Sendable]) async throws -> StreamReader {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/tts/stream")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 600

        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let httpResp = response as? HTTPURLResponse else {
            throw HarnessError.notHTTPResponse
        }

        // The URLSession bytes iterator isn't Sendable. We wrap the entire
        // read loop (preamble + frames) inside one Task that owns the iterator,
        // and surface the preamble via a one-shot continuation.
        let preambleBox = PreambleBox()
        let frames = AsyncThrowingStream<DecodedFrame, Error> { continuation in
            let task = Task {
                var iter = bytes.makeAsyncIterator()
                do {
                    // Preamble — 16 bytes.
                    var header = [UInt8]()
                    header.reserveCapacity(16)
                    for _ in 0..<16 {
                        guard let byte = try await iter.next() else {
                            await preambleBox.fail(HarnessError.truncatedPreamble)
                            throw HarnessError.truncatedPreamble
                        }
                        header.append(byte)
                    }
                    guard Array(header[0..<4]) == TTSHandler.streamMagic else {
                        let err = HarnessError.badMagic(Array(header[0..<4]))
                        await preambleBox.fail(err)
                        throw err
                    }
                    let preamble = Preamble(
                        sampleRate: be32(header, 4),
                        totalChunks: be32(header, 8),
                        reserved: be32(header, 12)
                    )
                    await preambleBox.succeed(preamble)

                    // Frames.
                    var frameHeader = [UInt8]()
                    frameHeader.reserveCapacity(8)
                    while true {
                        frameHeader.removeAll(keepingCapacity: true)
                        var ended = false
                        for _ in 0..<8 {
                            guard let byte = try await iter.next() else {
                                ended = true
                                break
                            }
                            frameHeader.append(byte)
                        }
                        if ended {
                            if !frameHeader.isEmpty {
                                throw HarnessError.truncatedFrameHeader
                            }
                            continuation.finish()
                            return
                        }
                        let index = be32(frameHeader, 0)
                        let pcmByteLen = Int(be32(frameHeader, 4))
                        guard pcmByteLen.isMultiple(of: 4) else {
                            throw HarnessError.misalignedPcmLength(pcmByteLen)
                        }
                        var pcmBytes = [UInt8]()
                        pcmBytes.reserveCapacity(pcmByteLen)
                        for _ in 0..<pcmByteLen {
                            guard let byte = try await iter.next() else {
                                throw HarnessError.truncatedFrameBody
                            }
                            pcmBytes.append(byte)
                        }
                        let pcm = pcmBytes.withUnsafeBufferPointer { ptr -> [Float] in
                            ptr.baseAddress!.withMemoryRebound(
                                to: Float.self,
                                capacity: pcmByteLen / 4
                            ) { fptr in
                                Array(UnsafeBufferPointer(start: fptr, count: pcmByteLen / 4))
                            }
                        }
                        continuation.yield(DecodedFrame(index: index, pcm: pcm))
                    }
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }

        let preamble = try await preambleBox.wait()
        return StreamReader(response: httpResp, preamble: preamble, frames: frames)
    }

    /// One-shot Sendable promise carrying either a `Preamble` or an `Error`.
    actor PreambleBox {
        private enum State {
            case pending([CheckedContinuation<Preamble, Error>])
            case ready(Preamble)
            case failed(Error)
        }
        private var state: State = .pending([])

        func succeed(_ preamble: Preamble) {
            switch state {
            case .pending(let waiters):
                state = .ready(preamble)
                for w in waiters { w.resume(returning: preamble) }
            case .ready, .failed:
                break
            }
        }

        func fail(_ error: Error) {
            switch state {
            case .pending(let waiters):
                state = .failed(error)
                for w in waiters { w.resume(throwing: error) }
            case .ready, .failed:
                break
            }
        }

        func wait() async throws -> Preamble {
            switch state {
            case .ready(let p): return p
            case .failed(let e): throw e
            case .pending:
                return try await withCheckedThrowingContinuation { cont in
                    appendWaiter(cont)
                }
            }
        }

        private func appendWaiter(_ cont: CheckedContinuation<Preamble, Error>) {
            switch state {
            case .pending(var waiters):
                waiters.append(cont)
                state = .pending(waiters)
            case .ready(let p):
                cont.resume(returning: p)
            case .failed(let e):
                cont.resume(throwing: e)
            }
        }
    }

    static func be32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
        return (UInt32(bytes[offset]) << 24)
            | (UInt32(bytes[offset + 1]) << 16)
            | (UInt32(bytes[offset + 2]) << 8)
            | UInt32(bytes[offset + 3])
    }
}

// MARK: - Test app harness (Sendable; runs the same routes as production)

/// Sendable promise-of-Int used to publish the test server's bound port.
final class PortPromise: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int?
    private var waiters: [CheckedContinuation<Int, Never>] = []

    func complete(_ port: Int) {
        lock.lock()
        defer { lock.unlock() }
        if value != nil { return }
        value = port
        for w in waiters { w.resume(returning: port) }
        waiters.removeAll()
    }

    func wait() async -> Int {
        await withCheckedContinuation { cont in
            lock.lock()
            if let v = value {
                lock.unlock()
                cont.resume(returning: v)
            } else {
                waiters.append(cont)
                lock.unlock()
            }
        }
    }
}

enum TestServer {

    /// Spin a Hummingbird app on an OS-assigned port, run `body(port)`, then
    /// gracefully shut it down.
    static func withServer<Result: Sendable>(
        _ body: @Sendable @escaping (_ port: Int) async throws -> Result
    ) async throws -> Result {
        let portReady = PortPromise()
        let router = Router()
        router.post("/tts") { req, ctx in
            try await TTSHandler.handle(request: req, context: ctx)
        }
        router.post("/tts/stream") { req, ctx in
            try await TTSHandler.handleStream(request: req, context: ctx)
        }

        var appLogger = Logger(label: "freekoko-test")
        appLogger.logLevel = .error

        let app = Application(
            router: router,
            configuration: .init(
                address: .hostname("127.0.0.1", port: 0),
                serverName: "freekoko-sidecar-test"
            ),
            onServerRunning: { channel in
                if let port = channel.localAddress?.port {
                    portReady.complete(port)
                }
            },
            logger: appLogger
        )

        var supervisorLogger = Logger(label: "freekoko-test-supervisor")
        supervisorLogger.logLevel = .error

        return try await withThrowingTaskGroup(of: Result?.self) { group in
            let serviceGroup = ServiceGroup(
                configuration: .init(
                    services: [app],
                    gracefulShutdownSignals: [],
                    logger: supervisorLogger
                )
            )
            group.addTask {
                try await serviceGroup.run()
                return nil
            }
            group.addTask {
                let port = await portReady.wait()
                let result = try await body(port)
                await serviceGroup.triggerGracefulShutdown()
                return result
            }
            var captured: Result?
            for try await value in group {
                if let value { captured = value }
            }
            return captured!
        }
    }
}

// MARK: - Tests

final class TTSStreamHandlerTests: XCTestCase {

    /// Skip if the Kokoro model couldn't be loaded for the suite.
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

    /// When the engine isn't loaded, `/tts/stream` must return 503
    /// `model_not_loaded` JSON and *not* try to crack open the stream. This
    /// also verifies the route is registered and the validation layer fires
    /// before we touch the writer closure (which would otherwise produce a
    /// 200 + truncated body). Runs under plain `swift test` — no MLX needed.
    func testStreamReturnsModelNotLoadedWhenEngineUnavailable() async throws {
        let isEngineReady = await EngineWrapper.shared.isReady()
        try XCTSkipIf(
            isEngineReady,
            "Engine already loaded by another test in this process; can't probe model_not_loaded path."
        )
        try await TestServer.withServer { port in
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/tts/stream")!)
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

    /// Smoke test for the wire-protocol constants — the `streamMagic` bytes
    /// must spell "FKST" so the client can sniff a valid stream prefix without
    /// reading more than 4 bytes. Runs under plain `swift test`.
    func testStreamMagicIsFKST() {
        XCTAssertEqual(TTSHandler.streamMagic, [0x46, 0x4B, 0x53, 0x54])
        XCTAssertEqual(
            String(bytes: TTSHandler.streamMagic, encoding: .ascii),
            "FKST"
        )
    }

    /// The wire protocol decodes cleanly: magic matches, preamble fields are
    /// sane, and exactly `totalChunks` frames arrive with monotonic indices.
    func testStreamPreambleAndFramesParse() async throws {
        try await ensureEngine()
        let text = String(repeating: "The quick brown fox jumps over the lazy dog. ", count: 20)
        let expectedChunks = TextChunker.chunk(text).count
        XCTAssertGreaterThan(expectedChunks, 1, "Test input must produce >1 chunk")
        let voice = Constants.defaultVoice

        try await TestServer.withServer { port in
            let reader = try await StreamHarness.openStream(
                port: port,
                body: ["text": text, "voice": voice]
            )
            XCTAssertEqual(reader.response.statusCode, 200)
            XCTAssertEqual(
                reader.response.value(forHTTPHeaderField: "Content-Type"),
                "application/octet-stream"
            )
            XCTAssertEqual(reader.preamble.sampleRate, 24000)
            XCTAssertEqual(Int(reader.preamble.totalChunks), expectedChunks)
            XCTAssertEqual(reader.preamble.reserved, 0)

            var seenIndices: [UInt32] = []
            var totalSamples = 0
            for try await frame in reader.frames {
                seenIndices.append(frame.index)
                totalSamples += frame.pcm.count
                XCTAssertGreaterThan(frame.pcm.count, 0)
            }
            XCTAssertEqual(seenIndices, Array(0..<UInt32(expectedChunks)))
            XCTAssertGreaterThan(totalSamples, 0)
        }
    }

    /// /tts and /tts/stream share `EngineWrapper.generate`; we compare the
    /// streamed Float32 PCM directly to a fresh engine call for the same chunk
    /// list, voice, and speed. Bitwise equality is achievable because both
    /// paths run the same actor-serialized inference with no post-processing.
    func testStreamParityWithEnginePerChunkOutput() async throws {
        try await ensureEngine()
        let text = "Hello there. This is a parity check across the streaming and batch endpoints."
        let voice = Constants.defaultVoice
        let speed: Float = 1.0
        let chunks = TextChunker.chunk(text)
        XCTAssertGreaterThanOrEqual(chunks.count, 1)

        // Reference: drive the same engine path /tts uses, ahead of the server
        // call so the reference Float32 vectors are local Sendable values when
        // the @Sendable closure captures them.
        var reference: [[Float]] = []
        for chunk in chunks {
            let samples = try await EngineWrapper.shared.generate(
                text: chunk, voice: voice, speed: speed
            )
            reference.append(samples)
        }
        let referenceCopy = reference  // capture as `let` for Sendable closure

        try await TestServer.withServer { port in
            let reader = try await StreamHarness.openStream(
                port: port,
                body: ["text": text, "voice": voice, "speed": Double(speed)]
            )
            XCTAssertEqual(reader.response.statusCode, 200)
            XCTAssertEqual(Int(reader.preamble.totalChunks), referenceCopy.count)

            var streamed: [[Float]] = []
            for try await frame in reader.frames {
                streamed.append(frame.pcm)
            }
            XCTAssertEqual(streamed.count, referenceCopy.count)
            for (i, (s, r)) in zip(streamed, referenceCopy).enumerated() {
                XCTAssertEqual(
                    s.count, r.count,
                    "Chunk \(i) sample-count mismatch: stream=\(s.count) ref=\(r.count)"
                )
                XCTAssertEqual(
                    s, r,
                    "Chunk \(i) PCM differs from reference engine output"
                )
            }
        }
    }

    /// Cancelling the URLSession bytes stream after the first frame must let
    /// the handler exit promptly. We verify by checking that a *follow-up*
    /// /tts/stream request can complete soon after — if the prior handler is
    /// hung, the engine actor's serialization would block the next request
    /// well past our 30 s budget. (The model's actor naturally serializes, so
    /// this is a real "no leaked Task" smoke test.)
    func testStreamCancellationPromptlyReleasesEngine() async throws {
        try await ensureEngine()
        // Long input → many chunks; without cancellation a full run is multi-second.
        let text = String(repeating: "The quick brown fox jumps over the lazy dog. ", count: 60)
        let chunkCount = TextChunker.chunk(text).count
        XCTAssertGreaterThanOrEqual(chunkCount, 4, "Need a long input to make cancellation observable")
        let voice = Constants.defaultVoice

        try await TestServer.withServer { port in
            // 1) Open stream, read the first frame, then drop the iterator —
            //    AsyncThrowingStream's onTermination tears down the bytes Task,
            //    which closes the TCP connection; the handler's next
            //    writer.write or Task.checkCancellation throws.
            let reader = try await StreamHarness.openStream(
                port: port,
                body: ["text": text, "voice": voice]
            )
            XCTAssertEqual(reader.response.statusCode, 200)
            var iter = reader.frames.makeAsyncIterator()
            let firstFrame = try await iter.next()
            XCTAssertNotNil(firstFrame, "Did not receive any frames before cancellation")

            // 2) Immediately fire a short request. If the prior handler is hung
            //    on the engine actor, this blocks past our timeout.
            let waitStart = Date()
            try await TestServer.withTimeout(seconds: 30) {
                let reader2 = try await StreamHarness.openStream(
                    port: port,
                    body: ["text": "Quick test.", "voice": voice]
                )
                XCTAssertEqual(reader2.response.statusCode, 200)
                XCTAssertGreaterThanOrEqual(reader2.preamble.totalChunks, 1)
                for try await _ in reader2.frames {}
            }
            let waited = Date().timeIntervalSince(waitStart)
            // Loose ceiling — purely a hung-engine canary.
            XCTAssertLessThan(waited, 30.0, "Second request blocked too long; engine likely hung after cancellation")
        }
    }
}

// MARK: - Misc

extension TestServer {
    static func withTimeout<T: Sendable>(
        seconds: TimeInterval,
        operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw TimeoutError()
            }
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }

    struct TimeoutError: Error {}
}
