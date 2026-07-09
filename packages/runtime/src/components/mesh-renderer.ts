// @forgeax/engine-runtime - MeshRenderer (multi-material array slot).
//
// feat-20260608-mesh-multi-section-primitive-multi-material-slot M2 / w7:
// the single `material` field is replaced with `materials` — an
// `array<shared<MaterialAsset>>` indexed by submesh. Each submesh gets one
// material slot; `materials.length` must equal `MeshAsset.submeshes.length`.
// The previous single-material path is unified into the array: AI users
// always write `materials: [handle]`, even for single-prim meshes.
//
// The schema-vocab keyword `'array<shared<MaterialAsset>>'` (feat-20260614
// M5 -- migrated from `'array<handle<MaterialAsset>>'`) stores as a u32
// column slot array; the brand prevents cross-asset assignment at compile
// time. The `'shared<T>'` arm routes element retain/release through
// SharedRefStore (M4 / w13) on overwrite / archetype migration.
//
// charter mapping: proposition 1 (single import — `MeshRenderer` is the
// only material-binding component AI users see); proposition 3
// (machine-readable schema > prose); proposition 4 (explicit failure: the
// TS brand on `Handle<'MaterialAsset','shared'>` rejects cross-variant
// assignment at compile time); proposition 5 (consistent abstraction:
// shading model classification (`'unlit'` / `'standard'`) lives ONLY on
// the asset discriminant, NOT on the component name).
//
// RenderSystem consumption: `render-system-extract.ts` runs ONE archetype
// query (`world.query(MeshRenderer)`) and routes per entity by
// `mat.materialShaderId` (shader identity) to the unlit.wgsl or pbr.wgsl
// pipeline tag.

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Mesh renderer (ECS component, multi-material array).
 *
 * Stores `materials: readonly Handle<'MaterialAsset','shared'>[]`
 * (u32-stored array, indexed by submesh). The asset's `passes[].shader`
 * identity is the SSOT for which pipeline RenderSystem routes the entity
 * to (record stage dispatches on `materialShaderId`).
 *
 * Defaults map carries `materials: []` — this routes through the D-Q7
 * case B path (extract reads empty materials array -> defaultMaterialSnapshot
 * fallback, mid-grey unlit material).
 *
 * @example Spawn with data: {} (D-Q7 case B; mid-grey default):
 *   world.spawn({ component: MeshRenderer, data: {} });
 *
 * @example Spawn an unlit-targeted entity:
 *   import { MeshRenderer, Materials } from '@forgeax/engine-runtime';
 *   const matPayload = engine.assets.catalog(matGuid, Materials.unlit([1, 0, 0, 1])).value;
 *   const matHandle = world.allocSharedRef('MaterialAsset', matPayload);
 *   world.spawn({ component: MeshRenderer, data: { materials: [matHandle] } });
 *
 * @example Spawn a standard (PBR) entity:
 *   const matPayload = engine.assets.catalog(matGuid, Materials.standard({
 *     baseColor: [0.5, 0.5, 0.5, 1], metallic: 0, roughness: 0.4,
 *   })).value;
 *   const matHandle = world.allocSharedRef('MaterialAsset', matPayload);
 *   world.spawn({ component: MeshRenderer, data: { materials: [matHandle] } });
 */
export const MeshRenderer = defineComponent('MeshRenderer', {
  materials: { type: 'array<shared<MaterialAsset>>', default: [] },
});
