// @forgeax/engine-runtime - public render-graph primitives
// (feat-20260604-resource-owning-render-graph-and-fullscreen-postpr M3 / w19).
//
// These factory functions are the AI-user-facing public vocabulary for assembling
// a render pipeline's per-frame graph. The urp pipeline (the engine
// builtin) and any custom pipeline use the SAME functions — the dogfood proof
// (AC-12 / AC-18). The internal recordXxxPass closures that do the actual GPU
// recording are package-private (no longer exported from
// `render-system-record.ts`); they are referenced here as the implementation
// detail of addScenePass / addFullscreenPass etc., satisfying plan-strategy D-5
// "per-entity logic stays as the addScenePass implementation detail; do NOT
// migrate it into the render-graph package (that would pollute its RHI-pure
// boundary)".
//
// API surface (the only nouns/verbs a pipeline author touches):
//   - addColorTarget(name, desc)       — allocate a graph-owned RT (M1)
//   - addColorTargetAlias(name, src)   — fold a logical key onto an existing RT
//   - addScenePass(g, name, opts)      — render the ECS scene into a colour target
//   - addShadowPass(g, name, opts)     — render shadow casters into a depth target
//   - addSkyboxPass(g, name, opts)     — render the skybox cube into a colour target
//   - addBloomPasses(g, opts)          — bloom bright + 2 blur + composite chain
//   - addSsaoPasses(g, opts)           — SSAO calc + blur chain (feat-20260612-hdrp-ssao)
//   - addTonemapPass(g, name, opts)    — HDR -> LDR tonemap
//   - addFullscreenPass(g, name, opts) — generic fullscreen post-process
//
// PIPELINE ROLE: urp-pipeline.buildGraph composes these in the
// canonical 9-pass order; a custom pipeline picks any subset / order.
//
// ─── EXTENSION-POINT MAP (F-5 doc-clarify) ───────────────────────────────
//
// Of the eight primitives above, EXACTLY ONE is an AI-user extension point;
// the other seven are engine-built-ins that DO NOT accept user-supplied
// execute closures.
//
//   addScenePass     | engine-built-in | execute = recordMainPass (private)
//   addShadowPass    | engine-built-in | execute = recordShadowPass (private)
//   addSkyboxPass    | engine-built-in | execute = recordSkyboxPass (private)
//   addBloomPasses   | engine-built-in | execute = 4× private record* closures
//   addSsaoPasses    | engine-built-in | execute = 2× private record* closures
//   addTonemapPass   | engine-built-in | execute = dispatchFullscreenPass('forgeax::tonemap')
//   addColorTarget    | engine-built-in (resource decl)
//   addColorTargetAlias | engine-built-in (resource decl)
//   addFullscreenPass | EXTENSION POINT (the only one)
//
// AI users wanting to add a CUSTOM SCENE pass (a per-entity geometry walk
// with their own shading model) write `graph.addPass(name, {reads, writes,
// execute: theirOwnClosure})` directly through the `@forgeax/engine-render-graph`
// `RenderGraph` API. addScenePass is intentionally NOT a customisation
// hook — it is the engine's urp main pass, full stop.
//
// AI users wanting to add a FULLSCREEN POST-PROCESS pass (e.g. a custom
// vignette, chromatic aberration, color grading LUT) take the two-step
// extension idiom:
//
//   // 1. Register the shader's WGSL source under a unique id (engine
//   //    builtins use `forgeax::` prefix; AI users use `<package>::<id>`).
//   //    Same-id re-register THROWS (programmer error, fail-fast).
//   renderer.postProcess.register('mypkg::vignette', {
//     source: vignetteWGSL,        // composed WGSL fragment stage
//     params: { byteSize: 16, defaultValue: ... }, // optional UBO
//     reads: ['hdrComposited'],    // optional graph resource keys
//   });
//
//   // 2. Reference the registered id from a custom pipeline's buildGraph.
//   //    The dispatcher looks the id up via runtime.lookupPostProcess;
//   //    a stale id THROWS PostProcessError{code:'post-process-not-found'}
//   //    inside the per-frame execute closure (charter P3 fail-fast).
//   addFullscreenPass(graph, 'vignette', {
//     shader: 'mypkg::vignette',
//     color: 'rt',                 // graph-owned scratch target
//     reads: ['hdrComposited'],
//   });
//
// The `'fxaa'` id is the engine-built-in special case: dispatcher delegates
// to `recordFxaaPass` to preserve R-COLORSPACE non-srgb storage view +
// dualPassDiff byte-equivalence. `addFullscreenPass(g, 'fxaa', ...)` is the
// canonical engine call site (used by urp-pipeline.buildGraph),
// not an AI user customisation lever.

import { mat4 } from '@forgeax/engine-math';
import type { RenderGraph, ResolveContext } from '@forgeax/engine-render-graph';
import {
  type Buffer,
  RhiError,
  type RhiRenderPassEncoder,
  type Sampler,
  type TextureView,
} from '@forgeax/engine-rhi';
import type { PassSelector } from '@forgeax/engine-types';
import {
  buildFullscreenPostProcessPass,
  createFullscreenBindGroup,
  entryHasDepthRead,
} from './fullscreen-post-process-pass';
import { getOrCreateSsaoFallbackTexture } from './hdrp-buffers';
import { buildBeginRenderPassDescriptor } from './pipeline-spec';
import { PostProcessError } from './post-process-errors';
import {
  computeProjectionMatrix,
  computeViewMatrix,
  getOrCreateFromChain,
  recordBloomBlurHPass,
  recordBloomBlurVPass,
  recordBloomBrightPass,
  recordBloomCompositePass,
  recordFxaaPass,
  recordMainPass,
  recordPointShadowPass,
  recordShadowPass,
  recordSkyboxPass,
  recordSpotShadowPass,
} from './record';
import type {
  _InternalRenderPipelineContext,
  RenderPipelineContext,
} from './render-pipeline-context';
import { getOrCreateSsaoBuffers } from './ssao-buffers';

/**
 * Selects which passes of a material asset are rendered by addScenePass / addShadowPass.
 *
 * An empty selector `{}` matches every pass. The selector is pipeline-specific:
 * the built-in URP uses `{ LightMode: ['Forward'] }` / `{ LightMode: ['ShadowCaster'] }`;
 * a custom pipeline can define its own tag keys and values.
 *
 * Matching rule: every key in the selector must exist in the pass's `tags` and the
 * pass's tag value must be in the selector's value list.
 */

export interface AddScenePassOptions {
  /** Graph colour target to write (declared via g.addColorTarget). */
  readonly color: string;
  /** Graph depth target to write (declared via g.addColorTarget). */
  readonly depth: string;
  /** Resource keys this pass samples (typically 'shadowDepth' + an upstream colour). */
  readonly reads?: readonly string[] | undefined;
  /**
   * Pass selector — a pipeline-specific filter for which material passes are
   * rendered. An empty selector `{}` matches every pass. The built-in URP uses
   * `{ LightMode: ['Forward'] }`; a custom pipeline defines its own tag keys.
   */
  readonly selector: PassSelector;
  /**
   * @internal — feat-20260609 framebuffers demo M5 / T-12-a opt-in flag.
   *
   * When `true`, the pass execute closure resolves `opts.color` / `opts.depth`
   * through the graph's resolveCtx and overrides the recordMainPass ctx so
   * the geometry pass renders into those graph-owned views. When `false` (or
   * unset, the default), recordMainPass picks the per-frame
   * `geometryColorView` / `geometryDepthView` set by recordFrame's URP
   * state-machine — this preserves byte-equivalence for urp-pipeline,
   * which encodes its own MSAA / LDR-no-MSAA / HDR routing in recordFrame
   * (where opts.color is a logical ordering token, not the physical write
   * target).
   *
   * AI-user-defined custom pipelines declaring their own offscreen RT (the
   * AC-11 "render scene to graph-owned colour + depth" contract) MUST set
   * this flag to opt out of the URP state-machine and route opts.color
   * directly. A future feat that migrates urp-pipeline off the recordFrame
   * state-machine flips the default and removes this flag.
   */
  readonly _routeFromOpts?: boolean | undefined;
}

/**
 * AC-11: render the ECS scene into a graph-owned colour + depth target.
 *
 * Adds a graph pass that, when executed, walks the per-frame validated
 * renderable list and dispatches geometry into `opts.color` (with `opts.depth`
 * as the depth attachment). The implementation detail (4-BGL chain, per-entity
 * material UBO packing, pipeline cache lookup, MSAA variant selection) is
 * package-private (`recordMainPass`); plan-strategy D-5 keeps it inside runtime
 * so the render-graph package stays RHI-pure.
 *
 * The `reads` array threads dependency edges into the graph (so shadow ->
 * skybox -> main is enforced topologically). The two writes are `opts.color`
 * and `opts.depth`.
 */
export function addScenePass(
  graph: RenderGraph<RenderPipelineContext>,
  name: string,
  opts: AddScenePassOptions,
): void {
  graph.addPass(name, {
    reads: opts.reads ?? [],
    writes: [opts.color, opts.depth],
    // feat-20260609 framebuffers demo M5 / T-12-a: route opts.color/opts.depth
    // through the resolveCtx and override the geometry view fields on the ctx
    // handed to recordMainPass when the caller is a non-URP custom pipeline.
    // Without this routing, recordMainPass picks `c.geometryColorView` whose
    // default (set by recordFrame) is the swap-chain `view`, only re-routed
    // onto graph-owned targets via the URP state-machine
    // (tonemapActive -> 'hdrColor' / msaaActive -> 'msaaColor' / etc.).
    //
    // URP byte-equivalence: urp-pipeline passes opts.color values that are
    // logical ordering tokens whose actual physical view is selected per
    // frame by recordFrame's state-machine (e.g. opts.color='hdrColor' but
    // recordFrame may select hdrColorMsaa, msaaColor, or the swap-chain
    // depending on tonemap+MSAA flags). Overriding from opts.color would
    // drop those MSAA-specific / LDR-swap-chain RT picks. The discriminator
    // is: URP keeps its state-machine because urp-pipeline does NOT pass
    // `_routeFromOpts: true`; a non-URP custom pipeline declaring its own
    // graph-owned RT opts in via the internal flag below.
    //
    // feat-20260609 selector: opts.selector is forwarded to recordMainPass for
    // pass-tag filtering (e.g. URP's `{ LightMode: ['Forward'] }`).
    execute: (ctx: RenderPipelineContext, resolveCtx?: ResolveContext) => {
      const internalCtx = ctx as _InternalRenderPipelineContext;
      if (!opts._routeFromOpts) {
        recordMainPass(internalCtx, opts.selector);
        return;
      }
      const colorView = resolveCtx?.resolve(opts.color) as TextureView | undefined;
      const depthView = resolveCtx?.resolve(opts.depth) as TextureView | undefined;
      const overridden: _InternalRenderPipelineContext = {
        ...internalCtx,
        geometryColorView: colorView ?? internalCtx.geometryColorView,
        geometryDepthView: depthView ?? internalCtx.geometryDepthView,
      };
      recordMainPass(overridden, opts.selector);
    },
  });
}

export interface AddShadowPassOptions {
  /** Graph depth target to write (declared via g.addColorTarget with depth format). */
  readonly depth: string;
  /**
   * Pass selector — a pipeline-specific filter for which material passes are
   * rendered as shadow casters. The built-in URP uses
   * `{ LightMode: ['ShadowCaster'] }`.
   */
  readonly selector: PassSelector;
  /**
   * Optional viewport for the shadow render pass. When set, the pass calls
   * `setViewport(x, y, w, h, 0, 1)` before dispatch so the depth rasterization
   * is clipped to the given sub-rectangle of the depth target. Undefined
   * preserves the pre-CSM behavior (full-RT viewport). Used by the cascaded
   * shadow map atlas: each cascade pass writes to one tile.
   *
   * @example viewport: { x: 0, y: 0, w: 2048, h: 2048 }
   */
  readonly viewport?:
    | { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
    | undefined;
  /**
   * Cascade index this pass renders into (0..3). The runtime writes the
   * value to `shadowCasterCascadeBuffer` immediately before submit; the
   * shadow_caster vertex shader reads it to pick the matching
   * `view.lightViewProj_X`. Defaults to 0 when unset (preserves the
   * single-cascade pre-CSM behaviour for any caller still calling
   * addShadowPass without the field; the URP per-cascade loop sets it
   * explicitly).
   *
   * @example cascadeIndex: 0  // first cascade (lightViewProj_A)
   */
  readonly cascadeIndex?: number;
}

/**
 * Render shadow casters into a depth-only graph target. Implementation detail:
 * `recordShadowPass` (package-private) iterates DirectionalLight + caster
 * renderables under their light-view + light-proj and writes the depth-32-float
 * target consumed by `addScenePass.reads`.
 */
export function addShadowPass(
  graph: RenderGraph<RenderPipelineContext>,
  name: string,
  opts: AddShadowPassOptions,
): void {
  const cascadeIndex = opts.cascadeIndex ?? 0;
  graph.addPass(name, {
    reads: [],
    writes: [opts.depth],
    execute: (c: RenderPipelineContext) =>
      recordShadowPass(
        c as Parameters<typeof recordShadowPass>[0],
        opts.selector,
        opts.viewport,
        cascadeIndex,
      ),
  });
}

/**
 * feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-4 (plan-strategy §D-1
 * + AC-04 + AC-09). Render the 6 x N point-light shadow caster passes into
 * the cube_array atlas owned by `frameState.pointShadowAtlas`. Implementation
 * detail: `recordPointShadowPass` (package-private) iterates
 * `frameState.pointShadowSnapshots` and emits one independent render pass
 * per (layer, face), opening / submitting each on its own command encoder
 * (RD-4 manual barrier between depth-write and the URP forward pass's
 * cube_array sample).
 *
 * Resource model: the cube_array atlas is a runtime-owned resource (NOT a
 * graph color target) because its size is `4 * 6 * faceSize^2` and per-face
 * 2D views must be created with explicit `baseArrayLayer` indexing — the
 * existing `addColorTarget` vocabulary is single-attachment-only. The pass
 * therefore declares no `writes` (the dependency between this pass and the
 * URP forward pass is enforced by the `addScenePass.reads` order — both
 * sample shadowAtlas, and graph topological order keeps shadow before
 * forward). A future render-graph extension may model the cube_array as a
 * first-class resource; for now the manual command-encoder boundary is the
 * synchronization point.
 *
 * AC-09 zero-shadow zero-pass: the URP `buildGraph` gates the call to
 * `addPointShadowPass` on `frameState.pointShadowSnapshots.length > 0` so
 * the graph itself never declares the pass when no PointLightShadow exists.
 * `recordPointShadowPass` re-checks at execute time as defence in depth.
 */
export function addPointShadowPass(graph: RenderGraph<RenderPipelineContext>, name: string): void {
  graph.addPass(name, {
    reads: [],
    writes: [],
    execute: recordPointShadowPass as (c: RenderPipelineContext) => void,
  });
}

export interface AddSpotShadowPassOptions {
  /** Graph depth target (depth32float 2x2 tile atlas) the spot casters write. */
  readonly depth: string;
}

/**
 * feat-20260625-spot-light-shadow-mapping M2 / w9 + w11 (D-1 + D-2). Render the
 * spot-light shadow caster passes into the graph-owned `spotShadowDepth` atlas
 * (a single 2D depth32float texture of 2x2 tiles — NOT a 2d-array). One graph
 * pass NODE; the execute closure (`recordSpotShadowPass`) loops the per-frame
 * `frameState.spotShadowSnapshots`, rendering each castShadow spot's perspective
 * depth into its tile (viewport keyed on `shadowAtlasTile`) with first-tile
 * clear / rest load (independent of the directional cascadeIndex; D-2). Unlike
 * `addPointShadowPass` the spot atlas IS a graph color target, so the pass
 * declares `writes: [opts.depth]` — `addScenePass.reads` lists the same key to
 * order spot-shadow -> main. The single-node-with-internal-loop shape keeps the
 * memoized graph from rebuilding on spot-count drift (AC-03 zero-spot scenes
 * record zero passes via the early-return inside recordSpotShadowPass).
 */
export function addSpotShadowPass(
  graph: RenderGraph<RenderPipelineContext>,
  name: string,
  opts: AddSpotShadowPassOptions,
): void {
  graph.addPass(name, {
    reads: [],
    writes: [opts.depth],
    execute: recordSpotShadowPass as (c: RenderPipelineContext) => void,
  });
}

export interface AddSkyboxPassOptions {
  /** Graph colour target the skybox writes (typically the same target the scene pass writes). */
  readonly color: string;
}

/**
 * Render a skybox cube into the declared colour target. Implementation detail:
 * `recordSkyboxPass` (package-private) emits a single cube draw with a
 * skybox-view matrix derived from the camera. Writes `opts.color` so the
 * scene pass can declare it under `reads` to enforce skybox -> main order.
 */
export function addSkyboxPass(
  graph: RenderGraph<RenderPipelineContext>,
  name: string,
  opts: AddSkyboxPassOptions,
): void {
  graph.addPass(name, {
    reads: [],
    writes: [opts.color],
    execute: recordSkyboxPass as (c: RenderPipelineContext) => void,
  });
}

export interface AddBloomPassesOptions {
  /** HDR colour target the bright-extract reads + the composite reads back. */
  readonly hdrColor: string;
  /** Logical key the composite WRITES (typically an alias of hdrColor). */
  readonly hdrComposited: string;
  /** Half-res bright target. */
  readonly bright: string;
  /** Half-res H blur target. */
  readonly blurH: string;
  /** Half-res V blur target. */
  readonly blurV: string;
}

/**
 * Wire the 4-pass bloom chain (bright -> blur-h -> blur-v -> composite). All
 * intermediate targets are half-resolution; the composite reads hdrColor +
 * blurV and writes the alias `hdrComposited` (declared via
 * `g.addColorTargetAlias` to fold onto the actual hdrColor texture, KB-1).
 */
export function addBloomPasses(
  graph: RenderGraph<RenderPipelineContext>,
  opts: AddBloomPassesOptions,
): void {
  graph.addPass('bloom-bright', {
    reads: [opts.hdrColor],
    writes: [opts.bright],
    execute: recordBloomBrightPass as (c: RenderPipelineContext) => void,
  });
  graph.addPass('bloom-blur-h', {
    reads: [opts.bright],
    writes: [opts.blurH],
    execute: recordBloomBlurHPass as (c: RenderPipelineContext) => void,
  });
  graph.addPass('bloom-blur-v', {
    reads: [opts.blurH],
    writes: [opts.blurV],
    execute: recordBloomBlurVPass as (c: RenderPipelineContext) => void,
  });
  graph.addPass('bloom-composite', {
    reads: [opts.hdrColor, opts.blurV],
    writes: [opts.hdrComposited],
    execute: recordBloomCompositePass as (c: RenderPipelineContext) => void,
  });
}

/**
 * feat-20260612-hdrp-ssao M3 / w15: SSAO pass parameters.
 *
 * Defaults: radius=0.5, bias=0.025, intensity=1.0.
 * Non-positive radius or negative bias triggers fail-fast PostProcessError
 * inside the per-frame record closure (w16 boundary impl).
 */
export interface AddSsaoPassesParams {
  /** SSAO sample radius in view-space units (default 0.5). */
  readonly radius?: number | undefined;
  /** SSAO depth bias to avoid self-occlusion (default 0.025). */
  readonly bias?: number | undefined;
  /** SSAO intensity blend factor (default 1.0). */
  readonly intensity?: number | undefined;
}

/**
 * Options for `addSsaoPasses` (plan-strategy D-5, D-2).
 *
 * The caller (hdrp-pipeline.buildGraph) declares the color targets
 * (ssaoRaw / ssaoBlurred as half-swapchain r8unorm) and passes their
 * graph resource keys here. `gbuf0` and `hdrDepth` are g-buffer
 * resources declared by the pipeline.
 */
export interface AddSsaoPassesOptions {
  /** G-buffer RT0 (normal.rgb + roughness.a), rgba16float, swapchain. */
  readonly gbuf0: string;
  /** Hardware depth target, depth24plus-stencil8, swapchain. */
  readonly hdrDepth: string;
  /** SSAO calc output: half-res r8unorm transient target. */
  readonly ssaoRaw: string;
  /** SSAO blur output: half-res r8unorm transient target. */
  readonly ssaoBlurred: string;
  /** SSAO parameters (radius, bias, intensity). */
  readonly params?: AddSsaoPassesParams | undefined;
  /** Pipeline context for lazy SSAO buffer resolution. */
  readonly ctx: RenderPipelineContext;
}

/**
 * Wire the 2-pass SSAO chain (calc -> blur) into the render graph.
 *
 * plan-strategy D-2: exactly 2 pass (ssao-calc + ssao-blur).
 * plan-strategy D-4: g-buffer missing -> graph-level skip.
 * plan-strategy D-5: signature matches addBloomPasses pattern.
 *
 * ssao-calc: reads gbuf0 + hdrDepth + ssao-noise + ssao-kernel + ssao-uniform,
 *   writes ssaoRaw (half-res r8unorm).
 * ssao-blur: reads ssaoRaw, writes ssaoBlurred (half-res r8unorm).
 *
 * Fail-fast: when SSAO buffers are unavailable (storageBuffer=false,
 * g-buffer not declared, or kernel/noise generation fails), the
 * function returns without wiring any pass nodes (graph-level skip).
 * Param validation happens in the record closure (w16 boundary impl).
 */
export function addSsaoPasses(
  graph: RenderGraph<RenderPipelineContext>,
  opts: AddSsaoPassesOptions,
): void {
  const ctx = opts.ctx as _InternalRenderPipelineContext;

  // plan-strategy D-4: g-buffer missing -> graph-level skip.
  // Check that gbuf0 + hdrDepth are declared as graph color targets.
  const resources = graph.listResources();
  const hasGbuf0 = resources.some((r) => r.key === opts.gbuf0);
  const hasHdrDepth = resources.some((r) => r.key === opts.hdrDepth);
  if (!hasGbuf0 || !hasHdrDepth) {
    return;
  }

  // Check SSAO buffers are available (storageBuffer cap gate + allocation).
  const ssaoBufs = getOrCreateSsaoBuffers(ctx.runtime);
  if (ssaoBufs === null) {
    return;
  }

  // Validate parameters (fail-fast on illegal values).
  const radius = opts.params?.radius ?? 0.5;
  const bias = opts.params?.bias ?? 0.025;
  if (radius <= 0) {
    throw new PostProcessError({
      code: 'ssao-radius-non-positive',
      detail: { paramName: 'radius', value: radius },
    });
  }
  if (bias < 0) {
    throw new PostProcessError({
      code: 'ssao-bias-negative',
      detail: { paramName: 'bias', value: bias },
    });
  }

  // Pass 1: SSAO calculation — fullscreen pass that samples g-buffer
  // RT0 + depth, computes 64-sample hemisphere occlusion, writes
  // single-channel R8 result to half-resolution target.
  // Kernel SSBO / noise texture / uniform UBO are runtime-owned
  // (getOrCreateSsaoBuffers) and bound at record time, not
  // through the graph resource system.
  graph.addPass('ssao-calc', {
    reads: [opts.gbuf0, opts.hdrDepth],
    writes: [opts.ssaoRaw],
    storageBuffer: true,
    execute: (_c: RenderPipelineContext, resolveCtx?: ResolveContext) => {
      const internalCtx = _c as _InternalRenderPipelineContext;
      recordSsaoCalcPass(internalCtx, resolveCtx, opts.ssaoRaw, opts.gbuf0, opts.hdrDepth);
    },
  });

  // Pass 2: SSAO blur — fullscreen pass that reads the half-res R8
  // ssaoRaw texture, applies a 4x4 box blur (16 taps), writes the
  // blurred result to ssaoBlurred.
  //
  // M8 / w38: gbuf0 + hdrDepth declared as reads even though the blur
  // shader does not sample them. Reason: the SSAO BGL is shared with the
  // calc pass (9 entries 0-8); WebGPU requires every BGL slot to carry a
  // valid resource, so the blur bind group must bind real gbuffer_normal +
  // hdr_depth views at slots 4 + 5 — declaring them as graph reads is the
  // mechanism that makes resolveCtx return their views here.
  graph.addPass('ssao-blur', {
    reads: [opts.ssaoRaw, opts.gbuf0, opts.hdrDepth],
    writes: [opts.ssaoBlurred],
    execute: (_c: RenderPipelineContext, resolveCtx?: ResolveContext) => {
      const internalCtx = _c as _InternalRenderPipelineContext;
      recordSsaoBlurPass(
        internalCtx,
        resolveCtx,
        opts.ssaoBlurred,
        opts.ssaoRaw,
        opts.gbuf0,
        opts.hdrDepth,
      );
    },
  });
}

/**
 * Lazy-allocate the three constant SSAO record companions the first time the
 * calc / blur closure runs: a filtering sampler (binding 3 + 8), a
 * non-filtering depth sampler (binding 6, paired with hdr_depth — WebGPU
 * validation rejects depth + filtering), and a 1x1 r8unorm fallback view bound
 * at ssaoRaw (binding 7) in the calc pass (the calc shader never samples
 * ssaoRaw, but the BGL still requires a valid view).
 *
 * Returns null if any underlying allocation fires a structured error onto
 * runtime.errorRegistry; the caller then skips the pass.
 */
/**
 * Resolve a depth-only view of a graph color target by key.
 *
 * On dawn the BindGroup validation rejects a default-view (aspect=all on a
 * depth+stencil texture) with "Multiple aspects (Depth|Stencil) selected".
 * A separate createTextureView({aspect:'depth-only'}) is required.
 *
 * @param internals - internal render pipeline context
 * @param key - graph color-target key to resolve depth from
 * @param label - debug label for the depth-only TextureView
 * @returns a depth-only TextureView, or null if the graph / texture is absent
 *   or creation fires a structured error
 */
export function resolveDepthOnlyView(
  internals: _InternalRenderPipelineContext,
  key: string,
  label: string,
): TextureView | null {
  const graph = internals.frameState.perFrameGraph;
  if (graph === null) return null;
  const tex = graph.getColorTargetTexture(key);
  if (tex === undefined) return null;
  const res = internals.runtime.device.createTextureView(tex as never, {
    label,
    dimension: '2d',
    aspect: 'depth-only',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  if (!res.ok) {
    internals.runtime.errorRegistry.fire(res.error);
    return null;
  }
  return res.value;
}

/**
 * Resolve a depth-only view of the graph's hdrDepth texture.
 *
 * Thin delegate to {@link resolveDepthOnlyView} (plan-strategy D-5: extract
 * the shared depth-only view helper, SSAO delegates). Behaviour is byte-identical
 * to the pre-extraction inline version. The SSAO BGL / bindings / sampler are
 * untouched (OOS-4).
 */
function resolveHdrDepthDepthOnlyView(
  internals: _InternalRenderPipelineContext,
  hdrDepthKey: string,
): TextureView | null {
  return resolveDepthOnlyView(internals, hdrDepthKey, 'ssao-hdr-depth-only-view');
}

function ensureSsaoRecordCompanions(internals: _InternalRenderPipelineContext): {
  filteringSampler: Sampler;
  depthSampler: Sampler;
  fallbackRawView: TextureView;
} | null {
  const pp = internals.pipelineState.perPassResources;
  if (
    pp.ssaoFilteringSampler !== null &&
    pp.ssaoDepthSampler !== null &&
    pp.ssaoFallbackRawView !== null
  ) {
    return {
      filteringSampler: pp.ssaoFilteringSampler,
      depthSampler: pp.ssaoDepthSampler,
      fallbackRawView: pp.ssaoFallbackRawView as TextureView,
    };
  }

  const device = internals.runtime.device;

  if (pp.ssaoFilteringSampler === null) {
    // Despite the field name, this sampler is non-filtering (NEAREST):
    // bindings 3 (noise sampler) + 8 (ssaoSampler) pair with unfilterable
    // float textures (rgba32float noise / r8unorm ssaoRaw on dawn without
    // float32-filterable). The "filtering" label in the field name predates
    // the sampler-type split; the resource itself is non-filtering.
    const res = device.createSampler({
      label: 'ssao-noise-sampler',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });
    if (!res.ok) {
      internals.runtime.errorRegistry.fire(res.error);
      return null;
    }
    pp.ssaoFilteringSampler = res.value;
  }

  if (pp.ssaoDepthSampler === null) {
    const res = device.createSampler({
      label: 'ssao-depth-sampler',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    if (!res.ok) {
      internals.runtime.errorRegistry.fire(res.error);
      return null;
    }
    pp.ssaoDepthSampler = res.value;
  }

  if (pp.ssaoFallbackRawView === null) {
    const fb = getOrCreateSsaoFallbackTexture(internals.runtime);
    if (fb === null) return null;
    pp.ssaoFallbackRawView = fb.view;
  }

  return {
    filteringSampler: pp.ssaoFilteringSampler,
    depthSampler: pp.ssaoDepthSampler,
    fallbackRawView: pp.ssaoFallbackRawView as TextureView,
  };
}

/**
 * Pack the 256B SSAO uniform payload from the camera + config.ssao.intensity.
 *
 * Layout (plan-strategy D-1 + D-C):
 *   floats [0..15]   view              mat4
 *   floats [16..31]  projection        mat4
 *   floats [32..47]  inverseProjection mat4
 *   floats [48..51]  intensityPad      vec4  (x=intensity, yzw=0 padding)
 *   floats [52..63]  trailing zero-pad to round to 256B / 64f UBO alignment.
 */
function buildSsaoUniformPayload(internals: _InternalRenderPipelineContext): Float32Array {
  const { camera, frameState } = internals;
  const sProj = computeProjectionMatrix(camera);
  const sView = computeViewMatrix(camera);
  const invProj = mat4.create();
  mat4.invert(invProj, sProj);

  const out = new Float32Array(64);
  out.set(sView as unknown as Float32Array, 0);
  out.set(sProj as unknown as Float32Array, 16);
  out.set(invProj as unknown as Float32Array, 32);

  const ssaoConfig = frameState.installedPipelineConfig?.ssao;
  const intensity =
    ssaoConfig !== undefined && ssaoConfig.enabled === true ? (ssaoConfig.intensity ?? 1.0) : 1.0;
  out[48] = intensity;
  return out;
}

/**
 * recordSsaoCalcPass — fullscreen SSAO occlusion calculation (M8 / w38).
 *
 * Resolves the graph-owned half-resolution ssaoRaw color target, writes the
 * 256 B SSAO uniform (view/proj/invProj/intensity) once per frame, then runs
 * a 3-vertex fullscreen-triangle draw with fs_ssao_calc.
 *
 * Bind group entries (must match the 9-entry SSAO BGL declared in
 * createRenderer.ts; see hdrp-ssao.wgsl §BGL layout):
 *   0 ssao_uniform UBO            5 hdr_depth view
 *   1 ssao_kernel SSBO            6 ssao_depth_sampler (non-filtering)
 *   2 ssao_noise_texture          7 fallback ssaoRaw view (calc never samples)
 *   3 ssao_noise_sampler          8 ssaoSampler (unused by calc, BGL slot)
 *   4 gbuffer_normal view
 *
 * Skips with no GPU work when the optional SSAO pipelines are unavailable
 * (manifest without hdrp-ssao.wgsl), when the dedicated BGL is null, when
 * the SSAO buffers fail to allocate, or when the graph cannot resolve the
 * required views.
 */
function recordSsaoCalcPass(
  _c: _InternalRenderPipelineContext,
  resolveCtx?: ResolveContext,
  ssaoRawKey?: string,
  gbuf0Key?: string,
  hdrDepthKey?: string,
): void {
  const { runtime, pipelineState, encoder } = _c;
  const pp = pipelineState.perPassResources;

  if (pp.ssaoCalcPipeline === null || pp.ssaoBgl === null) return;
  if (resolveCtx === undefined || ssaoRawKey === undefined) return;

  const ssaoRawView = resolveCtx.resolve(ssaoRawKey) as TextureView | undefined;
  const gbuf0View =
    gbuf0Key !== undefined ? (resolveCtx.resolve(gbuf0Key) as TextureView | undefined) : undefined;
  if (!ssaoRawView || !gbuf0View || hdrDepthKey === undefined) return;

  // hdrDepth needs a depth-only view (BGL binding 5 sampleType=depth);
  // resolveCtx returns a default all-aspects view that dawn rejects when
  // paired with a depth sampler.
  const hdrDepthView = resolveHdrDepthDepthOnlyView(_c, hdrDepthKey);
  if (hdrDepthView === null) return;

  // Cache key: the graph's pooled hdrDepth view (stable object per size, new
  // object on resize). The depth-only view above is created fresh every frame
  // so it cannot key the cache; the pooled all-aspects view co-varies with it
  // (both are views of the same transient hdrDepth texture) and changes exactly
  // on resize. Used only as a WeakMap key, never bound.
  const hdrDepthPooledView = resolveCtx.resolve(hdrDepthKey) as TextureView | undefined;
  if (hdrDepthPooledView === undefined) return;

  const ssaoBufs = getOrCreateSsaoBuffers(runtime);
  if (ssaoBufs === null) return;

  const noiseViewRes = runtime.device.createTextureView(ssaoBufs.noiseTexture, {
    label: 'hdrp-ssao-noise-view',
    format: 'rgba32float',
    dimension: '2d',
    aspect: 'all',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  if (!noiseViewRes.ok) {
    runtime.errorRegistry.fire(noiseViewRes.error);
    return;
  }

  const companions = ensureSsaoRecordCompanions(_c);
  if (companions === null) return;

  // Per-frame uniform write (D-C: view+proj+invProj+intensity at one queue
  // call). 256 B Float32Array (64 f32) lands in ssao_uniform UBO offset 0.
  const payload = buildSsaoUniformPayload(_c);
  const writeRes = runtime.device.queue.writeBuffer(ssaoBufs.uniformBuffer, 0, payload);
  if (!writeRes.ok) {
    runtime.errorRegistry.fire(writeRes.error);
    return;
  }

  // Identity-cached bind group: 9 entries mirror the BGL declared in
  // createRenderer. Keyed on the graph-pooled gbuf0 + hdrDepth views (both
  // retire + reallocate on resize), so the WeakMap misses after a resize and
  // rebuilds against the live textures. The noise / depth-only views bound
  // below are created fresh each frame but back stable textures; keying on the
  // resize-varying graph views is what makes invalidation correct. Replaces
  // the prior `=== null` slot cache that submitted a destroyed gbuf0/hdrDepth
  // after resize.
  const ssaoBgl = pp.ssaoBgl;
  const bindGroup = getOrCreateFromChain(
    _c.frameState.postProcessBgCache,
    [gbuf0View as unknown as object, hdrDepthPooledView as unknown as object],
    'ssao-calc',
    () => {
      const bgRes = runtime.device.createBindGroup({
        label: 'ssao-calc-bg',
        layout: ssaoBgl,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: ssaoBufs.uniformBuffer } } },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: ssaoBufs.kernelBuffer } } },
          { binding: 2, resource: { kind: 'textureView', value: noiseViewRes.value } },
          {
            binding: 3,
            resource: { kind: 'sampler', value: companions.filteringSampler },
          },
          { binding: 4, resource: { kind: 'textureView', value: gbuf0View } },
          { binding: 5, resource: { kind: 'textureView', value: hdrDepthView } },
          { binding: 6, resource: { kind: 'sampler', value: companions.depthSampler } },
          { binding: 7, resource: { kind: 'textureView', value: companions.fallbackRawView } },
          { binding: 8, resource: { kind: 'sampler', value: companions.filteringSampler } },
        ],
      });
      if (!bgRes.ok) throw bgRes.error;
      return bgRes.value;
    },
    _c.bindGroupCounts,
  );

  const pass: RhiRenderPassEncoder = encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      { colorFormats: ['r8unorm'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [ssaoRawView] },
      'post-process',
    ) as never,
  );
  pass.setPipeline(pp.ssaoCalcPipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3, 1, 0, 0);
  pass.end();
}

/**
 * recordSsaoBlurPass — fullscreen SSAO 4x4 box blur (M8 / w38).
 *
 * Reads the half-resolution ssaoRaw (R8), applies a 16-tap box blur, writes
 * the blurred result to ssaoBlurred. The BGL is the same 9-entry SSAO BGL
 * as the calc pass; the only difference is binding 7 carries the real
 * ssaoRaw view (vs the 1x1 fallback the calc pass binds).
 */
function recordSsaoBlurPass(
  _c: _InternalRenderPipelineContext,
  resolveCtx?: ResolveContext,
  ssaoBlurredKey?: string,
  ssaoRawKey?: string,
  gbuf0Key?: string,
  hdrDepthKey?: string,
): void {
  const { runtime, pipelineState, encoder } = _c;
  const pp = pipelineState.perPassResources;

  if (pp.ssaoBlurPipeline === null || pp.ssaoBgl === null) return;
  if (resolveCtx === undefined || ssaoBlurredKey === undefined || ssaoRawKey === undefined) return;

  const ssaoBlurredView = resolveCtx.resolve(ssaoBlurredKey) as TextureView | undefined;
  const ssaoRawView = resolveCtx.resolve(ssaoRawKey) as TextureView | undefined;
  const gbuf0View =
    gbuf0Key !== undefined ? (resolveCtx.resolve(gbuf0Key) as TextureView | undefined) : undefined;
  if (!ssaoBlurredView || !ssaoRawView) return;

  // hdrDepth depth-only view (see recordSsaoCalcPass).
  const hdrDepthView =
    hdrDepthKey !== undefined ? resolveHdrDepthDepthOnlyView(_c, hdrDepthKey) : null;
  // Pooled hdrDepth view for the cache key (the depth-only view above is
  // recreated every frame; see recordSsaoCalcPass).
  const hdrDepthPooledView =
    hdrDepthKey !== undefined
      ? (resolveCtx.resolve(hdrDepthKey) as TextureView | undefined)
      : undefined;

  const ssaoBufs = getOrCreateSsaoBuffers(runtime);
  if (ssaoBufs === null) return;

  const noiseViewRes = runtime.device.createTextureView(ssaoBufs.noiseTexture, {
    label: 'hdrp-ssao-noise-view',
    format: 'rgba32float',
    dimension: '2d',
    aspect: 'all',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  if (!noiseViewRes.ok) {
    runtime.errorRegistry.fire(noiseViewRes.error);
    return;
  }

  const companions = ensureSsaoRecordCompanions(_c);
  if (companions === null) return;

  // The blur reads ssaoRaw via binding 7 + ssaoSampler at binding 8. The
  // remaining slots 0..6 are bound for BGL completeness (BGL is shared with
  // the calc pass): WebGPU requires every BGL slot carry a valid resource
  // even when the active fragment entry does not statically reference it.
  // gbuf0 + hdr_depth views are resolved from the graph; they must exist
  // because addSsaoPasses declares them as `reads` on the blur node.
  if (gbuf0View === undefined || hdrDepthView === null || hdrDepthPooledView === undefined) return;
  // Identity-cached bind group keyed on the graph-pooled ssaoRaw + gbuf0 +
  // hdrDepth views (all retire + reallocate on resize). Replaces the prior
  // `=== null` slot cache that submitted destroyed transients after resize.
  const ssaoBgl = pp.ssaoBgl;
  const bindGroup = getOrCreateFromChain(
    _c.frameState.postProcessBgCache,
    [
      ssaoRawView as unknown as object,
      gbuf0View as unknown as object,
      hdrDepthPooledView as unknown as object,
    ],
    'ssao-blur',
    () => {
      const bgRes = runtime.device.createBindGroup({
        label: 'ssao-blur-bg',
        layout: ssaoBgl,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: ssaoBufs.uniformBuffer } } },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: ssaoBufs.kernelBuffer } } },
          { binding: 2, resource: { kind: 'textureView', value: noiseViewRes.value } },
          {
            binding: 3,
            resource: { kind: 'sampler', value: companions.filteringSampler },
          },
          { binding: 4, resource: { kind: 'textureView', value: gbuf0View } },
          { binding: 5, resource: { kind: 'textureView', value: hdrDepthView } },
          { binding: 6, resource: { kind: 'sampler', value: companions.depthSampler } },
          { binding: 7, resource: { kind: 'textureView', value: ssaoRawView } },
          { binding: 8, resource: { kind: 'sampler', value: companions.filteringSampler } },
        ],
      });
      if (!bgRes.ok) throw bgRes.error;
      return bgRes.value;
    },
    _c.bindGroupCounts,
  );

  const pass: RhiRenderPassEncoder = encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      { colorFormats: ['r8unorm'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [ssaoBlurredView] },
      'post-process',
    ) as never,
  );
  pass.setPipeline(pp.ssaoBlurPipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3, 1, 0, 0);
  pass.end();
}

export interface AddTonemapPassOptions {
  /** Logical HDR resource tonemap reads when bloom is on (the bloom composite output). */
  readonly hdrComposited: string;
  /**
   * Logical HDR resource tonemap reads when bloom is OFF (the bloom composite
   * pass is gated off and never writes hdrComposited). Defaults to
   * `hdrComposited` for pipelines where the two are the same texture (e.g.
   * HDRP passes `hdrColor` for both). URP passes `hdrColor` here so that with
   * bloom off, tonemap reads the main-rendered scene directly instead of an
   * unwritten hdrComposited target (bug-20260625).
   */
  readonly hdrColorWhenBloomOff?: string;
}

/**
 * Reserved post-process id for the engine built-in tonemap (feat-20260621 M-A3
 * / D-5). Registered at boot via `postProcess.register(TONEMAP_POST_PROCESS_ID,
 * { source, params })`; the extract stage bridges `Camera.exposure / whitePoint
 * / tonemap` onto the params channel under this key (render-system-extract.ts).
 */
export const TONEMAP_POST_PROCESS_ID = 'forgeax::tonemap';

/**
 * HDR -> LDR tonemap fullscreen pass. feat-20260621 M-A3 (D-5): the built-in
 * tonemap now flows through the SAME unified fullscreen post-process channel as
 * any custom post-process — registered at boot via `postProcess.register(
 * 'forgeax::tonemap', { source, params })`, its exposure/whitePoint/mode bridged
 * onto the per-frame params channel by the extract stage, and dispatched here
 * through `dispatchFullscreenPass`. This wrapper preserves two behaviours the
 * generic `addFullscreenPass` lacks:
 *   - the per-frame `tonemapActive` gate (`camera.tonemap === 'none'` ->
 *     zero-overhead skip), and
 *   - graceful degradation (charter §9) on the empty-manifest path: when
 *     `forgeax::tonemap` was never registered (Camera-only world, no manifest)
 *     fire a structured `shader-compile-failed` instead of letting the
 *     dispatcher throw `post-process-not-found`.
 * `writes: []` (not `['swapchain']`) keeps the graph dependency ordering
 * byte-identical to the pre-M-A3 pass; the swap-chain write target is resolved
 * inside `dispatchFullscreenPass` via the `'swapchain'` color key -> `ctx.view`.
 */
export function addTonemapPass(
  graph: RenderGraph<RenderPipelineContext>,
  name: string,
  opts: AddTonemapPassOptions,
): void {
  // Declare both potential read sources so the topo-sort keeps tonemap after
  // BOTH the composite writer (hdrComposited) and the main writer (hdrColor),
  // regardless of which one the dispatch resolves at record time. resolveCtx
  // exposes every compiled texture, so the runtime pick below always resolves.
  const hdrColorWhenBloomOff = opts.hdrColorWhenBloomOff ?? opts.hdrComposited;
  const tonemapReads =
    hdrColorWhenBloomOff === opts.hdrComposited
      ? [opts.hdrComposited]
      : [opts.hdrComposited, hdrColorWhenBloomOff];
  graph.addPass(name, {
    reads: tonemapReads,
    writes: [],
    execute: (ctx: RenderPipelineContext, resolveCtx?: ResolveContext) => {
      // tonemapActive SSOT: derived from camera.tonemap (mirrors recordFrame's
      // `camera.tonemap !== 'none'`); the `'none'` path is a zero-overhead skip.
      if (ctx.camera.tonemap === 'none') return;
      const registered = ctx.runtime.lookupPostProcess?.(TONEMAP_POST_PROCESS_ID);
      if (registered === undefined) {
        ctx.runtime.errorRegistry.fire(
          new RhiError({
            code: 'shader-compile-failed',
            expected:
              'manifest entries include pbr.wgsl + unlit.wgsl + tonemap.wgsl (engine SSOT triple)',
            hint: 'verify @forgeax/engine-vite-plugin-shader emits manifest.json with the 3 engine entries; check vite plugin engineEntries option',
          }),
        );
        return;
      }
      // Pick the read source by bloom state: when bloom is on the composite
      // pass wrote hdrComposited; when off it was gated and never ran, so read
      // the main-rendered hdrColor instead (bug-20260625). Same texture for
      // pipelines that pass identical keys (e.g. HDRP).
      const src = ctx.camera.bloom === 'on' ? opts.hdrComposited : hdrColorWhenBloomOff;
      dispatchFullscreenPass(ctx, name, TONEMAP_POST_PROCESS_ID, 'swapchain', [src], resolveCtx);
    },
  });
}

export interface AddFullscreenPassOptions {
  /**
   * Registered post-process shader id (via renderer.postProcess.register). The
   * built-in `'fxaa'` id is a hardwired dispatcher branch; any other id is an
   * AI-user effect whose WGSL declares `vs_main` + `fs_main` and samples the
   * input at `@group(1) @binding(0)` texture + `@binding(1)` sampler. With
   * `compositeOverSwapchain` this is how an effect layers over URP's final image
   * (see RenderPipelineAsset.config.postEffects).
   */
  readonly shader: string;
  /** Graph resource key the pass writes (intermediate scratch RT for FXAA / the composite scratch). */
  readonly color: string;
  /** Graph resource keys the pass samples. Empty = sample swap-chain via copyTextureToTexture. */
  readonly reads?: readonly string[] | undefined;
  /**
   * feat-20260621 M4': composite-over-swap-chain mode. When true, the pass
   * copies the CURRENT swap-chain into the `color` scratch target (so the effect
   * samples the already-composited final image), samples that scratch, then
   * writes the result back into the swap-chain through its non-srgb storage view
   * (R-COLORSPACE: the swap-chain is already sRGB-encoded, so writing through the
   * srgb view would double-encode). This is the generalisation of the built-in
   * `'fxaa'` copy idiom to AI-user effects — the mechanism that lets a built-in
   * pipeline layer a registered effect on top of its final image WITHOUT
   * replacing the pipeline (and dropping its shadow / tonemap passes). `color`
   * MUST be a `graph.addColorTarget` declared with the swap-chain storage format
   * + COPY_DST | TEXTURE_BINDING usage (it is both copy dst and sampled input);
   * `reads` stays empty.
   *
   * WebGPU backend only: the mid-frame swap-chain copy + non-srgb storage-view
   * write are not supported on the WebGL2 fallback swap-chain (no COPY_SRC, no
   * non-srgb reinterpret view) — the same constraint `recordFxaaPass` carries.
   */
  readonly compositeOverSwapchain?: boolean | undefined;
}

/**
 * AC-06 / AC-07: declare a generic fullscreen post-process pass. The shader is
 * looked up from `renderer.postProcess.register(shader, …)`; the primitive
 * builds the input-texture BGL + sampler + pipeline + ping-pong wiring. For
 * the FXAA case the implementation detail is `recordFxaaPass`
 * (package-private), which preserves the R-COLORSPACE non-srgb storage view
 * that AC-09 zero-visual-change requires.
 *
 * If `opts.reads` is empty the pass samples the swap-chain (default) — the
 * current FXAA case. Future post-processes that read a graph-owned texture
 * (e.g. tonemap rebuilt as a fullscreen pass, OOS-3) will declare reads
 * explicitly.
 *
 * F-3 topology refactor (2026-06-08): the FXAA path now flows through this
 * dispatcher (`addFullscreenPass(g, 'fxaa', ...)` -> `dispatchFullscreenPass` ->
 * `recordFxaaPass`). The two-branch dispatcher is the load-bearing AC-09
 * "FXAA refactored as the first post-process instance" claim: at the
 * topology layer FXAA is a special-cased shader id; at the record layer
 * recordFxaaPass's body is unchanged to preserve the R-COLORSPACE
 * non-srgb storage view + dualPassDiff=1069 / 768 byte-equivalence. The
 * dispatcher is extracted as a named function (`dispatchFullscreenPass`)
 * so an AI user reading the per-pass execute closure sees a single call
 * site — the if/else fan-out is in one place, not duplicated across
 * future fullscreen passes.
 */
export function addFullscreenPass(
  graph: RenderGraph<RenderPipelineContext>,
  name: string,
  opts: AddFullscreenPassOptions,
): void {
  const reads = opts.reads ?? [];
  graph.addPass(name, {
    reads,
    writes: [opts.color],
    execute: (ctx: RenderPipelineContext, resolveCtx?: ResolveContext) => {
      dispatchFullscreenPass(
        ctx,
        name,
        opts.shader,
        opts.color,
        reads,
        resolveCtx,
        opts.compositeOverSwapchain ?? false,
      );
    },
  });
}

/**
 * F-3 fix-up + feat-20260609 M1 / T-3 patch: per-frame fullscreen-post-process
 * dispatcher.
 *
 * Two-branch fan-out by shader id:
 * - `'fxaa'` (engine-built-in hardwire): delegate to `recordFxaaPass`. The
 *   FXAA implementation owns its own swap-chain `copyTextureToTexture` +
 *   non-srgb storage-view write (R-COLORSPACE), pipeline cache, and
 *   bindgroup-resize invalidation; that mechanics is engine-internal and
 *   not expressible through the generic public primitive. recordFxaaPass's
 *   body is intentionally unchanged across this refactor to preserve the
 *   AC-09 dualPassDiff=1069 (hello-fxaa) / 768 (learn-render-4-10-MSAA)
 *   byte-equivalence with the pre-feat baseline.
 * - any other id (AI-user path): the M1 patch wires `reads[0]` through the
 *   render-graph `resolveCtx` so the bind group samples the upstream
 *   graph-owned color target (e.g. `addScenePass` writes `'offscreenColor'`,
 *   a custom post-process pass declares `reads: ['offscreenColor']`).
 *   Failure modes (charter P3 fail-fast):
 *     - `lookupPostProcess(shader) === undefined` -> throw
 *       `PostProcessError({code:'post-process-not-found'})`
 *     - `reads.length > 0` but `resolveCtx.resolve(reads[0]) === undefined`
 *       -> throw `PostProcessError({code:'fullscreen-input-not-found',
 *       detail:{readsKey, passName}})`. AI users read err.detail.readsKey
 *       to find the missing graph.addColorTarget declaration.
 *   On success the dispatcher builds the input-texture BGL + sampler via
 *   `buildFullscreenPostProcessPass`, composes the per-frame bind group
 *   via `createFullscreenBindGroup`, opens a render pass writing the
 *   declared `color` (resolved through the graph's color-target view, or
 *   the swap-chain `ctx.view` when the graph has not allocated a target),
 *   binds the input bind group at slot 1 (the 0 slot is reserved for
 *   future view bind groups), and calls `handle.draw(pass)` which
 *   internally does `setPipeline(pipeline)` + `draw(3, 1, 0, 0)` over the
 *   fullscreen-triangle vertex shader.
 *
 * Extracted from the addPass execute closure so the topology fan-out is in
 * one named place; an AI user reading addFullscreenPass sees the single
 * call site, and future post-process branches (e.g. tonemap migrated onto
 * this dispatcher per OOS-3) extend this function rather than the addPass
 * inline closure.
 */
function dispatchFullscreenPass(
  ctx: RenderPipelineContext,
  name: string,
  shader: string,
  color: string,
  reads: readonly string[],
  resolveCtx?: ResolveContext,
  compositeOverSwapchain = false,
): void {
  if (shader === 'fxaa') {
    recordFxaaPass(ctx as unknown as _InternalRenderPipelineContext);
    return;
  }
  const lookup = ctx.runtime.lookupPostProcess;
  const entry = lookup === undefined ? undefined : lookup(shader);
  if (entry === undefined) {
    throw new PostProcessError({
      code: 'post-process-not-found',
      detail: { id: shader },
    });
  }

  // feat-20260621 M4' composite-over-swap-chain: copy the current swap-chain
  // into the `color` scratch target BEFORE sampling, so the effect reads the
  // already-composited final image (shadows + tonemap + fxaa). Generalises the
  // built-in FXAA copy idiom. The `color` key is BOTH the copy dst and the
  // sampled input (resolve its GPU texture via `${color}::tex` for the copy,
  // its TextureView via `${color}` for the bind group).
  let inputView: TextureView | null;
  if (compositeOverSwapchain) {
    const scratchTex = resolveCtx?.resolve(`${color}::tex`);
    const scratchView = resolveCtx?.resolve(color);
    if (scratchTex === undefined || scratchView === undefined) {
      throw new PostProcessError({
        code: 'fullscreen-input-not-found',
        detail: { readsKey: color, passName: name },
      });
    }
    ctx.encoder.copyTextureToTexture(
      { texture: ctx.currentTexture as never, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { texture: scratchTex as never, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { width: ctx.targetW, height: ctx.targetH, depthOrArrayLayers: 1 },
    );
    inputView = scratchView as TextureView;
  } else if (reads.length === 0) {
    // reads === [] preserves the legacy swap-chain sample path (used by
    // tonemap-style passes that read the framebuffer directly).
    inputView = ctx.view;
  } else {
    // reads with a key MUST resolve through the graph compile output, otherwise
    // the dispatcher throws fullscreen-input-not-found (charter P3 fail-fast).
    const readsKey = reads[0] as string;
    const resolved = resolveCtx?.resolve(readsKey);
    if (resolved === undefined) {
      throw new PostProcessError({
        code: 'fullscreen-input-not-found',
        detail: { readsKey, passName: name },
      });
    }
    inputView = resolved as TextureView;
  }
  if (inputView === null) return;

  // ── BGL/Pipeline build (before depth resolution so built.depthSampler is
  //    available for the depth threading block below) ────────────────────────
  const built = buildFullscreenPostProcessPass(
    { device: ctx.runtime.device, errorRegistry: ctx.runtime.errorRegistry },
    entry,
  );
  if (built === null) return;

  // ── plan-strategy D-6: depth read resolution (pipeline-agnostic, AC-02) ────
  // Iterate entry.reads looking for sampleType:'depth' entries. For each depth
  // entry, resolve a depth-only TextureView from the graph via
  // resolveDepthOnlyView, fail-fast on unresolvable keys. The depth sampler
  // is produced by buildFullscreenPostProcessPass (via createDepthSampler,
  // plan-strategy D-2: non-filtering nearest+clamp-to-edge).
  //
  // Both composite and non-composite branches handle depth symmetrically —
  // the depth resolution block is branch-agnostic (AC-02: no URP/HDRP
  // discrimination). Color input logic is unchanged (AC-03 zero-regression).
  let depthTexView: TextureView | null = null;
  let depthSampler: Sampler | null = null;
  if (entry.reads && entry.reads.length > 0) {
    const internals = ctx as unknown as _InternalRenderPipelineContext;
    for (const read of entry.reads) {
      if (typeof read !== 'string' && read.sampleType === 'depth') {
        const depthKey = read.key;
        depthTexView = resolveDepthOnlyView(
          internals,
          depthKey,
          'post-process-scene-depth-only-view',
        );
        if (depthTexView === null) {
          throw new PostProcessError({
            code: 'fullscreen-input-not-found',
            detail: { readsKey: depthKey, passName: name },
          });
        }
        depthSampler = built.depthSampler;
      }
    }
  }

  // feat-20260621 M4' composite-over-swap-chain write target: the swap-chain's
  // NON-srgb storage view (R-COLORSPACE — the scratch holds an already-sRGB-
  // encoded copy, so writing through the srgb view would double-encode; mirrors
  // recordFxaaPass). Otherwise resolve the declared color through the graph and
  // fall back to ctx.view (swap-chain srgb view) for normal post passes.
  let writeView: TextureView | null | undefined;
  let writeFormat = 'rgba8unorm-srgb';
  if (compositeOverSwapchain) {
    const storageViewRes = ctx.runtime.device.createTextureView(ctx.currentTexture, {});
    if (!storageViewRes.ok) {
      ctx.runtime.errorRegistry.fire(storageViewRes.error);
      return;
    }
    writeView = storageViewRes.value;
    writeFormat = ctx.pipelineState?.format ?? 'rgba8unorm';
  } else {
    writeView = (resolveCtx?.resolve(color) as TextureView | undefined) ?? ctx.view;
  }
  if (writeView === null || writeView === undefined) return;

  // feat-20260621 M-A2 / w8: per-frame data-driven params channel. When the
  // entry declares params, look up the per-id eager-created UBO + the per-frame
  // bytes from the PostProcessParams snapshot, fail-fast on a byteLength
  // mismatch, then writeBuffer + bind the UBO at group(1) binding(2). When
  // entry.params is undefined this whole block is skipped and the BGL degrades
  // to 2-entry (param-less zero-regression, R-A7).
  let paramsBuffer: Buffer | null = null;
  if (entry.params !== undefined) {
    const ubo = ctx.runtime.getPostProcessParamsBuffer?.(shader);
    if (ubo !== undefined) {
      const data = ctx.postProcessParams.get(shader);
      if (data !== undefined) {
        if (data.byteLength !== entry.params.byteSize) {
          throw new PostProcessError({
            code: 'params-update-size-mismatch',
            detail: { byteSize: entry.params.byteSize, actualLength: data.byteLength },
          });
        }
        const writeResult = ctx.runtime.device.queue.writeBuffer(ubo, 0, data);
        if (!writeResult.ok) return;
      }
      paramsBuffer = ubo;
    }
  } else if (entryHasDepthRead(entry)) {
    // D-3: a param-less depth entry still binds the minimal UBO auto-allocated
    // at register (the 'fullscreen-post-with-scene-depth' BGL always declares
    // params@2). No per-frame write -- the buffer stays zero-filled.
    paramsBuffer = ctx.runtime.getPostProcessParamsBuffer?.(shader) ?? null;
  }

  const bindGroup = createFullscreenBindGroup(
    ctx.runtime.device,
    built.bindGroupLayout,
    inputView,
    built.sampler,
    paramsBuffer,
    depthTexView,
    depthSampler,
  );
  if (bindGroup === null) return;

  // Pipeline source-of-truth (M4 / T-10-a, solving M1 CONCERN-1):
  // RenderSystemRuntime.getPostProcessPipeline is the sync wrapper over the
  // shared shader-module adapter (1-frame warmup). First frame after
  // postProcess.register: shader compile is in flight -> returns null -> we
  // skip the pass for that frame. Second frame onward: cached pipeline is
  // returned synchronously.
  //
  // Color format SSOT: the backend-aware swap-chain decision in
  // createRenderer.ts (selectSwapChainFormat) sets ctx.pipelineState.
  // colorAttachmentFormat per frame; Channel 2 (storageBufferCapable) picks the
  // UA preferred canvas format ('bgra8unorm-srgb' on macOS/Windows since
  // bug-20260612-webgpu-canvas-format-prefer-bgra) and Channel 3 (GLES
  // fallback) picks 'rgba8unorm-srgb'. The fullscreen post pass writes into the
  // swap-chain view (`color: 'swapchain'` -> ctx.view), so its PSO target
  // format MUST equal colorAttachmentFormat or dawn rejects the pass with an
  // attachment-state mismatch (the framebuffers/gamma/hdr learn-render demos hit
  // this on BGRA runners: nightly #385/#391). The `?? 'rgba8unorm-srgb'`
  // fallback keeps the unit fixtures that build a bare ctx without pipelineState
  // (makeSpyCtx in dispatch-fullscreen-pass-custom-reads.dawn.test.ts) green.
  // FXAA's rgba8unorm storage-view path is unaffected: it routes through
  // `recordFxaaPass` (the if(shader==='fxaa') branch above) and never reaches
  // this dispatcher line.
  // The PSO target format MUST equal the render-pass attachment format. For
  // the composite-over-swap-chain path that is the non-srgb storage format
  // (writeFormat); otherwise the backend-aware colorAttachmentFormat.
  const lookupPipeline = ctx.runtime.getPostProcessPipeline;
  if (lookupPipeline === undefined) return;
  const postColorFormat = (compositeOverSwapchain
    ? writeFormat
    : (ctx.pipelineState?.colorAttachmentFormat ??
      'rgba8unorm-srgb')) as unknown as GPUTextureFormat;
  const pipeline = lookupPipeline(shader, built.bindGroupLayout, postColorFormat);
  if (pipeline === null) return;
  const handle = built.createHandle(name, pipeline, paramsBuffer);

  // Open a render pass writing into the resolved color target. Fullscreen
  // post-process passes are non-MSAA, depth-less, single-attachment.
  // setBindGroup(1, ...) (group=1 reserved per plan-strategy convention;
  // group=0 is reserved for future view bind groups, mirroring the
  // recordTonemap / recordSkybox pattern that uses slot 0 only when the
  // pipeline declares a single bind group at slot 0).
  const pass = ctx.encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      {
        colorFormats: [writeFormat as unknown as GPUTextureFormat],
        depthFormat: undefined,
        sampleCount: 1,
      },
      { colorViews: [writeView] },
      'post-process',
    ) as never,
  );
  pass.setBindGroup(1, bindGroup);
  handle.draw(pass, inputView);
  pass.end();
}
