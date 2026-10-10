// Generates the PWA icons (PNG) and an SVG, no image libraries needed.
// Usage: node scripts/make-icons.js
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });

const BG = [47, 85, 212];
const BG2 = [36, 71, 184];
const FG = [255, 255, 255];

// glyph rectangles in unit coordinates (0..1): scan-frame corners + QR-like modules
const T = 0.06, L = 0.17, A = 0.25, B = 0.75;
const rects = [
  [A, A, A + L, A + T], [A, A, A + T, A + L],
  [B - L, A, B, A + T], [B - T, A, B, A + L],
  [A, B - T, A + L, B], [A, B - L, A + T, B],
  [B - L, B - T, B, B], [B - T, B - L, B, B],
  [0.36, 0.36, 0.47, 0.47], [0.53, 0.36, 0.64, 0.47], [0.36, 0.53, 0.47, 0.64], [0.53, 0.53, 0.58, 0.58], [0.59, 0.59, 0.64, 0.64],
];

function inRoundRect(x, y, r) {
  const dx = Math.max(r - x, x - (1 - r), 0);
  const dy = Math.max(r - y, y - (1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

function render(size, { rounded, scale = 1 }) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 3;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (i + (sx + 0.5) / SS) / size;
          const y = (j + (sy + 0.5) / SS) / size;
          if (rounded && !inRoundRect(x, y, 0.22)) continue;
          const t = (x + y) / 2;
          let c = [BG[0] + (BG2[0] - BG[0]) * t, BG[1] + (BG2[1] - BG[1]) * t, BG[2] + (BG2[2] - BG[2]) * t];
          const gx = (x - 0.5) / scale + 0.5, gy = (y - 0.5) / scale + 0.5;
          if (rects.some(([x0, y0, x1, y1]) => gx >= x0 && gx <= x1 && gy >= y0 && gy <= y1)) c = FG;
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = SS * SS;
      const o = (j * size + i) * 4;
      px[o] = r / Math.max(a / 255, 1); px[o + 1] = g / Math.max(a / 255, 1); px[o + 2] = b / Math.max(a / 255, 1);
      px[o + 3] = a / n;
    }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

fs.writeFileSync(path.join(out, 'icon-192.png'), png(192, render(192, { rounded: true })));
fs.writeFileSync(path.join(out, 'icon-512.png'), png(512, render(512, { rounded: true })));
// maskable: full-bleed background, glyph kept well inside the 80% safe zone
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), png(512, render(512, { rounded: false, scale: 0.85 })));

const svgRects = rects.map(([x0, y0, x1, y1]) => `<rect x="${(x0 * 512).toFixed(1)}" y="${(y0 * 512).toFixed(1)}" width="${((x1 - x0) * 512).toFixed(1)}" height="${((y1 - y0) * 512).toFixed(1)}" fill="#fff"/>`).join('');
fs.writeFileSync(path.join(out, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f55d4"/><stop offset="1" stop-color="#2447b8"/></linearGradient></defs><rect width="512" height="512" rx="113" fill="url(#g)"/>${svgRects}</svg>\n`);
console.log('icons written to', out);
