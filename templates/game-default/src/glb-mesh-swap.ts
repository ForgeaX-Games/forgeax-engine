import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import type { Handle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';

/** Khronos BoxTextured.glb mesh and material sub-assets. */
export const GAME_DEFAULT_GLB_MESH_GUID = '019ea7c7-4eb7-7b5c-8195-c14c7a0e258c';
export const GAME_DEFAULT_GLB_MATERIAL_GUID = '019ea7c7-4eb7-7b5c-8195-c14d326307ba';

export type GlbMeshSwap = {
  readonly entity: EntityHandle;
  readonly original: Handle<'MeshAsset', 'shared'>;
  readonly originalMaterials: readonly Handle<'MaterialAsset', 'shared'>[];
  readonly glb: Handle<'MeshAsset', 'shared'>;
  readonly glbMaterial: Handle<'MaterialAsset', 'shared'>;
  active: 'original' | 'glb';
  swaps: number;
};

/** Load one GLB mesh/material pair; the existing target remains the owner. */
export async function createGlbMeshSwap(
  world: World,
  assets: AssetRegistry | undefined,
  entity: EntityHandle | undefined,
): Promise<GlbMeshSwap | undefined> {
  if (assets === undefined || entity === undefined) return undefined;
  const original = world.get(entity, MeshFilter);
  const originalRenderer = world.get(entity, MeshRenderer);
  if (!original.ok || !originalRenderer.ok || originalRenderer.value.materials.length === 0) return undefined;
  const meshGuid = AssetGuid.parse(GAME_DEFAULT_GLB_MESH_GUID);
  const materialGuid = AssetGuid.parse(GAME_DEFAULT_GLB_MATERIAL_GUID);
  if (!meshGuid.ok || !materialGuid.ok) {
    console.warn('[game] GLB asset GUID invalid');
    return undefined;
  }
  const [meshResult, materialResult] = await Promise.all([
    assets.loadByGuid<MeshAsset>(meshGuid.value),
    assets.loadByGuid<MaterialAsset>(materialGuid.value),
  ]);
  if (!meshResult.ok) {
    console.warn(`[game] GLB mesh unavailable: ${meshResult.error.code} — ${meshResult.error.hint}`);
    return undefined;
  }
  if (!materialResult.ok) {
    console.warn(`[game] GLB material unavailable: ${materialResult.error.code} — ${materialResult.error.hint}`);
    return undefined;
  }
  return {
    entity,
    original: original.value.assetHandle,
    originalMaterials: [...originalRenderer.value.materials],
    glb: world.allocSharedRef('MeshAsset', meshResult.value),
    glbMaterial: world.allocSharedRef('MaterialAsset', materialResult.value),
    active: 'original',
    swaps: 0,
  };
}

export function toggleGlbMeshSwap(world: World, state: GlbMeshSwap): void {
  state.active = state.active === 'original' ? 'glb' : 'original';
  state.swaps += 1;
  world.set(state.entity, MeshFilter, { assetHandle: state.active === 'glb' ? state.glb : state.original });
  world.set(state.entity, MeshRenderer, {
    materials: state.active === 'glb' ? [state.glbMaterial] : [...state.originalMaterials],
  });
}

export function resetGlbMeshSwap(world: World, state: GlbMeshSwap | undefined): void {
  if (state === undefined || state.active === 'original') return;
  state.active = 'original';
  world.set(state.entity, MeshFilter, { assetHandle: state.original });
  world.set(state.entity, MeshRenderer, { materials: [...state.originalMaterials] });
}
