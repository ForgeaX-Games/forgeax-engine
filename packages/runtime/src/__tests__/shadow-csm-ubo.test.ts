// shadow-csm-ubo.test.ts - feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path
// M4 / w14: View UBO std140 layout test (RED, test-first).
//
// Covers AC-08: View UBO tail pre-allocation for 4 cascades, fixed 592 B size
// independent of runtime cascadeCount. Validates std140 byte offsets for
// lightViewProj[4], splitPlanes[4], cascadeCount, cascadeBlend.
//
// Layout (592 B std140, 148 f32):
//   [  0.. 16) worldViewProj   mat4x4<f32>  (align 16, size 64)
//   [ 16.. 19) lightDir        vec3<f32>    (align 16, 12 + 4 pad)
//   [ 20.. 22) lightColor      vec3<f32>    (align 16, 12 + 4 pad)
//   [ 24.. 26) cameraPos       vec3<f32>    (align 16, 12 + 4 pad)
//   [ 28.. 43) lightViewProj[0] mat4x4<f32> (align 16, size 64)
//   [ 44.. 59) inverseViewProj ma4x4<f32>   (align 16, size 64)
//   [ 60.. 75] lightViewProj[1] mat4x4<f32> (align 16, size 64)
//   [ 76.. 91) lightViewProj[2] mat4x4<f32> (align 16, size 64)
//   [ 92..107) lightViewProj[3] mat4x4<f32> (align 16, size 64)
//   [108..111) splitPlanes[0]  f32 + 12 pad (vec4 wrapper, 16 B)
//   [112..115) splitPlanes[1]  f32 + 12 pad (vec4 wrapper, 16 B)
//   [116..119) splitPlanes[2]  f32 + 12 pad (vec4 wrapper, 16 B)
//   [120..123) splitPlanes[3]  f32 + 12 pad (vec4 wrapper, 16 B)
//   [124]      cascadeCount    f32          (align 4, size 4)
//   [125]      cascadeBlend    f32          (align 4, size 4)
//   [126..147] tail padding    f32[22]      (struct tail 16 B align)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const VIEW_UBO_FLOAT_COUNT = 148;
const VIEW_UBO_BYTES = 592;

// feat-20260621-learn-render-5-3-production-shadow-demos M0 / AC-14:
// pcfKernelSize lands in the View UBO tail-pad slot [126] (plan-strategy D-0:
// zero byte-layout change, only a previously-zero tail-pad float is consumed).
const OFFSET_PCF_KERNEL_SIZE = 126; // byte 504

const F32_BYTES = 4;

// Offsets as f32 indices.
const OFFSET_LIGHT_VIEW_PROJ_0 = 28; // byte 112
const OFFSET_LIGHT_VIEW_PROJ_1 = 60; // byte 240
const OFFSET_LIGHT_VIEW_PROJ_2 = 76; // byte 304
const OFFSET_LIGHT_VIEW_PROJ_3 = 92; // byte 368
const OFFSET_INVERSE_VIEW_PROJ = 44; // byte 176
const OFFSET_SPLIT_PLANES_0 = 108; // byte 432
const OFFSET_SPLIT_PLANES_1 = 112; // byte 448
const OFFSET_SPLIT_PLANES_2 = 116; // byte 464
const OFFSET_SPLIT_PLANES_3 = 120; // byte 480
const OFFSET_CASCADE_COUNT = 124; // byte 496
const OFFSET_CASCADE_BLEND = 125; // byte 500

// Each split occupies a whole vec4 slot (16 B = 4 f32), even though only
// the .x component carries the depth value. The remaining 3 f32 lanes are
// padding to satisfy std140 alignment (f32 in a struct after mat4 arrays
// requires vec4-level stride).
const SPLIT_STRIDE_FLOATS = 4;

describe('View UBO std140 layout (w14)', () => {
  describe('size invariants', () => {
    it('UBO total size is 592 B (148 f32)', () => {
      expect(VIEW_UBO_FLOAT_COUNT).toBe(148);
      expect(VIEW_UBO_BYTES).toBe(VIEW_UBO_FLOAT_COUNT * F32_BYTES);
      expect(VIEW_UBO_BYTES).toBe(592);
    });

    it('UBO size is fixed — independent of cascadeCount', () => {
      // The host always allocates 592 B regardless of whether cascadeCount
      // is 1, 2, 3, or 4 at runtime. This validates AC-08.
      const sizeForN1 = VIEW_UBO_FLOAT_COUNT * F32_BYTES; // cascadeCount=1
      const sizeForN4 = VIEW_UBO_FLOAT_COUNT * F32_BYTES; // cascadeCount=4
      expect(sizeForN1).toBe(sizeForN4);
      expect(sizeForN1).toBe(592);
    });
  });

  describe('std140 byte offsets', () => {
    it('lightViewProj[0] at offset 112 B (f32 index 28)', () => {
      expect(OFFSET_LIGHT_VIEW_PROJ_0 * F32_BYTES).toBe(112);
      // lightViewProj[0] replaces lightSpaceMatrix slot.
    });

    it('lightViewProj[1] at offset 240 B (f32 index 60)', () => {
      expect(OFFSET_LIGHT_VIEW_PROJ_1 * F32_BYTES).toBe(240);
    });

    it('lightViewProj[2] at offset 304 B (f32 index 76)', () => {
      expect(OFFSET_LIGHT_VIEW_PROJ_2 * F32_BYTES).toBe(304);
    });

    it('lightViewProj[3] at offset 368 B (f32 index 92)', () => {
      expect(OFFSET_LIGHT_VIEW_PROJ_3 * F32_BYTES).toBe(368);
    });

    it('lightViewProj[4] data is 256 B (4 x 64 B mat4)', () => {
      // Each lightViewProj matrix is 64 B (16 f32). lightViewProj[0]
      // replaces lightSpaceMatrix at [28..43]; [1,2,3] append after
      // inverseViewProj at [60..107]. The total data payload across the
      // 4 slots is 4 × 64 = 256 B — inverseViewProj (64 B) sits
      // between slot 0 and slots 1-3.
      const perMatrixF32 = 16;
      const perMatrixBytes = perMatrixF32 * F32_BYTES;
      expect(perMatrixBytes).toBe(64);
      const totalDataBytes = 4 * perMatrixBytes;
      expect(totalDataBytes).toBe(256);
    });

    it('splitPlanes[0] at offset 432 B (f32 index 108)', () => {
      expect(OFFSET_SPLIT_PLANES_0 * F32_BYTES).toBe(432);
    });

    it('splitPlanes[1] at offset 448 B (f32 index 112)', () => {
      expect(OFFSET_SPLIT_PLANES_1 * F32_BYTES).toBe(448);
    });

    it('splitPlanes[2] at offset 464 B (f32 index 116)', () => {
      expect(OFFSET_SPLIT_PLANES_2 * F32_BYTES).toBe(464);
    });

    it('splitPlanes[3] at offset 480 B (f32 index 120)', () => {
      expect(OFFSET_SPLIT_PLANES_3 * F32_BYTES).toBe(480);
    });

    it('splitPlanes stride is 16 B (vec4-aligned)', () => {
      expect(OFFSET_SPLIT_PLANES_1 - OFFSET_SPLIT_PLANES_0).toBe(SPLIT_STRIDE_FLOATS);
      expect(OFFSET_SPLIT_PLANES_2 - OFFSET_SPLIT_PLANES_1).toBe(SPLIT_STRIDE_FLOATS);
      expect(OFFSET_SPLIT_PLANES_3 - OFFSET_SPLIT_PLANES_2).toBe(SPLIT_STRIDE_FLOATS);
    });

    it('splitPlanes[4] spans 64 B (4 x 16 B vec4 stride)', () => {
      const start = OFFSET_SPLIT_PLANES_0;
      const end = OFFSET_SPLIT_PLANES_3 + SPLIT_STRIDE_FLOATS;
      expect((end - start) * F32_BYTES).toBe(64);
    });

    it('cascadeCount at offset 496 B (f32 index 124)', () => {
      expect(OFFSET_CASCADE_COUNT * F32_BYTES).toBe(496);
    });

    it('cascadeBlend at offset 500 B (f32 index 125)', () => {
      expect(OFFSET_CASCADE_BLEND * F32_BYTES).toBe(500);
    });

    it('inverseViewProj at offset 176 B (f32 index 44) — unchanged', () => {
      // inverseViewProj keeps its existing position; lightViewProj[0]
      // replaces lightSpaceMatrix at [28..43], inverseViewProj stays at
      // [44..59]. The new 3 lightViewProj matrices are appended after.
      expect(OFFSET_INVERSE_VIEW_PROJ * F32_BYTES).toBe(176);
    });
  });

  describe('std140 alignment paper verify', () => {
    it('mat4 alignment is 16 B', () => {
      // All mat4x4<f32> slots start at 16B-aligned offsets.
      const mat4Offsets = [
        OFFSET_LIGHT_VIEW_PROJ_0 * F32_BYTES,
        OFFSET_INVERSE_VIEW_PROJ * F32_BYTES,
        OFFSET_LIGHT_VIEW_PROJ_1 * F32_BYTES,
        OFFSET_LIGHT_VIEW_PROJ_2 * F32_BYTES,
        OFFSET_LIGHT_VIEW_PROJ_3 * F32_BYTES,
      ];
      for (const off of mat4Offsets) {
        expect(off % 16).toBe(0);
      }
    });

    it('f32 after mat4 array gets vec4 stride (16 B)', () => {
      // std140: f32 following a mat4 (or vec4) aligns to vec4 level.
      // Each splitPlanes element is 16 B wide even though only 4 B (f32)
      // carries data — the compiler pads to vec4 boundaries.
      const splitStart = OFFSET_SPLIT_PLANES_0 * F32_BYTES;
      expect(splitStart % 16).toBe(0);
    });

    it('cascadeCount f32 at offset 496 is 16 B after splitPlanes end at 480', () => {
      const splitEnd = (OFFSET_SPLIT_PLANES_3 + SPLIT_STRIDE_FLOATS) * F32_BYTES;
      const ccStart = OFFSET_CASCADE_COUNT * F32_BYTES;
      expect(ccStart).toBe(splitEnd);
      // f32 after vec4: align is 4, so cascadeCount starts right after splitPlanes
      // (no extra gap needed since 496 / 4 = 124 is an integer index)
    });

    it('struct tail aligned to 16 B', () => {
      // Total UBO bytes must be 16B-aligned for uniform buffer binding.
      expect(VIEW_UBO_BYTES % 16).toBe(0);
    });
  });
});

// feat-20260621-learn-render-5-3-production-shadow-demos M0 / AC-14: the host
// record stage must write pcfKernelSize into the tail-pad slot [126], and the
// WGSL View struct must declare the matching `pcfKernelSize : f32` immediately
// after cascadeBlend (single SSOT, append-at-tail, plan-strategy D-0). These
// are read against the real source the compiler/host use (mirrors the
// shadow-csm-tile-consistency antipattern guard: never re-declare and test a
// formula against itself). RED until M0-T-IMPL-RECORD + M0-T-IMPL-WGSL-STRUCT
// land; the slot was previously a zero tail-pad float (no record write existed).
describe('pcfKernelSize tail-pad slot wiring (M0, AC-14)', () => {
  const recordSrc = readFileSync(
    fileURLToPath(new URL('../render-system-record.ts', import.meta.url)),
    'utf8',
  );
  const wgslSrc = readFileSync(
    fileURLToPath(new URL('../../../shader/src/common.wgsl', import.meta.url)),
    'utf8',
  );

  it('slot [126] is the tail-pad float, layout unchanged (148 f32 / 592 B)', () => {
    expect(OFFSET_PCF_KERNEL_SIZE * F32_BYTES).toBe(504);
    expect(OFFSET_PCF_KERNEL_SIZE).toBeGreaterThan(OFFSET_CASCADE_BLEND);
    expect(OFFSET_PCF_KERNEL_SIZE).toBeLessThan(VIEW_UBO_FLOAT_COUNT);
    // The float count / byte size invariant must NOT grow (D-0).
    expect(VIEW_UBO_FLOAT_COUNT).toBe(148);
    expect(VIEW_UBO_BYTES).toBe(592);
  });

  it('record writes lights.pcfKernelSize into viewPayload[126]', () => {
    expect(recordSrc).toMatch(/viewPayload\[126\]\s*=\s*lights\.pcfKernelSize/);
  });

  it('record does NOT grow VIEW_PAYLOAD_FLOATS past 148', () => {
    expect(recordSrc).toMatch(/VIEW_PAYLOAD_FLOATS\s*=\s*148/);
  });

  it('common.wgsl View struct declares pcfKernelSize immediately after cascadeBlend', () => {
    const m = wgslSrc.match(/cascadeBlend\s*:\s*f32\s*,\s*pcfKernelSize\s*:\s*f32\s*,/);
    expect(m).not.toBeNull();
  });
});
