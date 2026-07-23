// @forgeax/engine-runtime - RenderPipelineContext (the clean dependency face a
// RenderPipeline.buildGraph / .execute closure consumes) + RenderPipelineData (the
// per-frame projected snapshot)
// (feat-20260601-customizable-render-pipeline-seam-and-dogfood-rend M2 / w10).
//
// This type replaces the former full-field `RecordPassContext` (26 top-level fields,
// one of which - `internals: RenderSystemInternals` - was itself a ~16-field
// kitchen-sink). The whole point of M2 is that `internals` is GONE: a pipeline author
// can no longer reach the entire `RenderSystemInternals` private surface through the
// public pipeline ctx. `ctx.internals` is a compile error (the AC-08 oracle); the
// genuine runtime dependencies are now named, narrow surfaces.
//
// UE mental model (requirements: anchor the clean ctx on Unreal vocabulary):
//   - The per-VIEW input aggregate (camera + targets + the validated draw list + the
//     per-frame bind groups + the per-frame flags) is the forgeax analogue of UE's
//     `FSceneView` - the stable-per-view render inputs a pass reads.
//   - The RESOURCE + RUNTIME carriers (`assets` / `store` / `pipelineState` / `runtime`)
//     are the analogue of UE's `FRDGBuilder` handle - the substrate a pass uses to
//     resolve resources and record GPU work. The #289 three-layer surface lands here:
//     `assets` = CPU POD (AssetRegistry), `store` = GPU residency (GpuResourceStore),
//     `pipelineState` = the prebuilt per-RenderSystem GPU layouts/buffers.
//
// Field grouping below is documented (FSceneView vs FRDGBuilder) with grep-able field
// names so an AI user reading the type knows what each field is FOR, not just its type.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { BindGroup, RhiCommandEncoder, Texture, TextureView } from '@forgeax/engine-rhi';
import type { RenderPipelineAsset } from '@forgeax/engine-types';
import type { GpuResourceStore } from './gpu-resource-store';
import type {
  BindGroupCounts,
  DispatchCounts,
  RenderFrameState,
  ValidatedRenderable,
} from './record';
import type { PipelineState, RenderSystemRuntime } from './render-system';
import type {
  CameraSnapshot,
  DispatchEntry,
  SkyboxSnapshot,
  SkylightSnapshot,
} from './render-system-extract';

/**
 * Narrow runtime-services carrier handed to pipeline pass closures (UE `FRDGBuilder`
 * analogue, runtime half). The named, minimal replacement for the four
 * `RenderSystemInternals` members the 9 urp closures genuinely reach: the
 * GPU `device`, the `errorRegistry` structured-error sink, and the two per-MaterialShader
 * pipeline-cache / param-schema lookups. Deliberately NOT the full `RenderSystemInternals`
 * - a pipeline author sees exactly these four services and nothing else (charter P4: a
 * consistent narrow abstraction over the runtime, not the kitchen-sink).
 *
 * SSOT for the member types lives in `render-system.ts` `RenderSystemRuntime`; re-exported
 * here so a pipeline author importing the ctx type sees the runtime-services shape too.
 */
export type { RenderSystemRuntime } from './render-system';

/**
 * The clean dependency face a `RenderPipeline.buildGraph(ctx, data)` and each render-graph
 * pass `execute(ctx)` closure consumes. Strictly smaller and strictly named relative to
 * the former `RecordPassContext`: `internals: RenderSystemInternals` is gone (replaced by
 * the named `assets` / `store` / `pipelineState` / `runtime` surfaces) and the
 * 0-consumed `skyboxCount` residual is dropped.
 *
 * feat-20260604 M3 / w20 (D-7 breaking direct cut, no deprecation/shim/dual-path):
 * SIX urp-specific leakage fields are gone from the public surface
 * (`tonemapActive` / `geometryColorView` / `geometryDepthView` / `skyboxActive` /
 * `splitLdrSprite` / `ldrSpriteUnormView`). They were urp-private
 * post-process gating + RT view selection state that an AI-user-defined custom
 * pipeline must NOT see — pipelines pick their own colour/depth target via
 * `addColorTarget` and route per-frame branches through `RenderPipelineData`
 * (which retains the projection of these flags for buildGraph-time topology
 * decisions). The six fields persist as a package-internal extension consumed
 * by the urp record* closures only (see `_StandardForwardSceneView`
 * in `render-system-record.ts`).
 *
 * The 3 MSAA fields (`msaaActive` / `geometryColorResolveView` /
 * `ldrSpriteColorView`) are KEPT — MSAA renders are not urp-
 * specific; any pipeline using `addColorTarget({sample:4})` needs the
 * resolve targets in scope.
 *
 * Two documented groups (UE mental model):
 *
 * 1. PER-VIEW INPUTS (UE `FSceneView`) - the stable-per-view render inputs:
 *    `encoder` / `view` / `clear` / `targetW` / `targetH` / `currentTexture` / `camera`
 *    / `validated` / `validatedOrdered` / `viewBindGroup` / `meshBindGroup` /
 *    `frameState` / `dispatchCounts` / `bindGroupCounts` / `skylight` /
 *    `skylightCount` / `skybox` / `msaaActive` / `geometryColorResolveView` /
 *    `ldrSpriteColorView`.
 *
 * 2. RESOURCE + RUNTIME CARRIERS (UE `FRDGBuilder` + #289 three-layer):
 *    `assets` (CPU POD) / `store` (GPU residency) / `pipelineState` (prebuilt GPU
 *    layouts/buffers) / `runtime` (device + errorRegistry + shader-cache lookups).
 */
export interface RenderPipelineContext {
  // ── Resource + runtime carriers (FRDGBuilder + #289 three-layer) ──────────
  /** CPU POD registry (#289 layer 1). Pipeline closures read `assets.get<T>(handle)`. */
  readonly assets: AssetRegistry;
  /** GPU residency store (#289 layer 2). `store.ensureResident` + `store.getXxxGpuView`. */
  readonly store: GpuResourceStore;
  /** Prebuilt per-RenderSystem GPU layouts / buffers / pipelines (#289 layer 3). */
  readonly pipelineState: PipelineState;
  /** Narrow runtime services (device + errorRegistry + shader-cache lookups). */
  readonly runtime: RenderSystemRuntime;

  // ── Per-view inputs (FSceneView) ─────────────────────────────────────────
  readonly encoder: RhiCommandEncoder;
  readonly view: TextureView;
  readonly clear: readonly [number, number, number, number] | number[];
  readonly targetW: number;
  readonly targetH: number;
  readonly currentTexture: Texture;
  readonly camera: CameraSnapshot;
  readonly validated: readonly ValidatedRenderable[];
  readonly validatedOrdered: readonly ValidatedRenderable[];
  readonly viewBindGroup: BindGroup | null;
  readonly meshBindGroup: BindGroup | null;
  readonly frameState: RenderFrameState;
  readonly dispatchCounts: DispatchCounts;
  readonly bindGroupCounts: BindGroupCounts;
  readonly skylight: SkylightSnapshot | undefined;
  readonly skylightCount: number;
  readonly skybox: SkyboxSnapshot | undefined;
  /**
   * Per-frame post-process params snapshot collected from PostProcessParams
   * entities (D-1: data-driven params channel). Maps shader id to raw
   * bytes (Uint8Array). dispatchFullscreenPass queries this map per-shader.
   * Empty when no PostProcessParams entities exist.
   */
  readonly postProcessParams: ReadonlyMap<string, Uint8Array>;

  // ── MSAA (feat-20260604-learn-render-4.10-anti-aliasing-msaa M2 / w9-w10) ──
  /**
   * True when the active camera requests MSAA and the RHI reports a compatible
   * backend. Derived from `camera.antialias` plus the device capability, never
   * stored separately (C-9 / D-6). When true the geometry pass writes a count=4
   * multisample colour target and resolves to a single-sample output; when
   * false every attachment / pipeline is single-sample (including the
   * capability-accurate WebGL2 fallback route).
   */
  readonly msaaActive: boolean;
  /**
   * Single-sample resolve output for the main geometry colour pass when
   * `msaaActive`. LDR path: the swap-chain srgb view; HDR path: the
   * `hdrColorResolve` view the tonemap / bloom passes sample. `null` when
   * `msaaActive` is false (no resolve target -- direct single-sample render).
   */
  readonly geometryColorResolveView: TextureView | null;
  /**
   * Count=4 multisample unorm view the LDR sprite split sub-pass writes when
   * `msaaActive && splitLdrSprite`; it resolves to the single-sample
   * `ldrSpriteUnormView`. This is an unorm view of the SAME count=4 texture
   * the geometry pass writes through its srgb view (`msaaColorView`) -- one
   * multisample texture, two views of differing format (the bgra8unorm
   * storage format admits both srgb and unorm views). `null` when `msaaActive`
   * is false. (F-1)
   */
  readonly ldrSpriteColorView: TextureView | null;
}

/**
 * Per-frame projected render-data snapshot handed to `RenderPipeline.buildGraph` as the
 * second argument. The D-B litmus splits `RenderPipelineContext` from this type:
 * cross-frame-stable dependencies live on `ctx`; per-frame recomputed quantities live on
 * `data`. A pipeline that needs to branch its topology on per-frame state (e.g. a custom
 * pipeline sizing its pass count from a config) reads `data`; the standard forward
 * pipeline's topology is frame-invariant, so it ignores `data`.
 *
 * The fields here are the subset of per-view inputs that are recomputed every frame
 * (the camera snapshot, the validated draw lists, the target dimensions, the per-frame
 * skylight/skybox/tonemap/sprite flags). They are ALSO present on `ctx` for the execute
 * closures (which read a single ctx argument); `data` re-surfaces them at buildGraph time
 * so a pipeline can shape its graph before any closure runs.
 *
 * `config` carries the currently installed `RenderPipelineAsset.config` verbatim (the
 * per-install tuning POD). `installPipeline` stores it on the RenderSystem frame state and
 * the record stage projects it onto this snapshot, so a pipeline's `buildGraph` reads its
 * own install-time config at topology-build time (feat-20260601 verify round 2: config was
 * formerly dropped at the seam, making `config.passCount` a silent no-op; it is now threaded
 * end-to-end). `undefined` when the installed asset declared no `config`. The standard
 * forward pipeline ignores it (frame-invariant topology); a custom pipeline reads
 * `data.config?.passCount` to size its declared pass chain (AC-03, one-logic-N-configs).
 */
export interface RenderPipelineData {
  readonly camera: CameraSnapshot;
  readonly validated: readonly ValidatedRenderable[];
  readonly validatedOrdered: readonly ValidatedRenderable[];
  readonly targetW: number;
  readonly targetH: number;
  readonly skylight: SkylightSnapshot | undefined;
  readonly skylightCount: number;
  readonly skyboxActive: boolean;
  readonly skybox: SkyboxSnapshot | undefined;
  readonly tonemapActive: boolean;
  readonly splitLdrSprite: boolean;
  readonly config: RenderPipelineAsset['config'];
  /**
   * ECS-driven shadow map size (px square). The standard forward pipeline reads
   * this at buildGraph time to size the `shadowDepth` color target; `undefined`
   * (or 0) means no shadow caster is wired and the pipeline falls back to a
   * 1024 default declaration (the `shadow` pass is gated downstream by
   * `shadowMapSize > 0` in recordFrame, so a fallback texture is harmless).
   * Drift is rare in practice (a session installs one shadow map size and
   * keeps it); when it does change, recordFrame nulls `perFrameGraph` to
   * force a rebuild on the next frame.
   */
  readonly shadowMapSize: number | undefined;
  /**
   * feat-20260613-csm-cascaded-shadow-maps M3 / w12: effective cascade count
   * from DirectionalLight.cascadeCount (1..4). Drives atlas tilesPerSide /
   * atlasSize and the N-pass addShadowPass loop in urp-pipeline. undefined when
   * castShadow is disabled (fallback single 1024px shadow pass).
   */
  readonly cascadeCount: number | undefined;
}

/**
 * @internal — package-private extension consumed by urp record*
 * closures only. NOT exported from the runtime barrel; AI-user-defined custom
 * pipelines see the public `RenderPipelineContext` shape only (D-7).
 *
 * The six fields here used to live on the public `RenderPipelineContext` until
 * w20 narrowed it. They carry the urp post-process gating +
 * geometry RT view selection state the record* closures depend on:
 *
 * - `tonemapActive`: HDR -> LDR tonemap branch (also on `RenderPipelineData`
 *   for buildGraph-time topology decisions).
 * - `geometryColorView`/`geometryDepthView`: pre-resolved RT views the main
 *   pass writes (HDR-or-swap-chain colour, per-pass-or-HDR depth). After M3
 *   these come from the graph (resolve(name) in execute closure), so a
 *   future-pure addScenePass closure would receive them via resolve().
 * - `skyboxActive`: gates the recordSkyboxPass body.
 * - `splitLdrSprite`: gates the LDR sprite split sub-pass within recordMainPass
 *   / recordTonemapPass.
 * - `ldrSpriteUnormView`: the unorm view the sprite split writes (paired with
 *   the bgra8unorm-srgb view the geometry pass uses; F-1 dual-view single
 *   texture pattern).
 *
 * Invariant: a public `RenderPipelineContext` cast to this type by
 * `_asInternalCtx` (in render-system-record.ts) MUST originate from
 * recordFrame's passCtx builder; downstream consumers (custom pipelines) MUST
 * NOT cast — these fields are not part of the public contract.
 */
export interface _StandardForwardSceneView {
  /**
   * @internal — feat-20260614 M8 (D-19): the live World the record stage
   * resolves user-tier asset handles against. Asset payloads moved off the
   * AssetRegistry onto `world.sharedRefs`, so `resolveAssetHandle(world, handle)`
   * is the only resolution entry point; the record stage threads the World here
   * (it is not part of the public `RenderPipelineContext` — custom pipeline
   * authors never see it).
   */
  readonly world: World;
  readonly tonemapActive: boolean;
  readonly geometryColorView: TextureView | null;
  readonly geometryDepthView: TextureView | null;
  readonly skyboxActive: boolean;
  readonly splitLdrSprite: boolean;
  readonly ldrSpriteUnormView: TextureView | null;
  /** feat-20260609 M2: per-frame dispatch entries for selector-based pass filtering. */
  readonly dispatch: readonly DispatchEntry[];
  /**
   * @internal — feat-20260609-hdrp-cluster-fragment-ggx M4 / w15.
   *
   * The unified group(2) BindGroup the HDRP cluster-forward path binds at the
   * mesh slot. Carries the mesh SSBO at binding 0 (with dynamic offset, same
   * buffer as URP's `meshBindGroup`) plus the 4 HDRP cluster buffers at
   * bindings 3..6 (light_data / cluster_grid / light_index_list /
   * cluster_uniform). Non-null when `frameState.isHdrpActive` AND the HDRP
   * buffers have been allocated for the runtime; `null` on URP frames or when
   * HDRP buffer allocation failed.
   *
   * Plan D-4 (no `extraBindGroups` patch): the cluster bindings flow through
   * an explicit field on the internal scene-view extension; AI-user-defined
   * custom pipelines never see it (extension is `@internal`). recordMainPass
   * destructures it and selects it instead of `meshBindGroup` at
   * `setBindGroup(2, ...)` on HDRP frames; the single dynamic offset
   * (`i * MESH_PER_ENTITY_STRIDE`) stays valid because binding 0 of the unified
   * BGL is the same per-entity mesh SSBO.
   */
  readonly hdrpClusterBindGroup: BindGroup | null;
  /**
   * @internal — feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 /
   * w4-record-swap (D-1).
   *
   * The per-frame fold dispatch plan keyed by validatedOrdered index.
   * `null` when `transparentDispatch.length === 0` or when no fold-eligible
   * (bucketSize > 1) bucket exists this frame — the dispatch loops fall
   * through to the existing per-entity drawIndexed path byte-identically.
   *
   * Non-null carries:
   * - `headBuckets[i]` — bucket descriptor for index `i` (head of an
   *   instanced draw); the dispatch loop overrides @group(3) instances BG
   *   and emits one `drawIndexed(idxCount, bucket.bucketSize)`.
   * - `skipIndices[i]` — true when index `i` is a non-head member of
   *   a fold bucket; the dispatch loop emits `continue`.
   *
   * Plan D-1 (record-stage transparent fold): the plan reuses the
   * transparent-sort equivalence class as the bucket key, so no new
   * BinKey type. Mode-gate (D-5): only mode 0 produces non-singleton
   * buckets; modes 1/2/3 produce all-singleton plans which are byte-
   * identical to no plan.
   */
  readonly foldDispatchPlan: import('./render-system-fold').FoldDispatchPlan | null;
  /**
   * @internal — feat-20260612-hdrp-ssao wiring fix.
   *
   * The compiled `ssaoBlurred` graph-transient TextureView, resolved inside the
   * HDRP forward pass execute closure (the only place `resolveCtx` is live) and
   * stashed here for recordMainPass to build the SSAO-enabled unified group(2)
   * bind group. `undefined` when SSAO is disabled or on URP frames — then
   * recordMainPass keeps the white-fallback bind group (identity AO=1.0).
   *
   * Mutable (not readonly): the forward pass closure assigns it per frame just
   * before delegating to recordMainPass. The group(2) bind group cannot carry
   * the view ahead of graph.execute because the texture is a graph transient.
   */
  hdrpSsaoBlurredView?: import('@forgeax/engine-rhi').TextureView;
}

/**
 * @internal — the type passed to urp record* closures by
 * `recordFrame`. Public `RenderPipelineContext` plus the six urp
 * scene-view leakage fields under a flat structure (so existing destructures
 * like `c.tonemapActive` continue to work without churn). Custom pipelines
 * must NOT see this type.
 */
export type _InternalRenderPipelineContext = RenderPipelineContext & _StandardForwardSceneView;
