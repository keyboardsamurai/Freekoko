# freekoko-sidecar — Build Notes

This document captures open items and upstream quirks that affect how the
sidecar is built and packaged. It complements ARCHITECTURE.md §7 (Risk
Register). Update this file when the items below are resolved upstream.

## 1. MLXUtilsLibrary dependency resolution (applied workaround)

**Symptom.** `swift build` (in both `upstream-kokoro/` and
`freekoko-sidecar/`) failed with:

```
Sources/KokoroSwift/TTSEngine/KokoroTTS.swift:173:5: error: cannot find 'BenchmarkTimer' in scope
Sources/KokoroSwift/TTSEngine/KokoroTTS.swift:174:5: error: cannot find 'BenchmarkTimer' in scope
Sources/KokoroSwift/TTSEngine/KokoroTTS.swift:225:5: error: cannot find 'BenchmarkTimer' in scope
```

**Root cause.** Two packages in the graph declare different requirements
for `mlalma/MLXUtilsLibrary`:

| Package                                          | Requirement          |
|--------------------------------------------------|----------------------|
| `upstream-kokoro/Package.swift`                  | `branch: "main"`     |
| `upstream-kokoro/LocalPackages/kokoro-ios/...`   | `from: "0.0.6"`      |

SPM picks the branch-based requirement (HEAD ≈ tag 0.0.7), which contains
only `Utils/Log.swift`. The `BenchmarkTimer` symbol still referenced by
`KokoroSwift/TTSEngine/KokoroTTS.swift` was removed after v0.0.6, so the
KokoroSwift compile fails.

**Workaround (applied).** `upstream-kokoro/Package.swift` was patched in
place to pin `MLXUtilsLibrary` to `exact: "0.0.6"`. This is a 1-line change
inside the submodule-ish checkout. When `upstream-kokoro` is turned into a
proper git submodule (see ARCHITECTURE.md §1), this patch needs to either:

1. Be contributed back upstream to `keyboardsamurai/kokoro-voice` so the
   default `.package(..., branch: "main")` is replaced with an exact pin
   or a `"0.0.6"..<"0.0.7"` range, or
2. Be maintained as a dependency-override in `freekoko-sidecar/Package.swift`
   (SPM's `.package(url:, exact:)` at the root cannot override a
   `branch:` pin in a transitive dep — we'd need a fork), or
3. Motivate a fix in `mlalma/KokoroSwift` so it stops calling
   `BenchmarkTimer` (or conditionally compiles it out).

**Do not bump the upstream pin blindly** — verify `BenchmarkTimer`
compiles against the chosen MLXUtilsLibrary version first.

## 2. Duplicate MLX Obj-C class warnings at process startup

When the sidecar launches, stderr prints ~100 lines of:

```
objc[PID]: Class _TtC3MLX8MLXArray is implemented in both
  .../libMisakiSwift.dylib and .../libKokoroSwift.dylib ...
```

**Cause.** Both `KokoroSwift` and `MisakiSwift` link `mlx-swift`
statically, and both are dynamic libraries that the sidecar binary loads.
The Objective-C runtime complains once per duplicated class.

**Impact.** None observed at runtime — MLX routes through one
implementation and ignores the other. Tests and the HTTP server run
normally.

**Mitigation path.** This is a packaging problem for
`upstream-kokoro/LocalPackages/kokoro-ios` and `mlalma/MisakiSwift`. The
fix is to make one of them depend on the other transitively rather than
both linking MLX statically. Track under a separate upstream issue; the
warnings are harmless for the Electron-facing sidecar.

**Electron impact.** The supervisor in `freekoko-app` must read
`child.stderr` as a log stream, not treat the duplicate-class lines as
crash indicators. Pre-filter them out of the in-memory ring buffer.

## 3. Bundle.module / R1 (ARCHITECTURE §7.R1)

Not yet observed. `KokoroConfig.loadConfig()` is called deep inside
`KokoroEngine.loadModel`, which only runs when real model weights are
present. During P1 we intentionally do not exercise the full load path
(no 326 MB of weights on this dev machine), so `Bundle.module` may still
fail for the CLI target at first real launch.

**Mitigation (unchanged from §7.R1).** If a real run surfaces this, add
an environment variable (`KOKORO_CONFIG_PATH`) that the sidecar passes
through to `KokoroConfig.loadConfig()`.

## 4. Dylib runtime search path (packaging, open for P6)

The debug binary at `.build/debug/freekoko-sidecar` resolves dylibs via
SPM's generated rpaths pointing back into `.build/`. When the sidecar is
placed inside the packaged Electron app at
`Contents/Resources/sidecar/freekoko-sidecar`, its rpath needs to either:

1. Point at a sibling `Frameworks/` directory containing the required
   dylibs (`libKokoroSwift.dylib`, `libMisakiSwift.dylib`, `libMLX*.dylib`,
   etc.), or
2. Be rewritten with `install_name_tool -add_rpath @loader_path/../...`
   during `make dmg`.

**Action for P6.** Build the sidecar with
`swift build -c release -Xlinker -rpath -Xlinker @loader_path/../Frameworks`
and then script `install_name_tool` / `codesign` inside
`electron-builder`'s `afterPack` hook.

## 5. Graceful shutdown fidelity

The current SIGTERM handler calls `Foundation.exit(0)` directly after
logging `shutdown_complete`. This matches ARCHITECTURE §2.8's observable
contract (electron sees the shutdown line then the process exits) but
does not drain in-flight Hummingbird responses for up to 5 seconds.

**Follow-up (P2 or later).** Wire Hummingbird's `ServiceGroup` /
`GracefulShutdownManager` with a top-level `withTaskCancellationHandler`
so the server stops accepting new connections and finishes in-flight
requests before the process exits. The current implementation is
acceptable for P1 acceptance criteria but worth revisiting before P6.
