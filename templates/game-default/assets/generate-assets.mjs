// Generate the small license-safe authored texture used by the projectile slice.
// The PNG stays ignored by the engine's zero-binary policy; Preview invokes this
// before pluginPack scans template assets for dev or production.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WIDTH = 33;
const HEIGHT = 66;
const CELL = 4;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type, data) {
  const body = new Uint8Array([...type].map((char) => char.charCodeAt(0)).concat([...data]));
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

function makeProjectilePng() {
  const ihdr = new Uint8Array([...u32(WIDTH), ...u32(HEIGHT), 8, 6, 0, 0, 0]);
  const raw = new Uint8Array(HEIGHT * (1 + WIDTH * 4));
  let offset = 0;
  for (let y = 0; y < HEIGHT; y++) {
    raw[offset++] = 0;
    const lower = y >= HEIGHT / 2;
    for (let x = 0; x < WIDTH; x++) {
      const tile = (Math.floor(x / CELL) + Math.floor(y / CELL)) % 2 === 0;
      raw[offset++] = lower ? (tile ? 245 : 55) : (tile ? 45 : 15);
      raw[offset++] = lower ? (tile ? 105 : 25) : (tile ? 220 : 80);
      raw[offset++] = lower ? (tile ? 25 : 155) : (tile ? 95 : 35);
      raw[offset++] = 255;
    }
  }
  const idat = new Uint8Array(deflateSync(raw));
  return new Uint8Array([
    ...PNG_MAGIC,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', idat),
    ...chunk('IEND', new Uint8Array(0)),
  ]);
}

export function generateTemplateAssets() {
  const here = dirname(fileURLToPath(import.meta.url));
  const bytes = makeProjectilePng();
  writeFileSync(resolve(here, 'compressed-projectile.png'), bytes);
  return { width: WIDTH, height: HEIGHT, bytes: bytes.byteLength };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = generateTemplateAssets();
  console.log(`[game-default-assets] wrote compressed-projectile.png (${result.bytes}B, ${result.width}x${result.height})`);
}
