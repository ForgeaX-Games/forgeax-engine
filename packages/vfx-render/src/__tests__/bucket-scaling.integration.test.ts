import { World } from '@forgeax/engine-ecs';
import { toShared } from '@forgeax/engine-types';
import { createParticleRenderBatch, type ParticleOutputBatch } from '@forgeax/engine-vfx';
import {
  collectParticleRenderBuckets,
  particleRenderBucketKey,
  particleRenderBucketKeysEqual,
} from '@forgeax/engine-vfx-render';
import { describe, expect, it } from 'vitest';

function batches(outputs: readonly ParticleOutputBatch[]): readonly ParticleOutputBatch[] {
  const result = createParticleRenderBatch(outputs);
  if (!result.ok) throw new Error(result.error.code);
  return result.value.batches;
}

function billboard(material: number, count: number): ParticleOutputBatch {
  return {
    kind: 'billboard',
    material: toShared<'MaterialAsset'>(material),
    count,
    attributes: {
      position: new Float32Array(count * 3),
      size: new Float32Array(count * 2),
      color: new Float32Array(count * 4),
    },
  };
}

function mesh(material: number, meshHandle: number, count: number): ParticleOutputBatch {
  return {
    kind: 'mesh',
    material: toShared<'MaterialAsset'>(material),
    mesh: toShared<'MeshAsset'>(meshHandle),
    count,
    attributes: {
      transform: new Float32Array(count * 16),
      color: new Float32Array(count * 4),
    },
  };
}

describe('particle render bucket scaling', () => {
  it('groups same-World compatible outputs and scales by bucket, not particle count', () => {
    const world = new World();
    const first = billboard(7, 2);
    const second = billboard(7, 3);
    const empty = billboard(7, 0);
    const buckets = collectParticleRenderBuckets(world, batches([first, second, empty]));

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.count).toBe(5);
  });

  it('keeps material and mesh identity in the bucket key', () => {
    const world = new World();
    const outputs = batches([mesh(3, 11, 1), mesh(3, 12, 1), mesh(4, 11, 1)]);
    const buckets = collectParticleRenderBuckets(world, outputs);

    expect(buckets).toHaveLength(3);
  });

  it('never treats equal handles from different Worlds as one bucket', () => {
    const firstWorld = new World();
    const secondWorld = new World();
    const output = billboard(9, 1);
    const firstKey = particleRenderBucketKey(firstWorld, output);
    const secondKey = particleRenderBucketKey(secondWorld, output);

    expect(particleRenderBucketKeysEqual(firstKey, secondKey)).toBe(false);
  });
});
