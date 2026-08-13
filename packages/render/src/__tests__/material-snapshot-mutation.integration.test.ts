import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  extractFrames,
  type MaterialSnapshotCachesByWorld,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render/internal';
import { Transform } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

describe('material snapshot mutation', () => {
  it('projects in-place material value updates into the next extracted frame', () => {
    const world = new World();
    const assets = new AssetRegistry({
      findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
    } as unknown as ShaderRegistry);
    const values: Record<string, unknown> = {
      baseColor: [1, 0, 0, 1],
      metallic: 0,
      roughness: 0.5,
    };
    const material: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: values as NonNullable<MaterialAsset['values']>,
    };
    const materialHandle = world.allocSharedRef('MaterialAsset', material);

    world.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    );
    const materialCaches: MaterialSnapshotCachesByWorld = new WeakMap();

    const first = extractFrames([world], 0, assets, undefined, undefined, materialCaches)
      .renderables[0]?.material;
    expect(first?.baseColor).toEqual(new Float32Array([1, 0, 0]));

    values.baseColor = [0, 1, 0, 1];

    const second = extractFrames([world], 0, assets, undefined, undefined, materialCaches)
      .renderables[0]?.material;
    expect(second?.baseColor).toEqual(new Float32Array([0, 1, 0]));
    expect(second).not.toBe(first);
  });
});
