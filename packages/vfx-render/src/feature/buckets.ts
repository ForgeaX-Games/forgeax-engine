import type { World } from '@forgeax/engine-ecs';
import type { Handle } from '@forgeax/engine-types';
import type { ParticleOutputBatch } from '@forgeax/engine-vfx';

export interface ParticleRenderBucketKey {
  readonly world: World;
  readonly kind: ParticleOutputBatch['kind'];
  readonly material: Handle<'MaterialAsset', 'shared'>;
  readonly mesh: Handle<'MeshAsset', 'shared'> | undefined;
}

export interface ParticleRenderBucket {
  readonly key: ParticleRenderBucketKey;
  readonly count: number;
  readonly batches: readonly ParticleOutputBatch[];
}

export function particleRenderBucketKey(
  world: World,
  batch: ParticleOutputBatch,
): ParticleRenderBucketKey {
  return {
    world,
    kind: batch.kind,
    material: batch.material,
    mesh: batch.kind === 'mesh' ? batch.mesh : undefined,
  };
}

export function particleRenderBucketKeysEqual(
  left: ParticleRenderBucketKey,
  right: ParticleRenderBucketKey,
): boolean {
  return (
    left.world === right.world &&
    left.kind === right.kind &&
    left.material === right.material &&
    left.mesh === right.mesh
  );
}

export function collectParticleRenderBuckets(
  world: World,
  batches: readonly ParticleOutputBatch[],
): readonly ParticleRenderBucket[] {
  const buckets: Array<{
    key: ParticleRenderBucketKey;
    count: number;
    batches: ParticleOutputBatch[];
  }> = [];

  for (const batch of batches) {
    if (batch.count === 0) continue;
    const key = particleRenderBucketKey(world, batch);
    const bucket = buckets.find((candidate) => particleRenderBucketKeysEqual(candidate.key, key));
    if (bucket) {
      bucket.count += batch.count;
      bucket.batches.push(batch);
      continue;
    }
    buckets.push({ key, count: batch.count, batches: [batch] });
  }

  return buckets.map((bucket) => ({
    key: bucket.key,
    count: bucket.count,
    batches: bucket.batches,
  }));
}
