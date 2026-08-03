import type { AssetGuid, MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createMaterialCookFinalizer,
  materialCookPublication,
} from '../material/cook-finalizer.js';

describe('material cook parity', () => {
  it('keeps cold and warm catalog records, keys, and artifact bytes identical', async () => {
    let compileCount = 0;
    const finalizer = createMaterialCookFinalizer({
      compile: async () => {
        compileCount += 1;
        return new TextEncoder().encode(
          '@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }',
        );
      },
    });
    const request = {
      guid: 'mat-child',
      sourceClosure: ['materials/parent.material.json', 'materials/child.material.json'],
      profile: 'webgpu/v1',
      compilerVersion: 'compiler/1',
      material: {
        kind: 'material' as const,
        parent: 'mat-parent' as unknown as AssetGuid,
        passes: [{ name: 'forward', program: { module: 'core/pbr' } }],
        values: { roughness: 0.5 },
      } as MaterialAsset,
    };

    const cold = await finalizer.cook(request);
    const warm = await finalizer.cook(request);

    const coldPublication = materialCookPublication(cold);
    const warmPublication = materialCookPublication(warm);
    expect(coldPublication?.key).toBe(warmPublication?.key);
    expect(coldPublication?.record).toEqual(warmPublication?.record);
    expect(coldPublication?.artifactBytes).toEqual(warmPublication?.artifactBytes);
    expect(coldPublication?.catalog).toEqual(warmPublication?.catalog);
    expect(warmPublication?.cache).toBe('hit');
    expect(compileCount).toBe(1);
  });
});
