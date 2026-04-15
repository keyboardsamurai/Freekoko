// Engine/EngineWrapper.swift
//
// Actor wrapping KokoroEngine.shared. Owns the "is this model ready?" state
// and filters the static voice catalog by what's actually on disk.
// KokoroEngine is already an actor — this wrapper does not add any
// additional locking.

import Foundation
import KokoroVoiceShared

enum EngineWrapperError: Error, LocalizedError {
    case modelWeightsMissing(URL)
    case resourcesDirMissing(URL)

    var errorDescription: String? {
        switch self {
        case .modelWeightsMissing(let url):
            return "kokoro-v1_0.safetensors not found at \(url.path)"
        case .resourcesDirMissing(let url):
            return "Resources directory not found at \(url.path)"
        }
    }
}

actor EngineWrapper {

    static let shared = EngineWrapper()

    // MARK: - State

    private var resourcesURL: URL?
    private var loaded = false
    private var loadedVoiceIDs: Set<String> = []
    /// Unix epoch seconds when this process started.
    let startTimestamp: Date = Date()

    private init() {}

    // MARK: - Lifecycle

    /// Validate the resources directory, then ask the underlying
    /// KokoroEngine actor to load the model. Emits a `model_loaded`
    /// log line on success.
    func initialize(resourcesURL: URL) async throws {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: resourcesURL.path, isDirectory: &isDir),
              isDir.boolValue
        else {
            throw EngineWrapperError.resourcesDirMissing(resourcesURL)
        }

        let modelFile = resourcesURL.appendingPathComponent("kokoro-v1_0.safetensors")
        guard fm.fileExists(atPath: modelFile.path) else {
            throw EngineWrapperError.modelWeightsMissing(modelFile)
        }

        self.resourcesURL = resourcesURL

        let startedAt = Date()
        JSONLogger.info("model_loading", [
            "resources_dir": resourcesURL.path
        ])

        try await KokoroEngine.shared.loadModel(from: resourcesURL)

        // After loading, snapshot the voice IDs that KokoroEngine successfully
        // loaded embeddings for, so /voices reflects actual runtime availability
        // (not just files on disk).
        let voiceIDs = await KokoroEngine.shared.availableVoiceIds()
        loadedVoiceIDs = Set(voiceIDs)
        loaded = true

        JSONLogger.info("model_loaded", [
            "duration_ms": Int(Date().timeIntervalSince(startedAt) * 1000),
            "voice_count": loadedVoiceIDs.count,
        ])
    }

    // MARK: - Queries

    func isReady() -> Bool { loaded }

    func voiceCount() -> Int { loadedVoiceIDs.count }

    func uptimeSeconds() -> Double {
        Date().timeIntervalSince(startTimestamp)
    }

    /// Return the voice catalog filtered to the voices whose embeddings
    /// were actually loaded. Falls back to on-disk probing if the engine
    /// hasn't reported availability yet (pre-load).
    func availableVoices() -> [Constants.VoiceDefinition] {
        if !loadedVoiceIDs.isEmpty {
            return Constants.availableVoices.filter { loadedVoiceIDs.contains($0.id) }
        }
        // Fall back to checking disk — used before the engine reports,
        // or if embeddings are discovered async.
        guard let voicesDir = resourcesURL?.appendingPathComponent("voices") else {
            return []
        }
        let fm = FileManager.default
        return Constants.availableVoices.filter { voice in
            let file = voicesDir.appendingPathComponent("\(voice.id).safetensors")
            return fm.fileExists(atPath: file.path)
        }
    }

    /// Check voice availability by ID against the loaded embeddings.
    func isVoiceAvailable(_ voiceId: String) -> Bool {
        if !loadedVoiceIDs.isEmpty {
            return loadedVoiceIDs.contains(voiceId)
        }
        return availableVoices().contains { $0.id == voiceId }
    }

    /// Generate Float32 audio samples (24kHz mono). Delegates directly
    /// to the underlying actor — all calls are naturally serialized there.
    func generate(text: String, voice: String, speed: Float) async throws -> [Float] {
        try await KokoroEngine.shared.generateAudio(
            text: text,
            voiceId: voice,
            speed: speed
        )
    }
}
