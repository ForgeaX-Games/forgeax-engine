import type { ImageError } from '@forgeax/engine-types';
import { imageError } from './errors.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';

/**
 * Decoded HDR image POD.
 *
 * `data` is an interleaved RGBA Float32Array (4 floats per pixel, row-major).
 * Color space is always linear (RGBE is radiance).
 */
export interface HdrDecoded {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

// ASCII code points
const LF = 0x0a;

/**
 * Decode a Radiance RGBE (.hdr) byte stream into linear RGBA float pixels.
 *
 * Steps per research F-6:
 * 1. Parse ASCII header: magic (#?RADIANCE), FORMAT=32-bit_rle_rgbe,
 *    resolution line (-Y height +X width).
 * 2. Decode per-scanline new-RLE pixel data: 4 independent channel runs.
 * 3. Convert RGBE to float: if E==0 -> 0; else f=2^(E-136), R=(Rm+0.5)*f.
 * 4. Output as interleaved RGBA Float32Array (alpha=1.0).
 *
 * Old-RLE scanlines (prefix not matching 0x02,0x02,hi,lo with correct width)
 * return image-hdr-decode-failed.
 */
export function decodeHdr(bytes: Uint8Array): Result<HdrDecoded, ImageError> {
  let pos = 0;

  // Step 1a: magic -- must start with "#?RADIANCE" or "#?RGBE"
  if (bytes.length < 11) {
    return err(hdrDecodeError('file too short for Radiance HDR header'));
  }
  const magic = String.fromCharCode(...bytes.subarray(0, 11));
  if (magic !== '#?RADIANCE\n' && magic !== '#?RGBE\n') {
    return err(
      hdrDecodeError('missing or invalid Radiance HDR magic; expected #?RADIANCE or #?RGBE'),
    );
  }
  pos = 11;

  // Step 1b: key=value lines until empty line
  let formatFound = false;
  while (pos < bytes.length) {
    const lineEnd = findByte(bytes, LF, pos);
    if (lineEnd === -1) return err(hdrDecodeError('header truncated before empty line'));
    const line = asciiSubstring(bytes, pos, lineEnd);
    pos = lineEnd + 1;
    if (line === '') break;
    if (line.startsWith('FORMAT=')) {
      const val = line.slice(7);
      if (val === '32-bit_rle_rgbe') {
        formatFound = true;
      }
    }
  }
  if (!formatFound) {
    return err(hdrDecodeError('missing or unsupported FORMAT; expected FORMAT=32-bit_rle_rgbe'));
  }

  // Step 1c: resolution line (-Y height +X width)
  if (pos >= bytes.length) return err(hdrDecodeError('missing resolution line'));
  const resLineEnd = findByte(bytes, LF, pos);
  if (resLineEnd === -1) return err(hdrDecodeError('resolution line truncated'));
  const resLine = asciiSubstring(bytes, pos, resLineEnd);
  pos = resLineEnd + 1;
  const resMatch = /^-Y\s+(\d+)\s+\+X\s+(\d+)\s*$/.exec(resLine);
  if (resMatch === null) {
    return err(
      hdrDecodeError(`unexpected resolution line format: "${resLine}"; expected "-Y H +X W"`),
    );
  }
  const height = Number(resMatch[1]);
  const width = Number(resMatch[2]);
  if (height === undefined || width === undefined || height <= 0 || width <= 0) {
    return err(hdrDecodeError(`invalid dimensions: ${width}x${height}`));
  }

  // Step 2: decode per-scanline new-RLE pixel data
  const pixelCount = width * height;
  const rgbe = new Uint8Array(pixelCount * 4);
  const scanlineBytes = width * 4;

  for (let y = 0; y < height; y++) {
    if (pos + 4 > bytes.length) {
      return err(hdrDecodeError(`truncated at scanline ${y}: expected 4-byte prefix`));
    }
    const p0 = bytes[pos];
    const p1 = bytes[pos + 1];
    const pHi = bytes[pos + 2];
    const pLo = bytes[pos + 3];
    if (p0 === undefined || p1 === undefined || pHi === undefined || pLo === undefined) {
      return err(hdrDecodeError(`truncated at scanline ${y}`));
    }
    // biome-ignore lint/style/noNonNullAssertion: checked above
    const prefixWidth = (pHi! << 8) | pLo!;

    if (p0 === 0x02 && p1 === 0x02 && prefixWidth === width && width >= 8 && width <= 32767) {
      // New-RLE: 4 channels independently RLE-encoded, then interleaved
      const decoded = decodeNewRleScanline(bytes, pos + 4, width);
      if (decoded === null) {
        return err(hdrDecodeError(`RLE decode failed at scanline ${y}`));
      }
      // Copy into rgbe interleaved buffer
      const base = y * scanlineBytes;
      const channels = [decoded[0], decoded[1], decoded[2], decoded[3]];
      for (let x = 0; x < width; x++) {
        for (let ch = 0; ch < 4; ch++) {
          // biome-ignore lint/style/noNonNullAssertion: checked at allocation
          rgbe[base + x * 4 + ch] = channels[ch]![x]!;
        }
      }
      // Advance pos past the 4-byte prefix + the total RLE bytes consumed
      pos += 4 + decoded.totalBytes;
    } else {
      // Old-RLE: not supported
      return err(
        hdrDecodeError(
          'old-RLE format is not supported; only new-RLE (32-bit_rle_rgbe) is accepted',
        ),
      );
    }
  }

  // Step 3: RGBE to float
  const out = new Float32Array(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    const base = i * 4;
    // biome-ignore lint/style/noNonNullAssertion: checked at allocation
    const r = rgbe[base]!;
    // biome-ignore lint/style/noNonNullAssertion: checked at allocation
    const g = rgbe[base + 1]!;
    // biome-ignore lint/style/noNonNullAssertion: checked at allocation
    const b = rgbe[base + 2]!;
    // biome-ignore lint/style/noNonNullAssertion: checked at allocation
    const e = rgbe[base + 3]!;
    out[base + 3] = 1.0;

    if (e === 0) {
      out[base] = 0;
      out[base + 1] = 0;
      out[base + 2] = 0;
    } else {
      // f = 2^(E - 136) = ldexp(1.0, E - 128 - 8)
      // Equivalent: ldexp(1.0 / 256.0, E - 128)
      // But simpler: const f = (1.0 / 256.0) * Math.pow(2, e - 128);
      // Using ldexp: Math.pow(2, e - 136)
      const f = 2 ** (e - 136);
      out[base] = (r + 0.5) * f;
      out[base + 1] = (g + 0.5) * f;
      out[base + 2] = (b + 0.5) * f;
    }
  }

  return ok({ width, height, data: out });
}

interface DecodedScanline {
  /** 4 channels, each width bytes */
  readonly 0: Uint8Array;
  readonly 1: Uint8Array;
  readonly 2: Uint8Array;
  readonly 3: Uint8Array;
  readonly totalBytes: number;
}

/**
 * Decode one scanline of new-RLE data into 4 channel arrays.
 * Returns null on failure (data underrun).
 */
function decodeNewRleScanline(
  bytes: Uint8Array,
  start: number,
  width: number,
): DecodedScanline | null {
  const channels: Uint8Array[] = [];
  let cursor = start;

  for (let ch = 0; ch < 4; ch++) {
    const data = new Uint8Array(width);
    let x = 0;
    while (x < width) {
      if (cursor >= bytes.length) return null;
      // biome-ignore lint/style/noNonNullAssertion: checked above
      const code = bytes[cursor]!;
      cursor++;
      if (code > 128) {
        // RLE run: next byte repeated (code - 128) times
        const count = code - 128;
        if (cursor >= bytes.length || x + count > width) return null;
        // biome-ignore lint/style/noNonNullAssertion: checked above
        const val = bytes[cursor]!;
        cursor++;
        data.fill(val, x, x + count);
        x += count;
      } else {
        // Literal run: next `code` bytes copied verbatim
        if (code === 0) continue;
        if (cursor + code > bytes.length || x + code > width) return null;
        for (let k = 0; k < code; k++) {
          // biome-ignore lint/style/noNonNullAssertion: checked above
          data[x + k] = bytes[cursor + k]!;
        }
        cursor += code;
        x += code;
      }
    }
    channels.push(data);
  }

  const ch0 = channels[0];
  const ch1 = channels[1];
  const ch2 = channels[2];
  const ch3 = channels[3];
  if (ch0 === undefined || ch1 === undefined || ch2 === undefined || ch3 === undefined) {
    return null; // channels should always have 4 entries
  }
  return {
    0: ch0,
    1: ch1,
    2: ch2,
    3: ch3,
    totalBytes: cursor - start,
  };
}

function findByte(bytes: Uint8Array, target: number, start: number): number {
  for (let i = start; i < bytes.length; i++) {
    if (bytes[i] === target) return i;
  }
  return -1;
}

function asciiSubstring(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) {
    // biome-ignore lint/style/noNonNullAssertion: in bounds
    s += String.fromCharCode(bytes[i]!);
  }
  return s;
}

function hdrDecodeError(reason: string): ImageError {
  return imageError({
    code: 'image-hdr-decode-failed',
    reason,
  });
}
