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
export { createRenderer } from './createRenderer';

// feat-20260704-runtime-tier1-decomposition M2 / w10 (D-3 / D-9): the top-level
// RuntimeError / RuntimeErrorCode cross-cluster aggregates are ELIMINATED. Each
// error cluster's closed *ErrorCode + *Error union is re-exported so external
// consumers `import type` the cluster union and write exhaustive `switch
// (err.code)` (AC-07 a/b). Every re-export sources directly from
// ./errors/<cluster> (NOT the transitional errors.ts barrel, deleted in w15;
// NOT the @forgeax/engine-types zombie RuntimeErrorCode -- D-9).

// feat-20260705-runtime-tier2-decomposition M1 / w14: the asset cluster error
// re-exports (AssetRuntimeError / *Detail types + MaterialResolvedEmptyPasses /
// SceneCollect* classes) moved to @forgeax/engine-assets-runtime. Consumers
// import them from that package directly (AC-105: runtime barrel exports zero
// asset-cluster symbols).
// -- environment cluster --
export { EngineEnvironmentError } from './errors/environment';
// -- recover cluster --
// -- render cluster --
// -- skin cluster --

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
 *   } from '@forgeax/engine-runtime';
 *   import { type EquirectProjectionFailedDetail, type RendererError } from '@forgeax/engine-render';
 *   renderer.onError((e: RendererError) => {
 *     switch (e.code) {
 *       case 'limit-exceeded': {
 *         const detail = e.detail as LimitExceededDetail;
 *         // detail.maxStorageBufferBindingSize vs detail.requestedBytes
 *         break;
 *       }
 *       case 'equirect-projection-failed': {
 *         // renderer error arm — e narrows to EquirectProjectionFailedError
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
/**
 * Asset system SSOT re-exports (feat-20260511-asset-system-v1 / w30 / D-P7 +
 * plan-strategy §7.4 discoverability dual-entry).
 *
 * The error-model SSOT lives in `@forgeax/engine-types` (closed `AssetErrorCode`
 * 4-member union + `AssetError` class + `ASSET_ERROR_HINTS` per-code hint table);
 * this barrel is a thin re-export so AI users can write a single-line import —
 *
 *   import type { Asset } from '@forgeax/engine-assets-runtime';
 *   import type { Handle } from '@forgeax/engine-types';
 *   import { AssetError } from '@forgeax/engine-runtime';
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
  type MaterialPass,
  type ParamSchemaEntry,
  type RenderQueue,
  type SamplerAsset,
  type TextureAsset,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
// feat-20260705-runtime-tier2-decomposition M1 / w14: Asset / MeshAsset types
// moved to @forgeax/engine-assets-runtime (AC-105).
// feat-20260705-runtime-tier2-decomposition M1 / w14: AssetRegistry + the
// HANDLE_* builtin mesh handles moved to @forgeax/engine-assets-runtime (AC-105).
// feat-20260705-runtime-tier2-decomposition M1 / w14: the process-static
// BuiltinAssetRegistry tier (BUILTIN_* payloads) moved to
// @forgeax/engine-assets-runtime (AC-105). Geometry owns the shared runtime
// vertex layout.
// Runtime-specific authoring components remain here. Domain authorities are
// imported directly from @forgeax/engine-scene, @forgeax/engine-animation,
// @forgeax/engine-skinning, and @forgeax/engine-render.
/**
 * GlyphText authoring component for world-space MSDF text
 * (feat-20260531-world-space-msdf-text-rendering M4 / w14). Carries
 * `fontHandle` / `text` / `fontSize` / `color: array<f32, 4>`; the
 * `glyphTextLayoutSystem` (this package) bakes a MeshAsset and attaches
 * MeshFilter + MeshRenderer (plan-strategy D-2; GlyphText is pure authoring
 * data, baking is a system responsibility). Co-located with its consuming
 * system in `@forgeax/engine-runtime` so AI users import the component and
 * the system from one package.
 */
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
// feat-20260604-hdr-equirect-cube-importer-loader M4 / w15: the dev-only
// ImportTransport factory. A host wires it into createRenderer / createApp so
// a DDC miss at runtime triggers an on-demand POST /__import import against the
// vite-plugin-pack dev server. Aligned with the create*/wire* factory family.
export { createDevImportTransport } from './dev-import-transport';
// feat-20260705-runtime-tier2-decomposition M3 / w31: glyph-layout +
// glyph-mesh-bake (FONT_CONCURRENCY_LIMIT /
// GlyphLayoutResult / layoutGlyphText / resetFontConcurrency /
// trackFontConcurrency / VERTEX_OFFSET / bakeGlyphMesh / buildGlyphMeshAsset /
// conservativeCubeAabb / GlyphMeshBakeResult) moved to
// @forgeax/engine-graphics-extras (AC-303). Zero shim -- import from that
// package. glyphTextLayoutSystem stays here (system entry, S12).
/**
 * glyphTextLayoutSystem (feat-20260531-world-space-msdf-text-rendering) -- lays
 * out + bakes every `GlyphText` entity, attaching MeshFilter + MeshRenderer on
 * first observation and re-baking in place on a text / size / color change.
 * `renderer.attachWorld(world)` installs this derived-state owner before the
 * first `world.update()`; `renderer.draw()` only reads the published result.
 * `createApp` performs the attachment automatically.
 */
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
/**
 * feat-20260601-gpu-resource-store-extraction M1: the GPU residency store.
 * Reachable as `renderer.store`; exported here so AI users can construct one
 * directly for tests and `grep GpuResourceStore` discovers it.
 */
// feat-20260705-runtime-tier2-decomposition M1 / w14: the loader-injection
// surface (LoaderRegistry / wireDefaultLoaders / createDefaultLoaderRegistry)
// moved to @forgeax/engine-assets-runtime (AC-105).
// feat-20260705-runtime-tier2-decomposition M2 / w25: the picking cluster
// (pick / pickVertex / pickVertexOnEntity / pickTile + PickHit / VertexHit /
// PickError / PickErrorCode / PickTileError / PickTileHit) moved to
// @forgeax/engine-picking (AC-204). Zero shim -- import from that package.
/**
 * RenderSystem (D-S2 — feat-20260509-ecs-render-bridge-mvp).
 *
 * Engine-internal phase that walks the World query graph (Extract /
 * Prepare / Record three stages). RenderSystem is **not** registered to
 * the ECS schedule (AC-09); `Renderer.draw(worlds, options)` invokes it once per
 * frame.
 *
 * AI users see this re-export so the F-1 single-import contract holds:
 *
 * @example
 *   import {
 *     Camera, DirectionalLight, MeshFilter, MeshRenderer,
 *   } from '@forgeax/engine-render';
 *   import { Transform } from '@forgeax/engine-scene';
 *   import { AssetRegistry, HANDLE_CUBE, HANDLE_TRIANGLE } from '@forgeax/engine-assets-runtime';
 */
// feat-20260705-runtime-tier2-decomposition M1 / w14: resolveAssetHandle moved
// to @forgeax/engine-assets-runtime (AC-105).
export type { SpriteParamValues } from './sprite-param-values';
// feat-20260630-viewport-2x2-run-x-display-redesign M2 / w12 / plan-strategy D-2:
// engine-neutral by-entity-id active camera selection (no editor concept).
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
 *   } from '@forgeax/engine-render/internal';
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
// feat-20260705-runtime-tier2-decomposition M3 / w31: tile-bits (decodeTileBits
// / encodeTileBits) moved to @forgeax/engine-graphics-extras (AC-303). Zero shim
// -- import from that package. tilemapChunkExtractSystem stays here (system
// entry, S12).
// feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild — chunk-extract system
// feat-20260705-runtime-tier2-decomposition M3 / w31: the video cluster
// (VIDEO_ELEMENT_PROVIDER_KEY / VideoElementProvider / videoLoader / VideoPlayer
// / probeVideoHighPerfUpload / VideoCapabilityDevice) moved to
// @forgeax/engine-graphics-extras (AC-303). Zero shim -- import from that
// package.
// feat-20260705-runtime-tier2-decomposition M1 / w14: createDefaultLoaderRegistry
// + wireDefaultLoaders moved to @forgeax/engine-assets-runtime. Consumers import
// them from that package directly (AC-105).

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

// w8: Inspector contributor (registerRuntimeInspector + RegisterRuntimeInspectorResult)
// deleted — routing layer (Registry / sandbox) is removed; eval is the sole
// command channel.

// ─── Animation system wiring (M1 / T-19 - feat-20260523-skin-skeleton-animation) ──

// w8: registerRuntimeInspector export deleted alongside register-inspector.ts removal.

// feat-20260623-editor-openproject M2 w11+w12: SceneInstance→SceneAsset writeback
// chain (plan-strategy D-1: pure-data collection + pack serialization).
//
// feat-20260701-rootstosceneasset-forest-collect-schema-derived-ha M3:
// collectSceneAsset removed — replaced by rootsToSceneAsset (forest entry,
// schema-derived field dispatch, engine-self-contained GUID resolution).
// serializeSceneAssetToPack now uses schema-derived refs[] index (D-1/D-2).
export { rootsToSceneAsset, serializeSceneAssetToPack } from './collect-scene-asset';
// feat-20260626 M6 / m6-4: debug-draw auto-attach glue is re-exported from the
// main barrel (was a separate tsup entry). The separate entry produced a SECOND
// module copy of the mutable `registeredDebugDraw` registry: createApp set it on
// the subpath copy, but the URP/HDRP pipelines (bundled into index) read their
// own always-null copy AND tsup dead-code-eliminated the flush body into a stub,
// so DebugDraw.flush() never ran in the browser build (debug overlay leaked +
// never rendered). One barrel entry => one module copy => one registry shared by
// createDebugDrawOnReady (the writer) and attachDebugOverlayPass (the reader).
// feat-20260704-runtime-tier1-decomposition M2 / w10 (D-3): the third error
// re-export block (HdrpCapsInsufficientError / HdrpIndexListOverflowError /
// HdrpLightBudgetExceededError) is folded into the render-cluster class
// re-export block above -- they are render-cluster members sourced from
// ./errors/render.
// feat-20260608-cluster-lighting M2 / w10 + verify F-1/F-2: HDRP cluster-forward
// pipeline exports — full barrel surface (4 error classes + 4 sizing constants
// + pipeline + grid validator).
// feat-20260615-pipeline-spec-ssot: PipelineSpec 4-axis SSOT public surface
// (charter F1 single-entry indexability + P2 schema-as-contract). All 6 pure
// derive functions + the closed PipelineSpecErrorCode union + getOrBuildPipeline
// entrypoint reachable through the engine-runtime barrel so AI users follow
// `import { ... } from '@forgeax/engine-runtime'` without spelunking subpaths.
// Implementation SSOT: packages/runtime/src/pipeline-spec.ts.
// Round-2 [F-3] feat-20260612-hdrp-ssao: PostProcessError surfaces SSAO
// failures (storageBuffer-unavailable / radius-non-positive / bias-negative)
// alongside the existing fullscreen post-process register / not-found /
// reads-not-found codes. AI users `switch (err.code)` over the closed
// 6-member union without `default`; .detail narrows per-code per charter P3.
// feat-20260604 M3 / w19: render-graph-primitives — the public AI-user vocabulary
// for assembling a render pipeline's per-frame graph (addScenePass /
// addShadowPass / addSkyboxPass / addBloomPasses / addTonemapPass /
// addFullscreenPass). The urp pipeline (w21) and any custom
// pipeline use these factories — the dogfood proof of D-5.
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
 *   } from '@forgeax/engine-render/internal';
 */
// feat-20260604 M3 / w20 (AC-14): RenderPipelineContext is now barrel-exported so
// custom-pipeline buildGraph / execute closures can `import type` the clean,
// post-narrowing public ctx face from `@forgeax/engine-runtime` directly.
// feat-20260701-rootstosceneasset verify minor-edit (F2): collectSubtree is a
// reusable "BFS a subtree along Children" primitive (the forgeax-engine-ecs
// skill documents importing it from the barrel) — re-export so that claim holds.
// cache-bust-marker for feat-20260615-fbx-importer-via-sdk PR-CI run on bf1d383f / 05a331cd (post-rebase tsbuildinfo restore-keys staleness)
