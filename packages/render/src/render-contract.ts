import type { AssetRuntimeError } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { Vec3 } from '@forgeax/engine-math';
import type { ProfileFrameToken, Profiler } from '@forgeax/engine-profiler';
import type { RenderGraphError } from '@forgeax/engine-render-graph';
import type {
  BindGroupLayout,
  Buffer,
  Result,
  RhiCaps,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  RhiInstance,
  RhiRenderPassEncoder,
  RenderPipeline as RhiRenderPipeline,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import type { SkinError } from '@forgeax/engine-skinning';
import type { ImageError } from '@forgeax/engine-types';
import type { RhiBackendInstrumentation } from './assembly/backend-contract';
import type { Antialias, BloomEnabled, Tonemap } from './components/camera';
import type { RenderError } from './errors/render';
import type { RenderFeature, RenderFeatureDiagnostics } from './features/types';
import type { PostProcessShaderEntry } from './fullscreen-post-process-pass';
import type { RenderSceneInspection } from './inspection-types';

export type { PointsLinesInspection } from './points-lines/inspection';

import type { MeshMaterialBindingObservation } from './mesh-material-bindings';
import type { StandardProfile } from './pipeline/standard-profile';
import type { PostProcessError } from './post-process-errors';

export type RenderResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** The only World data boundary accepted by the M6 renderer contract. */
export type RenderWorldLease = RenderReadLease;

/**
 * Camera facts shared by extract, record, and scene owners.
 *
 * The extract stage resolves ECS camera state once and publishes this closed
 * POD contract. Keeping it beside the render lifecycle contracts prevents
 * extract from depending on the record implementation owner.
 */
export interface CameraSnapshot {
  /** Stable ECS identity used by the frame plan's camera authority fact. */
  readonly entityKey?: number;
  /** World-space camera translation (mat4.getTranslation of Transform.world). */
  readonly position: Vec3;
  /** Resolved world-space camera mat4, copied from Transform.world. */
  readonly world: Float32Array;
  readonly fov: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  /** Camera projection variant used by view and shadow matrix builders. */
  readonly projection: 'perspective' | 'orthographic';
  readonly orthoLeft: number;
  readonly orthoRight: number;
  readonly orthoBottom: number;
  readonly orthoTop: number;
  readonly tonemap: Tonemap;
  readonly exposure: number;
  readonly whitePoint: number;
  readonly antialias: Antialias;
  readonly bloom: BloomEnabled;
  readonly bloomThreshold: number;
  readonly bloomIntensity: number;
  readonly bloomBlurRadius: number;
  readonly clearColor: readonly [number, number, number, number];
}

/** Stable identity owned by the Standard feature host for built-in tonemap. */
export const STANDARD_TONEMAP_FEATURE_ID = 'forgeax::standard::tonemap';

/**
 * Render-graph state exposed to pipeline declarations. Concrete pipeline
 * caches stay in the assembly owner; graph code only needs the two target
 * formats that affect fullscreen descriptors.
 */
interface RenderPipelineStateView {
  readonly format: TextureFormat;
  readonly colorAttachmentFormat: TextureFormat;
}

/**
 * Narrow runtime capability consumed by typed graph primitives. The concrete
 * RenderSystemRuntime structurally satisfies this contract, but the public
 * frame surface does not depend on that assembly owner.
 */
interface RenderPipelineRuntime {
  readonly device: RhiDevice;
  readonly errorRegistry: { fire(error: RendererError): void };
  readonly debugOverlay?: RenderDebugOverlay | undefined;
  readonly lookupPostProcess?: (id: string) => PostProcessShaderEntry | undefined;
  readonly getPostProcessParamsBuffer?: (id: string) => Buffer | undefined;
  readonly getPostProcessPipeline?: (
    id: string,
    bgl: BindGroupLayout,
    colorFormat: GPUTextureFormat,
  ) => RhiRenderPipeline | null;
}

/**
 * Render-owned declaration for an app-provided debug overlay. App owns the
 * concrete DebugDraw instance and its GPU lifecycle; Render only records this
 * capability in the typed graph.
 */
export interface RenderDebugOverlay {
  encode(
    pass: RhiRenderPassEncoder,
    viewProj: import('@forgeax/engine-math').Mat4,
  ): Result<void, unknown>;
}

/**
 * The leaf frame context consumed by RenderPipeline and graph primitives.
 * Concrete assembly data is added only by the internal record extension in
 * render-system.ts, so this contract never imports the RenderSystem owner.
 */
export interface RenderPipelineContext {
  readonly pipelineState: RenderPipelineStateView;
  readonly runtime: RenderPipelineRuntime;
  readonly encoder: RhiCommandEncoder;
  readonly view: TextureView;
  readonly clear: readonly [number, number, number, number] | number[];
  readonly targetW: number;
  readonly targetH: number;
  readonly currentTexture: Texture;
  readonly camera: CameraSnapshot;
  /** Per-frame post-process parameter bytes keyed by shader id. */
  readonly postProcessParams: ReadonlyMap<string, Uint8Array>;
  readonly msaaActive: boolean;
  readonly geometryColorResolveView: TextureView | null;
  readonly ldrSpriteColorView: TextureView | null;
}

/**
 * The sole public renderer contract. Concrete assembly stays behind the host;
 * callers retain only leases, receipts, inspection PODs, and recovery Result.
 */
export interface Renderer {
  attach(world: World): RenderResult<RenderWorldLease, RenderError>;
  draw(input: RenderFrameInput): RenderResult<FrameReceipt, RenderError>;
  setProfile(profile: RenderProfile): RenderResult<void, RenderError>;
  state(): RendererState;
  inspect(): RenderInspection;
  observe(
    receipt: FrameReceipt,
    request: FrameObservationRequest,
  ): Promise<RenderResult<FrameReceiptObservation, RenderError>>;
  subscribe(listener: (event: RendererEvent) => void): () => void;
  releaseSurface(): RenderResult<void, RenderError>;
  restoreSurface(): RenderResult<void, RenderError>;
  recover(): Promise<RenderResult<void, RenderError>>;
  dispose(): Promise<RenderResult<void, RenderError>>;
}

/** The single public renderer lifecycle authority. */
export type RendererState = 'alive' | 'device-lost' | 'recovering' | 'faulted' | 'disposed';

/** Immutable, inspectable quality and budget policy for the Standard pipeline. */
export type RenderProfile = StandardProfile;

/** Ordered events projected from renderer state and expected-operation failures. */
export type RendererEvent =
  | {
      readonly kind: 'state-changed';
      readonly previous: RendererState;
      readonly current: RendererState;
    }
  | { readonly kind: 'error'; readonly error: RenderError }
  /** Emitted only after the renderer's sole submit path returns a receipt. */
  | {
      readonly kind: 'frame-submitted';
      readonly frameId: number;
      readonly deviceGeneration: number;
    };

/** Package-local listener alias used by the renderer assembly implementation. */
export type RendererEventListener = (event: RendererEvent) => void;

/**
 * Camera authority supplied for one frame; Render owns the lease contract and
 * the host releases it with the frame lifecycle. It is intentionally bound to
 * the attached scene lease and never accepts a backend object.
 */
export interface FrameCamera {
  readonly lease: RenderWorldLease;
  readonly entityKey?: number;
}

/**
 * Environment authority supplied for one frame. The scene/environment owner
 * supplies the identity; the host validates it against the attached lease.
 */
export interface FrameEnvironment {
  readonly lease: RenderWorldLease;
  readonly identity?: string;
}

/**
 * Receipt-bound observation selection. The request is consumed by `observe`
 * only with the matching FrameReceipt and returns a structured Result error
 * when the generation or frame identity is stale.
 */
export interface FrameObservationRequest {
  readonly include: readonly ('timings' | 'draws' | 'bindings')[];
}

/**
 * Immutable synchronous proof that the sole host-owned submit reached the
 * queue. It is the only successful synchronous draw signal and is required by
 * every observation request.
 */
export interface FrameReceipt {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly completed: Promise<RenderResult<void, RenderError>>;
}

/**
 * The sole public draw input; World objects never cross this boundary. Render
 * owns extraction and graph interpretation, while the host owns encoding,
 * finish, submit, and recovery of the attached lease generation.
 */
export interface RenderFrameInput {
  readonly leases: readonly RenderWorldLease[];
  readonly camera: FrameCamera;
  readonly environment: FrameEnvironment;
  /** Optional profiler correlation token owned by App and consumed by Render. */
  readonly profileFrame?: ProfileFrameToken;
}

/** Detached, bounded observation metadata tied to one FrameReceipt and request. */
export interface FrameReceiptObservation {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly include: readonly ('timings' | 'draws' | 'bindings')[];
}

/**
 * Detached renderer facts for host diagnostics and capability selection.
 *
 * The snapshot contains only POD values. It never exposes a device, queue,
 * registry, encoder, or live renderer-owned collection.
 */
export interface RenderInspection {
  readonly state: RendererState;
  readonly surface: 'available' | 'released';
  readonly profile: RenderProfile;
  readonly capabilities: Readonly<RhiCaps>;
  readonly frame: {
    readonly frameId: number;
    readonly deviceGeneration: number;
  };
  readonly features: readonly string[];
  /** Truthful lifecycle facts for every registered declarative feature. */
  readonly featureDiagnostics: readonly RenderFeatureDiagnostics[];
  readonly frustumStats: { readonly culled: number; readonly total: number };
  readonly visibilityStats: { readonly explicitlyHidden: number };
  readonly renderScene: RenderSceneInspection;
  readonly meshMaterialBindings: readonly MeshMaterialBindingObservation[];
  readonly perFramePassNames: readonly string[];
  readonly bindGroupCounts: {
    readonly createBindGroup: number;
    readonly keys: readonly string[];
  };
}

/** Backend marker — single-element union preserved for future extensibility (D-2). */
/**
 * `renderer.draw(worlds, options)` owner options
 * (feat-20260709-editor-world-partition M1 / w6, plan-strategy §2 D-3).
 *
 * The single `owner` index that previously served BOTH the surfaced cameras
 * and the singleton render resources (skylight / skybox / postProcessParams) is
 * split into two independent indices:
 *   - `cameraOwner`   — the world whose cameras are surfaced.
 *   - `resourceOwner` — the world whose skylight / skybox / postProcessParams
 *                       are surfaced.
 *
 * Both owners are always explicit. Single-world callers pass zero for both;
 * composite callers may select different worlds.
 */
export type DrawOwnerOptions = {
  readonly cameraOwner: number;
  readonly resourceOwner: number;
  readonly profileFrame?: ProfileFrameToken;
};

/** Information attached to a device-loss notification. */
export interface RendererLostInfo {
  /** Concise machine-readable cause, mapped to a single vocabulary. */
  reason: string;
  /** Free-form description (UA / extension / driver text). */
  message: string;
}

/** Listener registered through `Renderer.onLost`. */
export type RendererLostListener = (info: RendererLostInfo) => void;

/**
 * Composite error type retained for package-local renderer diagnostics. The
 * public Renderer projects expected operation failures through the single
 * `subscribe` event stream and its `error` event; this type does NOT define a
 * error; it only references the cluster unions whose members can arrive here.
 * As such it is an external wire alias (AGENTS.md Change stance add-only wire
 * exception), NOT the eliminated cross-cluster `RuntimeError` SSOT (D-3).
 *
 * Composition = `RhiError | RenderError | AssetRuntimeError | SkinError |
 * PostProcessError`. This equals the pre-decomposition
 * `RhiError | RuntimeError | PostProcessError` exactly: `RuntimeError` was
 * `RenderError | AssetRuntimeError | SkinError` (27 classes). `RecoverError`
 * and `EngineEnvironmentError` are intentionally excluded — neither is ever
 * emitted through the Renderer event stream (`RecoverError` returns from `recover()`,
 * `EngineEnvironmentError` throws at construction), matching the original
 * `RuntimeError` union which excluded both (OOS-3 behavior equivalence).
 *
 * AI consumers do `switch (err.code)` over the union: the disjoint
 * `RhiErrorCode` / `RenderErrorCode` / `AssetRuntimeErrorCode` / `SkinErrorCode`
 * / `PostProcessErrorCode` literal sets let TS narrow each arm to the concrete
 * class (charter P3 union discoverability — every fan-out member is reachable
 * in an exhaustive switch, no untyped escape). Example:
 *
 * ```ts
 * renderer.subscribe((event) => {
 *   if (event.kind !== 'error') return;
 *   switch (event.error.code) {
 *     case 'asset-not-registered': // AssetRuntimeError arm, err narrowed here
 *       return report(err.hint);
 *     // ...one arm per RhiErrorCode | RenderErrorCode | AssetRuntimeErrorCode
 *     //    | SkinErrorCode | PostProcessErrorCode member; no default needed,
 *     //    TS flags every unhandled code at compile time.
 *   }
 * });
 * ```
 */
export type RendererError =
  | RhiError
  | RenderGraphError
  | ImageError
  | RenderError
  | AssetRuntimeError
  | SkinError
  | PostProcessError;

/**
 * Package-local error listener retained for host assembly. Public consumers
 * use `Renderer.subscribe` and receive `RendererEvent` instead.
 */
export type RendererErrorListener = (error: RendererError) => void;

/**
 * Built-in graph pass owners used as nested children of `record/graph-execute`.
 * Unknown extension pass names use the explicit `other` bucket so custom
 * pipelines retain a bounded catalog while the default render workload gets
 * actionable owner attribution.
 */
export const RENDER_GRAPH_EXECUTION_PHASE_CATALOG = [
  'record/graph-execute/point-shadow',
  'record/graph-execute/cluster-binner-upload',
  'record/graph-execute/g-buffer',
  'record/graph-execute/g-buffer/geometry-loop',
  'record/graph-execute/g-buffer/material-bind-groups',
  'record/graph-execute/g-buffer/pipeline-selection',
  'record/graph-execute/g-buffer/draw-submit',
  'record/graph-execute/ssao-calc',
  'record/graph-execute/ssao-blur',
  'record/graph-execute/lighting',
  'record/graph-execute/forward',
  'record/graph-execute/forward/geometry-loop',
  'record/graph-execute/forward/material-bind-groups',
  'record/graph-execute/forward/pipeline-selection',
  'record/graph-execute/forward/draw-submit',
  'record/graph-execute/tonemap',
  'record/graph-execute/debug-overlay',
  'record/graph-execute/shadow',
  'record/graph-execute/spot-shadow',
  'record/graph-execute/skybox',
  'record/graph-execute/main',
  'record/graph-execute/fxaa',
  'record/graph-execute/bloom-bright',
  'record/graph-execute/bloom-blur-h',
  'record/graph-execute/bloom-blur-v',
  'record/graph-execute/bloom-composite',
  'record/graph-execute/other',
] as const;

export type RenderGraphExecutionPhase = (typeof RENDER_GRAPH_EXECUTION_PHASE_CATALOG)[number];

/** Bounded producer-owned children of the scene-state record owner. */
export const RENDER_HDRP_BINNER_PHASE_CATALOG = [
  'record/scene-state/hdrp-cluster/binner/light-bounds-and-occupancy',
  'record/scene-state/hdrp-cluster/binner/light-bounds-and-occupancy/light-aabb',
  'record/scene-state/hdrp-cluster/binner/light-bounds-and-occupancy/cluster-occupancy',
  'record/scene-state/hdrp-cluster/binner/cluster-reserve',
  'record/scene-state/hdrp-cluster/binner/input-preparation',
  'record/scene-state/hdrp-cluster/binner/bin-core',
  'record/scene-state/hdrp-cluster/binner/light-index-write',
  'record/scene-state/hdrp-cluster/binner/light-index-write/bounds-read',
  'record/scene-state/hdrp-cluster/binner/light-index-write/cluster-write',
] as const;

export const RENDER_HDRP_CLUSTER_PHASE_CATALOG = [
  'record/scene-state/hdrp-cluster/binner',
  ...RENDER_HDRP_BINNER_PHASE_CATALOG,
  'record/scene-state/hdrp-cluster/payload-packing',
  'record/scene-state/hdrp-cluster/buffer-upload',
] as const;

export type RenderHdrpClusterPhase = (typeof RENDER_HDRP_CLUSTER_PHASE_CATALOG)[number];

export const RENDER_SCENE_STATE_PHASE_CATALOG = [
  'record/scene-state/fold-buckets',
  'record/scene-state/lighting-prep',
  'record/scene-state/ambient-resolution',
  'record/scene-state/directional-shadow-cache',
  'record/scene-state/hdrp-cluster',
  ...RENDER_HDRP_CLUSTER_PHASE_CATALOG,
] as const;

/**
 * Opt-in boundaries inside one `Renderer.draw` call. The observer is a
 * diagnostics seam only: it receives wall-time boundaries and must never be
 * required for rendering correctness. The stage names mirror the existing
 * engine-owned Extract / Prepare / Record orchestration so a host can measure
 * attribution without guessing from RHI command counts.
 */
export const RENDER_RECORD_PHASE_CATALOG = [
  'record/scene-state',
  ...RENDER_SCENE_STATE_PHASE_CATALOG,
  'record/swapchain',
  'record/render-graph',
  'record/target-views',
  'record/validation',
  'record/dispatch-plan',
  'record/uploads',
  'record/bind-groups',
  'record/graph-execute',
  ...RENDER_GRAPH_EXECUTION_PHASE_CATALOG,
] as const;

export type RenderRecordPhase = (typeof RENDER_RECORD_PHASE_CATALOG)[number];

export const RENDER_PHASE_CATALOG = [
  'extract',
  'bind-groups',
  'features',
  'sort',
  'record',
  ...RENDER_RECORD_PHASE_CATALOG,
] as const;

export type RenderPhase = (typeof RENDER_PHASE_CATALOG)[number];

export type RenderPhaseSkipReason =
  | 'feature-host-unavailable'
  | 'feature-host-empty'
  | 'pipeline-state-unavailable'
  | 'camera-unavailable';

/** First-version options bag (intentionally empty; reserved for v0.1). */
export interface RendererOptions {
  /** Producer-owned features installed by the renderer host. */
  readonly features?: readonly RenderFeature<unknown>[] | undefined;
  /** Standard profile consumed by the single renderer-owned pipeline. */
  readonly standardProfile?: RenderProfile | undefined;
  /** Explicit profiler capability shared by App and Render. */
  readonly profiler?: Profiler | undefined;
  /** Optional host-owned RHI lifecycle instrumentation, such as recording. */
  readonly rhiInstrumentation?: RhiBackendInstrumentation | undefined;
  // feat-20260608-create-app-param-surface-trim / M1 / AC-02: `clearColor`
  // was deleted as a one-cut breaking change (AGENTS.md Change stance +
  // requirements constraint #1: no deprecation window, no shim). Scene
  // clear color now lives on the Camera entity (`clearColor`, an inline
  // array<f32,4> column as of feat-20260709 M3); zero-Camera fallback uses
  // `ZERO_CAMERA_CLEAR_FALLBACK = [0, 0, 0, 1]` from
  // `render-system-record`. AI users that pass `{ clearColor: [...] }` on
  // RendererOptions still get a TS2353 excess-property error at compile time.
  //
  // feat-20260608-create-app-param-surface-trim / M2 / AC-06 + D-3:
  // `shaderManifestUrl` was deleted from RendererOptions and moved to
  // the third-arg `BundlerOptions` (build-tool injection channel). The
  // fallback literal '/shaders/manifest.json' stays at the createRenderer
  // body site (D-2 q5-A) so the LO 1.1 zero-config takeoff path keeps
  // working without explicit injection. AI users that pass
  // `{ shaderManifestUrl: '...' }` to RendererOptions get a TS2353
  // excess-property error at compile time pointing them to the third
  // arg (charter P1 progressive disclosure -- the message names
  // BundlerOptions, not a free-form string).
  /**
   * M3 D-P4 escape hatch (feat-20260511-rhi-wgpu-impl): explicit
   * `RhiInstance` injection bypasses the dynamic-import auto-select
   * facade. When set, `createRenderer` uses this instance verbatim and
   * neither concrete backend adapter is imported dynamically (charter
   * proposition 5 discoverable opt-in /
   * plan-strategy §6 M3 + §7.4 escape hatch + Bevy
   * `RenderCreation::Manual` partial equivalent).
   *
   * Typical use cases:
   *   - Testing / debugging — inject a deterministic stub.
   *   - Pinning a specific backend even when the browser adapter is present,
   *     for cross-shim regression tests.
   *   - Advanced AI users implementing their own `RhiInstance` shim.
   *
   * AI users who want the default behaviour leave this field omitted;
   * `navigator.gpu` presence/absence drives the dynamic import (see the
   * `createRenderer` JSDoc for the full auto-select decision tree).
   */
  readonly rhi?: RhiInstance | undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Renderer health / recover surface (feat-20260621-renderer-health-recover-skeleton M1)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Closed union of renderer health states.
 *
 * 3 members per plan-strategy D-1:
 *   - `'alive'` — healthy baseline (registry not yet fired)
 *   - `'device-lost'` — device loss detected
 *   - `'internal-fault'` — internal renderer fault
 *
 * AI users exhaustively switch on `HealthReason` without default; TS guards
 * completeness.
 */
export type HealthReason = 'alive' | 'device-lost' | 'internal-fault';

/** Detail for `HealthReason 'device-lost'`. */
export interface HealthDetailDeviceLost {
  readonly lostReason: 'unknown' | 'destroyed';
  readonly message: string;
}

/** Detail for `HealthReason 'internal-fault'`. */
export interface HealthDetailInternalFault {
  readonly message: string;
}

/**
 * Pull-style health snapshot — discriminated union by `reason`.
 *
 * Per plan-strategy D-2: `switch(snap.reason)` narrows `snap.detail` to the
 * per-reason detail type automatically, with zero `as` casts. `alive` has no
 * `.detail` field; `device-lost` / `internal-fault` have a required `.detail`
 * of the respective variant.
 *
 *   - `recoverable` — explicit snapshot data owned by the lifecycle authority
 */
export type HealthSnapshot =
  | { readonly reason: 'alive'; readonly recoverable: boolean }
  | {
      readonly reason: 'device-lost';
      readonly detail: HealthDetailDeviceLost;
      readonly recoverable: boolean;
    }
  | {
      readonly reason: 'internal-fault';
      readonly detail: HealthDetailInternalFault;
      readonly recoverable: boolean;
    };

/**
 * Maps `HealthReason` to recoverable boolean per the derive table
 * (requirements section "range"):
 *
 *   | reason         | recoverable |
 *   |:---------------|:-----------|
 *   | `'alive'`      | false       |
 *   | `'device-lost'`| true        |
 *   | `'internal-fault'` | false   |
 */
/** Callback type for `Renderer.onHealthChange`. */
export type HealthChangeListener = (snapshot: HealthSnapshot) => void;
