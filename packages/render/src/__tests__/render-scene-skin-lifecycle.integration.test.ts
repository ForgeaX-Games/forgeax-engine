import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createRenderReadLease, type RenderReadLease } from '@forgeax/engine-ecs/projection';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import type { Handle, SkeletonAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createSkinPaletteOwner } from '../assembly/skin-palette-owner';
import { MeshFilter, MeshRenderer } from '../components';
import type { ExtractedFrame } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../scene/render-scene';

type SkinWorld = {
  readonly world: World;
  readonly joint: EntityHandle;
  readonly renderable: EntityHandle;
};

function makeSkeleton(world: World): Handle<'SkeletonAsset', 'shared'> {
  const inverseBindMatrices = new Float32Array(16);
  inverseBindMatrices[0] = 1;
  inverseBindMatrices[5] = 1;
  inverseBindMatrices[10] = 1;
  inverseBindMatrices[15] = 1;
  return world.allocSharedRef<'SkeletonAsset', SkeletonAsset>('SkeletonAsset', {
    kind: 'skeleton',
    inverseBindMatrices,
    jointCount: 1,
  });
}

function makeSkinWorld(): SkinWorld {
  const world = new World();
  registerPropagateTransforms(world);
  const skeleton = makeSkeleton(world);
  const joint = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
  const renderable = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: Skin, data: { skeleton, joints: new Uint32Array([joint as number]) } },
    )
    .unwrap() as EntityHandle;
  world.update(0).unwrap();
  return { world, joint, renderable };
}

function skinFor(frame: ExtractedFrame, worldId: number, entity: EntityHandle) {
  return frame.renderables.find(
    (snapshot) => snapshot.worldId === worldId && snapshot.entityKey === entity,
  )?.skin;
}

describe('PersistentRenderScene skin palette lifecycle', () => {
  it('preserves untouched partial palettes, none scope, reorder identity, and retires removed Skin', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, true);
    const assets = new AssetRegistry({} as unknown as ShaderRegistry);
    const first = makeSkinWorld();
    const second = makeSkinWorld();
    let worlds: readonly World[] = [first.world, second.world];
    let leases: readonly RenderReadLease[] = worlds.map((world) => createRenderReadLease(world));
    const owner = { cameraOwner: 0, resourceOwner: 0 } as const;
    const scene = new PersistentRenderScene();
    const requests: PersistentRenderCandidateRequest[] = [];
    const build = (request: PersistentRenderCandidateRequest): ExtractedFrame => {
      requests.push(request);
      return extractFrames(
        worlds,
        owner,
        assets,
        { skinPaletteAllocator: allocator },
        scene.materialSnapshotCacheStore(),
        { cull: 'none', retainHidden: true, renderables: request },
      );
    };
    const draw = (): ExtractedFrame => scene.extractComposition(worlds, owner, 0, build, leases);

    try {
      const initial = draw();
      const firstInitial = skinFor(initial, 0, first.renderable);
      const secondInitial = skinFor(initial, 1, second.renderable);
      expect(firstInitial).toBeDefined();
      expect(secondInitial).toBeDefined();
      expect(firstInitial?.identity).not.toBe(secondInitial?.identity);
      const firstBuffer = firstInitial?.buffer;
      const firstOffset = firstInitial?.byteOffset;
      const secondBuffer = secondInitial?.buffer;
      const secondOffset = secondInitial?.byteOffset;
      expect(firstBuffer).toBeDefined();
      expect(secondBuffer).toBeDefined();
      expect(firstOffset).toBe(0);
      expect(secondOffset).toBe(256);

      requests.length = 0;
      first.world.set(first.joint, Transform, { pos: [1, 0, 0] }).unwrap();
      first.world.update(0).unwrap();
      const firstPartial = draw();
      const firstPartialRequest = requests.find(
        (request): request is Extract<PersistentRenderCandidateRequest, { kind: 'partial' }> =>
          typeof request === 'object',
      );
      expect(firstPartialRequest).toBeDefined();
      expect(firstPartialRequest?.entitiesByWorld[0]?.has(first.renderable as number)).toBe(true);
      expect(
        firstPartialRequest?.entitiesByWorld[1]?.has(second.renderable as number) ?? false,
      ).toBe(false);
      expect(skinFor(firstPartial, 1, second.renderable)?.buffer).toBe(secondBuffer);
      expect(skinFor(firstPartial, 1, second.renderable)?.byteOffset).toBe(secondOffset);

      // Resource-only publication must not reconcile the identity set or
      // release either persistent palette.
      const none = extractFrames(
        worlds,
        owner,
        assets,
        { skinPaletteAllocator: allocator },
        scene.materialSnapshotCacheStore(),
        { cull: 'none', retainHidden: true, renderables: 'none' },
      );
      expect(none.renderables).toHaveLength(0);

      // Visit the previously untouched entity after the partial and none
      // scopes. Reusing its exact receipt proves its allocation survived both.
      second.world.set(second.joint, Transform, { pos: [2, 0, 0] }).unwrap();
      second.world.update(0).unwrap();
      const secondPartial = draw();
      expect(skinFor(secondPartial, 0, first.renderable)?.buffer).toBe(firstBuffer);
      expect(skinFor(secondPartial, 0, first.renderable)?.byteOffset).toBe(firstOffset);
      expect(skinFor(secondPartial, 1, second.renderable)?.buffer).toBe(secondBuffer);
      expect(skinFor(secondPartial, 1, second.renderable)?.byteOffset).toBe(secondOffset);

      // A full rebuild after worlds[] reorder must retain each World's palette
      // identity. Entity keys intentionally start at the same value in both
      // independent Worlds, so an index-derived key would alias or move them.
      worlds = [second.world, first.world];
      leases = [leases[1] as RenderReadLease, leases[0] as RenderReadLease];
      const reordered = draw();
      expect(skinFor(reordered, 0, second.renderable)?.buffer).toBe(secondBuffer);
      expect(skinFor(reordered, 0, second.renderable)?.byteOffset).toBe(secondOffset);
      expect(skinFor(reordered, 1, first.renderable)?.buffer).toBe(firstBuffer);
      expect(skinFor(reordered, 1, first.renderable)?.byteOffset).toBe(firstOffset);

      // Removing Skin leaves the renderable slot alive, but the producer must
      // retire its palette during the selected partial extraction.
      first.world.removeComponent(first.renderable, Skin).unwrap();
      first.world.update(0).unwrap();
      const afterSkinRemoval = draw();
      expect(skinFor(afterSkinRemoval, 1, first.renderable)).toBeUndefined();
      expect(skinFor(afterSkinRemoval, 0, second.renderable)?.buffer).toBe(secondBuffer);
      expect(skinFor(afterSkinRemoval, 0, second.renderable)?.byteOffset).toBe(secondOffset);

      await device.queue.onSubmittedWorkDone();
      const replacement = allocator.allocatePersistentSlice({
        identity: 'test-replacement',
        generation: 1,
        jointCount: 1,
      });
      expect(replacement.byteOffset).toBe(firstOffset);
    } finally {
      for (const lease of leases) lease.dispose();
      scene.dispose();
      allocator.dispose();
    }
  });
});
