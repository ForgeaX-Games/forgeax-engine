// texel-picker.test.ts — coordinate mapping + raw texel decode unit tests for AC-11.
//
// (a) canvasToTexel: zoom fit/1:1/2x modes, object-fit contain letterbox, OOB -> null.
// (b) decodeTexelRaw: raw byte decode without float clamp (D-4), HDR >1.0 preserved.

import { describe, expect, it } from 'vitest';
import { canvasToTexel } from '../texel-coord';
import { decodeTexelRaw } from '../texel-decode';

// ---- helpers ----------------------------------------------------------------

/** Pack a Float32Array into a little-endian byte view. */
function f32Bytes(values: number[]): Uint8Array {
  const f = new Float32Array(values);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

/** Pack u16 half-float bit patterns into a little-endian byte view. */
function u16Bytes(values: number[]): Uint8Array {
  const u = new Uint16Array(values);
  return new Uint8Array(u.buffer, u.byteOffset, u.byteLength);
}

/** Pack a Uint8Array directly. */
function u8Bytes(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

// ====================================================================
// canvasToTexel — coordinate mapping under zoom / object-fit contain
// ====================================================================

describe('canvasToTexel', () => {
  describe('fit mode (object-fit contain)', () => {
    it('maps center of a same-aspect canvas to center texel', () => {
      // Canvas 400x300, tex 800x600 (both 4:3). Scale = min(400/800, 300/600) = 0.5.
      // Displayed: 400x300 → offset=(0,0). Center canvas (200,150) → texel (400,300).
      const r = canvasToTexel(200, 150, 400, 300, 800, 600, 'fit');
      expect(r).not.toBeNull();
      if (!r) return;
      expect(r.x).toBe(400);
      expect(r.y).toBe(300);
    });

    it('maps a canvas corner to texel corner when same aspect', () => {
      // Top-left corner (0,0) → texel (0,0).
      const r = canvasToTexel(0, 0, 400, 300, 800, 600, 'fit');
      expect(r).not.toBeNull();
      if (!r) return;
      expect(r.x).toBe(0);
      expect(r.y).toBe(0);
    });

    it('accounts for horizontal letterbox', () => {
      // Canvas 500x300, tex 400x400 (1:1 ratio).
      // Scale = min(500/400, 300/400) = 0.75.
      // Displayed: 300x300. OffsetX = (500-300)/2 = 100.
      // Mouse at (100, 0) → left edge of texture → texel (0, 0).
      const r = canvasToTexel(100, 0, 500, 300, 400, 400, 'fit');
      expect(r).not.toBeNull();
      if (!r) return;
      expect(r.x).toBe(0);
      expect(r.y).toBe(0);
    });

    it('returns null for mouse in horizontal letterbox gap', () => {
      // Canvas 500x300, tex 400x400. Scale=0.75. OffsetX=100, displayedW=300.
      // Mouse at x=50 is left of the texture area → null.
      const r = canvasToTexel(50, 150, 500, 300, 400, 400, 'fit');
      expect(r).toBeNull();
    });

    it('returns null for mouse in vertical letterbox gap', () => {
      // Canvas 300x500, tex 400x400. Scale=0.75. OffsetY=(500-300)/2=100.
      // Mouse at y=50 is above texture → null.
      const r = canvasToTexel(150, 50, 300, 500, 400, 400, 'fit');
      expect(r).toBeNull();
    });

    it('maps a known pixel at a non-origin position', () => {
      // Canvas 400x300, tex 1024x768 (both 4:3). Scale = 400/1024 ≈ 0.390625.
      // Displayed: 400x300. Offset=(0,0).
      // Mouse at (200, 150) center → texel (512, 384).
      const r = canvasToTexel(200, 150, 400, 300, 1024, 768, 'fit');
      expect(r).not.toBeNull();
      if (!r) return;
      expect(r.x).toBe(512);
      expect(r.y).toBe(384);
    });
  });

  describe('1:1 mode', () => {
    it('direct maps mouse to texel with no scaling', () => {
      // Canvas 1200x900, tex 1024x768. 1:1 → no scale, no letterbox.
      const r = canvasToTexel(512, 384, 1200, 900, 1024, 768, 1);
      expect(r).not.toBeNull();
      if (!r) return;
      expect(r.x).toBe(512);
      expect(r.y).toBe(384);
    });

    it('returns null when mouse is past texture width', () => {
      const r = canvasToTexel(1024, 100, 1200, 900, 1024, 768, 1);
      expect(r).toBeNull();
    });

    it('returns null when mouse is past texture height', () => {
      const r = canvasToTexel(100, 768, 1200, 900, 1024, 768, 1);
      expect(r).toBeNull();
    });

    it('maps origin correctly', () => {
      const r = canvasToTexel(0, 0, 1200, 900, 1024, 768, 1);
      expect(r).not.toBeNull();
      if (!r) return;
      expect(r.x).toBe(0);
      expect(r.y).toBe(0);
    });
  });

  describe('2x zoom mode', () => {
    it('divides mouse by zoom to get texel', () => {
      // Canvas 2048x1536 (large enough to hold 2x texture). Tex 1024x768.
      // 2x displayed: 2048x1536.
      // Mouse at (1024, 768) → texel (512, 384).
      const r = canvasToTexel(1024, 768, 2048, 1536, 1024, 768, 2);
      expect(r).not.toBeNull();
      if (!r) return;
      expect(r.x).toBe(512);
      expect(r.y).toBe(384);
    });

    it('returns null past displayed 2x bounds', () => {
      // 2x displayed: 2048x1536. Mouse at x=2048 is OOB.
      const r = canvasToTexel(2048, 100, 2500, 2000, 1024, 768, 2);
      expect(r).toBeNull();
    });

    it('handles fractional zoom mapping (floor to nearest texel)', () => {
      // zoom=2, mouse at (3, 3) → floor(1.5)=1.
      const r = canvasToTexel(3, 3, 200, 200, 50, 50, 2);
      expect(r).not.toBeNull();
      if (!r) return;
      expect(r.x).toBe(1);
      expect(r.y).toBe(1);
    });
  });

  describe('fractional zoom mode', () => {
    it('handles 0.5x zoom', () => {
      // Canvas 400x300, tex 800x600, zoom 0.5x → displayed 400x300.
      // Mouse at (200, 150) → texel floor(200/0.5)=400, floor(150/0.5)=300.
      const r = canvasToTexel(200, 150, 500, 400, 800, 600, 0.5);
      expect(r).not.toBeNull();
      if (!r) return;
      expect(r.x).toBe(400);
      expect(r.y).toBe(300);
    });
  });

  describe('zero-size texture guard', () => {
    it('returns null for zero-width texture', () => {
      expect(canvasToTexel(10, 10, 100, 100, 0, 100, 'fit')).toBeNull();
    });

    it('returns null for zero-height texture', () => {
      expect(canvasToTexel(10, 10, 100, 100, 100, 0, 'fit')).toBeNull();
    });
  });
});

// ====================================================================
// decodeTexelRaw — raw byte decode without float clamp (D-4)
// ====================================================================

describe('decodeTexelRaw', () => {
  describe('rgba16float — HDR values preserved', () => {
    it('returns raw float values for a single texel, 2.5 not clamped', () => {
      // f16 patterns: 2.5=0x4100, 0.5=0x3800, 0.0=0x0000, 1.0=0x3c00
      const bytes = u16Bytes([0x4100, 0x3800, 0x0000, 0x3c00]);
      const out = decodeTexelRaw(bytes, 'rgba16float', 1, 1, 0, 0);
      expect(out).not.toBeNull();
      if (!out) return;
      // 2.5 must NOT be clamped to 1.0
      expect(out[0]).toBeCloseTo(2.5, 3);
      expect(out[1]).toBeCloseTo(0.5, 3);
      expect(out[2]).toBeCloseTo(0, 3);
      expect(out[3]).toBeCloseTo(1, 3);
    });

    it('preserves negative float values', () => {
      // -1.0 = 0xbc00
      const bytes = u16Bytes([0xbc00, 0x0000, 0x0000, 0x3c00]);
      const out = decodeTexelRaw(bytes, 'rgba16float', 1, 1, 0, 0);
      expect(out).not.toBeNull();
      if (!out) return;
      expect(out[0]).toBeCloseTo(-1, 3);
    });

    it('preserves large HDR values', () => {
      // 10.0 f16 = 0x4900
      const bytes = u16Bytes([0x4900, 0x0000, 0x0000, 0x3c00]);
      const out = decodeTexelRaw(bytes, 'rgba16float', 1, 1, 0, 0);
      expect(out).not.toBeNull();
      if (!out) return;
      expect(out[0]).toBeCloseTo(10, 3);
    });
  });

  describe('rgba32float — full precision HDR', () => {
    it('preserves 2.5 and negative values without clamp', () => {
      const bytes = f32Bytes([2.5, -0.5, 3.0, 0.25]);
      const out = decodeTexelRaw(bytes, 'rgba32float', 1, 1, 0, 0);
      expect(out).not.toBeNull();
      if (!out) return;
      expect(out[0]).toBeCloseTo(2.5, 5);
      expect(out[1]).toBeCloseTo(-0.5, 5);
      expect(out[2]).toBeCloseTo(3.0, 5);
      expect(out[3]).toBeCloseTo(0.25, 5);
    });
  });

  describe('rgba8unorm — values stay in [0,1]', () => {
    it('decodes unorm byte values to float', () => {
      const bytes = u8Bytes([64, 128, 192, 255]);
      const out = decodeTexelRaw(bytes, 'rgba8unorm', 1, 1, 0, 0);
      expect(out).not.toBeNull();
      if (!out) return;
      expect(out[0]).toBeCloseTo(64 / 255, 5);
      expect(out[1]).toBeCloseTo(128 / 255, 5);
      expect(out[2]).toBeCloseTo(192 / 255, 5);
      expect(out[3]).toBeCloseTo(1, 5);
    });
  });

  describe('multi-texel buffer — correct offset', () => {
    it('reads texel at (2, 1) in a 4-wide row-major texture', () => {
      // 4x3 rgba8unorm texture (bytesPerTexel=4, rowBytes=16).
      // Fill known pattern: row 0 [0,0,0,0] x4, row 1 [0,0,0,0] [0,0,0,0] [10,20,30,40] [0,0,0,0].
      const w = 4;
      const h = 3;
      const bpt = 4;
      const bytes = new Uint8Array(w * h * bpt);
      bytes.fill(0);
      // Texel (2, 1) — row offset = 1*16=16, col offset = 2*4=8 → pos=24.
      bytes[24] = 10;
      bytes[25] = 20;
      bytes[26] = 30;
      bytes[27] = 40;

      const out = decodeTexelRaw(bytes, 'rgba8unorm', w, h, 2, 1);
      expect(out).not.toBeNull();
      if (!out) return;
      expect(out[0]).toBeCloseTo(10 / 255, 5);
      expect(out[1]).toBeCloseTo(20 / 255, 5);
      expect(out[2]).toBeCloseTo(30 / 255, 5);
      expect(out[3]).toBeCloseTo(40 / 255, 5);
    });

    it('returns null when x is OOB', () => {
      const bytes = new Uint8Array(4 * 4); // 1x1 rgba8 at 4bytes
      expect(decodeTexelRaw(bytes, 'rgba8unorm', 1, 1, 1, 0)).toBeNull();
    });

    it('returns null when y is OOB', () => {
      const bytes = new Uint8Array(4 * 4);
      expect(decodeTexelRaw(bytes, 'rgba8unorm', 1, 1, 0, 1)).toBeNull();
    });
  });

  describe('unsupported formats return null', () => {
    it('depth32float returns null', () => {
      expect(decodeTexelRaw(new Uint8Array(4), 'depth32float', 1, 1, 0, 0)).toBeNull();
    });

    it('compressed bc7 returns null', () => {
      expect(decodeTexelRaw(new Uint8Array(16), 'bc7-rgba-unorm', 4, 4, 0, 0)).toBeNull();
    });
  });

  describe('1-channel format fills R=G=B', () => {
    it('r32float — single channel replicates to RGB, A=1', () => {
      const bytes = f32Bytes([0.75]);
      const out = decodeTexelRaw(bytes, 'r32float', 1, 1, 0, 0);
      expect(out).not.toBeNull();
      if (!out) return;
      expect(out[0]).toBeCloseTo(0.75, 5);
      expect(out[1]).toBeCloseTo(0.75, 5);
      expect(out[2]).toBeCloseTo(0.75, 5);
      expect(out[3]).toBeCloseTo(1, 5);
    });
  });
});
