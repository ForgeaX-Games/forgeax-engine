import { readFile } from 'node:fs/promises';
import type { Vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { packLightSlot, packSpotLight } from '../light-buffer-layout';
import type { SpotLightSnapshot } from '../render-system-extract';

const snapshot: SpotLightSnapshot = {
  kind: 'spot',
  position: new Float32Array([0, 2, 0]) as Vec3,
  direction: new Float32Array([0, 1, 0]) as Vec3,
  color: new Float32Array([2, 1, 0.5]) as Vec3,
  intensity: 2,
  invRangeSquared: 0.01,
  cosInner: 0.98,
  cosOuter: 0.7,
  castShadow: false,
  lightViewProj: undefined,
  mapSize: 2048,
  nearPlane: 0.1,
  farPlane: 50,
  shadowAtlasTile: -1,
};

describe('one direct-light snapshot proof', () => {
  it('passes the same snapshot identity to URP and HDRP buffer owners', () => {
    const consumed: SpotLightSnapshot[] = [];
    const consume = (value: SpotLightSnapshot) => {
      consumed.push(value);
      return {
        urp: packSpotLight(value),
        hdrp: packLightSlot(value),
      };
    };

    const packed = consume(snapshot);

    expect(consumed).toEqual([snapshot]);
    expect(packed.urp[8]).toBe(0);
    expect(packed.urp[9]).toBe(1);
    expect(packed.hdrp[8]).toBe(0);
    expect(packed.hdrp[9]).toBe(1);
  });

  it('keeps extract and shader owners single-source', async () => {
    const extract = await readFile(new URL('../render-system-extract.ts', import.meta.url), 'utf8');
    const hdrp = await readFile(new URL('../hdrp-pipeline.ts', import.meta.url), 'utf8');
    const shader = await readFile(
      new URL('../../../shader/src/hdrp-cluster-forward.wgsl', import.meta.url),
      'utf8',
    );

    expect(extract.match(/const spotLightQuery =/g)).toHaveLength(1);
    expect(extract).toContain('direction: dirN');
    expect(hdrp).toContain('shared LightSlot packer');
    expect(shader).not.toContain('normalize(light.direction.xyz)');
  });
});
