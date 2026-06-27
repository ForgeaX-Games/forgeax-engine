// @forgeax/engine-runtime - RenderSystem main entry (D-S2 three-stage Extract ->
// Prepare -> Record + 4-tier error fan-out).
//
// Engine-internal phase: NOT registered to World schedule (AC-09);
// `Renderer.draw(world)` invokes once per frame. See `Renderer` JSDoc in
// `./renderer.ts` for the full error tier table (D-S4..D-S8) and AGENTS.md
// "ECS render bridge" section for the AI-user-facing contract.
//
// Stage carve-out (review round 1 finding #3 - 505 line cap fallback):
//   - render-system.ts          (this file)             types + orchestration
//   - render-system-extract.ts  Extract ECS query phase + snapshot helpers
//   - render-system-record.ts   Prepare + Record GPU phase + matrix helpers
//
// @forgeax/engine-math is referenced through render-system-record.ts which builds
// view/proj matrices and worldFromLocal via `mat4.compose / .multiply /
// .invert` (charter proposition 5: no math reinvention; render-system.test.ts
// asserts `/@forgeax\/engine-math/` shows up in render-system.ts source).

import type { ErrorContext, World } from '@forgeax/engine-ecs';
import { Severity } from '@forgeax/engine-ecs';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  PipelineLayout,
  RenderPipeline,
  RhiCanvasContext,
  RhiDevice,
  Sampler,
  TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import {
  derive,
  type MaterialRenderState,
  type ParamSchemaEntry,
  type PassKind,
  type PrimitiveTopology,
  type RenderPipelineAsset,
  RenderQueue,
} from '@forgeax/engine-types';
import { type AssetRegistry, HANDLE_CUBE, HANDLE_TRIANGLE } from './asset-registry';

import type { EngineMetrics } from './engine-metrics';
import { HdrpCapsInsufficientError } from './errors';
import type { PostProcessShaderEntry } from './fullscreen-post-process-pass';
import type { GpuBuffer } from './gpu-resource';
import type { GpuResourceStore } from './gpu-resource-store';
import { validateClusterGrid } from './hdrp-pipeline';
import { disposeInstanceBuffers } from './instance-buffer-cache';
import { PipelineError } from './pipeline-errors';
import { PostProcessError } from './post-process-errors';
// The forgeax-concept RenderPipeline (registrable / installable unit) - aliased to avoid
// the name collision with the RHI opaque `RenderPipeline` handle imported above. The RHI
// handle stays internal (requirements line 155); this concept type is the public surface.
import type { RenderPipeline as RenderPipelineDef } from './render-pipeline';
import type { CameraSnapshot, DispatchEntry, RenderableSnapshot } from './render-system-extract';
import { extractFrame } from './render-system-extract';
import { type RenderFrameState, recordFrame } from './render-system-record';
import type { RhiErrorListenerRegistry } from './renderer';
import { propagateTransforms } from './systems/propagate-transforms';
import type { SkinPaletteAllocator } from './systems/skin-palette-allocator';
import {
  getTransparentSortConfig,
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from './systems/transparent-sort-config';
import { urpPipeline } from './urp-pipeline';

/**
 * Unified transparent-queue sub-sort covering all four
 * {@link TransparentSortConfig} modes. Reorders the
 * `queue === RenderQueue.Transparent` segment of the dispatch list;
 * all other queue segments keep their relative order.
 *
 * | mode | primary key | secondary key |
 * |:--:|:--|:--|
 * | 0 (LAYER_Z)   | `layer` ASC | `posZ` ASC |
 * | 1 (LAYER_Y)   | `layer` ASC | `-(posY - pivotY * sizeY)` ASC |
 * | 2 (LAYER_YZ)  | `layer` ASC | `(posY - pivotY * sizeY) + yzAlpha * posZ` ASC |
 * | 3 (DISTANCE)  | `-(dist² from camera)` ASC (back-to-front, layer ignored) |
 *
 * `posX/Y/Z` = translation column of the entity's world mat4 (indices 12/13/14).
 * `pivotY` = `RenderableSnapshot.material.spriteFields.pivot[1]` (default 0.5).
 * `sizeY`  = length of the Y-axis column of the world mat4 (indices 4/5/6).
 */
function sortTransparentDispatch(
  dispatch: DispatchEntry[],
  world: World,
  cameras: readonly CameraSnapshot[],
  renderables: readonly RenderableSnapshot[],
): DispatchEntry[] {
  const cfg = getTransparentSortConfig(world);
  const mode = cfg.mode;

  // Indices of Transparent-queue entries within the dispatch list.
  const transparentSlots: number[] = [];
  for (let i = 0; i < dispatch.length; i++) {
    if (dispatch[i]?.queue === RenderQueue.Transparent) transparentSlots.push(i);
  }
  if (transparentSlots.length <= 1) return dispatch;

  let sortedSlotOrder: number[];

  if (mode === TRANSPARENT_SORT_MODE_DISTANCE) {
    const camera = cameras[0];
    if (camera === undefined) return dispatch;
    const camPos = camera.position;

    // Squared camera distance per entry (negated → ascending = back-to-front).
    // D-3: world position = translation column of Transform.world (m[12,13,14]).
    const negDistSq = (entry: DispatchEntry): number => {
      const tx = renderables[entry.renderableIndex]?.transform;
      if (tx === undefined) return 0;
      const w = tx.world;
      const dx = (w[12] ?? 0) - (camPos[0] ?? 0);
      const dy = (w[13] ?? 0) - (camPos[1] ?? 0);
      const dz = (w[14] ?? 0) - (camPos[2] ?? 0);
      return -(dx * dx + dy * dy + dz * dz);
    };

    sortedSlotOrder = transparentSlots.slice().sort((a, b) => {
      const da = negDistSq(dispatch[a] as DispatchEntry);
      const db = negDistSq(dispatch[b] as DispatchEntry);
      if (da < db) return -1;
      if (da > db) return 1;
      return 0;
    });
  } else {
    // Modes 0/1/2: primary = layer ASC, secondary = mode-formula ASC.
    // sizeY = length of the Y-axis column (col1 = indices 4,5,6) of the
    // world mat4; rotation-invariant and handles flipV sign correctly.
    const sortVal = (entry: DispatchEntry): number => {
      const tx = renderables[entry.renderableIndex]?.transform;
      const w = tx?.world;
      const posY = (w?.[13] ?? 0) as number;
      const posZ = (w?.[14] ?? 0) as number;
      if (mode === TRANSPARENT_SORT_MODE_LAYER_Z) return posZ;
      const mat = renderables[entry.renderableIndex]?.material;
      const pivotY = ((mat?.spriteFields?.pivot as readonly number[] | undefined)?.[1] ??
        0.5) as number;
      const wy4 = (w?.[4] ?? 0) as number;
      const wy5 = (w?.[5] ?? 1) as number;
      const wy6 = (w?.[6] ?? 0) as number;
      const sizeY = Math.sqrt(wy4 * wy4 + wy5 * wy5 + wy6 * wy6);
      const footY = posY - pivotY * sizeY;
      if (mode === TRANSPARENT_SORT_MODE_LAYER_Y) return -footY;
      if (mode === TRANSPARENT_SORT_MODE_LAYER_YZ) return footY + cfg.yzAlpha * posZ;
      // Defensive fallback for any unknown mode that slips past setTransparentSortConfig.
      return posZ;
    };

    sortedSlotOrder = transparentSlots.slice().sort((a, b) => {
      const da = dispatch[a] as DispatchEntry;
      const db = dispatch[b] as DispatchEntry;
      const la = da.layer;
      const lb = db.layer;
      if (la !== lb) return la - lb;
      const va = sortVal(da);
      const vb = sortVal(db);
      if (va < vb) return -1;
      if (va > vb) return 1;
      return 0;
    });
  }

  // Scatter the reordered Transparent entries back into their original slots.
  const result = dispatch.slice();
  for (let k = 0; k < transparentSlots.length; k++) {
    const targetSlot = transparentSlots[k] as number;
    const sourceSlot = sortedSlotOrder[k] as number;
    result[targetSlot] = dispatch[sourceSlot] as DispatchEntry;
  }
  return result;
}

/**
 * Per-entity material slice size in bytes — SSOT consumed by both
 * `createRenderer.ts` (BG entry size) and `render-system-record.ts`
 * (per-entity writeBuffer payload size).
 *
 * feat-20260613 fix-issue-3: the value is derived from the actual
 * default-standard-pbr sidecar paramSchema (post-D-8 channelMap split:
 * 10 numeric entries packed std140 + 3 textures). The transitional
 * STANDARD_PBR_LEGACY_UBO_SCHEMA placeholder schema (5 fake `color`
 * slots whose only purpose was to make `derive(...).totalBytes` return
 * 80) is gone — the sidecar paramSchema is the only SSOT for the layout.
 *
 * The schema below mirrors `default-standard-pbr.wgsl.meta.json` field-
 * for-field; trailing texture entries do not affect uboLayout.totalBytes
 * (only numeric entries occupy UBO bytes). std140 produces:
 *   baseColor          : vec4<f32>     0..16
 *   metallic           : f32          16..20
 *   roughness          : f32          20..24
 *   metallicChannel    : f32          24..28
 *   roughnessChannel   : f32          28..32
 *   aoChannel          : f32          32..36
 *   extraChannel       : f32          36..40
 *   (vec3 align=16 inserts implicit pad to 48)
 *   emissive           : vec3<f32>    48..60
 *   emissiveIntensity  : f32          60..64
 *   occlusionStrength  : f32          64..68
 *                                     = alignUp(68, 16) = 80
 * The dynamic-offset stride of `PER_ENTITY_STRIDE = 256` is unchanged
 * (D-P9 256-byte minimum dynamic-offset alignment); only the per-entity
 * BindGroup entry size + writeBuffer payload size adopt the 80 B shape.
 */
const STANDARD_PBR_SIDECAR_SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color' },
  { name: 'metallic', type: 'f32' },
  { name: 'roughness', type: 'f32' },
  { name: 'metallicChannel', type: 'f32' },
  { name: 'roughnessChannel', type: 'f32' },
  { name: 'aoChannel', type: 'f32' },
  { name: 'extraChannel', type: 'f32' },
  { name: 'emissive', type: 'vec3' },
  { name: 'emissiveIntensity', type: 'f32' },
  { name: 'occlusionStrength', type: 'f32' },
];

/** Per-entity material slice size (80 B; derived from the sidecar paramSchema). */
export const STANDARD_PBR_UBO_SIZE = derive(STANDARD_PBR_SIDECAR_SCHEMA).uboLayout.totalBytes;

/**
 * Engine-internal Extract / Prepare / Record driver; constructed by createRenderer.
 *
 * w15 M5 dual-pipeline dispatch: `pipelineDispatchCounts` surfaces per-frame
 * counters of how many entities were routed to each pipeline (plan-strategy
 * D-P4 / requirements AC-07). The counts roll over monotonically — test
 * callers read them after `draw(world)` to assert each tag saw >= 1 draw.
 * Reset is intentional on every `draw(world)` entry so per-frame assertions
 * stay local (charter proposition 4 explicit failure: test code sees exact
 * per-draw counts, not stale cross-frame totals).
 *
 * bug-20260519: BUILTIN cube migrated to 12F so the legacy `unlitBuiltin`
 * counter is gone; the surface collapses to `unlit` (every entity carrying
 * `MaterialAsset { shadingModel: 'unlit' }`) + `standard` (every entity
 * carrying `shadingModel: 'standard'`).
 */
export interface RenderSystem {
  draw(world: World): void;
  readonly pipelineDispatchCounts: {
    readonly unlit: number;
  };
  /**
   * feat-20260528-frustum-culling M5 / w14: per-frame frustum-culling counters.
   * Updated by `draw(world)` on every call from the Extract stage.
   */
  readonly frustumStats: { culled: number; total: number };
  /**
   * feat-20260531-bloom-first-declarative-render-graph-pass M4 fix-up w19:
   * per-frame render-graph pass names in declaration order. Empty array
   * before the first `draw(world)` call; populated after the per-frame
   * graph is built (lazily on first draw). Read-only introspection surface
   * so smoke tests can assert the declarative pass chain is wired without
   * reaching into engine internals.
   */
  readonly perFramePassNames: readonly string[];
  /**
   * feat-20260531-per-frame-bind-group-cache M1 / w4: per-frame
   * createBindGroup counter. Reset to 0 on every `draw(world)` entry,
   * bumped on each cache-miss createBindGroup call in the record stage.
   * Aligns with pipelineDispatchCounts precedent: closure-mutable object
   * + draw-entry reset + readonly getter. Stable-frame AC-03 asserts
   * createBindGroup == 0 when all bind groups are cache-resident.
   *
   * M5 / w19 type-safe finalization: the return type is purposely the
   * narrowest inline object literal `{ readonly createBindGroup: number }`
   * rather than a wider Record/alias — this ensures TS language service
   * hover shows the exact field name + type, and AC-09 consumption sites
   * infer `number` without `as` casts (plan-strategy D-7 + sec.8
   * discoverability).
   */
  readonly bindGroupCounts: {
    readonly createBindGroup: number;
    readonly keys: readonly string[];
  };
  /**
   * feat-20260615-pipeline-spec-ssot M5-T2: latest URP shadow-atlas
   * texture view resolved off the per-frame render-graph
   * (`addColorTarget('shadowDepth', ...)`). Returns `null` when no
   * frame has been drawn yet, or when the active pipeline does not
   * declare the `shadowDepth` color target. Read-only debug seam:
   * the engine itself reads the same view inline in `recordFrame`;
   * this getter exists so debug readback paths
   * (`Renderer.debugSampleShadowFactor`) read the same SSOT view as
   * the engine's record stage (D-2: graph owns the lifecycle; no
   * mirror slot on `pipelineState.perPassResources`).
   */
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  getCurrentShadowView(): any | null;
  /**
   * feat-20260601-customizable-render-pipeline-seam M1 / w7: register a render-pipeline
   * logic under `id`. Same-id re-register THROWS a PipelineError
   * (`'pipeline-already-registered'`) - programmer-error fail-fast, mirroring
   * ShaderRegistry.registerMaterialShader. Engine builtins use the `forgeax::` prefix.
   */
  registerPipeline(id: string, impl: RenderPipelineDef): void;
  /**
   * feat-20260601-customizable-render-pipeline-seam M1 / w7 (D-19): install the pipeline
   * described by a `RenderPipelineAsset` POD. Looks up `pipelineId` in the registry; on an
   * unregistered id returns `Result.err(PipelineError{code:'pipeline-not-found'})`. On
   * success the next `draw` detects the install-epoch bump and rebuilds the memoized
   * per-frame graph (hot-swap). Takes the payload directly because installation happens at
   * boot/swap time before any World exists -- there is no handle to resolve.
   */
  installPipeline(asset: RenderPipelineAsset): Result<void, PipelineError>;
  /**
   * feat-20260604-resource-owning-render-graph-and-fullscreen-postpr M2 / w13:
   * fullscreen post-process shader registry, parallel to ShaderRegistry.registerMaterialShader
   * (D-4: material shader handles 4-BGL / 12-float-vertex / depth / triangle-list, while
   * fullscreen post-process uses 0-vertex-buffer / no-depth / input-texture-BGL).
   * Same-id re-register THROWS PostProcessError ('post-process-already-registered').
   * Engine builtins use the `forgeax::` prefix.
   */
  readonly postProcess: {
    register(id: string, entry: PostProcessShaderEntry): void;
  };
  /**
   * feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5 / w21:
   * release the per-RenderSystem frame-state GPU bookkeeping during
   * `Renderer.dispose()`. Walks the perFrameGraph drain (releases pooled
   * transient + persistent textures via the stashed device, plan-strategy
   * D-2 step 2) and the instanceBuffers cache (destroys + clears every
   * GpuBuffer entry, plan-strategy D-2 step 3).
   *
   * Idempotent (architecture-principles §6): a second call after both
   * structures are cleared is a no-op. Per-step failures inside drain /
   * disposeInstanceBuffers fall through silently -- the Renderer.dispose
   * cascade owns the try/catch + errorRegistry.fire fan-out (D-3).
   */
  disposeFrameState(): void;

  /**
   * feat-20260622-s5 M3 / B-2 / w18: drop the device-bound state the recover()
   * rebuild must shed before re-running the pipeline build against a fresh
   * device. Two effects, both keyed to the lost device:
   *   1. the per-frame render-graph's pendingDestroy queue (PooledTextures
   *      minted by the lost device — clearPendingDestroy skips destroyTexture);
   *   2. the post-process registry + its eager param UBOs (the WGSL re-registers
   *      during the rebuild's buildReadyWebGPU; without this reset the tonemap
   *      re-register throws `post-process-already-registered`, and the UBOs are
   *      stale lost-device handles anyway).
   * Idempotent and graph-optional (no-op when nothing has compiled yet).
   */
  resetForRecover(): void;
}

/**
 * feat-20260601-customizable-render-pipeline-seam M2 / w10: the NARROW runtime-services
 * surface a `RenderPipeline` pass closure consumes (UE `FRDGBuilder` runtime half). Bundles
 * exactly the four `RenderSystemInternals` members the 9 urp closures reach
 * directly: the GPU `device`, the structured-error sink `errorRegistry`, and the two
 * per-MaterialShader pipeline-cache / param-schema lookups. `RenderPipelineContext.runtime`
 * is typed as this interface, NOT the full `RenderSystemInternals` - a pipeline author
 * cannot reach `context` / `getPipelineState` / `canvas` (charter P4: a
 * consistent narrow abstraction over the runtime, not the kitchen-sink). `internals`
 * itself is unreachable through the public ctx (the AC-08 oracle: `ctx.internals` is a
 * compile error).
 */
export interface RenderSystemRuntime {
  readonly device: RhiDevice;
  readonly errorRegistry: RhiErrorListenerRegistry;
  /**
   * feat-20260622-s5-device-surface-self-heal-recover M2 / w8: health registry
   * threaded into the record stage so `recordFrame` can fire `internal-fault`
   * when surface reconfigure+retry both fail (A-IN-2).
   */
  readonly healthRegistry: import('./renderer').HealthListenerRegistry;
  // feat-20260523-shader-template-instance-split M9-T03 (D-PipelineBuilder):
  // per-MaterialShader pipeline cache lookup. Returns the cached pipeline
  // for `materialShaderId`, lazily building on first miss via
  // ShaderRegistry.lookupMaterialShader -> buildPipelineForMaterialShader.
  // Returns `null` when:
  //   - the id is not registered in ShaderRegistry (caller falls back to
  //     pipelineState.standardPipeline / standardPipelineHdr)
  //   - the underlying async shader-module build is still pending (caller
  //     falls back for one frame and retries on the next; mirrors the
  //     `makeShaderDeviceAdapter` 1-frame-warmup idiom)
  //   - the pipeline build itself fails (caller fires a structured
  //     RhiError via errorRegistry; charter P3 explicit failure)
  readonly getMaterialShaderPipeline?: (
    materialShaderId: string,
    isHdr: boolean,
    renderState?: MaterialRenderState,
    // feat-20260604 M3 / w9: per-mesh topology selects a per-topology PSO
    // (WebGPU bakes topology into the immutable pipeline). Omitted resolves to
    // 'triangle-list' (AC-03 zero-regression).
    topology?: PrimitiveTopology,
    // feat-20260604 M5 / w15: strip topologies bake the mesh's index width into
    // primitive.stripIndexIndex. The record stage threads entry.mesh.indexFormat
    // here so a uint16-indexed strip gets a uint16 PSO (not a hardcoded uint32).
    // Ignored for list topologies (WebGPU spec: stripIndexFormat strip-only).
    indexFormat?: 'uint16' | 'uint32',
    // feat-20260609 M4 / w33: variantSet selects the per-variant WGSL from the
    // shader manifest. When non-empty, the pipeline builder resolves the matching
    // variant's composedWgsl instead of the boot-time default; the BGL is
    // derived from paramSchema via derive() in pbr-pipeline (M3 / w12-w13).
    // URP callers pass 'STORAGE_BUFFER_AVAILABLE=true'; HDRP callers pass
    // 'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true'. Omitted
    // (undefined / '') preserves backward-compatible behaviour (existing PSOs).
    variantSet?: string,
    // feat-20260609 M0 / T-002: passKind distinguishes forward (colour+DS)
    // from shadow-caster passes in the PSO cache key. Defaults to
    // 'forward' for backward compatibility (AC-06).
    passKind?: PassKind,
    // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
    // pbr-skin layoutKind reads its 6-attribute / 72-byte vertex buffer
    // layout via `deriveVertexBufferLayout` (vertex-attribute-layout.ts SSOT).
    // Callers with a resolved `MeshAsset.attributes` pass it through so the
    // built PSO matches the mesh's real attribute set. Undefined falls
    // through to the synthesized 6-key sentinel inside buildPipelineContext;
    // non-skin layoutKinds ignore this parameter entirely.
    meshAttributes?: import('@forgeax/engine-types').VertexAttributeMap,
    // bug-20260615 M2 / m2-1: sampleCount drives the multisample descriptor
    // field in the pipeline builder — it is a CAMERA fact (per-frame
    // antialias setting). Default 1 preserves byte-identity of every
    // pre-M2 cache slot + descriptor.
    sampleCount?: number,
  ) => RenderPipeline | null;
  /**
   * feat-20260527 M2 / w7: schema lookup for material param overlay.
   * Returns the paramSchema for a registered material shader, or
   * `undefined` when the shader is not in the ShaderRegistry.
   * Record stage uses this instead of reading `MaterialSnapshot.paramSchema`.
   */
  readonly getParamSchema?: (materialShaderId: string) => readonly ParamSchemaEntry[] | undefined;
  /**
   * feat-20260621-learn-render-5-5-parallax M2 / w6 (D-1): the per-shader
   * material BindGroupLayout for the given material shader. A custom shader
   * declaring >3 user-region textures (e.g. parallax `heightTexture`) owns a
   * material BGL whose entry count + injection start differ from the built-in
   * 18-entry layout; the record stage must create the material bind group
   * against THIS layout so the entry count matches. Returns `undefined` when
   * the shader is unregistered or resolves to the shared built-in layout
   * (3-texture shaders), in which case the caller falls back to
   * `pipelineState.materialBindGroupLayout`.
   */
  readonly getMaterialBindGroupLayout?: (materialShaderId: string) => BindGroupLayout | undefined;
  /**
   * feat-20260527-sprite-nineslice M4 / w16 (D-5): per-Renderer metrics counter
   * surfaced through `renderer.metrics`. Record-stage soft-warns (e.g.
   * `nineslice.scale-too-small` when Transform.scale falls below the four
   * 9-slice corner anchors) call `runtime.metrics.increment(name)` instead of
   * a per-entity `console.warn` so AI users observe machine-readable counters
   * (charter P3 over P-flooded text logs). Each Renderer owns its own
   * EngineMetrics instance (D-5 candidate 1: multi-Renderer isolation).
   */
  readonly metrics: EngineMetrics;
  /**
   * feat-20260604-resource-owning-render-graph-and-fullscreen-postpr M3 / F-2 fix-up:
   * post-process registry lookup. Returns the `PostProcessShaderEntry` registered
   * via `renderer.postProcess.register(id, entry)`, or `undefined` when `id`
   * resolves to no entry. `addFullscreenPass`'s execute closure dispatches on this
   * to route to either the FXAA built-in path (id === 'fxaa') or the generic
   * `buildFullscreenPostProcessPass + createFullscreenBindGroup` path; an
   * unregistered id surfaces as a thrown `PostProcessError({code:'post-process-not-found'})`
   * fail-fast (charter P3 / pipeline-errors throw template).
   *
   * Optional so a custom RenderSystemRuntime fixture (test doubles) need not
   * supply it; the engine's own createRenderSystem populates it unconditionally.
   */
  readonly lookupPostProcess?: (id: string) => PostProcessShaderEntry | undefined;
  /**
   * feat-20260621-fullscreen-post-process-per-frame-uniform-params-l M-A2 / w8:
   * per-shader params UBO accessor. Returns the eager-created (at register time,
   * M-A1 / w5) GPU buffer for `id`, or `undefined` when the id has no params
   * (param-less consumer) / is unregistered. dispatchFullscreenPass reads this to
   * writeBuffer the per-frame snapshot bytes and bind the buffer at group(1)
   * binding(2). Optional so test fixtures need not supply it; createRenderSystem
   * populates it unconditionally (mirrors lookupPostProcess / getPostProcessPipeline).
   */
  readonly getPostProcessParamsBuffer?: (id: string) => Buffer | undefined;
  /**
   * feat-20260609-learn-render-4-5-framebuffers-demo-offscreen-rt-an M4 / T-10-a:
   * post-process render-pipeline lookup with eager-on-first-call build. Returns a
   * cached `RenderPipeline` (RHI handle) for `id`, lazily building on first call
   * via the closure passed through `RenderSystemInternals.buildPostProcessPipeline`.
   * Returns `null` when:
   *   - the id is not registered in the post-process registry (caller skips the
   *     pass — paired with the `'post-process-not-found'` throw site, this branch
   *     is unreachable on the happy path)
   *   - the underlying async shader-module compile is still pending (caller falls
   *     back for one frame and retries on the next; mirrors the
   *     `getMaterialShaderPipeline` 1-frame-warmup idiom)
   *   - the pipeline build itself fails (caller skips the pass; the build path
   *     fires a structured RhiError via errorRegistry; charter P3 explicit failure)
   *
   * Solves M1 CONCERN-1: the dispatcher in `dispatchFullscreenPass` previously
   * passed `pipeline=null` to `built.createHandle` because the per-frame execute
   * closure cannot await `createShaderModule` (async). With this lookup the
   * dispatcher reads the pipeline synchronously; warm-up costs one frame.
   *
   * `bgl` is the fullscreen input-texture BGL the dispatcher already built via
   * `buildFullscreenPostProcessPass`. The engine assumes a single static BGL
   * shape (FULLSCREEN_BGL_DESCRIPTOR) so the pipeline cache keys on `id` only;
   * subsequent calls reuse the cached pipeline regardless of which BGL identity
   * is threaded.
   *
   * `colorFormat` is the swap-chain / target color format the post-process
   * pipeline writes (`bgra8unorm-srgb` for swap-chain, the offscreen RT format
   * otherwise). Cache key is `id|colorFormat`.
   *
   * Optional so a custom RenderSystemRuntime fixture (test doubles) need not
   * supply it; the engine's own createRenderSystem populates it when
   * `RenderSystemInternals.buildPostProcessPipeline` is provided.
   */
  readonly getPostProcessPipeline?: (
    id: string,
    bgl: BindGroupLayout,
    colorFormat: GPUTextureFormat,
  ) => RenderPipeline | null;
  /**
   * feat-20260623-world-space-video-asset M4 / w16 (D-3): transient per-frame
   * texture store for VideoAsset sources. Independent of {@link gpuStore} — the
   * record stage routes a `MaterialSnapshot.videoTextureFields` field through
   * this store (per-frame copyExternalImageToTexture upload + current-frame view)
   * instead of `gpuStore.ensureResident` (whose static cache video must never
   * enter, AC-08). Optional so test fixtures that drive recordFrame manually
   * need not supply one — a video field then degrades to the default view
   * (charter P3). The production createRenderer always wires it.
   */
  readonly dynamicTextureStore?: import('./dynamic-texture-store').DynamicTextureStore | undefined;
}

export interface RenderSystemInternals extends RenderSystemRuntime {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  // M6 / w41 (feat-20260510-rhi-resource-creation): the canvas context is the
  // forgeax `RhiCanvasContext` brand; render-system-record.ts uses
  // `getCurrentTexture()` -> `device.createTextureView(...)` (K-4 two-step
  // explicit form, charter proposition 5 consistent abstraction red line).
  readonly context: RhiCanvasContext | null;
  // feat-20260608-create-app-param-surface-trim / M1 / AC-02: the legacy
  // `clearColor` field is removed. The record stage reads clear color
  // straight from the Camera SoA (`camera.clearR/G/B/A`); zero-Camera
  // fallback uses `ZERO_CAMERA_CLEAR_FALLBACK = [0, 0, 0, 1]` (D-8).
  readonly getPipelineState: () => PipelineState | null;
  readonly assets: AssetRegistry;
  // feat-20260601-gpu-resource-store-extraction M1: GPU residency layer
  // extracted out of AssetRegistry. Record stage reads GPU texture / cubemap /
  // mesh handles through the store; CPU POD reads stay on `assets`.
  readonly gpuStore: GpuResourceStore;
  // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M3 / T-M3-04:
  // mesh-SSBO grow hook + read-only state surface threaded into the record
  // stage so `ensureMeshSsboCapacity(internals, validatedOrdered.length)` can
  // bridge the recordFrame → growController seam without leaking the full
  // controller object into RenderSystemRuntime (the narrow ctx). Both fields
  // are optional for test fixtures that wire createRenderSystem manually
  // without a controller (legacy path returns ok:true and short-circuits);
  // the production createRenderer always sets both. The `| undefined`
  // suffix keeps both fields assignable from the WebGPU-internals carrier
  // whose own field is `?:` -- exactOptionalPropertyTypes ABI compat.
  readonly growMeshSsbo?:
    | ((neededSlots: number) =>
        | { readonly ok: true }
        | {
            readonly ok: false;
            readonly code: 'mesh-ssbo-ceiling-reached' | 'mesh-ssbo-capacity-exceeded';
            readonly degradedToSlotCount: number;
          })
    | undefined;
  readonly meshSsboState?: { readonly slotCount: number } | undefined;
  /**
   * feat-20260609 M4 / T-10-a: factory backing `getPostProcessPipeline`. Provided
   * by `createRenderer.ts` (it owns the shared `getShaderModuleAdapter` and the
   * fullscreen pipeline-layout builder); receives a registered
   * `PostProcessShaderEntry` + the fullscreen BGL the dispatcher already
   * composed + the target color format, returns a built `RenderPipeline`
   * (RHI handle) or `null` (shader still compiling / build failed). The first
   * call per id triggers the async shader compile; subsequent calls hit the
   * RenderSystem-level cache and never reach this factory.
   *
   * Optional so test fixtures (createRenderSystem with a stub
   * RenderSystemInternals) need not provide a real factory; without it
   * `getPostProcessPipeline` resolves to `undefined` on the runtime surface
   * and the dispatcher falls through to its existing `null`-skip branch.
   */
  readonly buildPostProcessPipeline?:
    | ((
        entry: PostProcessShaderEntry,
        bgl: BindGroupLayout,
        colorFormat: GPUTextureFormat,
        label: string,
      ) => RenderPipeline | null)
    | undefined;
}

export interface PipelineState {
  readonly meshes: ReadonlyMap<number, MeshGpuHandles>;
  readonly format: string;
  // Color-attachment view format. May differ from `format` (canvas storage)
  // when an sRGB-encoding view is requested over a linear storage texture.
  // Backend-aware SSOT: selectSwapChainFormat in createRenderer.ts derives
  // both format and colorAttachmentFormat from storageBufferCapable
  // (Channel 2 UA-preferred bgra8unorm / Channel 3 GLES fallback rgba8unorm);
  // bug-20260612-webgpu-canvas-format-prefer-bgra supersedes the previous
  // module-level SWAP_CHAIN_VIEW_FORMAT constant (bug-20260519 / bug-20260610).
  // Equal to `format` for offscreen render targets.
  readonly colorAttachmentFormat: string;

  // Per-frame uniform / storage buffers + bind group layouts used to compose
  // the 3 BindGroups (view / material / mesh-array) the pbr.wgsl pipeline
  // expects (D-S2 + plan-strategy 1 architecture). The view + material UBOs
  // and the mesh SSBO are reused across frames; only the contents are
  // queue.writeBuffer-updated each draw(world) invocation.
  readonly viewBindGroupLayout: BindGroupLayout;
  readonly materialBindGroupLayout: BindGroupLayout;
  readonly meshBindGroupLayout: BindGroupLayout;
  readonly viewUniformBuffer: Buffer;
  // feat-20260613-csm-cascaded-shadow-maps M5 / w28: per-pass shadow_caster
  // cascade-index UBO. 16 B (1 u32 + 12 B pad to satisfy the 16 B uniform
  // buffer alignment). The host writes `index = i` (0..3) before each
  // cascade's recordShadowPass submit; shadow_caster.wgsl reads it via
  // `@group(0) @binding(5) shadowCasterCascade.index` to pick the matching
  // `view.lightViewProj_X`. Forward shaders declare the binding (so the
  // shared view BGL accommodates both pipelines) but never reference it.
  readonly shadowCasterCascadeBuffer: Buffer;
  // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 / T-M2-06:
  // materialUniformBuffer + meshStorageBuffer fields hold wrapper objects
  // (`{ buffer, sizeInBytes }`) instead of bare `Buffer` handles. The outer
  // wrapper-object identity is stable across grow events (research §F8 R1)
  // so PipelineState references survive grow without re-bind cycles; the
  // inner `.buffer` is replaced by `growMeshSsbo` (createRenderer.ts /
  // T-M2-05). Consumers must read `.buffer` to reach the underlying
  // `Buffer` handle (M3-04: `pipelineState.meshStorageBuffer.buffer` /
  // `.materialUniformBuffer.buffer`); using the wrapper directly as a
  // WeakMap chain key would bind the cache to the wrapper object identity
  // (which never changes) instead of the inner buffer identity (which DOES
  // change on grow), defeating the cache miss -> re-bind path (D-3
  // grep-gate guards this).
  readonly materialUniformBuffer: { readonly buffer: Buffer; readonly sizeInBytes: number };
  readonly meshStorageBuffer: { readonly buffer: Buffer; readonly sizeInBytes: number };
  // feat-20260519-light-casters-point-spot-pbr M3 / w20 (D-S1 + D-S2):
  // PointLight + SpotLight std430 storage buffers occupy two new
  // viewBindGroupLayout entries (binding 1 + 2) alongside the existing
  // viewUniformBuffer (binding 0). Each buffer carries a 16 B std430 header
  // (count u32 + 12 B pad) followed by a fixed 4-slot first-slice cap
  // (32 B per PointLight / 48 B per SpotLight; total 144 B / 208 B). The
  // record stage rewrites both buffers per frame via `queue.writeBuffer`
  // (D-S6 per-frame full rewrite); the bind-group layout entries exist
  // even when shaders do not yet reference them so the M4 pbr.wgsl
  // multi-light helper landing requires no further createRenderer
  // changes (charter P5 consistent abstraction; AC-04 c byte-frozen
  // layout). Cap-gate at createRenderer time
  // (`assertStorageBufferCap >= 4`) keeps the layout reachable before any
  // frame records (R-4 + plan-strategy 4 risk table).
  readonly pointLightsBuffer: Buffer;
  readonly spotLightsBuffer: Buffer;
  // feat-20260513-instanced-mesh M3 (T-M3-2 / T-M3-3): SSBO single-branch
  // record-stage. `meshStorageBuffer` carries one `entity_world` mat4 per
  // renderable (256-byte stride for dynamic-offset alignment); the
  // `instancesBindGroupLayout` + `identityInstanceBuffer` form the second
  // tier of the chained transform: shader composes
  // `world = entity_world * instances_local[instance_index]`. When a
  // renderable does not carry an `Instances` component the record stage
  // binds the shared 1-element identity-mat4 fallback (`drawIndexed
  // instanceCount=1`); when it does, the per-entity GPU storage buffer
  // owned by the record stage's `frameState.instanceBuffers` cache is
  // bound (`drawIndexed instanceCount=Instances.transforms.count / 16`).
  // feat-20260514 M3 / w15: the legacy
  // `AssetRegistry.createInstancedBuffer` triplet is gone — Instances data
  // flows entirely through the ECS-managed `array<f32>` field; the record
  // stage owns GPU storage buffer allocation + `LimitExceededDetail`
  // emit + `caps.storageBuffer` cap-gate.
  readonly instancesBindGroupLayout: BindGroupLayout;
  readonly identityInstanceBuffer: Buffer;

  // feat-20260515 M3 / T-M3-05 (research F-6 fix): default sampler +
  // fallback 1x1 white textureView seed the materialBindGroup binding=1 /
  // binding=2 entries when MaterialAsset.baseColorTexture is undefined.
  // The defaults follow research F-5 SSOT (linear min/mag/mipmap +
  // repeat) so AI users that don't supply a texture still get a sensible
  // sampling configuration without having to register a SamplerAsset
  // (charter F2 minimal surface).
  readonly defaultSampler: Sampler;
  // Nearest-neighbour (mag=nearest, min=nearest, mip=nearest, clamp-to-edge)
  // sampler used for sprite / tilemap materials so pixel-art tiles render sharp.
  readonly nearestSampler: Sampler;
  readonly fallbackTextureView: TextureView;

  // bug-20260519: BUILTIN_CUBE / BUILTIN_TRIANGLE migrated to 12-floats
  // (position + normal + uv + tangent) so a single (`unlit-procedural` /
  // `standard`) pipeline pair handles all renderables. The legacy
  // `unlitBuiltinPipeline` + zero-stride `unlitBuiltinDummyAttrBuffer`
  // (which hard-coded uv = (0,0) for BUILTIN cubes) are deleted.
  //
  //   - `unlitPipeline` : unlit module + 12F vertex stride.
  //                                  Routed to every entity carrying a
  //                                  `MaterialAsset { shadingModel: 'unlit' }`.
  //   - `standardPipeline`        : pbr module + 12F vertex stride.
  //                                  Routed to every entity carrying a
  //                                  standard / GGX-PBR material.
  //
  // Both pipelines share the same 4-BindGroupLayout chain (view + material +
  // mesh-array + instances). The record stage selects between them on
  // `mat.shadingModel` only (D-2 BUILTIN-vs-procedural distinction retired).
  // bug-20260519 D-3: nullable when manifest carries zero entries (Camera-
  // only / clear-pass-only path; D-1 + D-2 + plan-strategy section 1
  // mermaid). The render-time access point in `render-system-record.ts`
  // narrows on `=== null` and fires a structured `RhiError
  // shader-compile-failed` (charter P3 explicit failure; AC-03).
  readonly unlitPipeline: RenderPipeline | null;
  readonly standardPipeline: RenderPipeline | null;
  /**
   * feat-20260604-learn-render-4.10-anti-aliasing-msaa M2 / w8: count=4
   * multisample variants of the 7 geometry pipelines that write the screen
   * or HDR colour target. A pipeline's `multisample.count` must match the
   * sampleCount of the colour attachment it writes (WebGPU validation),
   * so a count=4 pass cannot reuse a count=1 pipeline -- the record stage
   * picks the `*Msaa` variant when the active camera carries
   * `antialias === 'msaa'`. Post-process + shadow pipelines stay single-
   * sample (AC-06) and have no MSAA variant. `null` when the base pipeline
   * is null (empty-manifest path).
   */
  readonly unlitPipelineMsaa: RenderPipeline | null;
  readonly standardPipelineMsaa: RenderPipeline | null;
  readonly spritePipelineMsaa: RenderPipeline | null;
  readonly spritePipelineHdrMsaa: RenderPipeline | null;
  readonly unlitPipelineHdrMsaa: RenderPipeline | null;
  readonly standardPipelineHdrMsaa: RenderPipeline | null;
  /**
   * feat-20260523-shader-template-instance-split M9-T03 (D-PipelineBuilder):
   * the shared 4-BindGroupLayout chain pipeline layout (`[view, material,
   * mesh-array, instances]`) -- same handle the standard / unlit / sprite
   * pipelines share. M9 exposes it on PipelineState so the per-MaterialShader
   * pipeline cache (`getMaterialShaderPipeline`) can reuse it at lazy build
   * time without re-running pbrLayouts construction (charter P4 consistent
   * abstraction). `null` when the manifest is empty (Camera-only / clear-
   * pass-only path; bug-20260519 D-3 nullable).
   */
  readonly pbrPipelineLayout: PipelineLayout | null;
  /**
   * feat-20260609-hdrp-cluster-fragment-ggx M4.5 / w36 (D-10 option A):
   * per-variant PipelineLayout for HDRP. Mirrors `pbrPipelineLayout` but
   * substitutes the HDRP unified 7-slot group(2) BGL
   * (`createHdrpBindGroupLayoutDescriptor`) for the 1-slot pbr-mesh-array
   * BGL. Built once at boot and reused for any HDRP variant PSO. `null`
   * when the manifest is empty (parallel to `pbrPipelineLayout`) or when
   * the boot-time createBindGroupLayout / createPipelineLayout fails (in
   * which case `selectPipelineLayoutForVariant` falls back to the URP
   * `pbrPipelineLayout` instead of hard-disabling the build path).
   */
  readonly hdrpPbrPipelineLayout: PipelineLayout | null;
  /**
   * bug-20260611-skin-pipeline-layout: dedicated PipelineLayout for the
   * `forgeax::pbr-skin` material shader. Mirrors `pbrPipelineLayout` but
   * substitutes a 2-entry mesh-array BGL (binding 0 = meshes, binding 1 =
   * palette) for standard PBR's 1-entry mesh-array BGL. Built once at boot
   * by `buildPbrSkinLayouts` and selected by
   * `selectPipelineLayoutForVariant` when the caller passes
   * `LayoutKind = 'pbr-skin'`. `null` when manifest is empty or the skin
   * shader is not registered (storage-buffer cap gate / register failure);
   * `selectPipelineLayoutForVariant` returns `null` rather than silently
   * falling back to URP layout (charter P3 explicit failure, mirroring the
   * `hdrp-active-must-not-fallback-to-urp-pipeline` guard).
   */
  readonly pbrSkinPipelineLayout: PipelineLayout | null;
  /**
   * feat-20260611 R2 / M8 / w28 (IS-14): record-stage handle to the
   * 2-binding `pbr-skin-mesh-array-bgl` returned by `buildPbrSkinLayouts`
   * (binding 0 mesh-array UBO, binding 1 palette UBO; both
   * `hasDynamicOffset: true`). The record stage builds a BG against this
   * BGL for skin entries (`entry.source.skin !== undefined`) and binds it
   * at group(2) when the entry's pipeline layout is `pbr-skin-pl`. The
   * URP path keeps using `meshBindGroupLayout` (1-binding) at group(2),
   * so `pbr-mesh-array-bgl` is unchanged. Stays `null` when
   * `pbrSkinPipelineLayout` itself failed to build (charter P3 explicit
   * failure -- skin path is hard-disabled, mirroring the pipeline-layout
   * fallback in `selectPipelineLayoutForVariant`).
   */
  readonly pbrSkinMeshBindGroupLayout: BindGroupLayout | null;
  /**
   * feat-20260612-skin-palette-per-frame-upload M1 / m1-2: animator-ready
   * skin-palette storage allocator. Replaces the prior identity-buffer
   * stub (PR #353 / feat-20260611 R2 / M8 / w28 IS-14) -- a single 16320 B
   * identity-seeded UBO shared by every skin entry. The allocator owns the
   * lifecycle of the per-frame palette buffer (`createSkinPaletteAllocator`
   * from `./systems/skin-palette-allocator`); the record stage reads the
   * GPU buffer through `skinPaletteAllocator.buffer` and the extract stage
   * (M2) calls `allocateSlice` + `writeJointPalette` to land animated
   * palette data per skinned entity. Per plan-strategy D-1 candidate (b) the
   * allocator is the single authoritative carrier -- no parallel fallback
   * stub. `null` when `pbrSkinPipelineLayout` itself failed (skin path
   * hard-disabled, mirroring the prior stub field's gating).
   */
  readonly skinPaletteAllocator: SkinPaletteAllocator | null;
  /**
   * Sprite alpha-blend pipeline pair (feat-20260520-2d-sprite-layer-mvp
   * M-3 / w24 + @new-surface). Mirrors `unlitPipeline` / `standardPipeline`
   * shape: same 4-BindGroupLayout chain, same 12-float vertex stride, same
   * `pipelineLayoutResult` reference. The differences are:
   *
   *   - module = sprite.wgsl (4th engine entry; w20 vite-plugin-shader
   *     registration; sprite material reads colorTint / region /
   *     pivotAndSize uniforms + baseColor sampler + texture; the 4 unused
   *     binding-3..6 slots bind `defaultSampler` + `defaultWhiteTextureView`
   *     in the record stage via plan-strategy D-1 candidate (b)).
   *   - blend = premultiplied alpha (`one` / `one-minus-src-alpha`); sprite
   *     fragment emits premultiplied RGB so over-composite math is direct.
   *   - depthWriteEnabled = false; depthCompare = 'less-equal'. The
   *     transparent bucket runs back-to-front (post-sort, w23 CPU sort)
   *     under depth test only — the opaque bucket already wrote depth
   *     correctly so sprites occlude what is behind but do not write depth
   *     themselves (transparent layering convention).
   *
   * Routing: the record stage picks `spritePipeline` (LDR) when the active
   * camera carries `tonemap === 'none'` and `spritePipelineHdr` (HDR) when
   * `tonemap !== 'none'` — same gate the unlit / standard HDR siblings use.
   *
   * Null when the manifest carries the pre-feat 3-tuple (legacy back-compat
   * — apps that pinned manifest URL pre-feat-20260520 keep working without
   * sprite render; spawning a sprite material in that build raises
   * `shader-compile-failed` via the record stage's null-narrow path).
   */
  readonly spritePipeline: RenderPipeline | null;
  readonly spritePipelineHdr: RenderPipeline | null;
  // 1x1 white texture view (feat-20260518 M3 / w13 + AC-06): seeds the
  // baseColorTexture (binding 2) and metallicRoughnessTexture (binding 4)
  // entries when the schema-driven MaterialAsset paramValues omit the optional textures.
  // Reuses the same sampling-friendly default as `fallbackTextureView`
  // (above); the alias keeps the new MVP code path declarative without
  // renaming the existing field. Note: normalTexture (binding 6) does
  // NOT use this view -- it has its own RG-encoded fallback below.
  readonly defaultWhiteTextureView: TextureView;
  // 1x1 RGBA8 (128,128,255,255) view dedicated to the normalTexture slot
  // (binding 6). pbr.wgsl decodes sample.rg * 2 - 1 + z = sqrt(1-x^2-y^2),
  // so RG=(128,128)=0.5 maps to tangent (0,0,1) -- zero perturbation when
  // normalTexture is absent. White (255,255) would yield sqrt(1-2)=NaN
  // under saturate (clamps to 0) -> tangent.z=0 -> N rotated into the
  // tangent plane (severely wrong). Separate view because baseColor /
  // metallicRoughness require white-on-missing, normal requires (0,0,1).
  readonly defaultNormalTextureView: TextureView;

  // ── feat-20260519-tonemap-reinhard-mvp / M2 / T-M2.5 ──────────────────────
  //
  // HDR (rgba16float) variants of `unlitPipeline` / `standardPipeline`. AI
  // users opt in via `Camera.tonemap === 'reinhard-extended'`; the record
  // stage picks `unlitPipelineHdr` / `standardPipelineHdr` when the active
  // camera's tonemap field is non-'none', and writes the geometry pass into
  // `hdrColorView` instead of the swap-chain view. The post-process tonemap
  // pass then reads `hdrColorView` and writes the final LDR pixels into the
  // swap-chain view (charter P3 explicit failure: a wrong format combination
  // would otherwise silently produce mis-tonemapped pixels).
  //
  // Both HDR pipelines share the same 4-BindGroupLayout chain as their
  // sRGB siblings — only the colour-attachment format differs (D-2 +
  // plan-strategy D-3).
  //
  // bug-20260519 D-3 nullable extension: when the renderer starts with a
  // zero-entry shader manifest the entire HDR + tonemap-resource block in
  // `createRenderer.ts` is skipped (Camera-only / clear-pass-only path),
  // so these fields stay `null`. Record-stage HDR pipeline dispatch +
  // fullscreen tonemap pass narrow on `=== null` and fire structured
  // `shader-compile-failed` (charter P3 explicit failure; AC-03).
  readonly unlitPipelineHdr: RenderPipeline | null;
  readonly standardPipelineHdr: RenderPipeline | null;

  /**
   * feat-20260520-directional-light-shadow-mapping M2 / w14 (D-1):
   * 1x1 depth32float fallback bound at viewBindGroup binding(3) when no
   * shadow RT exists (castShadow:false or allocation failed).
   * Cleared to 1.0 (far plane) so comparison-sampler always returns fully lit.
   */
  readonly shadowFallbackTextureView: TextureView;

  /**
   * feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: 1x1x6
   * depth32float `texture_depth_cube_array` (layers=1) fallback bound at
   * viewBindGroup binding(5) when no PointLightShadow snapshots are active
   * (zero-shadow scene = AC-09 zero allocation -- the real cube_array atlas
   * stays in `ShadowAtlas` and is only allocated when the extract stage
   * sees its first PointLightShadow). Cleared to 1.0 so the
   * comparison-sampler returns fully lit on the no-shadow path. The view
   * dimension is `cube-array` to satisfy the BGL `viewDimension:
   * 'cube-array'`; the underlying texture has 6 layers (one cube).
   */
  readonly shadowAtlasFallbackTextureView: TextureView;

  /**
   * feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: 64 B uniform
   * buffer carrying `array<vec4<f32>, 4>` -- one lane per shadow-casting
   * point light slot. Lane N stores `(near, far, 1/(far-near), 0)` for the
   * point light with `shadowAtlasLayer === N`. Lanes for non-shadow-casting
   * slots stay zeroed; the WGSL sample path is gated by
   * `PointLight.shadowAtlasLayer >= 0` so zeroed lanes are never read.
   * Bound at viewBindGroup binding(6); written per frame from the
   * `pointShadowSnapshots` array.
   */
  readonly shadowParamsBuffer: Buffer;

  // feat-20260625-spot-light-shadow-mapping w25 (scope-amend webkit-fallback):
  // the per-spot fragment-read perspective lightViewProj matrices no longer
  // occupy a dedicated `spotLightViewProjBuffer` / view-BG binding 9 — they fold
  // into the View UBO tail (`view.spotLightViewProj`, bytes 528..784) written by
  // render-system-record's viewPayload. The standalone uniform buffer pushed the
  // WebGL2 fallback fragment uniform-buffer count to 12, over GLES 3.0's
  // `max_uniform_buffers_per_shader_stage = 11`. Caster vertex channel (binding
  // 7) is untouched: same-frame write contention only applies to casters (D-1).

  // ── feat-20260520-directional-light-shadow-mapping M2 / w15 (AC-12) ─────
  //
  // GPU shadow-factor probe pipeline. `debugSampleShadowFactor` packs N world
  // positions into `shadowProbeInputBuf` (`array<vec4<f32>, PROBE_MAX_COUNT>`),
  // writes the active lightSpaceMatrix into `shadowProbeLsmUbo`, builds a
  // transient BindGroup binding the active shadow texture + comparison
  // sampler, and renders 1 pixel per probe into `shadowProbeOutputTex`
  // (1xN r32float). The fragment stage runs `textureSampleCompareLevel`
  // byte-for-byte mirroring `pbr.wgsl::evalDirectional()`. The 1-row staging
  // buffer (256 B = PROBE_MAX_COUNT * 4 B; already 256B-aligned) is mapped
  // and the leading N floats returned. Compiled once at pipeline build time;
  // null when the shader manifest is empty (no probe possible).
  readonly shadowProbePipeline: RenderPipeline | null;
  readonly shadowProbeBindGroupLayout: BindGroupLayout | null;
  readonly shadowProbeLsmUbo: Buffer | null;
  readonly shadowProbeInputBuf: Buffer | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle (matches sibling fields)
  readonly shadowProbeOutputTex: any | null;
  readonly shadowProbeOutputView: TextureView | null;
  readonly shadowProbeStagingBuf: Buffer | null;

  /**
   * Fallback Skylight resource bundle (feat-20260520-skylight-ibl-cubemap
   * M2 round-2 / t40, plan-strategy D-5). 1x1 all-zero rgba16float
   * texture_cube * 2 (irradiance + prefilter) + 1x1 all-zero rg16float
   * brdfLut + intensity=0 16 B uniform buffer + 7-entry BindGroup compose
   * the @group(4) skylight binding for the "no Skylight ECS entity"
   * branch. The M4 round-2 recordFrame branch binds `bindGroup` when
   * `skylightCount === 0` so `standardPipeline` / `standardPipelineHdr`
   * (which keep a 4-slot pipeline layout per D-5 round-4) dispatch with
   * ambient=0 -- physical convergence with D-4 (charter F1: AI users
   * writing demos do not need a "is there a skylight?" branch).
   *
   * D-5 round-4: the fallback bundle no longer carries a stand-alone
   * BindGroup. The PBR material BindGroupLayout now holds 14 entries
   * (material 0..6 + Skylight 7..13) and the per-frame material
   * BindGroup assembly site (render-system-record) merges Skylight
   * resources at binding 7..13 -- active when a Skylight component
   * exists, fallback identity when `skylightCount === 0`.
   *
   * bug-20260519 D-3 nullable extension: the empty-manifest path
   * (Camera-only / clear-pass-only) skips the entire PBR pipeline build
   * block; we still allocate the fallback bundle in the normal path,
   * but tests / OOS paths that mock the manifest empty land here with
   * `null` (charter P3 explicit failure: M4 record-stage gates on
   * `skylightFallback !== null` before binding fallback resources at
   * material BG entries 7..13).
   */
  // biome-ignore lint/suspicious/noExplicitAny: opaque SkylightFallback shape
  readonly skylightFallback: any | null;

  /**
   * feat-20260529-rendergraph-pass-abstraction M3 / w11 (D-2 + Finding 3):
   * per-pass mutable texture cache slots extracted from the global
   * PipelineState. These fields are the lazily-allocated texture attachments
   * + pass-specific pipelines and bindgroups that belong to a single render
   * pass (depth / shadow / tonemap / FXAA). M4 render-graph resource
   * declarations will read these descriptors to derive transient/persistent
   * resources; shadow probe (OOS-4) stays on PipelineState directly.
   */
  readonly perPassResources: PerPassResources;
}

/**
 * Configure a canvas surface from the two PipelineState format fields, applying
 * the WebGL2-fallback gate (storage-buffer cap == 0 proxy): full WebGPU surface
 * (sRGB view format + RENDER_ATTACHMENT|TEXTURE_BINDING|COPY_SRC usage) when
 * storage buffers are available, single-format COLOR_TARGET-only surface on the
 * GLES fallback. Single SSOT for the configure descriptor consumed by both the
 * lazy first-frame path (ensureContextConfigured in createRenderer.ts) and the
 * F2 surface-outdated reconfigure-and-retry branch (render-system-record.ts) so
 * the two cannot drift (architecture-principles #1 SSOT). Returns the configure
 * Result; callers own the `state.perPassResources.configured` flag + the
 * `__forgeaxSwapChainFormat` probe write (those differ per call site).
 */
export function configureSurface(
  context: RhiCanvasContext,
  device: RhiDevice,
  format: string,
  colorAttachmentFormat: string,
): Result<void, RhiError> {
  const limitsHere = (device as { limits?: Readonly<Record<string, number>> }).limits;
  const storageCap = limitsHere?.maxStorageBuffersPerShaderStage ?? 1;
  const supportsViewFormats = storageCap > 0;
  return context.configure({
    device,
    format: (supportsViewFormats ? format : colorAttachmentFormat) as unknown as GPUTextureFormat,
    alphaMode: 'opaque',
    usage: supportsViewFormats ? 0x10 | 0x04 | 0x01 : 0x10,
    ...(supportsViewFormats
      ? { viewFormats: [colorAttachmentFormat as unknown as GPUTextureFormat] }
      : {}),
  });
}

/**
 * feat-20260529-rendergraph-pass-abstraction M3 / w11 (D-2):
 * per-pass mutable resource slots extracted from PipelineState per
 * research Finding 3 fact-based grouping (depth / shadow / tonemap / fxaa).
 * These fields are the lazily-allocated texture caches + pass-specific
 * pipeline/bindgroup handles that belong to a single render pass.
 * Mutable (non-readonly) because the record stage writes back after
 * lazy-alloc on size drift.
 */
export interface PerPassResources {
  /**
   * Per-frame depth attachment. Lazily allocated by
   * `ensureContextConfigured` and recreated whenever the canvas resizes
   * (see `ensureDepthTexture` in createRenderer.ts). Bound at the
   * `beginRenderPass.depthStencilAttachment` slot with `depthLoadOp:'clear'`
   * + `clearValue:1` so each frame starts with a far-plane depth buffer
   * and the back-face / inside-of-cube fragments are correctly occluded
   * (bug-20260519).
   *
   * `depthTextureView` is `null` until the canvas dimensions are known
   * (first draw); the record stage skips the frame and fires
   * `webgpu-runtime-error` if it stays null past configure.
   */
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle (matches sibling fields)
  depthTexture: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  depthTextureView: any | null;
  depthTextureWidth: number;
  depthTextureHeight: number;
  configured: boolean;

  // ── feat-20260519-tonemap-reinhard-mvp / M2 / T-M2.5 ──────────────────────
  // feat-20260621 M-A3 (D-5): the dedicated tonemap pipeline / BGL / sampler /
  // params-UBO fields are deleted — the built-in tonemap now flows through the
  // unified fullscreen post-process channel (`postProcess.register(
  // 'forgeax::tonemap', { source, params })` + the per-frame PostProcessParams
  // channel). dispatchFullscreenPass owns the pipeline (getPostProcessPipeline
  // cache), the BGL + sampler (buildFullscreenPostProcessPass), and the params
  // UBO (eager-created at register). Only the HDR colour/depth attachments below
  // remain here — they belong to the geometry pass, not the tonemap pass.

  /**
   * Lazy HDR colour + depth attachments for the opt-in tonemap path. Both
   * are `null` until the first frame whose active camera carries
   * `tonemap !== 'none'`; the record stage allocates them at the swap-chain
   * size and re-creates on resize (mirrors `depthTexture` / `depthTextureView`
   * idiom; AC-12).
   *
   * `hdrColor`'s format is `rgba16float` (AC-03(d)); the depth attachment is
   * the same `depth24plus-stencil8` format the geometry pipelines already declare
   * (`DEPTH_TEXTURE_FORMAT` SSOT in `createRenderer.ts`). When a camera
   * downgrades to `tonemap === 'none'` between frames the textures stay
   * allocated for cheap re-opt-in; full dispose happens via
   * `Renderer.dispose()` -> browser GC (matches the `depthTexture` fix-f6
   * placeholder).
   */
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle (matches sibling fields)
  hdrColorTexture: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  hdrColorView: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  hdrDepthTexture: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  hdrDepthView: any | null;
  hdrTextureWidth: number;
  hdrTextureHeight: number;
  /**
   * feat-20260604 M2 / w10: sampleCount the `hdrDepth` attachment was last
   * allocated at (1 or 4). The HDR colour target is always sampled
   * single-sample (`hdrColorView`); the depth pairs with the geometry colour
   * target's sampleCount, which flips with `antialias === 'msaa'`. Tracking it
   * lets the record stage reallocate depth when MSAA toggles between frames
   * (a stale count=4 depth under a count=1 pipeline fails WebGPU validation).
   */
  hdrDepthSampleCount: number;

  // -- feat-20260528-fxaa-post-processing M2 / w7 ----------------------------------
  //
  // FXAA fullscreen post-process pipeline resources. Mirrors the tonemap
  // pipeline shape: compiled at buildReadyWebGPU step 2 alongside the tonemap
  // pipeline and stored on PipelineState for per-frame consumption in the
  // record stage.
  //
  // D-2: 2-entry BGL (texture + sampler), no UBO. D-3: intermediate texture
  // format = bgra8unorm (swap-chain storage format). D-7: antialias=0
  // zero-overhead -- all FXAA fields stay null/0 until the first frame with
  // antialias='fxaa'.
  readonly fxaaPipeline: RenderPipeline | null;
  readonly fxaaBindGroupLayout: BindGroupLayout | null;
  readonly fxaaSampler: Sampler | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle (matches sibling fields)
  fxaaIntermediateTexture: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  fxaaIntermediateView: any | null;
  fxaaIntermediateWidth: number;
  fxaaIntermediateHeight: number;
  /** Cached FXAA BindGroup, invalidated on resize. */
  fxaaBindGroup: BindGroup | null;

  // ── feat-20260604-learn-render-4.10-anti-aliasing-msaa M2 / w7 ──────────
  //
  // MSAA (4x multisample) attachment slots. All `null`/0 until the first
  // frame whose active camera carries `antialias === 'msaa'`; the record
  // stage allocates them at the swap-chain size and re-creates on resize
  // (mirrors the hdrColor / fxaaIntermediate size-drift idiom; D-1). When
  // antialias is none/fxaa these stay null with zero allocation (C-9: MSAA
  // is a per-Camera switch derived from `camera.antialias === 'msaa'`, D-6).
  //
  // LDR swap-chain path (tonemapActive=false):
  //   ONE count=4 multisample texture backs both the geometry and sprite
  //   sub-passes. Two views of that same texture are taken: an srgb view
  //   (msaaColorView, geometry pass) and an unorm view (msaaSpriteColorView,
  //   sprite-split sub-pass; F-1). The single texture's storage format is
  //   bgra8unorm, so the srgb and unorm views are both valid view formats of
  //   it (same trick as the non-MSAA split path). The srgb view resolves to
  //   the swap-chain srgb view; the unorm view resolves to the swap-chain
  //   unorm view. No second multisample texture is allocated.
  //   msaaDepth (depth24plus-stencil8, count=4) -> paired, never resolved (D-3).
  //
  // HDR path (tonemapActive=true): hdrColor/hdrDepth are themselves
  //   allocated count=4 (record stage); hdrColorResolve is the single-sample
  //   resolve output the tonemap/bloom passes sample (AC-03).
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle (matches sibling fields)
  msaaColorTexture: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  msaaColorView: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  msaaSpriteColorTexture: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  msaaSpriteColorView: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  msaaDepthTexture: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  msaaDepthView: any | null;
  msaaTextureWidth: number;
  msaaTextureHeight: number;
  // HDR path MSAA: the count=4 multisample rgba16float geometry target. The
  // geometry + skybox passes write it; it resolves to the single-sample
  // `hdrColorView` (which the tonemap / bloom passes keep sampling unchanged).
  // Allocated alongside hdrColor when antialias='msaa' && tonemap!='none'.
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle (HDR multisample target)
  hdrColorMsaaTexture: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  hdrColorMsaaView: any | null;

  // ── feat-20260531-skybox-env-background M3 / w15 ─────────────────────────
  //
  // Skybox fullscreen cubemap pipeline resources. Mirrors tonemap/fxaa
  // construction: 3-entry BGL (texture_cube + sampler + View UBO), fullscreen
  // triangle vertex stage, cubemap-sample fragment stage. Skybox writes HDR to
  // hdrColor rgba16float (targeted by the hdrColor render target); the tonemap
  // pass later reads hdrColor and maps to the LDR swap-chain. Fields are null
  // when the manifest has no skybox entry (D-7 optional, legacy manifests
  // continue to boot).
  readonly skyboxPipeline: RenderPipeline | null;
  // feat-20260604 M2 / w8: count=4 multisample variant of the skybox pipeline.
  // Used when the active camera carries antialias='msaa' (the skybox writes the
  // count=4 hdrColorMsaa target alongside the main geometry pass). null when
  // the base skybox pipeline is null (legacy manifest) or its MSAA build failed.
  readonly skyboxPipelineMsaa: RenderPipeline | null;
  readonly skyboxBindGroupLayout: BindGroupLayout | null;
  readonly skyboxSampler: Sampler | null;
  /** Cached skybox BindGroup, rebuilt each frame when cubemap GpuView is fresh. */
  skyboxBindGroup: BindGroup | null;

  // ── feat-20260520-directional-light-shadow-mapping M1c / w8 ────────────
  //
  // Shadow RT (depth32float) lazy-allocated per mapSize; recreated on mapSize
  // drift. Used by the shadow depth pass (colorAttachments: []) and sampled
  // by the main pass as @group(0) binding(3) in M2/M3. debugReadback copies
  // the depth texture to a staging buffer for Inspector readback (D-2/D-5).
  //
  // feat-20260609 M4 / T-009: shadowCasterPipeline / shadowCasterPipelineLayout
  // removed — shadow PSO now obtained via frameState.pipelineCache lookup
  // (runtime.getMaterialShaderPipeline, passKind: 'shadow-caster'), same
  // path as forward passes (charter P4 consistent abstraction).
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  shadowTexture: any | null;
  shadowMapSize: number;
  shadowCascadeCount: number;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  shadowSampler: any | null;
  /**
   * feat-20260520-directional-light-shadow-mapping M1c / w11 +
   * feat-20260613-csm-cascaded-shadow-maps M5 / w28:
   * latest cascade-0 lightViewProj mat4 (16 f32, col-major). Kept under
   * the legacy field name as an Inspector backward-compat surface
   * (`runtime.lights.directionalShadow.lightSpaceMatrix` JSON-RPC), per
   * AGENTS.md §Change stance exception for external-visible wire
   * protocols with known downstream consumers. Populated each frame
   * from `lights.lightViewProj[0]`. Null before the first extract with
   * an active shadow-casting DirectionalLight.
   */
  shadowLightSpaceMatrix: Float32Array | null;
  /**
   * feat-20260613-csm-cascaded-shadow-maps M5 / w28: full 4-cascade
   * lightViewProj concatenation (4 × 16 = 64 f32, col-major) consumed by
   * `debugSampleShadowFactor` so the probe can pick the right cascade
   * geometrically (frustum containment). Null before the first extract
   * with an active shadow-casting DirectionalLight.
   */
  shadowCsmLightViewProj: Float32Array | null;

  // ── feat-20260531-bloom-first-declarative-render-graph-pass w13/w16 ────
  //
  // Bloom post-processing chain: 4 passes (bright / blur-H / blur-V / composite)
  // operating in HDR rgba16float domain. Pipeline handles assembled at
  // buildReadyWebGPU (optional — legacy manifests without bloom.wgsl leave
  // these null). Intermediate textures allocated lazily at 1/2-res in the
  // execute closures via ensureLazyTexture; size-drift rebuild invalidates
  // BindGroup caches.
  //
  // D-1: blur H/V share the same module, per-axis texelSize baked at UBO write.
  // D-4: 3 distinct BGL layouts (bright/blur: 1-tex+UBO, composite: 2-tex+UBO).
  // D-6: all intermediate textures use rgba16float format.
  readonly bloomBrightPipeline: RenderPipeline | null;
  readonly bloomBlurHPipeline: RenderPipeline | null;
  readonly bloomBlurVPipeline: RenderPipeline | null;
  readonly bloomCompositePipeline: RenderPipeline | null;
  readonly bloomBrightBindGroupLayout: BindGroupLayout | null;
  readonly bloomBlurBindGroupLayout: BindGroupLayout | null;
  readonly bloomCompositeBindGroupLayout: BindGroupLayout | null;
  readonly bloomSampler: Sampler | null;
  readonly bloomBrightParamsBuffer: Buffer | null;
  // bug-20260625: H and V blur passes need SEPARATE params UBOs. They run in
  // the same frame encoder; with one shared buffer the later writeBuffer (V's
  // texelSize=(0,1/h)) clobbers H's (texelSize=(1/w,0)) before the GPU runs the
  // H pass, so both passes blurred vertically -> only vertical bloom, no
  // horizontal spread. One buffer per axis keeps each pass's params intact.
  readonly bloomBlurHParamsBuffer: Buffer | null;
  readonly bloomBlurVParamsBuffer: Buffer | null;
  readonly bloomCompositeParamsBuffer: Buffer | null;

  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  bloomBrightTexture: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  bloomBrightView: any | null;
  bloomBrightWidth: number;
  bloomBrightHeight: number;

  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  bloomBlurHTexture: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  bloomBlurHView: any | null;
  bloomBlurHWidth: number;
  bloomBlurHHeight: number;

  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  bloomBlurVTexture: any | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  bloomBlurVView: any | null;
  bloomBlurVWidth: number;
  bloomBlurVHeight: number;

  /** Cached bloom-bright BindGroup, invalidated on resize. */
  bloomBrightBindGroup: BindGroup | null;
  /** Cached bloom-blur-H BindGroup, invalidated on resize. */
  bloomBlurHBindGroup: BindGroup | null;
  /** Cached bloom-blur-V BindGroup, invalidated on resize. */
  bloomBlurVBindGroup: BindGroup | null;
  /** Cached bloom-composite BindGroup, invalidated on resize. */
  bloomCompositeBindGroup: BindGroup | null;

  // ── feat-20260612-hdrp-ssao M6 / w26 + M8 / w37 + w38 ───────────────────
  //
  // SSAO post-processing chain: 2 passes (calc + blur) operating on
  // half-resolution R8 single-channel textures. RenderPipeline handles
  // assembled at buildReadyWebGPU (optional — manifests without
  // hdrp-ssao.wgsl leave these null). Dedicated BGL (9 entries matching
  // current WGSL @group(0) bindings 0-8) shared by both pipelines: calc
  // and blur both bind all 9 entries; the blur uses ssaoRaw (binding 7) +
  // ssaoSampler (binding 8) while the calc binds a 1x1 fallback view at
  // 7 (the calc shader never samples ssaoRaw).
  // plan-strategy D-A; D-D; D-E.
  //
  // Samplers (filtering + non-filtering depth) and the 1x1 ssaoRaw fallback
  // view used by the calc pass are lazy-allocated inside the record closure
  // on first frame and cached on the mutable slots below — keeps createRenderer
  // free of additional state and matches bloom's lazy bind-group pattern.
  readonly ssaoCalcPipeline: RenderPipeline | null;
  readonly ssaoBlurPipeline: RenderPipeline | null;
  readonly ssaoBgl: BindGroupLayout | null;
  /** Filtering sampler shared by ssao_noise_sampler (binding 3) + ssaoSampler (binding 8). */
  ssaoFilteringSampler: Sampler | null;
  /** Non-filtering sampler dedicated to hdr_depth (binding 6); WebGPU validation. */
  ssaoDepthSampler: Sampler | null;
  /** 1x1 fallback view bound at ssaoRaw (binding 7) in the calc pass. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
  ssaoFallbackRawView: any | null;
  /** Cached calc-pass bind group (lazy on first frame; rebuilt if views drift). */
  ssaoCalcBindGroup: BindGroup | null;
  /** Cached blur-pass bind group (lazy on first frame; rebuilt if ssaoRaw view drifts). */
  ssaoBlurBindGroup: BindGroup | null;
}

export interface MeshGpuHandles {
  /**
   * Vertex buffer wrapped as a GpuBuffer (M-3 / w11). Consumers reach the
   * raw RHI Buffer via `.handle` for `setVertexBuffer` etc.; `.destroy()`
   * routes through the RHI shim's lifecycle SSOT (charter §F1 single-entry
   * indexability + plan-strategy D-9 wrapper migration).
   */
  readonly vertexBuffer: GpuBuffer;
  /**
   * Index buffer wrapper, or `null` for a vertex-only mesh (no
   * `MeshAsset.indices`). When `null` the record stage takes the non-indexed
   * `pass.draw(vertexCount)` path and never calls `setIndexBuffer`. Gated
   * on `indexed` below.
   */
  readonly indexBuffer: GpuBuffer | null;
  /** Allocation byte size of the vertex buffer (mirrors GPUBuffer.size). */
  readonly vboBytes: number;
  /** Allocation byte size of the index buffer, or 0 when `indexBuffer` is null. */
  readonly iboBytes: number;
  readonly indexCount: number;
  /**
   * Index buffer format inferred from the source `MeshAsset.indices` typed
   * array (`Uint16Array` -> `'uint16'`, `Uint32Array` -> `'uint32'`). The
   * record stage threads this into `pass.setIndexBuffer(..., format)` so
   * the GPU reads the correct stride per index. bug-20260519: the prior
   * hard-coded `'uint16'` corrupted procedural meshes whose factories
   * (`createBoxGeometry` etc) emit Uint32Array indices.
   */
  readonly indexFormat: 'uint16' | 'uint32';
  /**
   * Vertex layout discriminator stamped at upload time. `'12F'` = 48 B
   * (position+normal+uv+tangent); BUILTIN and procedural geometry stay 12F
   * (bug-20260519). `'18F'` = 72 B (12F + skinIndex uint16x4 + skinWeight
   * float32x4) for skinned glTF meshes (feat-20260611). The MeshRenderData
   * (render-data.ts) / MeshGpuEntry (gpu-resource-store.ts) / MeshGpuHandles
   * layout fields are the same union and move together.
   */
  readonly layout: '12F' | '18F';
  /**
   * Vertex count = `vertices.length / (layout === '18F' ? 18 : 12)`. The
   * non-indexed draw path passes this to `pass.draw(vertexCount)`.
   */
  readonly vertexCount: number;
  /**
   * True when the mesh carries an index buffer (`MeshAsset.indices` present).
   * `false` for vertex-only meshes. The record stage branches on this to pick
   * `drawIndexed` vs `draw` and to gate `setIndexBuffer`.
   */
  readonly indexed: boolean;
  /**
   * Primitive topology of this mesh (first submesh's topology, default
   * 'triangle-list'). WebGPU bakes topology into the immutable PSO, so the
   * record stage threads this into `getMaterialShaderPipeline` to select a
   * per-topology PSO (feat-20260604 M3 / w9).
   *
   * feat-20260608 M4 / w16: topology is per-submesh; this field reflects
   * `submeshes[0].topology` for backward compat. Use `submeshes` field for
   * per-submesh draw iteration.
   */
  readonly topology: PrimitiveTopology;
  /**
   * Submeshes from MeshAsset.submeshes, carried through from the GPU store
   * so the record stage can iterate per-submesh drawIndexed (feat-20260608 M4 / w16).
   */
  readonly submeshes: readonly import('@forgeax/engine-types').Submesh[];
}

export function createRenderSystem(internals: RenderSystemInternals): RenderSystem {
  // Per-RenderSystem frame state: closure-internal frameNumber + the
  // per-entity instance GPU buffer cache (feat-20260514 M3 / w15: the
  // record stage owns GPU storage buffer allocation for Instances entities;
  // the `instanceBuffers` map is keyed by the packed Entity u32 surfaced
  // through `InstancesSnapshot.cacheKey` and rebuilds buffers on archetype
  // version bump or byte-length change). The legacy
  // `lastFiredLimitExceededFrame` engine-side dedup field was removed in
  // feat-20260513-instanced-mesh M5 (T-M5-1 + T-M5-3); the active
  // `'limit-exceeded'` emit point is now the record stage upload path.
  const frameState: RenderFrameState = {
    frameNumber: 0,
    perFrameGraph: null,
    instanceBuffers: new Map(),
    warnedZeroLightStandard: false,
    warnedMultiLightDirectional: false,
    warnedMultiLightPoint: false,
    warnedMultiLightSpot: false,
    warnedSkyboxTonemapNone: false,
    // feat-20260520-2d-sprite-layer-mvp M-3 / w25 (AC-18 path 4): per-
    // handle warn-once anchor for the sprite-bucket missing-texture
    // fallback. Set<number> keyed by raw Handle<TextureAsset>; never
    // cleared (charter F1 minimal surface — the per-RenderSystem lifetime
    // is the natural upper bound).
    warnedMissingSpriteTextureHandles: new Set<number>(),
    // feat-20260527-sprite-nineslice M2 / w11 + M4 / w16 (AC-16): once-per-
    // renderable guard for the runtime `nineslice.scale-too-small` metric
    // counter (`runtime.metrics.increment(...)` in render-system-record.ts).
    warnedNineSliceScaleEntities: new Set<number>(),
    // feat-20260622-handle-to-id-allocator-elimination M1 / w3: per-frame
    // bind group caches as nested WeakMap chain roots. viewBindGroupCache
    // covers main and shadow variants; meshBindGroupCache keys on inner
    // buffer handles (D-3). Roots are init-time stable (never cleared).
    viewBindGroupCache: new WeakMap(),
    meshBindGroupCache: new WeakMap(),
    // feat-20260622-handle-to-id-allocator-elimination M1 / w2: per-entity
    // material and instances caches (outer Map<entityKey, WeakMap>).
    materialBgPerEntity: new Map(),
    instancesBgPerEntity: new Map(),
    // cross-entity shared material cache (outer Map<shaderId, WeakMap>).
    materialBgShared: new Map(),
    // singleton material cache (flat Map<variant, BindGroup>; D-6).
    singletonMaterialCache: new Map(),
    // feat-20260601-customizable-render-pipeline-seam M1 / w7: installed-pipeline state.
    // 0 = nothing installed yet (createRenderer dogfood installs the default before any
    // draw). activePipeline defaults to the built-in forward pipeline.
    installedPipelineHandle: 0,
    activePipeline: urpPipeline,
    // feat-20260601 verify round 2: the standard forward pipeline installs with no config
    // (its topology is frame-invariant). installPipeline overwrites this with the resolved
    // asset's `config` on every swap so a custom pipeline reads its install-time config.
    installedPipelineConfig: undefined,
    // feat-20260608-cluster-lighting M2 / w10 + M5 / w20: HDRP active flag + once-per-frame
    // warn dedup set for hdrp-light-budget-exceeded / hdrp-index-list-overflow.
    isHdrpActive: false,
    hdrpOncePerFrameFired: new Set(),
    // feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-2 (plan-strategy §D-1):
    // cube_array shadow atlas + per-frame snapshot list. Atlas is null until the
    // first frame whose extracted lights.pointShadow is non-empty (zero-shadow
    // scenes never allocate; AC-09); the snapshot list defaults to an empty
    // tuple so the URP `addPointShadowPass` gate sees zero shadow lights as the
    // initial steady state.
    pointShadowAtlas: null,
    pointShadowSnapshots: [],
    // feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4 (D-1):
    // initial fold-bucket count is 0; recordFrame writes the per-frame
    // value from foldDispatchBuckets(...) before dispatch.
    lastFoldBucketCount: 0,
    // feat-20260625-spot-light-shadow-mapping M2 / w9 (D-2): empty initial spot
    // shadow snapshot list so the spotShadowDepth caster pass renders zero
    // tiles until the first frame with a castShadow spot (AC-03).
    spotShadowSnapshots: [],
  };
  // feat-20260601 M1 / w7: pipeline registry (id -> impl) + the handle the memoized
  // perFrameGraph was last built for. Both live in the createRenderSystem closure
  // (plan-strategy D-D: all real logic on the RenderSystem layer; the Renderer facade
  // only forwards). The registry dedups same-id register (Map.has -> throw), mirroring
  // ShaderRegistry.registerMaterialShader.
  const pipelineRegistry = new Map<string, RenderPipelineDef>();
  let lastBuiltPipelineHandle = 0;
  // Monotonic install epoch: bumped on every installPipeline call to brand the
  // installed pipeline so `draw` can detect a swap and rebuild the per-frame
  // graph. Replaces the prior raw-handle brand (D-19: installPipeline takes a
  // POD, no handle).
  let installEpoch = 0;
  // feat-20260604-resource-owning-render-graph-and-fullscreen-postpr M2 / w13:
  // post-process shader registry (id -> PostProcessShaderEntry), parallel to pipelineRegistry.
  // Dedups same-id register (Map.has -> throw), mirroring ShaderRegistry.registerMaterialShader.
  const postProcessRegistry = new Map<string, PostProcessShaderEntry>();
  // D-3 / D-8: per-shader params UBO resource table (id -> GPU Buffer).
  // Eager-created at register time when entry.params is present (byteSize >= 16,
  // defaultValue.length === byteSize); reused frame-to-frame via queue.writeBuffer.
  const postProcessParamsBuffers = new Map<string, Buffer>();
  // F-2 fix-up: expose registry lookup through the narrow runtime surface so
  // addFullscreenPass's execute closure (in render-graph-primitives.ts) can
  // resolve a registered shader id without reaching into RenderSystemInternals.
  // Inject as a post-construction property on `internals` (typed as readonly
  // optional on RenderSystemRuntime, so a one-time cast is the only path);
  // every consumer that types `RenderPipelineContext.runtime` will see it.
  const lookupPostProcess = (id: string): PostProcessShaderEntry | undefined =>
    postProcessRegistry.get(id);
  (internals as unknown as { lookupPostProcess: typeof lookupPostProcess }).lookupPostProcess =
    lookupPostProcess;
  // feat-20260621 M-A2 / w8: expose the eager-created per-id params UBO through
  // the narrow runtime surface so dispatchFullscreenPass can writeBuffer the
  // per-frame snapshot + bind it at group(1) binding(2).
  const getPostProcessParamsBuffer = (id: string): Buffer | undefined =>
    postProcessParamsBuffers.get(id);
  (
    internals as unknown as { getPostProcessParamsBuffer: typeof getPostProcessParamsBuffer }
  ).getPostProcessParamsBuffer = getPostProcessParamsBuffer;
  // feat-20260609 M4 / T-10-a: post-process pipeline cache (id|colorFormat -> RhiRenderPipeline).
  // Solves CONCERN-1: dispatcher previously passed `pipeline=null` to
  // built.createHandle because per-frame execute closures cannot await async
  // shader compile. The cache here delegates the actual build to
  // `internals.buildPostProcessPipeline` (sync wrapper over the shared shader
  // adapter; 1-frame warmup), then memoizes by `id|colorFormat`.
  const postProcessPipelineCache = new Map<string, RenderPipeline>();
  const getPostProcessPipeline = (
    id: string,
    bgl: BindGroupLayout,
    colorFormat: GPUTextureFormat,
  ): RenderPipeline | null => {
    const key = `${id}|${colorFormat}`;
    const cached = postProcessPipelineCache.get(key);
    if (cached !== undefined) return cached;
    const entry = postProcessRegistry.get(id);
    if (entry === undefined) return null;
    const factory = internals.buildPostProcessPipeline;
    if (factory === undefined) return null;
    const built = factory(entry, bgl, colorFormat, `post-process-${id}`);
    if (built === null) return null;
    postProcessPipelineCache.set(key, built);
    return built;
  };
  (
    internals as unknown as { getPostProcessPipeline: typeof getPostProcessPipeline }
  ).getPostProcessPipeline = getPostProcessPipeline;
  // w15 M5 (plan-strategy D-P4 / AC-07): per-frame dispatch counters. Reset
  // on every `draw(world)` entry; bumped once per actual `pass.setPipeline`
  // dispatch in render-system-record.ts. Two-way split mirrors the two
  // render pipelines on PipelineState (bug-20260519: BUILTIN cube migrated
  // to 12F so `unlitBuiltin` retired): `unlit` covers every
  // unlit material, `standard` covers every PBR material.
  const dispatchCounts: { unlit: number } = {
    unlit: 0,
  };
  // feat-20260531-per-frame-bind-group-cache M1 / w4: per-frame
  // createBindGroup counter scaffolding. Reset on every draw(world) entry,
  // bumped on cache-miss in render-system-record.ts (M2-M4 bump points).
  // Aligns with dispatchCounts precedent: closure-mutable object.
  const bindGroupCounts: { createBindGroup: number; keys: string[] } = {
    createBindGroup: 0,
    keys: [],
  };
  const lastFrustumStats: { culled: number; total: number } = { culled: 0, total: 0 };
  return {
    draw(world: World): void {
      try {
        // feat-20260601 M1 / w7: pipeline hot-swap detection. If the installed handle
        // changed since the memoized graph was built (a SWAP, not an effect toggle), null
        // perFrameGraph so recordFrame rebuilds it via the now-active pipeline impl. The
        // brand-number compare is the cheap gate; the rebuild reuses the existing
        // perFrameGraph === null memoization path.
        if (frameState.installedPipelineHandle !== lastBuiltPipelineHandle) {
          frameState.perFrameGraph = null;
          lastBuiltPipelineHandle = frameState.installedPipelineHandle;
        }
        dispatchCounts.unlit = 0;
        // feat-20260601 D-3: the render path reads the resolved `Transform.world`
        // mat4 for every world-space consumer (extract mesh-walk / camera / light
        // / cull). That column is derived by `propagateTransforms`; running it at
        // the top of draw guarantees a fresh world for any caller, including
        // `createRenderer` demos that drive `renderer.draw(world)` directly
        // without a `world.update()` schedule tick (requirements line 221:
        // createRenderer auto-wire fallback). It is idempotent -- a createApp
        // driver that already ran propagate via the schedule recomposes the same
        // world (compose -> multiply, no decompose), so the second pass is a
        // redundant-but-correct write, not a behaviour change. Errors route
        // through the World Layer-3 ErrorHandler (a stale ChildOf surfaces as a
        // structured `hierarchy-broken`), matching the schedule path.
        const propagateResult = propagateTransforms(world);
        if (!propagateResult.ok) {
          (world as unknown as { _routeError(err: Error, ctx: ErrorContext): void })._routeError(
            propagateResult.error as unknown as Error,
            {
              severity: Severity.Error,
              systemName: 'RenderSystem.draw (propagateTransforms)',
            },
          );
        }
        const {
          cameras,
          lights,
          renderables,
          dispatch,
          skylight,
          skylightCount,
          skybox,
          skyboxCount,
          frustumStats,
          postProcessParams,
        } = extractFrame(world, internals.assets, internals.getPipelineState(), internals.gpuStore);
        bindGroupCounts.createBindGroup = 0;
        bindGroupCounts.keys = [];
        lastFrustumStats.culled = frustumStats.culled;
        lastFrustumStats.total = frustumStats.total;

        // Unified transparent-sort: (layer ASC, sortValue ASC) for modes 0/1/2;
        // distance back-to-front for mode=3. `world` and the camera/renderable
        // snapshots are only in scope here (the record stage no longer receives
        // `world` after the render-graph refactor), so the sub-sort runs at
        // the extract/record boundary. Only the Transparent segment is
        // reordered; queue ordering between segments (sortDispatchByQueue,
        // stable) is preserved.
        const orderedDispatch = sortTransparentDispatch(dispatch, world, cameras, renderables);

        // M3 / w26: single dispatch list replaces old three-bucket model.
        // Pass dispatch to recordFrame — the record stage iterates dispatch
        // entries in queue order per plan-strategy D-3.
        recordFrame(
          internals,
          world,
          cameras,
          lights,
          renderables,
          orderedDispatch,
          frameState,
          dispatchCounts,
          bindGroupCounts,
          skylight,
          skylightCount,
          skybox,
          skyboxCount,
          postProcessParams,
        );
      } catch (err) {
        const innerError =
          err instanceof RhiError
            ? err
            : { code: 'unknown' as const, message: String(err), name: (err as Error)?.name };
        internals.errorRegistry.fire(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'RenderSystem to record one frame without an internal exception',
            hint: 'inspect detail.error for the underlying cause; next frame will retry',
            detail: { error: innerError },
          }),
        );
      }
    },
    pipelineDispatchCounts: dispatchCounts,
    bindGroupCounts: bindGroupCounts,
    frustumStats: lastFrustumStats,
    get perFramePassNames(): readonly string[] {
      return frameState.perFrameGraph?.listPasses().map((p: { name: string }) => p.name) ?? [];
    },
    // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
    getCurrentShadowView(): any | null {
      return frameState.perFrameGraph?.getColorTargetView('shadowDepth') ?? null;
    },
    registerPipeline(id: string, impl: RenderPipelineDef): void {
      if (pipelineRegistry.has(id)) {
        throw new PipelineError({ code: 'pipeline-already-registered', detail: { id } });
      }
      pipelineRegistry.set(id, impl);
    },
    installPipeline(asset: RenderPipelineAsset): Result<void, PipelineError> {
      const impl = pipelineRegistry.get(asset.pipelineId);
      if (impl === undefined) {
        return err(
          new PipelineError({ code: 'pipeline-not-found', detail: { handle: installEpoch } }),
        );
      }
      // feat-20260608-cluster-lighting M2 / w10: HDRP grid validation.
      // When the pipelineId is 'forgeax::hdrp', validate clusterGrid dimensions
      // before installing. Grid-invalid throws a standalone HdrpInstallError
      // (NOT in RuntimeErrorCode; synchronous install-time config error).
      //
      // feat-20260608-cluster-lighting M5 / w20: HDRP caps gate.
      // Before grid validation, check device.caps.maxStorageBuffersPerShaderStage >= 4.
      // Caps insufficient throws HdrpCapsInsufficientError (RuntimeErrorCode member,
      // synchronously at install time).
      if (asset.pipelineId === 'forgeax::hdrp') {
        const storageBuffersCap = internals.device.limits.maxStorageBuffersPerShaderStage;
        if (storageBuffersCap < 4) {
          throw new HdrpCapsInsufficientError(
            'maxStorageBuffersPerShaderStage',
            storageBuffersCap,
            4,
          );
        }
        const grid = asset.config?.clusterGrid ?? { x: 16, y: 9, z: 24 };
        const gridResult = validateClusterGrid(grid);
        if (!gridResult.ok) {
          throw gridResult.error;
        }
      }
      frameState.activePipeline = impl;
      // installPipeline no longer carries a handle (D-19: RenderPipelineAsset is
      // installed as a POD at boot/swap time before any World exists). The
      // brand-number that `draw` compares to force a per-frame graph rebuild is
      // now a monotonic epoch bumped on every install -- distinct configs (and
      // even identical re-installs) trigger the rebuild, which is correct: install
      // is a rare boot/swap event, never a per-frame cost.
      installEpoch += 1;
      frameState.installedPipelineHandle = installEpoch;
      frameState.isHdrpActive = asset.pipelineId === 'forgeax::hdrp';
      // feat-20260601 verify round 2: thread the install-time config to buildGraph. The
      // install epoch changes on every install (two assets sharing one logic id
      // but differing in config get different epochs), so the `draw` brand-number compare
      // already forces a graph rebuild; the rebuilt graph now reads this config via
      // RenderPipelineData.config. config.passCount is no longer a silent no-op.
      frameState.installedPipelineConfig = asset.config;
      return ok(undefined);
    },
    postProcess: {
      register(id: string, entry: PostProcessShaderEntry): void {
        if (postProcessRegistry.has(id)) {
          throw new PostProcessError({
            code: 'post-process-already-registered',
            detail: { id },
          });
        }
        // D-3: eager-create params UBO at register time + fail-fast
        // byteSize / defaultValue validation (q5=A).
        if (entry.params !== undefined) {
          const { byteSize, defaultValue } = entry.params;
          if (byteSize < 16 || defaultValue.length !== byteSize) {
            throw new PostProcessError({
              code: 'params-size-mismatch',
              detail: { byteSize, actualLength: defaultValue.length },
            });
          }
          const paramsBufferResult = internals.device.createBuffer({
            label: `post-process-params-${id}`,
            size: byteSize,
            usage: 0x40 /* UNIFORM */ | 0x08 /* COPY_DST */,
            mappedAtCreation: false,
          });
          if (!paramsBufferResult.ok) throw paramsBufferResult.error;
          postProcessParamsBuffers.set(id, paramsBufferResult.value);
          // Write initial defaultValue into the eager-created UBO.
          const writeResult = internals.device.queue.writeBuffer(
            paramsBufferResult.value,
            0,
            defaultValue,
          );
          if (!writeResult.ok) throw writeResult.error;
        }
        postProcessRegistry.set(id, entry);
      },
    },
    disposeFrameState(): void {
      // feat-20260612 M5 / w21 (plan-strategy D-2 steps 2 + 3): drain the
      // perFrameGraph's pooled textures and walk the instanceBuffers cache.
      // Both calls are idempotent + tolerate per-handle errors silently;
      // the Renderer.dispose() cascade owns the surrounding try/catch
      // (D-3 method A: void signature, sub-errors fan out via
      // errorRegistry.fire at the cascade layer, dispose still walks all
      // 6 steps).
      const graph = frameState.perFrameGraph;
      if (graph !== null) {
        graph.drain();
        frameState.perFrameGraph = null;
      }
      // feat-20260619 M4 (D-6): pass errorRegistry to disposeInstanceBuffers
      // so destroy failures fire structured errors (unified per-frame +
      // dispose error strategy).
      disposeInstanceBuffers(frameState.instanceBuffers, internals.errorRegistry);
      // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-2: dispose the
      // cube_array shadow atlas owned by the RenderSystem closure. The atlas
      // is per-RenderSystem (= per Renderer) and is shared transparently
      // between URP and HDRP pipelines (recordPointShadowPass reads it from
      // frameState; the buildGraph closures of both pipelines invoke the
      // same addPointShadowPass primitive, so a single atlas serves both).
      // Idempotent: dispose() on a null / already-disposed atlas is a no-op.
      if (frameState.pointShadowAtlas !== null) {
        frameState.pointShadowAtlas.dispose();
        frameState.pointShadowAtlas = null;
      }
    },
    resetForRecover(): void {
      // feat-20260622-s5 M3 / B-2 / w18: recover() rebuild drops device-bound
      // state minted by the lost device. (1) graph pendingDestroy (stale
      // handles, skip device.destroyTexture); no-op when no graph compiled yet.
      frameState.perFrameGraph?.clearPendingDestroy();
      // (2) post-process registry + eager param UBOs: the rebuild's
      // buildReadyWebGPU re-registers the engine tonemap, which would throw
      // `post-process-already-registered` against a populated registry; the
      // UBOs are stale lost-device handles released with the device.
      postProcessRegistry.clear();
      postProcessParamsBuffers.clear();
    },
  };
}

// F-1 single-import contract part 3/3: AI users discover RenderSystem +
// builtin handles + AssetRegistry from the same `@forgeax/engine-runtime` import.
export const RENDER_SYSTEM_BUILTIN_HANDLES = Object.freeze({
  cube: HANDLE_CUBE,
  triangle: HANDLE_TRIANGLE,
});
