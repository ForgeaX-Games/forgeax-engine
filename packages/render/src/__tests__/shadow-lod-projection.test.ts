import { mat4 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import type { GpuDrivenBatch, GpuDrivenCandidate } from '../gpu-driven/batch-topology';
import { projectedHeightForCandidate } from '../gpu-driven/batch-topology';
import {
  lodProjectionState,
  lodViewCameraFromMatrix,
  SHADOW_LOD_MAX_COARSER,
  shadowLodProjectionState,
} from '../gpu-driven/production-raster-lod';
import type { CameraSnapshot } from '../render-contract';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { projectedHeight as measureProjectedHeight } from '../scene/visibility/lod-selector';

function slotAt(x: number, y: number, z: number): RenderSceneSlot {
  const world = new Float32Array(mat4.identity(mat4.create()));
  world[12] = x;
  world[13] = y;
  world[14] = z;
  return {
    snapshot: {
      localAabb: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
      transform: { world },
    },
  } as unknown as RenderSceneSlot;
}

function viewProjection(projection: Float32Array, eye: readonly number[]): Float32Array {
  const view = mat4.lookAt(mat4.create(), eye, [0, 0, 0], [0, 1, 0]);
  return new Float32Array(mat4.multiply(mat4.create(), projection, view));
}

const RADIUS = Math.hypot(0.5, 0.5, 0.5);

describe('shadow light-view LOD projection', () => {
  it('matches the orthographic camera height in an orthographic light view', () => {
    const matrix = viewProjection(
      new Float32Array(mat4.orthographic(mat4.create(), -8, 8, -4, 4, 0.1, 100)),
      [0, 20, 10],
    );
    expect(
      projectedHeightForCandidate(slotAt(3, 0, -2), lodViewCameraFromMatrix(matrix)),
    ).toBeCloseTo(
      measureProjectedHeight({
        radius: RADIUS,
        depth: 1,
        projection: 'orthographic',
        orthoHeight: 8,
      }),
      6,
    );
  });

  it('matches the perspective camera height along the view axis', () => {
    const fov = Math.PI / 3;
    const matrix = viewProjection(
      new Float32Array(mat4.perspective(mat4.create(), fov, 1, 0.1, 100)),
      [0, 0, 12],
    );
    expect(
      projectedHeightForCandidate(slotAt(0, 0, 0), lodViewCameraFromMatrix(matrix)),
    ).toBeCloseTo(
      measureProjectedHeight({ radius: RADIUS, depth: 12, projection: 'perspective', fov }),
      6,
    );
    expect(
      [...lodViewCameraFromMatrix(matrix).position].map((v) => Math.round(v * 1e4) / 1e4),
    ).toEqual([0, 0, 12]);
  });

  it('never selects more than the allowed levels coarser than the main camera', () => {
    const source = {
      key: { first: 0, count: 36, baseVertex: 0 },
      lod: {
        coverages: [1, 0.5, 0.25, 0.1, 0.02],
        hysteresis: 0.08,
        ranges: [
          { first: 36, count: 24, baseVertex: 0 },
          { first: 60, count: 12, baseVertex: 0 },
          { first: 72, count: 6, baseVertex: 0 },
          { first: 78, count: 3, baseVertex: 0 },
        ],
      },
    } as unknown as GpuDrivenBatch;
    const candidate = { primitiveIndex: 0 } as GpuDrivenCandidate;
    const prepared = { lodCandidates: [{ source, candidate }], lodPrimitives: [0] };
    const slot = slotAt(0, 0, 0);
    const camera = {
      projection: 'perspective',
      fov: Math.PI / 3,
      position: new Float32Array([0, 0, 2]),
      orthoTop: 1,
      orthoBottom: -1,
    } as unknown as CameraSnapshot;
    const main = lodProjectionState(prepared, camera, () => slot);
    const mainLevel = main.selections[0]?.[0] ?? -1;
    expect(mainLevel).toBe(0);

    // A wide cascade shrinks the caster far below every coverage threshold.
    const wide = viewProjection(
      new Float32Array(mat4.orthographic(mat4.create(), -400, 400, -400, 400, 0.1, 100)),
      [0, 20, 10],
    );
    const shadow = shadowLodProjectionState(prepared, wide, main, () => slot);
    const levels = shadow.selections[0] ?? [];
    expect(Math.max(...levels)).toBe(mainLevel + SHADOW_LOD_MAX_COARSER);

    // A tight view keeps its own finer level.
    const tight = viewProjection(
      new Float32Array(mat4.orthographic(mat4.create(), -1, 1, -1, 1, 0.1, 100)),
      [0, 20, 10],
    );
    expect(shadowLodProjectionState(prepared, tight, main, () => slot).selections[0]).toEqual([0]);
  });
});
