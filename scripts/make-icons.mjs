/**
 * Generates the PWA icons referenced by the manifest, with no image library:
 * a raw RGBA buffer deflated into a minimal PNG. Run via `npm run icons`.
 *
 * Deliberately dependency-free — the whole point of this app is that it can be
 * rebuilt and re-deployed from a laptop in a sports hall with no network.
 */

import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const BG = [2, 6, 23]; // court-bg slate-950
const ACCENT = [34, 211, 238]; // signal-accent cyan

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, draw) {
  // Raw scanlines, each prefixed with filter byte 0.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = draw(x, y, size);
      const offset = rowStart + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A wrist-velocity trace peaking at contact, with the peak marked.
 *
 * Earlier attempts at a ring-and-arm motif read as a prohibition sign and then
 * as a smiley; a curve with a marked peak is unambiguous and says what the app
 * actually does.
 */
function icon(inset) {
  return (x, y, size) => {
    const margin = size * (1 - inset) * 0.5;
    const span = size - margin * 2;

    const peakX = margin + span * 0.62;
    const peakY = margin + span * 0.2;
    const baseY = margin + span * 0.92;

    // Parabola through the peak, falling away to the baseline at both ends.
    const k = (baseY - peakY) / Math.pow(span * 0.62, 2);
    const curveY = peakY + k * Math.pow(x - peakX, 2);

    const thickness = size * 0.055;
    const onCurve =
      x >= margin && x <= size - margin && Math.abs(y - curveY) < thickness && y <= baseY;

    // Baseline, so the curve reads as a graph rather than a hill.
    const onAxis =
      Math.abs(y - baseY) < size * 0.035 && x >= margin && x <= size - margin;

    const inMarker = Math.hypot(x - peakX, y - peakY) < size * 0.1;

    return onCurve || onAxis || inMarker ? [...ACCENT, 255] : [...BG, 255];
  };
}

await mkdir(OUT, { recursive: true });

const targets = [
  ["icon-192.png", 192, 0.78],
  ["icon-512.png", 512, 0.78],
  // Maskable icons must survive a circular crop, so keep the art well inside.
  ["icon-512-maskable.png", 512, 0.58],
];

for (const [name, size, inset] of targets) {
  await writeFile(join(OUT, name), png(size, icon(inset)));
  console.log(`[icons] wrote ${name} (${size}x${size})`);
}
