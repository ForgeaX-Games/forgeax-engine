import { HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { MeshFilter } from '@forgeax/engine-render';
import type { Handle } from '@forgeax/engine-types';

export interface MeshHandleSwap {
  readonly entity: EntityHandle;
  readonly original: Handle<'MeshAsset', 'shared'>;
  readonly alternate: Handle<'MeshAsset', 'shared'>;
  active: 'original' | 'alternate';
  swaps: number;
}

export function createMeshHandleSwap(world: World, entity: EntityHandle | undefined): MeshHandleSwap | undefined {
  if (entity === undefined) return undefined;
  const mesh = world.get(entity, MeshFilter);
  if (!mesh.ok || mesh.value.assetHandle === HANDLE_SPHERE) return undefined;
  return {
    entity,
    original: mesh.value.assetHandle,
    alternate: HANDLE_SPHERE,
    active: 'original',
    swaps: 0,
  };
}

export function toggleMeshHandleSwap(world: World, state: MeshHandleSwap): void {
  state.active = state.active === 'original' ? 'alternate' : 'original';
  state.swaps += 1;
  world.set(state.entity, MeshFilter, {
    assetHandle: state.active === 'original' ? state.original : state.alternate,
  });
}

export function resetMeshHandleSwap(world: World, state: MeshHandleSwap | undefined): void {
  if (state === undefined || state.active === 'original') return;
  state.active = 'original';
  world.set(state.entity, MeshFilter, { assetHandle: state.original });
}
