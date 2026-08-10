import type { Vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { packSpotLight } from '../light-buffer-layout';
import type { SpotLightSnapshot } from '../render-system-extract';

const snapshot: SpotLightSnapshot = {
  kind: 'spot',
  position: new Float32Array([2, 3, 4]) as Vec3,
  direction: new Float32Array([0, 1, 0]) as Vec3,
  color: new Float32Array([4, 2, 1]) as Vec3,
  intensity: 4,
  invRangeSquared: 0.25,
  cosInner: 0.98,
  cosOuter: 0.7,
  castShadow: false,
  lightViewProj: undefined,
  mapSize: 2048,
  nearPlane: 0.1,
  farPlane: 50,
  shadowAtlasTile: -1,
};

describe('direct light snapshot buffer layout', () => {
  it('packs the normalized snapshot without changing its public semantics', () => {
    const packed = packSpotLight(snapshot);

    expect([...packed.slice(0, 7)]).toEqual([2, 3, 4, 0.25, 4, 2, 1]);
    expect(packed[7]).toBeCloseTo(0.98, 5);
    expect([...packed.slice(8, 11)]).toEqual([0, 1, 0]);
    expect(packed[11]).toBeCloseTo(0.7, 5);
  });

  it('does not introduce a pipeline-specific intensity multiplier', () => {
    const packed = packSpotLight(snapshot);

    expect(packed[4]).toBe(snapshot.color[0]);
    expect(packed[5]).toBe(snapshot.color[1]);
    expect(packed[6]).toBe(snapshot.color[2]);
  });
});
