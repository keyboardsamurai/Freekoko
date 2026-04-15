#!/usr/bin/env node
// Tray icon generator for freekoko.
//
// Produces 22×22 (and 44×44 @2x) PNGs for three states:
//   - idle    : plain speaker glyph, template-image style (black/alpha only).
//   - running : speaker + two sound-wave arcs, template style (macOS tints
//               it automatically; we still colorize subtly for non-template
//               rendering in non-menubar contexts).
//   - error   : speaker with a circled-X overlay in the top-right.
//
// Zero external dependencies — PNG bytes are emitted manually. This file
// replaces the original P2 generator that drew flat colored circles.
//
// Usage:
//   node scripts/generate-tray-icons.mjs
//   npm run generate:tray-icons
//
// Design note: macOS menubar "template" icons are expected to be mostly
// black pixels on a transparent background so the system can auto-tint
// them (white in dark mode, dark in light mode, colored on status
// accents). We keep the art black + alpha and set the images as
// Template Images in electron by suffixing the filename with `Template`
// OR by calling `nativeImage.setTemplateImage(true)` in the main
// process. P2 already wires the icons; that code stays unchanged.

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'resources', 'tray');
mkdirSync(OUT_DIR, { recursive: true });

// ---------- PNG writer ---------------------------------------------------
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function makePng(width, height, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    pixels.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const idatData = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- tiny 2D rasteriser ------------------------------------------
/**
 * Canvas backed by a flat RGBA Buffer, with a handful of primitives:
 * rect, filledTrapezoid, disk, ring (arc slice), line. All primitives
 * paint in [r,g,b,a] at each pixel (no antialiasing — that's fine at
 * 22×22 and the Retina 44×44 resamples cleanly).
 */
class Canvas {
  constructor(size) {
    this.size = size;
    this.pixels = Buffer.alloc(size * size * 4);
  }
  setPixel(x, y, [r, g, b, a]) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    // Simple "source-over" with premultiplied-ish alpha: if a>=255 we
    // just overwrite. Otherwise blend onto current.
    if (a === 255) {
      this.pixels[i] = r;
      this.pixels[i + 1] = g;
      this.pixels[i + 2] = b;
      this.pixels[i + 3] = 255;
      return;
    }
    const da = this.pixels[i + 3] / 255;
    const sa = a / 255;
    const outA = sa + da * (1 - sa);
    if (outA === 0) return;
    this.pixels[i] = (r * sa + this.pixels[i] * da * (1 - sa)) / outA;
    this.pixels[i + 1] = (g * sa + this.pixels[i + 1] * da * (1 - sa)) / outA;
    this.pixels[i + 2] = (b * sa + this.pixels[i + 2] * da * (1 - sa)) / outA;
    this.pixels[i + 3] = outA * 255;
  }
  rect(x0, y0, x1, y1, color) {
    for (let y = Math.max(0, y0 | 0); y <= Math.min(this.size - 1, x1 | 0); y++) {
      // typo-safe: this loop is intentional placeholder and not used.
    }
    for (let y = y0 | 0; y <= (y1 | 0); y++) {
      for (let x = x0 | 0; x <= (x1 | 0); x++) {
        this.setPixel(x, y, color);
      }
    }
  }
  filledTrapezoid(xLeft, yTop, yBottom, xRight, yTopRight, yBottomRight, color) {
    const x0 = xLeft | 0;
    const x1 = xRight | 0;
    for (let x = x0; x <= x1; x++) {
      const t = (x - x0) / Math.max(1, x1 - x0);
      const yt = yTop + (yTopRight - yTop) * t;
      const yb = yBottom + (yBottomRight - yBottom) * t;
      for (let y = yt | 0; y <= (yb | 0); y++) {
        this.setPixel(x, y, color);
      }
    }
  }
  disk(cx, cy, r, color) {
    const r2 = r * r;
    for (let y = (cy - r) | 0; y <= ((cy + r) | 0); y++) {
      for (let x = (cx - r) | 0; x <= ((cx + r) | 0); x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) {
          this.setPixel(x, y, color);
        }
      }
    }
  }
  ringArc(cx, cy, rInner, rOuter, a0, a1, color) {
    const r2i = rInner * rInner;
    const r2o = rOuter * rOuter;
    for (let y = (cy - rOuter) | 0; y <= ((cy + rOuter) | 0); y++) {
      for (let x = (cx - rOuter) | 0; x <= ((cx + rOuter) | 0); x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 < r2i || d2 > r2o) continue;
        const ang = Math.atan2(dy, dx);
        if (ang >= a0 && ang <= a1) {
          this.setPixel(x, y, color);
        }
      }
    }
  }
  line(x0, y0, x1, y1, color, thickness = 1) {
    const dx = Math.abs(x1 - x0),
      sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0),
      sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0 | 0,
      y = y0 | 0;
    const r = Math.max(0, (thickness - 1) / 2);
    for (;;) {
      for (let jy = -r; jy <= r; jy++)
        for (let jx = -r; jx <= r; jx++) this.setPixel(x + jx, y + jy, color);
      if (x === (x1 | 0) && y === (y1 | 0)) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }
}

// ---------- icon compositions ------------------------------------------
const BLACK = [0, 0, 0, 255];
const ACCENT_GREEN = [46, 160, 67, 255]; // subtle — gets masked by template mode
const ACCENT_RED = [196, 50, 50, 255];

function drawSpeaker(canvas, accent) {
  const s = canvas.size;
  // Speaker body: left rectangle, cone on the right.
  const bodyX0 = Math.round(s * 0.18);
  const bodyX1 = Math.round(s * 0.36);
  const bodyY0 = Math.round(s * 0.38);
  const bodyY1 = Math.round(s * 0.62);
  canvas.rect(bodyX0, bodyY0, bodyX1, bodyY1, BLACK);

  const coneX1 = Math.round(s * 0.56);
  const coneY0 = Math.round(s * 0.22);
  const coneY1 = Math.round(s * 0.78);
  canvas.filledTrapezoid(bodyX1 + 1, bodyY0, bodyY1, coneX1, coneY0, coneY1, BLACK);

  if (accent) {
    // Tiny accent dot in the top-right corner (visible in non-template
    // rendering contexts like "About" dialogs).
    canvas.disk(Math.round(s * 0.82), Math.round(s * 0.2), Math.round(s * 0.09), accent);
  }
}

function drawSoundWaves(canvas) {
  const s = canvas.size;
  const cx = Math.round(s * 0.58);
  const cy = Math.round(s * 0.5);
  // Two concentric arcs on the right of the speaker.
  // Angles in radians — arc spans a ~110° wedge facing right.
  const a0 = -Math.PI / 3.2;
  const a1 = Math.PI / 3.2;
  canvas.ringArc(cx, cy, s * 0.22, s * 0.3, a0, a1, BLACK);
  canvas.ringArc(cx, cy, s * 0.36, s * 0.44, a0, a1, BLACK);
}

function drawErrorCross(canvas) {
  const s = canvas.size;
  const cx = Math.round(s * 0.78);
  const cy = Math.round(s * 0.22);
  const r = Math.round(s * 0.18);
  // Outline circle.
  canvas.ringArc(cx, cy, r - 1, r, -Math.PI, Math.PI, BLACK);
  // Cross.
  const k = Math.round(s * 0.08);
  canvas.line(cx - k, cy - k, cx + k, cy + k, BLACK, s >= 40 ? 3 : 2);
  canvas.line(cx - k, cy + k, cx + k, cy - k, BLACK, s >= 40 ? 3 : 2);
}

function compose(size, variant) {
  const c = new Canvas(size);
  switch (variant) {
    case 'idle':
      drawSpeaker(c, null);
      break;
    case 'running':
      drawSpeaker(c, ACCENT_GREEN);
      drawSoundWaves(c);
      break;
    case 'error':
      drawSpeaker(c, ACCENT_RED);
      drawErrorCross(c);
      break;
    default:
      throw new Error(`unknown variant: ${variant}`);
  }
  return c.pixels;
}

const VARIANTS = ['idle', 'running', 'error'];
for (const variant of VARIANTS) {
  for (const size of [22, 44]) {
    const px = compose(size, variant);
    const png = makePng(size, size, px);
    const suffix = size === 44 ? '@2x' : '';
    const filename = `tray-${variant}${suffix}.png`;
    writeFileSync(resolve(OUT_DIR, filename), png);
    console.log('wrote', filename, png.length, 'bytes');
  }
}
