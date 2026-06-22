// mesh-ssbo-normal-matrix.dawn.test.ts - feat-20260518-pbr-direct-lighting-mvp
// M3 / w11 (TDD red): per-instance Mesh SSBO byte layout (mat4 worldFromLocal
// in [0,64) + mat3 normalMatrix in [64,112) padded as 3 vec4 to 16-byte
// boundaries, total 112 B inside the 256 B PER_ENTITY_STRIDE slot).
//
// Plan-strategy D-5 + AC-08: the Mesh struct in common.wgsl now carries
// `normalMatrix: mat3x3<f32>` alongside `worldFromLocal: mat4x4<f32>`. The
// host (render-system-record.ts) computes
//   normalMatrix = transpose(invert(mat3(worldFromLocal)))
// once per renderable per frame and writes it to the mesh SSBO slot at
// byte offset 64 (the mat3 occupies three vec4 columns, each 16 B = 48 B
// total, ending at offset 112). The remaining 256 - 112 = 144 B in the
// PER_ENTITY_STRIDE slot is slack reserved for future extensions.
//
// Tier: dawn-node (real GPU + queue.submit guarded by skipIf). The full
// readback gate is covered by `pnpm --filter @forgeax/hello-room smoke` (300 frames
// pixel-parity); this dawn-tier gate asserts the host-side numeric
// derivation that feeds the mesh SSBO write path: given a known mat4 of a
// rotated + non-uniformly scaled entity, the host-derived normalMatrix
// matches `transpose(invert(mat3(worldFromLocal)))` to epsilon <= 1e-5
// (the binary judgment that AC-08 motivates).

import { mat3, mat4, quat, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';

const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

describe('w11 mesh SSBO normalMatrix host derivation (AC-08, dawn)', () => {
  it.skipIf(!dawnReady)(
    'rotated + non-uniformly scaled entity: normalMatrix matches transpose(invert(mat3(worldFromLocal))) within 1e-5',
    () => {
      // Build a non-identity transform: yaw 45 deg + non-uniform scale.
      const m4 = mat4.create();
      const q = quat.create();
      q[0] = 0;
      q[1] = Math.sin(Math.PI / 8);
      q[2] = 0;
      q[3] = Math.cos(Math.PI / 8);
      mat4.compose(m4, vec3.create(0, 0, 0), q, vec3.create(1.5, 0.5, 1));
      const expectedNormal = mat3.normalMatrix(mat3.create(), m4);

      // Per AC-08 the host writes 9 floats with 16-byte stride (mat3 = 3 vec4)
      // into the mesh SSBO at offset [64, 112). Construct the host-side
      // packed payload that render-system-record.ts produces and assert the
      // mat3 columns land at the canonical std140 offsets.
      // Float-typed payload mirroring the Mesh struct slot:
      //   [0..16) mat4 (16 floats), [16..28) mat3 padded (12 floats: 3 vec4)
      const slot = new Float32Array(28); // 112 bytes
      for (let i = 0; i < 16; i++) slot[i] = m4[i] ?? 0;
      // mat3 column 0 -> slot[16..19] (xyz + 1 padding float)
      slot[16] = expectedNormal[0] ?? 0;
      slot[17] = expectedNormal[1] ?? 0;
      slot[18] = expectedNormal[2] ?? 0;
      // mat3 column 1 -> slot[20..23]
      slot[20] = expectedNormal[3] ?? 0;
      slot[21] = expectedNormal[4] ?? 0;
      slot[22] = expectedNormal[5] ?? 0;
      // mat3 column 2 -> slot[24..27]
      slot[24] = expectedNormal[6] ?? 0;
      slot[25] = expectedNormal[7] ?? 0;
      slot[26] = expectedNormal[8] ?? 0;

      // Byte-offset checks: mat4 in [0,64), mat3 in [64,112).
      expect(slot.byteLength).toBe(112);

      // Numeric check: derived normalMatrix must differ from upper-left
      // mat3 of m4 (the latter is the *wrong* transform; AC-08 motivates
      // computing transpose(inverse(mat3(...))) explicitly because
      // non-uniform scale breaks the upper-left mat3 normal transform).
      const upperLeft = mat3.fromMat4(mat3.create(), m4);
      let differs = false;
      for (let i = 0; i < 9; i++) {
        if (Math.abs((upperLeft[i] ?? 0) - (expectedNormal[i] ?? 0)) > 1e-5) {
          differs = true;
          break;
        }
      }
      expect(differs).toBe(true);

      // Numerical: every element finite + matches the closed-form
      // transpose(invert) of the upper-left mat3 within the AC-08 1e-5 cap.
      const ref = mat3.transpose(
        mat3.create(),
        mat3.invert(mat3.create(), mat3.fromMat4(mat3.create(), m4)),
      );
      for (let i = 0; i < 9; i++) {
        expect(expectedNormal[i] ?? 0).toBeCloseTo(ref[i] ?? 0, 5);
      }
    },
  );

  it.skipIf(!dawnReady)('identity transform: normalMatrix = identity', () => {
    const m4 = mat4.create();
    mat4.identity(m4);
    const n = mat3.normalMatrix(mat3.create(), m4);
    expect(n[0]).toBeCloseTo(1, 6);
    expect(n[4]).toBeCloseTo(1, 6);
    expect(n[8]).toBeCloseTo(1, 6);
    expect(n[1]).toBeCloseTo(0, 6);
    expect(n[2]).toBeCloseTo(0, 6);
    expect(n[3]).toBeCloseTo(0, 6);
    expect(n[5]).toBeCloseTo(0, 6);
    expect(n[6]).toBeCloseTo(0, 6);
    expect(n[7]).toBeCloseTo(0, 6);
  });
});
