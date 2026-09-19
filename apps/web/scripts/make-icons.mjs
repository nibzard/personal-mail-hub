#!/usr/bin/env node
/*
 * Generates the progressive web app icons in `public/icons` from the design
 * tokens (SPEC section 6 and F12). The colors are the accent and background
 * values `src/styles.css` defines, converted from OKLCH to sRGB here, so the
 * icons follow the theme instead of holding a second palette. The mark is an
 * envelope: a glyph body with a flap cut from the accent surface.
 *
 * Outputs:
 *
 * - `icon-192.png`, `icon-512.png`        rounded squares, `purpose: any`,
 * - `maskable-192.png`, `maskable-512.png` full-bleed squares whose glyph
 *                                          stays inside the maskable safe
 *                                          zone (the inner 80 percent),
 * - `apple-touch-icon.png`                 the full square iOS rounds itself.
 *
 * Usage: `node scripts/make-icons.mjs` from `apps/web`. Commit the results;
 * the build does not run this script.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/* The token values of `src/styles.css`, in OKLCH (L, C, H). */
const ACCENT = [0.52, 0.163, 262];
const ACCENT_FOREGROUND = [0.985, 0.002, 250];

/**
 * One OKLCH color as sRGB bytes. The matrices are the standard OKLab
 * reference transform; gamut errors clamp to the nearest representable
 * color, which the small chroma here never triggers.
 */
function oklchToSrgb([l, c, h]) {
  const angle = (h * Math.PI) / 180;
  const a = c * Math.cos(angle);
  const b = c * Math.sin(angle);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const cube = (x) => x * x * x;
  const linear = [
    4.0767416621 * cube(l_) - 3.3077115913 * cube(m_) + 0.2309699292 * cube(s_),
    -1.2684380046 * cube(l_) + 2.6097574011 * cube(m_) - 0.3413193965 * cube(s_),
    -0.0041960863 * cube(l_) - 0.7034186147 * cube(m_) + 1.707614701 * cube(s_),
  ];
  return linear.map((channel) => {
    const encoded =
      channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
  });
}

const ACCENT_RGB = oklchToSrgb(ACCENT);
const GLYPH_RGB = oklchToSrgb(ACCENT_FOREGROUND);

/** The CRC-32 every PNG chunk ends with. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One length-prefixed, CRC-suffixed PNG chunk. */
function chunk(type, data) {
  const head = Buffer.from(type, "latin1");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head, data])));
  return Buffer.concat([length, head, data, crc]);
}

/** One 8-bit RGBA PNG from uncompressed pixel bytes. */
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // Bit depth.
  header.writeUInt8(6, 9); // Color type: alpha.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // Filter type: none.
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** True when the point sits inside a rounded rectangle. */
function insideRoundedRect(x, y, x0, y0, x1, y1, radius) {
  if (x < x0 || x > x1 || y < y0 || y > y1) {
    return false;
  }
  const dx = Math.max(x0 + radius - x, x - (x1 - radius), 0);
  const dy = Math.max(y0 + radius - y, y - (y1 - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * True when the point sits inside one triangle of three corners. Each cross
 * product says which side of one edge the point lies on; the point is inside
 * when no two edges disagree.
 */
function insideTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const cross = (x1, y1, x2, y2) => (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
  const d1 = cross(ax, ay, bx, by);
  const d2 = cross(bx, by, cx, cy);
  const d3 = cross(cx, cy, ax, ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

/**
 * Renders one icon. Each pixel averages a 4x4 grid of samples, so the edges
 * anti-alias. `fullBleed` paints the whole square for maskable and iOS
 * icons; otherwise the surface is a rounded square over transparency.
 */
function renderIcon(size, { fullBleed, glyphScale }) {
  const rgba = Buffer.alloc(size * size * 4);
  // The glyph box, centered and scaled inside the surface.
  const half = 0.22 * glyphScale;
  const x0 = 0.5 - half;
  const x1 = 0.5 + half;
  const y0 = 0.5 - half * 1.05;
  const y1 = 0.5 + half * 0.95;
  const corner = 0.045 * glyphScale;
  const apex = [0.5, y0 + (y1 - y0) * 0.45];

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let background = 0;
      let glyph = 0;
      for (let sy = 0; sy < 4; sy += 1) {
        for (let sx = 0; sx < 4; sx += 1) {
          const x = (px + (sx + 0.5) / 4) / size;
          const y = (py + (sy + 0.5) / 4) / size;
          const onSurface = fullBleed || insideRoundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.2);
          if (!onSurface) {
            continue;
          }
          background += 1;
          const inBody = insideRoundedRect(x, y, x0, y0, x1, y1, corner);
          const inFlap = insideTriangle(x, y, [x0 + corner, y0], [x1 - corner, y0], apex);
          if (inBody && !inFlap) {
            glyph += 1;
          }
        }
      }
      const offset = (py * size + px) * 4;
      if (background === 0) {
        rgba[offset + 3] = 0;
        continue;
      }
      const [br, bg, bb] = ACCENT_RGB;
      const [gr, gg, gb] = GLYPH_RGB;
      const coverage = glyph / 16;
      rgba[offset] = Math.round(br + (gr - br) * coverage);
      rgba[offset + 1] = Math.round(bg + (gg - bg) * coverage);
      rgba[offset + 2] = Math.round(bb + (gb - bb) * coverage);
      rgba[offset + 3] = Math.round((background / 16) * 255);
    }
  }
  return encodePng(size, size, rgba);
}

const outDir = fileURLToPath(new URL("../public/icons", import.meta.url));
await mkdir(outDir, { recursive: true });

const outputs = [
  ["icon-192.png", renderIcon(192, { fullBleed: false, glyphScale: 1 })],
  ["icon-512.png", renderIcon(512, { fullBleed: false, glyphScale: 1 })],
  ["maskable-192.png", renderIcon(192, { fullBleed: true, glyphScale: 0.8 })],
  ["maskable-512.png", renderIcon(512, { fullBleed: true, glyphScale: 0.8 })],
  ["apple-touch-icon.png", renderIcon(180, { fullBleed: true, glyphScale: 1 })],
];

for (const [name, bytes] of outputs) {
  await writeFile(join(outDir, name), bytes);
  console.log(`icons: wrote public/icons/${name} (${bytes.length} bytes)`);
}

const toHex = ([r, g, b]) =>
  `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
console.log(`icons: accent ${toHex(ACCENT_RGB)}, glyph ${toHex(GLYPH_RGB)}`);
