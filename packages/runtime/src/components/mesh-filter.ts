// @forgeax/engine-runtime - MeshFilter (mesh asset reference).
//
// Schema: `{ assetHandle: 'shared<MeshAsset>' }`. The schema-vocab
// `'shared<T>'` keyword stores a u32 column and type-derives to
// `Handle<'MeshAsset', 'shared'>` (engine-ecs Handle<T,M> twoParam
// phantom; `'shared'` mode = ref-counted retain on set / release on
// clear, lifecycle owned by `SharedRefStore` per feat-20260614).
// The brand prevents cross-asset assignment at compile time (e.g.
// `Handle<'TextureAsset','shared'>` is not assignable to `assetHandle`).
//
// AI users spawn with the engine-runtime constants `HANDLE_CUBE` /
// `HANDLE_TRIANGLE` (now branded `Handle<'MeshAsset','shared'>` to
// match the schema-derived shape); custom mesh registration is owned by
// feat-future-asset-system (this MVP only exposes builtin handles).
//
// Naming flavor: unity-style "MeshFilter / MeshRenderer" pair, but the forgeax
// pair does NOT mirror Unity's filter-toggle semantics - MeshFilter only
// carries the geometry ref, MeshRenderer only carries the material handle;
// the pair is independently composable. D-Q7 default-material policy
// (feat-20260517-merge-mesh-renderer-material-renderer plan-strategy §2.2):
// case A (entity carries MeshFilter without MeshRenderer) -> archetype
// query never matches -> entity is silently absent from the
// RenderableSnapshot[] (NO default-material fallback, NO onError fire);
// case B (MeshRenderer.material omitted at spawn) -> mid-grey
// defaultMaterialSnapshot fallback (no onError); case C (material handle
// unresolved) -> RhiError 'asset-not-registered' (mirrors the
// MeshFilter.assetHandle dangling-ref path).
//
// charter mapping: proposition 1 (single import) + proposition 4 (explicit
// failure: missing or unregistered handle fires onError 'asset-not-registered'
// with .detail = { assetHandle } + cross-asset brand mismatch is a TS
// compile-time error) + proposition 5 (consistent abstraction: the schema
// vocab `'shared<T>'` is the SSOT for AssetRegistry-owned handles across
// the engine).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Mesh filter (geometry asset reference).
 *
 * `assetHandle` carries a `Handle<'MeshAsset', 'shared'>` (u32-stored)
 * pointing into `engine.assets: AssetRegistry`. Use the predefined
 * constants `HANDLE_CUBE` / `HANDLE_TRIANGLE` exported from
 * `@forgeax/engine-runtime`; custom-mesh registration is OOS in MVP (see
 * feat-future-asset-system).
 *
 * Error path: if the handle is not registered at draw time, RenderSystem
 * fires `Renderer.onError` with
 * `RhiError({ code: 'asset-not-registered', detail: { assetHandle } })`
 * and skips this entity (other entities continue rendering; charter
 * proposition 9 graceful degradation).
 *
 * @example Spawn an entity referencing the builtin cube mesh:
 *   import { HANDLE_CUBE, MeshFilter } from '@forgeax/engine-runtime';
 *   world.spawn({ component: MeshFilter, data: { assetHandle: HANDLE_CUBE } });
 */
export const MeshFilter = defineComponent('MeshFilter', {
  assetHandle: { type: 'shared<MeshAsset>' },
});
