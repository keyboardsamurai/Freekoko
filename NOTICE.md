# Third-party notices

freekoko bundles and/or depends on the following third-party components. Their individual licenses apply to the portions of this distribution that they govern. Where a license requires attribution, it is provided below. All permissive licenses referenced here allow commercial use, modification, and redistribution under the stated terms.

## Bundled at runtime

### Kokoro-82M TTS model
- **Source:** https://huggingface.co/hexgrad/Kokoro-82M
- **License:** Apache License 2.0
- **Author:** hexgrad
- **Use in freekoko:** the `.safetensors` model weights and voice embeddings are downloaded at build time and shipped inside the distributable `.app`. freekoko does not modify the weights.

### KokoroSwift (inference library)
- **Source:** https://github.com/keyboardsamurai/kokoro-voice (`LocalPackages/kokoro-ios/`)
- **License:** MIT
- **Use in freekoko:** linked as a Swift Package Manager dependency in `freekoko-sidecar/Package.swift`. Provides the MLX-based Kokoro inference pipeline that the Swift sidecar calls via `KokoroEngine`.

### MLX Swift
- **Source:** https://github.com/ml-explore/mlx-swift
- **License:** MIT
- **Copyright:** Apple Inc.
- **Use in freekoko:** transitively linked through KokoroSwift for on-device tensor operations on Apple Silicon GPUs.

### MisakiSwift (English G2P)
- **Source:** https://github.com/mlalma/MisakiSwift
- **License:** MIT
- **Use in freekoko:** transitively linked through KokoroSwift for grapheme-to-phoneme conversion on English text.

### MLXUtilsLibrary
- **Source:** https://github.com/mlalma/MLXUtilsLibrary
- **License:** MIT
- **Use in freekoko:** transitively linked through KokoroSwift for npz file loading and MLX utilities.

### Hummingbird 2 (Swift HTTP server)
- **Source:** https://github.com/hummingbird-project/hummingbird
- **License:** Apache License 2.0
- **Use in freekoko:** HTTP server in the Swift sidecar (`freekoko-sidecar`) exposing the `/tts`, `/voices`, `/health` endpoints on `localhost:5002`.

### swift-argument-parser
- **Source:** https://github.com/apple/swift-argument-parser
- **License:** Apache License 2.0
- **Copyright:** Apple Inc.
- **Use in freekoko:** CLI argument parsing in the Swift sidecar.

### Electron
- **Source:** https://github.com/electron/electron
- **License:** MIT
- **Use in freekoko:** desktop app shell (main process, tray, BrowserWindow).

### React + React DOM
- **Source:** https://github.com/facebook/react
- **License:** MIT
- **Copyright:** Meta Platforms, Inc.
- **Use in freekoko:** renderer UI framework.

### Vite + electron-vite
- **Source:** https://github.com/vitejs/vite, https://github.com/alex8088/electron-vite
- **License:** MIT
- **Use in freekoko:** renderer build tool and Electron multi-target build orchestrator.

### Zustand
- **Source:** https://github.com/pmndrs/zustand
- **License:** MIT
- **Use in freekoko:** renderer state management.

### electron-store, electron-log
- **Source:** https://github.com/sindresorhus/electron-store, https://github.com/megahertz/electron-log
- **License:** MIT
- **Use in freekoko:** persisted settings and rolling log files.

## Development-only

These are used during `npm install` / `swift build` but are not distributed inside the shipped `.app`:

- TypeScript, ESLint, Vitest (all MIT)
- electron-builder (MIT)
- @testing-library/* (MIT, if present)

## Upstream repo

freekoko is layered on top of the **keyboardsamurai/kokoro-voice** Swift project (MIT-licensed, Antonio Agudo and contributors). The upstream repo lives at `upstream-kokoro/` as a vendored copy and supplies the `KokoroEngine` actor, voice catalog, and supporting types that the sidecar imports directly. Modifications to upstream code for freekoko's needs are documented in `freekoko-sidecar/NOTES.md`.

---

If you redistribute freekoko or a modified build, retain this file alongside the `LICENSE`. If you embed only the Swift sidecar or only the Electron app as part of another product, include the attributions relevant to that subset.
