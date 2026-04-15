// main.swift
//
// Entry point for freekoko-sidecar.
//
// Usage:
//   freekoko-sidecar \
//     --resources-dir /abs/path/to/kokoro \
//     [--port 5002] \
//     [--host 127.0.0.1] \
//     [--log-json]
//
// The binary loads the Kokoro model at startup, then serves HTTP on
// host:port. SIGTERM/SIGINT trigger graceful shutdown.

import ArgumentParser
import Dispatch
import Foundation

@main
struct FreekokoSidecar: AsyncParsableCommand {

    static let configuration = CommandConfiguration(
        commandName: "freekoko-sidecar",
        abstract: "HTTP sidecar wrapping the Kokoro TTS engine for Electron."
    )

    @Option(name: .long, help: "HTTP listen port.")
    var port: Int = 5002

    @Option(name: .long, help: "Host/interface to bind to.")
    var host: String = "127.0.0.1"

    @Option(
        name: .long,
        help: "Absolute path to directory containing kokoro-v1_0.safetensors and voices/."
    )
    var resourcesDir: String

    @Flag(
        inversion: .prefixedNo,
        exclusivity: .chooseLast,
        help: "Emit newline-delimited JSON log lines to stdout. Pass --no-log-json for human-readable output (default: on)."
    )
    var logJson: Bool = true

    func run() async throws {
        installSignalHandlers()

        let resourcesURL = URL(fileURLWithPath: resourcesDir, isDirectory: true)

        JSONLogger.info("sidecar_starting", [
            "port": port,
            "host": host,
            "resources_dir": resourcesURL.path,
        ])

        // Load the model up front so the HTTP server only binds once the
        // actor is ready to serve.
        do {
            try await EngineWrapper.shared.initialize(resourcesURL: resourcesURL)
        } catch {
            JSONLogger.error("model_load_failed", [
                "error": String(describing: error),
                "resources_dir": resourcesURL.path,
            ])
            throw ExitCode.failure
        }

        let server = Server(host: host, port: port)
        try await server.run()

        JSONLogger.info("shutdown_complete")
    }

    // MARK: - Signal handling

    /// Install handlers for SIGTERM and SIGINT. Hummingbird's runService
    /// listens for task cancellation to trigger graceful shutdown, so we
    /// cancel the top-level task when a signal arrives.
    private func installSignalHandlers() {
        let handledSignals: [Int32] = [SIGTERM, SIGINT]
        for sig in handledSignals {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(
                signal: sig,
                queue: .main
            )
            source.setEventHandler {
                JSONLogger.info("signal_received", [
                    "signal": Int(sig)
                ])
                // Exit 0 — best we can do in a plain DispatchSource
                // handler. Hummingbird's ServiceGroup integration would
                // allow a cleaner drain, but for P1 a direct exit after
                // logging is within spec (see ARCHITECTURE.md §2.8).
                JSONLogger.info("shutdown_complete")
                Foundation.exit(0)
            }
            source.resume()
            // Keep the source alive for the life of the process.
            SignalSourceRetainer.shared.add(source)
        }
    }
}

/// Retains `DispatchSourceSignal` instances so they don't deinit and
/// immediately cancel themselves. Access is serialized by an internal lock.
private final class SignalSourceRetainer: @unchecked Sendable {
    static let shared = SignalSourceRetainer()
    private let lock = NSLock()
    private var sources: [DispatchSourceSignal] = []

    func add(_ source: DispatchSourceSignal) {
        lock.lock()
        defer { lock.unlock() }
        sources.append(source)
    }
}
