// @forgeax/engine-runtime — public API surface (M3).
//
// Surface (K-4):
//   - createRenderer(canvas, options?) — async factory; uses WebGPU
//     exclusively; throws EngineEnvironmentError when no adapter is usable.
//   - Renderer / RendererOptions / RendererBackend / RendererLostInfo /
//     RendererLostListener — types for callers.
//   - EngineEnvironmentError — thrown when no backend is usable.
//
// What is **NOT** here, by design (acceptance grep checks negative existence):
//   - any internal backend module — locked by `package.json#exports`
//     entry `"./internal/*": null`.

import { createRenderer as _createRendererForEngineAlias } from './createRenderer';

/**
 * `acquireCanvasContext` facade re-export (M3 D-P3 / w15).
 *
 * Single-entry SSOT for vite apps: instead of importing rhi-webgpu directly,
 * AI users wire canvas through engine-runtime's public surface (charter
 * proposition 5 consistent abstraction — apps see one entry; pipeline
 * isolation — apps depend on engine-runtime, not on the rhi backend choice).
 *
 * @example
 *   import { acquireCanvasContext } from '@forgeax/engine-runtime';
 *   const ctxResult = acquireCanvasContext(canvas);
 */
export { acquireCanvasContext } from '@forgeax/engine-rhi-webgpu';
export type { BundlerOptions } from './createRenderer';
export { createRenderer } from './createRenderer';
export type {
  EquirectProjectionFailedDetail,
  MaterialResolvedEmptyPassesDetail,
  MaterialSkinAttrMissingDetail,
  // feat-20260621-renderer-health-recover-skeleton verify minor-edit:
  // closed RecoverErrorCode union re-exported so AI users `switch (err.code)`
  // exhaustively on the recover() failure result (peer to RuntimeErrorCode).
  RecoverErrorCode,
  RuntimeError,
  RuntimeErrorCode,
  ShadowInvalidConfigDetail,
  SkinMaterialMismatchDetail,
} from './errors';
export {
  EngineEnvironmentError,
  EquirectProjectionFailedError,
  // feat-20260612-skin-palette-per-frame-upload M2 / m2-5: SkinExtractErrorCode
  // subset union (3 new extract-stage classes) + M2 fixup post-spawn fail-fast.
  // Re-exported so AI users can `instanceof JointCountMismatchError` etc. per
  // the convention established by SkinMaterialMismatchError / MaterialSkinAttrMissingError.
  JointCountMismatchError,
  JointEntityDanglingError,
  MaterialResolvedEmptyPassesError,
  MaterialSkinAttrMissingError,
  PointShadowAtlasBoundsViolationError,
  PointShadowAtlasUninitializedError,
  // feat-20260621-renderer-health-recover-skeleton verify minor-edit:
  // RecoverError class re-exported so AI users `instanceof RecoverError` the
  // recover() failure (peer convention to SkinMaterialMismatchError etc.).
  RecoverError,
  ShadowInvalidConfigError,
  SkeletonResolveFailedError,
  SkinMaterialMismatchError,
  SkinPaletteOverflowError,
  // feat-20260623-world-space-video-asset M3 / w11: AC-10 capability
  // double-miss error class (instanceof + .code/.hint property access).
  VideoUploadUnsupportedError,
} from './errors';

/**
 * `Engine` namespace alias for `createRenderer` (w55 round 2 fix-up F-3
 * closure). Plan-strategy §7.1 / §7.2 / §7.4 + requirements.md §AI User
 * Affordances reference the factory in `Engine.create({ canvas })` form;
 * the concrete code-level entry is `createRenderer(canvas, options?)`. To
 * keep both call sites valid without forcing a doc-wide rewrite (the
 * plan/requirements text is appended-only audit history per architecture
 * principle 7), the namespace alias re-exports `createRenderer` under the
 * `Engine.create` shape — AI users can write either form and TypeScript
 * resolution lands on the same factory.
 *
 * Single SSOT: the runtime behaviour, signatures, and JSDoc all live on
 * `createRenderer`; `Engine.create` is a thin re-export (charter
 * proposition 1 progressive disclosure — both names are grep-able + lead
 * to the same body; proposition 5 consistent abstraction — the alias does
 * not introduce a second factory shape).
 *
 * Usage parity:
 *
 *   import { createRenderer } from '@forgeax/engine-runtime';
 *   const renderer = await createRenderer(canvas, { ... }, bundler?);
 *
 *   // identical:
 *   import { Engine } from '@forgeax/engine-runtime';
 *   const renderer = await Engine.create(canvas, { ... }, bundler?);
 *
 * feat-20260608-create-app-param-surface-trim / M2 / R-8: Engine.create
 * is a thin re-export of createRenderer; the third BundlerOptions arg
 * forwards verbatim through the alias (no separate Engine.create
 * implementation -- `create: createRenderer` shape).
 */
export const Engine = {
  create: _createRendererForEngineAlias,
} as const;

export type {
  // feat-20260621-renderer-health-recover-skeleton verify minor-edit:
  // health channel types re-exported for parity with the onLost / onError
  // channels (RendererLostInfo / RendererLostListener / RhiErrorDetail
  // variants below). `switch (snap.reason)` narrows `snap.detail` to the
  // matching HealthDetail* interface; AI users import these to annotate the
  // callback + name extracted detail variants. The HealthListenerRegistry
  // mechanism stays internal (peer LostListenerRegistry is also unexported).
  HealthChangeListener,
  HealthDetailDeviceLost,
  HealthDetailInternalFault,
  HealthReason,
  HealthSnapshot,
  Renderer,
  RendererBackend,
  RendererLostInfo,
  RendererLostListener,
  RendererOptions,
} from './renderer';

// ─── ECS render bridge (feat-20260509-ecs-render-bridge-mvp) ────────────────
//
// Single-import surface for the 5-component schema set + builtin asset handles
// (charter proposition 1 progressive disclosure + plan-strategy 7.4
// discoverability "AI users see 8 core symbols in one read").

/**
 * RHI error-model surface (feat-20260511-tetris-retro-followups verify minor-edit).
 *
 * Re-export the closed `RhiError` / `RhiErrorCode` union + detail interfaces so
 * AI users wiring a `'limit-exceeded'` / `'asset-not-registered'` /
 * `'webgpu-runtime-error'` listener only import from `@forgeax/engine-runtime`
 * (charter proposition 1 progressive disclosure + proposition 5 consistent
 * abstraction; plan-strategy §7.1 decision 1 single-entry SSOT — IDE
 * autocomplete on `@forgeax/engine-runtime` already covers the full
 * observable surface, including the failure path). The error-model SSOT
 * still lives in `packages/rhi/src/errors.ts` — this is a thin re-export, no
 * new types or renames.
 *
 * `LimitExceededDetail` carries `{ maxStorageBufferBindingSize,
 * requestedBytes }` (feat-20260513-instanced-mesh M5 D-3 evolution
 * major reshape from the legacy `{ renderableCount, limit }` shape).
 * Read both fields directly through typed property access after the
 * `code === 'limit-exceeded'` discriminant narrows `err.detail`.
 *
 * The `Renderer.onError` channel fans out **both** error families —
 * `RhiError` (RHI layer) and `RuntimeError` (runtime layer, e.g.
 * `'equirect-projection-failed'`) — so the listener parameter is the
 * `RhiError | RuntimeError` union (feat-20260531-skybox-env-background:
 * widened from `RhiError` only, dropping the prior `as any` fan-out cast).
 * The disjoint `RhiErrorCode` / `RuntimeErrorCode` literal sets let
 * `switch (e.code)` narrow each arm to the concrete class without a default.
 *
 * @example
 *   import {
 *     RhiError, type RhiErrorCode, type LimitExceededDetail,
 *     type RuntimeError, type EquirectProjectionFailedDetail,
 *   } from '@forgeax/engine-runtime';
 *   renderer.onError((e: RhiError | RuntimeError) => {
 *     switch (e.code) {
 *       case 'limit-exceeded': {
 *         const detail = e.detail as LimitExceededDetail;
 *         // detail.maxStorageBufferBindingSize vs detail.requestedBytes
 *         break;
 *       }
 *       case 'equirect-projection-failed': {
 *         // RuntimeError arm — e narrows to EquirectProjectionFailedError
 *         const detail: EquirectProjectionFailedDetail = e.detail;
 *         // detail.handle — the equirect handle whose projection failed
 *         break;
 *       }
 *     }
 *   });
 */
export {
  type LimitExceededDetail,
  type RhiAssetNotRegisteredDetail,
  RhiError,
  type RhiErrorCode,
  type RhiErrorDetail,
  type RhiShaderCompileDetail,
  type RhiWebgpuRuntimeDetail,
} from '@forgeax/engine-rhi';
/**
 * Asset system SSOT re-exports (feat-20260511-asset-system-v1 / w30 / D-P7 +
 * plan-strategy §7.4 discoverability dual-entry).
 *
 * The error-model SSOT lives in `@forgeax/engine-types` (closed `AssetErrorCode`
 * 4-member union + `AssetError` class + `ASSET_ERROR_HINTS` per-code hint table);
 * this barrel is a thin re-export so AI users can write a single-line import —
 *
 *   import { Handle, Asset, AssetError } from '@forgeax/engine-runtime';
 *
 * — and let IDE autocomplete on `@forgeax/engine-runtime` cover the full asset
 * surface (charter proposition 1 progressive disclosure). `@forgeax/engine-types`
 * remains a valid import entry for AI users that want the bare SSOT layer.
 */
export {
  AssetError,
  type AssetErrorCode,
  type Handle,
  MATERIAL_PARAM_TYPES,
  type MaterialAsset,
  type MaterialPassDescriptor,
  type ParamSchemaEntry,
  type RenderQueue,
  type SamplerAsset,
  type TextureAsset,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
export type { Asset, MeshAsset } from './asset-registry';
/**
 * AssetRegistry (D-S9) + builtin mesh handles. Pair with `MeshFilter` to
 * spawn cube / triangle / quad entities without writing geometry by hand.
 *
 * `HANDLE_QUAD` (feat-20260520-2d-sprite-layer-mvp M-1 w06) joins the
 * builtin trio as the base mesh for sprite + tilemap; same 12-floats
 * vertex layout as the cube / triangle so the sprite pipeline (M-3)
 * reuses the existing vertex branch without a new layout discriminator.
 *
 * @example
 *   import { AssetRegistry, HANDLE_CUBE, HANDLE_TRIANGLE, HANDLE_QUAD } from '@forgeax/engine-runtime';
 *
 * @example Spawn the cube entity:
 *   world.spawn({ component: MeshFilter, data: { assetHandle: HANDLE_CUBE } });
 *
 * @example Spawn a sprite quad entity (M-1 surface; full sprite material in M-3):
 *   world.spawn({ component: MeshFilter, data: { assetHandle: HANDLE_QUAD } });
 */
export {
  AssetRegistry,
  HANDLE_CUBE,
  HANDLE_NINESLICE_QUAD,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
} from './asset-registry';
// D-15: builtin payloads + slot boundary are owned by the process-static
// BuiltinAssetRegistry tier (builtin-asset-registry.ts), not the World-bound
// AssetRegistry. BUILTIN_FLOATS_PER_VERTEX is the single vertex-layout SSOT.
export {
  BUILTIN_BASE,
  BUILTIN_CUBE,
  BUILTIN_FLOATS_PER_VERTEX,
  BUILTIN_NINESLICE_QUAD,
  BUILTIN_QUAD,
  BUILTIN_SPHERE,
  BUILTIN_TRIANGLE,
  BuiltinAssetRegistry,
} from './builtin-asset-registry';
/**
 * 5-component schema set (Transform / MeshFilter / MeshRenderer /
 * Camera / DirectionalLight). Each is a frozen `Component<N, S>`
 * token returned by `defineComponent`. Pair with `world.spawn({ component, data })`
 * and the builtin `HANDLE_CUBE` / `HANDLE_TRIANGLE` constants (added in w10).
 *
 * feat-20260517-merge-mesh-renderer-material-renderer M2 / w7: the legacy
 * dual material-binding component (the previously separate component
 * carrying `{ material: 'ref' }`) and its companion data-shape re-export
 * were physically deleted alongside the component file; the merged
 * `MeshRenderer` (`{ materials: 'array<shared<MaterialAsset>>' }` schema) is the
 * single material-binding component AI users see; spawn payloads omit
 * `material` to request the mid-grey default (D-Q7 case B). Migration
 * SSOT lives in AGENTS.md §Breaking changes row dated 2026-05-17.
 *
 * @example
 *   import {
 *     Transform, MeshFilter, MeshRenderer,
 *     Camera, DirectionalLight,
 *   } from '@forgeax/engine-runtime';
 */
export {
  ANTIALIAS_FXAA,
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  AnimationPlayer,
  type Antialias,
  antialiasFromF32,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  type BloomEnabled,
  bloomEnabledFromF32,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  type CameraProjection,
  ChildOf,
  Children,
  cameraProjectionFromF32,
  DirectionalLight,
  decodeSortScope,
  encodeSortScope,
  Instances,
  type InstancesData,
  Layer,
  MeshFilter,
  MeshRenderer,
  markTileLayerDirty,
  Name,
  orthographic,
  PointLight,
  PointLightShadow,
  PostProcessParams,
  perspective,
  SceneInstance,
  type SceneInstanceOverrideRecord,
  type SceneInstanceState,
  SKYBOX_MODE_CUBEMAP,
  Skin,
  SkyboxBackground,
  type SkyboxMode,
  Skylight,
  SortKey,
  type SortScope,
  SPRITE_PLAYBACK_MODE_CLAMP,
  SPRITE_PLAYBACK_MODE_LOOP,
  SpotLight,
  SpriteAnimation,
  type SpritePlaybackMode,
  SpriteRegionOverride,
  skyboxModeFromF32,
  spritePlaybackModeFromU32,
  TileLayer,
  type TileLayerData,
  Tilemap,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_CINEON,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_NONE,
  TONEMAP_REINHARD_EXTENDED,
  type Tonemap,
  Transform,
  tonemapFromF32,
} from './components';
/**
 * GlyphText authoring component for world-space MSDF text
 * (feat-20260531-world-space-msdf-text-rendering M4 / w14). Carries
 * `fontHandle` / `text` / `fontSize` / `colorR/G/B/A`; the
 * `glyphTextLayoutSystem` (this package) bakes a MeshAsset and attaches
 * MeshFilter + MeshRenderer (plan-strategy D-2; GlyphText is pure authoring
 * data, baking is a system responsibility). Co-located with its consuming
 * system in `@forgeax/engine-runtime` so AI users import the component and
 * the system from one package.
 */
export { GlyphText } from './components/glyph-text';
/**
 * feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M1 / w4 —
 * SpriteInstances primitive: 2D peer of `Instances`. Carries per-instance
 * mat4 (stride 16) + per-instance UV region (stride 4). Exported directly
 * from the @forgeax/engine-runtime barrel so AI users discover both
 * primitives side-by-side via IDE autocomplete on `@forgeax/engine-runtime`.
 * Per plan-strategy D-8, the barrel re-export lives here (runtime top-level),
 * not in `@forgeax/engine-ecs` — the ecs package stays unaware of the sprite
 * shading model concept.
 */
export {
  SpriteInstances,
  type SpriteInstancesData,
} from './components/sprite-instances';
// feat-20260604-hdr-equirect-cube-importer-loader M4 / w15: the dev-only
// ImportTransport factory. A host wires it into createRenderer / createApp so
// a DDC miss at runtime triggers an on-demand POST /__import import against the
// vite-plugin-pack dev server. Aligned with the create*/wire* factory family.
export { createDevImportTransport } from './dev-import-transport';
/**
 * feat-20260527-sprite-nineslice M4 / w16 (D-5 + AC-16): per-Renderer
 * EngineMetrics counter. Surfaced through `renderer.metrics`; exported here
 * so AI users can grep `EngineMetrics` and reach the public type for ts
 * generics, and so test utilities can construct a free-standing instance.
 *
 * @example
 *   const renderer = await createRenderer(canvas);
 *   // ...later, after the world has rendered for a few frames...
 *   const counts = renderer.metrics.snapshot();
 *   if (counts['nineslice.scale-too-small'] !== undefined) {
 *     // surface a once-per-session UI hint, run a regression bench, etc.
 *   }
 */
export type { EngineMetrics } from './engine-metrics';
export { createEngineMetrics } from './engine-metrics';
/**
 * Procedural geometry factories (M3 / D-P5 / w8).
 *
 * Six Three.js-r184-aligned factories (`createBoxGeometry` /
 * `createSphereGeometry` / `createPlaneGeometry` / `createCylinderGeometry` /
 * `createConeGeometry` / `createTorusGeometry`), each returning
 * `Result<MeshAsset, AssetError>` with `asset-parse-failed` for degenerate
 * inputs (charter proposition 1 progressive disclosure + proposition 4
 * explicit failure).
 *
 * README §M3 + requirements §AC-06 / §AC-14 / §AC-15 / §AC-16 + plan-strategy
 * §7.4 promise a single-line import from the top-level barrel:
 *
 * @example
 *   import { createBoxGeometry, AssetRegistry } from '@forgeax/engine-runtime';
 *   const meshRes = createBoxGeometry(1, 1, 1, 2, 2, 2);
 *
 * The SSOT lives in `./geometry/*.ts`; this is a thin re-export. A parallel
 * subpath entry `@forgeax/engine-runtime/geometry` is also exposed via
 * `package.json#exports` for AI users that want the namespace form.
 */
export {
  createBoxGeometry,
  createConeGeometry,
  createCylinderGeometry,
  createPlaneGeometry,
  createSphereGeometry,
  createTorusGeometry,
  meshFromInterleaved,
} from './geometry';
export {
  FloatsPerGlyphVertex,
  FONT_CONCURRENCY_LIMIT,
  type GlyphLayoutResult,
  layoutGlyphText,
  resetFontConcurrency,
  trackFontConcurrency,
  VERTEX_OFFSET,
} from './glyph-layout';
export {
  bakeGlyphMesh,
  buildGlyphMeshAsset,
  conservativeCubeAabb,
  type GlyphMeshBakeResult,
} from './glyph-mesh-bake';
/**
 * glyphTextLayoutSystem (feat-20260531-world-space-msdf-text-rendering) -- lays
 * out + bakes every `GlyphText` entity, attaching MeshFilter + MeshRenderer on
 * first observation and re-baking in place on a text / size / color change. The
 * renderer auto-invokes it at the top of `draw(world)`; hosts driving their own
 * loop can call it directly before `renderer.draw(world)`.
 */
export { glyphTextLayoutSystem, resetGlyphBakeCache } from './glyph-text-layout-system';
/**
 * GpuBuffer / GpuTexture runtime wrappers + GpuResource union
 * (feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M2).
 *
 * AI-user-facing handles for explicit GPU lifecycle:
 *   - `new GpuBuffer(device, handle).destroy()`
 *   - `new GpuTexture(device, handle).destroy()`
 *   - `type GpuResource = GpuBuffer | GpuTexture` for "dispose any
 *     GPU resource" call sites (charter §F1 single-entry).
 *
 * Forwarding shape (D-7 SSOT): the wrapper forwards to
 * `device.destroyBuffer / destroyTexture`; the destroyed: boolean
 * bookkeeping lives once on the RHI shim. Second `.destroy()` returns
 * `Result.err({ code: 'destroy-after-destroy' })`.
 */
export type { GpuResource } from './gpu-resource';
export { GpuBuffer, GpuTexture } from './gpu-resource';
/**
 * feat-20260601-gpu-resource-store-extraction M1: the GPU residency store.
 * Reachable as `renderer.store`; exported here so AI users can construct one
 * directly for tests and `grep GpuResourceStore` discovers it.
 */
export { GpuResourceStore } from './gpu-resource-store';
/**
 * Loader-injection surface (feat-20260603-asset-import-loader-injection M1).
 * `LoaderRegistry` is the injectable `asset.kind` -> loader table held by
 * `AssetRegistry`; `wireDefaultLoaders` wires the engine's default loader set
 * onto it in one call (mirrors `@forgeax/engine-remote` `wireDefaultInspectors`).
 *
 * @example
 *   import { LoaderRegistry, wireDefaultLoaders } from '@forgeax/engine-runtime';
 *   const loaders = new LoaderRegistry();
 *   wireDefaultLoaders(loaders);
 */
export { LoaderRegistry } from './loader-registry';
// feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild — pickTile cell-level query
export { type PickTileError, type PickTileHit, pickTile } from './pick-tile';
/**
 * RenderSystem (D-S2 — feat-20260509-ecs-render-bridge-mvp).
 *
 * Engine-internal phase that walks the World query graph (Extract /
 * Prepare / Record three stages). RenderSystem is **not** registered to
 * the ECS schedule (AC-09); `Renderer.draw(world)` invokes it once per
 * frame.
 *
 * AI users see this re-export so the F-1 single-import contract holds:
 *
 * @example
 *   import {
 *     Transform, MeshFilter, MeshRenderer,
 *     Camera, DirectionalLight,
 *     RenderSystem, AssetRegistry, HANDLE_CUBE, HANDLE_TRIANGLE,
 *   } from '@forgeax/engine-runtime';
 */
export type { RenderSystem } from './render-system';
// M7 w56: resolveAssetHandle two-tier slot-range dispatch (D-15).
// Single-entry handle-to-payload resolution; AI users import one helper
// instead of switching between BuiltinAssetRegistry.resolve and assets.get.
export { resolveAssetHandle } from './resolve-asset-handle';
export type { SpriteParamValues } from './sprite-param-values';
/**
 * Transparent-bucket sort configuration (feat-20260520-2d-sprite-layer-mvp
 * M-2 w14). The POD interface + 3 named mode constants + `get/set`
 * helpers form the entire AI-user-visible surface for transparent sort
 * mode selection — see `transparent-sort-config.ts` JSDoc head for the
 * 5-view selection table (horizontal / top-down / Don't-Starve /
 * isometric / JRPG).
 *
 * `setTransparentSortConfig` returns
 * `Result<void, ResourceInvalidValueError>`; AI users self-repair by
 * reading `.code / .expected / .hint / .detail` property access on the
 * err branch (charter P3 structured failure SSOT).
 *
 * @example
 *   import {
 *     TRANSPARENT_SORT_CONFIG_KEY,
 *     TRANSPARENT_SORT_MODE_LAYER_Y,
 *     setTransparentSortConfig,
 *   } from '@forgeax/engine-runtime';
 *   const r = setTransparentSortConfig(world,
 *     { mode: TRANSPARENT_SORT_MODE_LAYER_Y, yzAlpha: 1.0 });
 */
/**
 * Sprite-animation tick system (feat-20260521-sprite-atlas-animation M4 /
 * T-24). Walks every entity carrying `SpriteAnimation`, advances the
 * per-entity dt accumulator clock, and writes the current frame's UV
 * slice into `SpriteRegionOverride`. Returns
 * `Result<void, SpriteAnimationInvalidError>` so AI users self-repair
 * via `.code / .expected / .hint / .detail` property access on the err
 * branch (charter P3 structured failure SSOT).
 *
 * Wire into the `App` schedule between input/time and `RenderSystem.
 * extract`; the M3 sprite-bucket extract branch reads the override
 * column populated by this tick.
 *
 * @example
 *   import { spriteAnimationTickSystem } from '@forgeax/engine-runtime';
 *   const app = createApp({ canvas, schedule: { update: [
 *     spriteAnimationTickSystem,
 *   ] } });
 */
export { spriteAnimationTickSystem } from './systems/sprite-animation-tick';
// feat-20260630-viewport-2x2-run-x-display-redesign M2 / w12 / plan-strategy D-2:
// engine-neutral by-entity-id active camera selection (no editor concept).
export {
  ACTIVE_CAMERA_KEY,
  type ActiveCamera,
  getActiveCamera,
  selectActiveCameraIndex,
  setActiveCamera,
} from './systems/active-camera';
export {
  getTransparentSortConfig,
  setTransparentSortConfig,
  TRANSPARENT_SORT_CONFIG_KEY,
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
  type TransparentSortConfig,
} from './systems/transparent-sort-config';
// feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild — tile-bits SSOT
export { decodeTileBits, encodeTileBits } from './tile-bits';
// feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild — chunk-extract system
export {
  encodeTilemapLayerValue,
  resetTilemapChunkExtractCache,
  resetTilemapDerivedEntityTracker,
  tilemapChunkExtractSystem,
} from './tilemap-chunk-extract-system';
// ─── VideoElementProvider host bridge (M3 / w9) ─────────────────────────
export {
  VIDEO_ELEMENT_PROVIDER_KEY,
  type VideoElementProvider,
} from './video-element-provider';

// ─── VideoPlayer component (M3 / w7) ────────────────────────────────────
export { VideoPlayer } from './video-player';
// ─── video high-perf upload capability probe (M4 / w17) ──────────────────
// The single per-frame video upload + AC-10 failure path lives in the record
// stage (videoTextureView); this module only exports the AC-09 capability probe.
export { probeVideoHighPerfUpload, type VideoCapabilityDevice } from './video-player-system';
export {
  audioLoaderPlaceholder,
  createDefaultLoaderRegistry,
  videoLoader,
  wireDefaultLoaders,
} from './wire-default-loaders';

// ─── Math namespace re-export (M2 / w15) ────────────────────────────────

/**
 * `quat` namespace re-export from `@forgeax/engine-math`.
 *
 * AI users write a single import from engine-runtime to get the full
 * quaternion surface (16+ functions: create / fromEuler / multiply /
 * slerp / eulerY / transformVec3 etc.) without cross-package math
 * topology memory (charter P4 consistent abstraction).
 *
 * engine-math has zero Node-only dependencies per feat-20260524
 * browser-safe-subexports -- this barrel re-export does not trigger
 * the browser-safe gate.
 *
 * @example
 * ```ts
 * import { quat } from '@forgeax/engine-runtime';
 * const yaw = quat.eulerY(Math.PI / 4);
 * ```
 */
export { quat } from '@forgeax/engine-math';

/**
 * `Materials` namespace with static factory functions (unlit / standard).
 *
 * AI users create material asset payloads without writing full POJOs:
 * `Materials.unlit([r,g,b,a])` returns an UnlitMaterialAsset shape;
 * `Materials.standard({ baseColor, metallic?, roughness? })` returns
 * a `MaterialAsset` for `register<MaterialAsset>`.
 *
 * @example
 * ```ts
 * import { Materials } from '@forgeax/engine-runtime';
 * const unlitWhite = Materials.unlit([1, 1, 1, 1]);
 * const standardPbr = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
 * ```
 *
 * `SPRITE_PREMULTIPLIED_ALPHA_BLEND` is a sibling re-export here for
 * sprite materials opting into the transparent compositing route —
 * assign on `MaterialPassDescriptor.renderState.blend`. See
 * `./materials.ts` for the constant's full JSDoc (factor pair, equation,
 * paste-able snippet).
 */
export { Materials, SPRITE_PREMULTIPLIED_ALPHA_BLEND } from './materials';

// w8: Inspector contributor (registerRuntimeInspector + RegisterRuntimeInspectorResult)
// deleted — routing layer (Registry / sandbox) is removed; eval is the sole
// command channel.

// ─── Animation system wiring (M1 / T-19 - feat-20260523-skin-skeleton-animation) ──

export {
  ADVANCE_ANIMATION_PLAYER_SYSTEM,
  AdvanceAnimationPlayer,
  ANIMATION_ASSET_RESOLVER_KEY,
  createAnimationAssetResolver,
  PROPAGATE_TRANSFORMS_SYSTEM,
  PropagateTransforms,
  registerAdvanceAnimationPlayer,
  registerPropagateTransforms,
} from './createRenderer';
// ─── Plugin factories (M2 / w6 - feat-20260623-plugin-system-unify) ─────────
export { animationPlugin, timePlugin, transformPlugin } from './plugin-factories';
// w8: registerRuntimeInspector export deleted alongside register-inspector.ts removal.

// ─── Screen-to-entity picking (feat-20260529-picking-raycasting-screen-to-entity M3 / w14) ──

// feat-20260623-editor-openproject M2 w11+w12: SceneInstance→SceneAsset writeback
// chain (plan-strategy D-1: pure-data collection + pack serialization;
// handle→GUID reverse lookup via caller-supplied Map built from
// AssetRegistry.inspect()).
//
// collectSceneAsset reads live component values from a materialised
// SceneInstance back into a SceneAsset POD. serializeSceneAssetToPack
// serializes the POD into a valid internal-text-package JSON object
// suitable for disk write via forge.json / file system writer.
export { collectSceneAsset, serializeSceneAssetToPack } from './collect-scene-asset';
// feat-20260626 M6 / m6-4: debug-draw auto-attach glue is re-exported from the
// main barrel (was a separate tsup entry). The separate entry produced a SECOND
// module copy of the mutable `registeredDebugDraw` registry: createApp set it on
// the subpath copy, but the URP/HDRP pipelines (bundled into index) read their
// own always-null copy AND tsup dead-code-eliminated the flush body into a stub,
// so DebugDraw.flush() never ran in the browser build (debug overlay leaked +
// never rendered). One barrel entry => one module copy => one registry shared by
// createDebugDrawOnReady (the writer) and attachDebugOverlayPass (the reader).
export { attachDebugOverlayPass, createDebugDrawOnReady } from './debug-draw-glue';
export {
  HdrpCapsInsufficientError,
  HdrpIndexListOverflowError,
  HdrpLightBudgetExceededError,
} from './errors';
// feat-20260608-cluster-lighting M2 / w10 + verify F-1/F-2: HDRP cluster-forward
// pipeline exports — full barrel surface (4 error classes + 4 sizing constants
// + pipeline + grid validator).
export {
  CLUSTER_GRID_STRIDE_U32,
  DEFAULT_CLUSTER_GRID,
  HDRP_PIPELINE_ID,
  HdrpInstallError,
  hdrpPipeline,
  LIGHT_INDEX_LIST_CAPACITY,
  MAX_LIGHTS,
  validateClusterGrid,
} from './hdrp-pipeline';
export type { PickHit } from './pick';
/**
 * `pick(world, cameraEntity, screenX, screenY, viewportWidth, viewportHeight)`
 * unprojects a viewport-relative screen coordinate into a world-space ray through the
 * supplied camera and returns the nearest pickable mesh entity's `PickHit`
 * (`{ entity, point, distance }`), or `undefined` on a miss. A `cameraEntity` without a
 * `Camera` component throws a structured `PickError` (`code: 'camera-component-missing'`).
 *
 * @example
 *   import { pick, type PickHit, PickError, type PickErrorCode } from '@forgeax/engine-runtime';
 *   const hit = pick(world, cameraEntity, x, y, canvas.width, canvas.height);
 *   if (hit) world.set(hit.entity, MeshRenderer, { materials: [highlight] });
 */
export { pick } from './pick';
export type { PickErrorCode } from './pick-errors';
export { PickError } from './pick-errors';
/**
 * `pickVertexOnEntity(world, cameraEntity, screenX, screenY, vpW, vpH, entity, options?)`
 * returns the nearest vertex on a single mesh entity.
 *
 * Three-state return (static dispatch via overload):
 *   - No options → `VertexHit | undefined` (nearest, or undefined on miss).
 *   - `{ limit: N }` → `VertexHit[]` sorted by `screenDist` ascending.
 *
 * `VertexHit` fields: `{ entity, vertexIndex, worldPos: Vec3Like, screenDist, worldDist, deformed }`.
 * Caller must `propagateTransforms(world)` before calling.
 *
 * @example
 *   import { pickVertexOnEntity, type VertexHit } from '@forgeax/engine-runtime';
 *   const hit = pickVertexOnEntity(world, cam, x, y, w, h, entity);
 *   if (hit) console.log(hit.worldPos, hit.vertexIndex);
 */
export type { VertexHit } from './pick-vertex';
export { pickVertex, pickVertexOnEntity } from './pick-vertex';
export type {
  PipelineErrorCode,
  PipelineErrorDetail,
  PipelineNotFoundDetail,
  PipelinePreviouslyRegisteredDetail,
} from './pipeline-errors';
export { PipelineError } from './pipeline-errors';
// feat-20260615-pipeline-spec-ssot: PipelineSpec 4-axis SSOT public surface
// (charter F1 single-entry indexability + P2 schema-as-contract). All 6 pure
// derive functions + the closed PipelineSpecErrorCode union + getOrBuildPipeline
// entrypoint reachable through the engine-runtime barrel so AI users follow
// `import { ... } from '@forgeax/engine-runtime'` without spelunking subpaths.
// Implementation SSOT: packages/runtime/src/pipeline-spec.ts.
export type {
  AttachmentColorOps,
  AttachmentDepthOps,
  BglKind,
  BindGroupLayoutDescriptorOutput,
  BindGroupLayoutShape,
  PassKindAttachmentPolicy,
  PipelineCache,
  PipelineDeviceProvider,
  PipelineSpec,
  PipelineSpecErrorCode,
} from './pipeline-spec';
export {
  buildBeginRenderPassDescriptor,
  buildBindGroupLayoutDescriptor,
  buildPipelineDescriptor,
  cacheKeyOf,
  deriveBglShapeFromShader,
  getOrBuildPipeline,
  PipelineSpecError,
  passKindPolicyTable,
  specsEqual,
  validateSpec,
} from './pipeline-spec';
// Round-2 [F-3] feat-20260612-hdrp-ssao: PostProcessError surfaces SSAO
// failures (storageBuffer-unavailable / radius-non-positive / bias-negative)
// alongside the existing fullscreen post-process register / not-found /
// reads-not-found codes. AI users `switch (err.code)` over the closed
// 6-member union without `default`; .detail narrows per-code per charter P3.
export type {
  FullscreenInputNotFoundDetail,
  PostProcessErrorCode,
  PostProcessErrorDetail,
  PostProcessNotFoundDetail,
  PostProcessPreviouslyRegisteredDetail,
  SsaoBiasNegativeDetail,
  SsaoRadiusNonPositiveDetail,
  SsaoStorageBufferUnavailableDetail,
} from './post-process-errors';
export { PostProcessError } from './post-process-errors';
// feat-20260604 M3 / w19: render-graph-primitives — the public AI-user vocabulary
// for assembling a render pipeline's per-frame graph (addScenePass /
// addShadowPass / addSkyboxPass / addBloomPasses / addTonemapPass /
// addFullscreenPass). The urp pipeline (w21) and any custom
// pipeline use these factories — the dogfood proof of D-5.
export type {
  AddBloomPassesOptions,
  AddFullscreenPassOptions,
  AddScenePassOptions,
  AddShadowPassOptions,
  AddSkyboxPassOptions,
  AddSsaoPassesOptions,
  AddSsaoPassesParams,
  AddTonemapPassOptions,
} from './render-graph-primitives';
export {
  addBloomPasses,
  addFullscreenPass,
  addScenePass,
  addShadowPass,
  addSkyboxPass,
  addSsaoPasses,
  addTonemapPass,
} from './render-graph-primitives';
// feat-20260601-customizable-render-pipeline-seam-and-dogfood-rend M1.
/**
 * Render-pipeline surface. `renderer.registerPipeline(id, impl)` registers a
 * `RenderPipeline` logic; `renderer.installPipeline(handle)` installs the pipeline bound
 * by a `RenderPipelineAsset` handle (from `renderer.assets.register(...)`). The built-in
 * `forgeax::urp` (`urpPipeline`) is the authoritative worked
 * example - it is dogfooded through the same public channel inside `createRenderer`.
 *
 * @example
 *   import {
 *     type RenderPipeline, urpPipeline, URP_PIPELINE_ID,
 *     PipelineError, type PipelineErrorCode,
 *   } from '@forgeax/engine-runtime';
 */
export type { RenderPipeline, RenderPipelineData } from './render-pipeline';
// feat-20260604 M3 / w20 (AC-14): RenderPipelineContext is now barrel-exported so
// custom-pipeline buildGraph / execute closures can `import type` the clean,
// post-narrowing public ctx face from `@forgeax/engine-runtime` directly.
export type { RenderPipelineContext } from './render-pipeline-context';
export { URP_PIPELINE_ID, urpPipeline } from './urp-pipeline';
// cache-bust-marker for feat-20260615-fbx-importer-via-sdk PR-CI run on bf1d383f / 05a331cd (post-rebase tsbuildinfo restore-keys staleness)
