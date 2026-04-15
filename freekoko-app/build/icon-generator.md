# Generating `icon.icns` for the Electron app

electron-builder picks up `build/icon.icns` as the application bundle icon
(used in Dock previews, the DMG background, Finder Get Info, etc.). The
committed `icon.icns` in this directory is a **placeholder** at
16×16 / 32×32 / 128×128 / 256×256 / 512×512 (plus @2x variants up to
1024×1024). Replace it with real art before a public release.

## Required inputs

A single **square PNG** at **1024×1024** with transparent background and
the final art pre-rendered. The PNG is the source of truth; every other
size is derived from it.

## One-shot generation script

macOS has everything in the box (`sips` + `iconutil`). From the repo root:

```bash
SRC="./build/icon-1024.png"     # your master PNG
OUT="./build/icon.icns"
ICONSET="./build/icon.iconset"

rm -rf "$ICONSET"
mkdir -p "$ICONSET"

# Normal + @2x sizes that macOS expects.
sips -z   16   16  "$SRC" --out "$ICONSET/icon_16x16.png"
sips -z   32   32  "$SRC" --out "$ICONSET/icon_16x16@2x.png"
sips -z   32   32  "$SRC" --out "$ICONSET/icon_32x32.png"
sips -z   64   64  "$SRC" --out "$ICONSET/icon_32x32@2x.png"
sips -z  128  128  "$SRC" --out "$ICONSET/icon_128x128.png"
sips -z  256  256  "$SRC" --out "$ICONSET/icon_128x128@2x.png"
sips -z  256  256  "$SRC" --out "$ICONSET/icon_256x256.png"
sips -z  512  512  "$SRC" --out "$ICONSET/icon_256x256@2x.png"
sips -z  512  512  "$SRC" --out "$ICONSET/icon_512x512.png"
cp                    "$SRC"    "$ICONSET/icon_512x512@2x.png"

iconutil -c icns -o "$OUT" "$ICONSET"
rm -rf "$ICONSET"

file "$OUT"   # => Mac OS X icon, "icns" resource (1024×1024)
```

## Design guidelines

- Follow Apple's macOS app icon grid: 824×824 safe area inside a 1024×1024
  canvas, centered, with soft 22.5% corner radius to match the system
  icon mask.
- Single primary subject, readable down to 16×16.
- Avoid text; the icon scales below legibility.
- Prefer a dark-to-light gradient background so the icon stays recognizable
  on both light and dark Dock backgrounds.

## Why not ImageMagick / PIL / sharp?

`iconutil` is the only tool that produces a byte-for-byte correct
macOS `.icns` with all the right `icnV`, `ic07`, `ic08`, etc. resource
types. Third-party tools often omit Retina variants or skip the table
of contents and Finder renders a blurry thumbnail. Keep it to the
one-liner above.
