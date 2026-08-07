// @forgeax/engine-runtime - RenderSystem record stage: frame render targets.
// feat-20260704 M5/w31: further-split from frame.ts (AC-05 <=1500 lines/file).
// Pure leaf helpers invoked once each from recordFrame; behavior verbatim.

import type { RenderGraph, ResolveContext } from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type Buffer,
  type CommandBuffer,
  type RenderPipeline,
  type RhiCanvasContext,
  type RhiCommandEncoder,
  RhiError,
  type Texture,
  type TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import {
  composeRenderFeatureGraph,
  type RenderFeatureContributionPass,
} from '../features/graph-contribution';
import {
  type RenderFeatureGraphicsPassDescriptor,
  type RenderFeaturePreparedGraphicsState,
  type RenderFeaturePreparedRef,
  validateRenderFeatureGraphicsPass,
} from '../features/prepared-graphics';
import type { RenderFeaturePassContext } from '../features/types';
import type {
  PreparedGraphicsResolvedResource,
  PreparedGraphicsResolvedSnapshot,
} from '../prepare/prepared-graphics-resolver';
import type {
  _InternalRenderPipelineContext,
  RenderPipelineContext,
  RenderPipelineData,
} from '../render-pipeline-context';
import {
  configureSurface,
  getRenderFeatureGraphState,
  type PipelineState,
  type RenderSystemInternals,
  type RenderSystemRuntime,
} from '../render-system';
import type {
  CameraSnapshot,
  ExtractedLights,
  SkyboxSnapshot,
  SkylightSnapshot,
} from '../render-system-extract';
import type { RenderGraphExecutionPhase, RenderRecordPhase } from '../renderer';

import { type RenderFrameState, retirePerFrameGraph } from './frame-snapshot';

type RecordProfilePhase = (phase: RenderRecordPhase, action: () => void) => void;

function graphExecutionPhase(passName: string): RenderGraphExecutionPhase {
  switch (passName) {
    case 'point-shadow':
      return 'record/graph-execute/point-shadow';
    case 'cluster-binner-upload':
      return 'record/graph-execute/cluster-binner-upload';
    case 'g-buffer':
      return 'record/graph-execute/g-buffer';
    case 'ssao-calc':
      return 'record/graph-execute/ssao-calc';
    case 'ssao-blur':
      return 'record/graph-execute/ssao-blur';
    case 'lighting':
      return 'record/graph-execute/lighting';
    case 'forward':
      return 'record/graph-execute/forward';
    case 'tonemap':
      return 'record/graph-execute/tonemap';
    case 'debug-overlay':
      return 'record/graph-execute/debug-overlay';
    case 'shadow':
      return 'record/graph-execute/shadow';
    case 'spot-shadow':
      return 'record/graph-execute/spot-shadow';
    case 'skybox':
      return 'record/graph-execute/skybox';
    case 'main':
      return 'record/graph-execute/main';
    case 'fxaa':
      return 'record/graph-execute/fxaa';
    case 'bloom-bright':
      return 'record/graph-execute/bloom-bright';
    case 'bloom-blur-h':
      return 'record/graph-execute/bloom-blur-h';
    case 'bloom-blur-v':
      return 'record/graph-execute/bloom-blur-v';
    case 'bloom-composite':
      return 'record/graph-execute/bloom-composite';
    default:
      return 'record/graph-execute/other';
  }
}

/**
 * Resolve a graph color target in the format required by a render attachment.
 * The native swap-chain path stores LDR targets in the storage format and
 * attaches an sRGB view; WebGL2 uses the target's default sRGB view because
 * it cannot reinterpret the texture format.
 *
 * @internal
 */
export function resolveGraphColorAttachmentView(
  runtime: Pick<RenderSystemRuntime, 'device' | 'errorRegistry'>,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  key: string,
  fallback: TextureView | null,
): TextureView | null {
  const graph = frameState.perFrameGraph;
  const graphView = (graph?.getColorTargetView(key) as TextureView | undefined) ?? fallback;
  if (graphView === null || graphView === undefined) return null;
  if (key !== 'ldrColor' || !runtime.device.caps.storageBuffer) {
    return graphView;
  }
  const graphTexture = graph?.getColorTargetTexture(key);
  if (graphTexture === undefined) return graphView;
  const srgbViewRes = runtime.device.createTextureView(graphTexture as never, {
    format: pipelineState.colorAttachmentFormat as unknown as GPUTextureFormat,
  });
  if (!srgbViewRes.ok) {
    runtime.errorRegistry.fire(srgbViewRes.error);
    return null;
  }
  return srgbViewRes.value;
}

/**
 * feat-20260704 M3/w18: resolve the geometry pass colour / depth / resolve /
 * sprite-split target views (MSAA + tonemap routing) and write MSAA-dependent
 * graph-resolved views back to `pipelineState.perPassResources`. Extracted
 * verbatim from `recordFrame`.
 *
 * feat-20260604-learn-render-4.10-anti-aliasing-msaa M2 / w9 (D-6, C-9): MSAA
 * is a per-Camera switch derived from `camera.antialias`; when active the
 * geometry pass writes a count=4 multisample colour target and resolves to a
 * single-sample output. The single-sample path is byte-for-byte unchanged.
 *
 * @internal
 */
export function resolveGeometryTargetViews(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  camera: CameraSnapshot,
  view: TextureView,
  depthView: TextureView | null,
  tonemapActive: boolean,
  targetW: number,
  targetH: number,
): {
  msaaActive: boolean;
  geometryColorView: TextureView | null;
  geometryDepthView: TextureView | null;
  geometryDepthKey: string | null;
  geometryColorResolveView: TextureView | null;
  ldrSpriteColorView: TextureView | null;
} {
  // The wasm GL fallback cannot allocate multisample texture storage. Keep
  // the capability decision at the RHI boundary: an MSAA request degrades to
  // the single-sample route on that backend, while WebGPU/native retain the
  // existing 4x path.
  const msaaActive =
    camera.antialias === 'msaa' && internals.device.caps.backendKind !== 'wgpu-webgl2';
  let geometryColorView: TextureView | null = view;
  let geometryDepthView: TextureView | null = depthView;
  let geometryDepthKey: string | null = null;
  // Single-sample resolve out for the main colour pass (LDR: swap-chain
  // srgb view; HDR: hdrColorResolve view) + the multisample unorm target
  // for the LDR sprite split sub-pass. Both null when msaaActive is false.
  let geometryColorResolveView: TextureView | null = null;
  let ldrSpriteColorView: TextureView | null = null;
  if (tonemapActive) {
    // M1 / w7: HDR colour + depth textures owned by render-graph.
    // The graph owns all transient targets; recordFrame reads resolved
    // TextureViews each frame via getColorTargetView.
    geometryColorView =
      (frameState.perFrameGraph?.getColorTargetView('hdrColor') as TextureView) ?? view;
    geometryDepthView = msaaActive
      ? ((frameState.perFrameGraph?.getColorTargetView('hdrDepthMsaa') as TextureView) ?? depthView)
      : ((frameState.perFrameGraph?.getColorTargetView('hdrDepth') as TextureView) ?? depthView);
    geometryDepthKey = msaaActive ? 'hdrDepthMsaa' : 'hdrDepth';
    if (msaaActive) {
      geometryColorView =
        (frameState.perFrameGraph?.getColorTargetView('hdrColorMsaa') as TextureView) ??
        geometryColorView;
      geometryColorResolveView =
        (frameState.perFrameGraph?.getColorTargetView('hdrColor') as TextureView) ?? view;
    }
  } else if (msaaActive) {
    // M1 / w7: LDR MSAA textures owned by render-graph. The graph
    // allocates a count=4 bgra8unorm texture (msaaColor). The geometry
    // pass needs an srgb view of it (bgra8unorm-srgb) for hardware sRGB
    // encoding; the sprite sub-pass uses the unorm view. Create the
    // srgb view from the graph-owned texture on first use or resize.
    // bug-20260611: WebGL2 fallback path allocates msaaColor without
    // viewFormats so requesting a `*-srgb` view fails; in that case
    // pipelineState.format === pipelineState.colorAttachmentFormat (the
    // surface is already configured as the sRGB storage format directly),
    // so the graph default view IS the sRGB view -- skip the rebuild.
    const msaaColorView = frameState.perFrameGraph?.getColorTargetView('msaaColor') as TextureView;
    const msaaColorTex = frameState.perFrameGraph?.getColorTargetTexture('msaaColor');
    const srgbReinterpretSupported = pipelineState.format !== pipelineState.colorAttachmentFormat;
    if (
      srgbReinterpretSupported &&
      msaaColorTex !== undefined &&
      (pipelineState.perPassResources.msaaColorView === null ||
        pipelineState.perPassResources.msaaTextureWidth !== targetW ||
        pipelineState.perPassResources.msaaTextureHeight !== targetH)
    ) {
      const srgbViewRes = internals.device.createTextureView(msaaColorTex as never, {
        format: pipelineState.colorAttachmentFormat as unknown as GPUTextureFormat,
      });
      if (srgbViewRes.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
        pipelineState.perPassResources.msaaColorView = srgbViewRes.value as any;
        pipelineState.perPassResources.msaaTextureWidth = targetW;
        pipelineState.perPassResources.msaaTextureHeight = targetH;
      }
    }
    geometryColorView = srgbReinterpretSupported
      ? pipelineState.perPassResources.msaaColorView
      : msaaColorView;
    geometryDepthView = frameState.perFrameGraph?.getColorTargetView('msaaDepth') as TextureView;
    geometryDepthKey = 'msaaDepth';
    geometryColorResolveView = view;
    ldrSpriteColorView = msaaColorView;
  } else if (camera.antialias === 'fxaa') {
    geometryColorView = resolveGraphColorAttachmentView(
      internals,
      frameState,
      pipelineState,
      'ldrColor',
      view,
    );
  }

  // M1 / w7: write back MSAA-dependent graph-resolved views to perPassResources.
  {
    const graphHdrDepthView = frameState.perFrameGraph?.getColorTargetView('hdrDepth') as
      | TextureView
      | undefined;
    if (graphHdrDepthView !== undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
      pipelineState.perPassResources.hdrDepthView = graphHdrDepthView as any;
      pipelineState.perPassResources.hdrDepthSampleCount = msaaActive ? 4 : 1;
    }
    const graphHdrMsaaView = frameState.perFrameGraph?.getColorTargetView('hdrColorMsaa') as
      | TextureView
      | undefined;
    if (graphHdrMsaaView !== undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
      pipelineState.perPassResources.hdrColorMsaaView = graphHdrMsaaView as any;
    }
    const graphMsaaColorView = frameState.perFrameGraph?.getColorTargetView('msaaColor') as
      | TextureView
      | undefined;
    if (graphMsaaColorView !== undefined) {
      // w7-fix (round 3): msaaColor is one count=4 storage texture (bgra8unorm)
      // viewed through TWO formats: bgra8unorm (sprite split sub-pass, no
      // sRGB encoding) and bgra8unorm-srgb (geometry pass, hardware sRGB
      // encoding). The graph publishes the default bgra8unorm view; the
      // LDR-MSAA branch above creates the bgra8unorm-srgb view from the
      // graph-owned texture and stores it as `msaaColorView`. So the
      // sprite-side view is the graph default; the geometry-side view stays
      // whatever the LDR-MSAA branch (or HDR-MSAA path) just installed.
      // Overwriting `msaaColorView` here would drop the srgb view and the
      // geometry pass would attempt to write a bgra8unorm view alongside a
      // bgra8unorm-srgb resolve target, failing colorAttachment/resolveTarget
      // format-match validation.
      // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
      pipelineState.perPassResources.msaaSpriteColorView = graphMsaaColorView as any;
      pipelineState.perPassResources.msaaTextureWidth = targetW;
      pipelineState.perPassResources.msaaTextureHeight = targetH;
    }
    const graphMsaaDepthView = frameState.perFrameGraph?.getColorTargetView('msaaDepth') as
      | TextureView
      | undefined;
    if (graphMsaaDepthView !== undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
      pipelineState.perPassResources.msaaDepthView = graphMsaaDepthView as any;
    }
  }
  return {
    msaaActive,
    geometryColorView,
    geometryDepthView,
    geometryColorResolveView,
    ldrSpriteColorView,
    geometryDepthKey,
  };
}

/**
 * feat-20260704 M3/w18: write back graph-resolved TextureViews (depth / shadow
 * / hdrColor) into `pipelineState.perPassResources` so
 * downstream pass closures (recordMainPass / recordTonemapPass /
 * recordFxaaPass / recordShadowPass / recordSkyboxPass) and the view BG cache
 * read them without signature changes. Extracted verbatim from `recordFrame`.
 * The graph owns the texture lifecycle; perPassResources holds a cached
 * reference for bindgroup invalidation self-checks (D-3 physical texture
 * identity). hdrDepth / hdrColorMsaa / msaaColor / msaaDepth are written back
 * separately in resolveGeometryTargetViews (per-frame MSAA/tonemap ownership).
 *
 * @internal
 */
export function writebackGraphViews(
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  lights: ExtractedLights,
  shadowView: TextureView | null,
  shadowMs: number | undefined,
  targetW: number,
  targetH: number,
): void {
  const graphDepthView = frameState.perFrameGraph?.getColorTargetView('depth') as
    | TextureView
    | undefined;
  if (graphDepthView !== undefined) {
    // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
    pipelineState.perPassResources.depthTextureView = graphDepthView as any;
    pipelineState.perPassResources.depthTextureWidth = targetW;
    pipelineState.perPassResources.depthTextureHeight = targetH;
  }
  if (shadowView !== null) {
    // M5-T2: shadow textureView writeback to the ECS-managed slot
    // is removed; downstream consumers (recordFrame view-main b3,
    // recordShadowPass shadowView gate, debugSampleShadowFactor
    // probe) now read directly from the render-graph via
    // `getColorTargetView('shadowDepth')` /
    // `renderSystem.getCurrentShadowView()` (D-2 SSOT). The texture
    // handle writeback below stays — debugReadbackShadowDepth still
    // copies from the GPU Texture, not the view.
    // w7-fix (round 3): also write back the GPU Texture handle. The
    // pre-w7 ensureLazyTexture path wrote both view + texture; w7 only
    // wrote the view, leaving `shadowTexture` null forever and breaking
    // `debugReadbackShadowDepth` (it copies from the texture, not the
    // view).
    const graphShadowTex = frameState.perFrameGraph?.getColorTargetTexture('shadowDepth');
    // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
    pipelineState.perPassResources.shadowTexture = graphShadowTex as any;
    pipelineState.perPassResources.shadowMapSize = shadowMs ?? 0;
    pipelineState.perPassResources.shadowCascadeCount = lights.cascadeCount ?? 0;
    // feat-20260613-csm-cascaded-shadow-maps M5 / w28: populate the
    // legacy single-mat4 field (cascade 0 lightViewProj — kept for
    // Inspector backward compatibility) AND the full 4-cascade matrix
    // pack (consumed by debugSampleShadowFactor's CSM-aware probe so
    // worldPos → cascade picking matches the main path's geometry).
    // Both are pre-allocated 64-float arrays (single mat4 / 4 mat4)
    // and overwritten in place each frame.
    const lvp0 = lights.lightViewProj?.[0];
    if (lvp0 !== undefined) {
      pipelineState.perPassResources.shadowLightSpaceMatrix = new Float32Array(lvp0);
    }
    if (lights.lightViewProj !== undefined) {
      const csmPack = new Float32Array(64);
      for (let c = 0; c < 4; c++) {
        const m = lights.lightViewProj[c];
        if (m === undefined) continue;
        for (let i = 0; i < 16; i++) csmPack[c * 16 + i] = m[i] ?? 0;
      }
      pipelineState.perPassResources.shadowCsmLightViewProj = csmPack;
    }
  } else {
    pipelineState.perPassResources.shadowTexture = null;
    pipelineState.perPassResources.shadowMapSize = 0;
    pipelineState.perPassResources.shadowCascadeCount = 0;
    pipelineState.perPassResources.shadowLightSpaceMatrix = null;
    pipelineState.perPassResources.shadowCsmLightViewProj = null;
  }
  const graphHdrView = frameState.perFrameGraph?.getColorTargetView('hdrColor') as
    | TextureView
    | undefined;
  if (graphHdrView !== undefined) {
    // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
    pipelineState.perPassResources.hdrColorView = graphHdrView as any;
    pipelineState.perPassResources.hdrTextureWidth = targetW;
    pipelineState.perPassResources.hdrTextureHeight = targetH;
  }
}

/**
 * feat-20260704 M3/w18: acquire the swap-chain colour texture + view + target
 * dimensions for this frame, extracted verbatim from `recordFrame`.
 *
 * A-IN-2 / AC-03: on `getCurrentTexture` failure, reset the configured flag,
 * reconfigure the canvas surface, and retry getCurrentTexture exactly once
 * (the normal hot path never reconfigures — A-AC-05). Returns null when the
 * context is null, the retry also fails (fires internal-fault A-AC-04), or the
 * colour view cannot be created — the caller bails after the finally-block
 * frame advance.
 *
 * bug-20260519: when the canvas storage format differs from the sRGB-encoding
 * view format, request the view explicitly so the GPU performs linear -> sRGB
 * encoding on store; when formats match request the default view.
 *
 * @internal
 */
export function acquireSwapChainTarget(
  internals: RenderSystemInternals,
  pipelineState: PipelineState,
): { currentTexture: Texture; view: TextureView; targetW: number; targetH: number } | null {
  const canvasContext: RhiCanvasContext | null = internals.context;
  if (canvasContext === null) return null;

  let currentTextureResult = canvasContext.getCurrentTexture();
  if (!currentTextureResult.ok) {
    // A-IN-2 / AC-03: reset configured flag + reconfigure canvas context +
    // retry getCurrentTexture once. Only the exceptional path (surface
    // outdated) hits this branch; the normal hot path stays unmodified
    // (A-AC-05: zero reconfigure calls on success).
    pipelineState.perPassResources.configured = false;
    const cfgResult = configureSurface(
      canvasContext,
      internals.device,
      pipelineState.format,
      pipelineState.colorAttachmentFormat,
    );
    if (cfgResult.ok) {
      pipelineState.perPassResources.configured = true;
      (globalThis as Record<string, unknown>).__forgeaxSwapChainFormat = pipelineState.format;
    }
    // Retry getCurrentTexture exactly once
    const retryResult = canvasContext.getCurrentTexture();
    if (!retryResult.ok) {
      internals.errorRegistry.fire(retryResult.error);
      // A-AC-04: consecutive failure → internal-fault with surface detail
      internals.healthRegistry.fire({
        reason: 'internal-fault',
        detail: {
          message:
            'surface-configure-failed after retry: getCurrentTexture failed twice consecutively',
        },
        recoverable: false,
      });
      return null;
    }
    currentTextureResult = retryResult;
  }
  // bug-20260519: when the canvas storage format differs from the
  // sRGB-encoding view format, ask for the view explicitly so the GPU
  // performs linear -> sRGB encoding on store. When formats match
  // (offscreen render targets / non-sRGB swap-chains) request the
  // default view to stay compatible with textures created without
  // `viewFormats`.
  const viewDesc =
    pipelineState.colorAttachmentFormat === pipelineState.format
      ? {}
      : { format: pipelineState.colorAttachmentFormat as unknown as GPUTextureFormat };
  const viewResult = internals.device.createTextureView(currentTextureResult.value, viewDesc);
  if (!viewResult.ok) {
    internals.errorRegistry.fire(viewResult.error);
    return null;
  }
  const view = viewResult.value;

  // bug-20260519: depth attachment. Allocate a `depth24plus-stencil8` texture sized
  // to the swap-chain texture; recreate when the canvas resizes. The
  // pipelines were upgraded to `depthStencil: { format: 'depth24plus-stencil8',
  // depthWriteEnabled: true, depthCompare: 'less' }` + `cullMode: 'back'`
  // in the same fix; without a depth attachment the renderpass would
  // fail validation. The size mirrors the actual GPU texture, not the
  // CSS-pixel canvas attribute, so HiDPI canvases stay correct.
  const colorTexAny = currentTextureResult.value as unknown as {
    readonly width: number;
    readonly height: number;
  };
  const targetW = colorTexAny.width | 0;
  const targetH = colorTexAny.height | 0;
  return { currentTexture: currentTextureResult.value, view, targetW, targetH };
}

/**
 * feat-20260704 M3/w18: build (memoized) + resize-recompile the per-frame
 * render graph, extracted verbatim from `recordFrame`. Drift-rebuild: if the
 * installed shadow map size or cascade count changed since the last buildGraph,
 * null `perFrameGraph` so the next buildGraph re-sizes the shadowDepth target
 * (cascadeCount changes atlas tilesPerSide + N-pass loop count). buildGraph
 * runs once per RenderSystem (memoized); the topology-relevant subset of
 * RenderPipelineData is computed here with per-frame runtime state stubbed to
 * identity (validated / validatedOrdered / skyboxActive / splitLdrSprite are
 * never used to shape graph topology). Returns null when buildGraph produces
 * null or the resize recompile fails — the caller bails.
 *
 * @internal
 */
export function ensurePerFrameGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  camera: CameraSnapshot,
  lights: ExtractedLights,
  skylight: SkylightSnapshot | undefined,
  skylightCount: number,
  skybox: SkyboxSnapshot | undefined,
  targetW: number,
  targetH: number,
  shadowMapSizeOverride?: number,
): RenderGraph<RenderPipelineContext> | null {
  const earlyTonemapActive = camera.tonemap !== 'none';
  const earlyTopologyKey = `${camera.antialias}:${earlyTonemapActive ? 'tonemap' : 'ldr'}`;
  const earlyShadowMapSize = shadowMapSizeOverride ?? lights.shadowMapSize;
  const earlyCascadeCount = lights.cascadeCount;
  // Drift-rebuild: if the installed shadow map size or cascade count has
  // changed since the last buildGraph, null perFrameGraph so the next
  // buildGraph re-sizes the shadowDepth target. cascadeCount changes the
  // atlas tilesPerSide and the N-pass loop count. The RenderSystem's
  // installed-pipeline-handle change already triggers a similar rebuild on
  // pipeline swap.
  if (
    frameState.perFrameGraph !== null &&
    (frameState.perFrameGraphTopologyKey !== earlyTopologyKey ||
      pipelineState.perPassResources.shadowMapSize !== (earlyShadowMapSize ?? 0) ||
      pipelineState.perPassResources.shadowCascadeCount !== (earlyCascadeCount ?? 0))
  ) {
    retirePerFrameGraph(frameState);
  }
  const earlyData: RenderPipelineData = {
    camera,
    validated: [],
    validatedOrdered: [],
    targetW,
    targetH,
    skylight,
    skylightCount,
    skyboxActive: false,
    skybox,
    tonemapActive: earlyTonemapActive,
    splitLdrSprite: false,
    config: frameState.installedPipelineConfig,
    shadowMapSize: earlyShadowMapSize,
    cascadeCount: earlyCascadeCount,
  };
  // pipelineState carried so buildGraph closures can read the swap-chain
  // colour format (pipelineState.colorAttachmentFormat) when declaring
  // offscreen render targets — a custom pipeline that renders the scene into
  // its own colour target MUST match the geometry PSO format, which follows
  // the UA-preferred canvas format (bgra8unorm-srgb on macOS/Windows since
  // bug-20260612-webgpu-canvas-format-prefer-bgra). The per-frame passCtx
  // below already carries it; the memoized earlyCtx build path did not, so
  // offscreen-RT demos hardcoded rgba8unorm-srgb and broke on BGRA runners
  // (nightly #385/#391).
  const earlyCtx = {
    runtime: internals,
    pipelineState,
    targetW,
    targetH,
  };
  if (frameState.perFrameGraph === null) {
    frameState.perFrameGraph = frameState.activePipeline.buildGraph(
      earlyCtx as unknown as RenderPipelineContext,
      earlyData,
    );
    frameState.perFrameGraphTopologyKey = earlyTopologyKey;
    getRenderFeatureGraphState(internals).composition = undefined;
  }
  const perFrameGraph = frameState.perFrameGraph;
  if (perFrameGraph === null) return null;

  const featureGraphState = getRenderFeatureGraphState(internals);
  const hasFeatureGraphWork = featureGraphState.contributions.some(
    (contribution) => contribution.resources.length > 0 || contribution.passes.length > 0,
  );
  if (featureGraphState.composition === undefined && hasFeatureGraphWork) {
    const composed = composeRenderFeatureGraph(
      perFrameGraph,
      featureGraphState.contributions,
      (context, contributionPass, resolveContext, execute) =>
        executeGraphOwnedRenderFeaturePass(context, contributionPass, resolveContext, execute),
      (identity, order, failure) =>
        reportRenderFeatureExecutionError(internals, { featureIdentity: identity, order }, failure),
    );
    if (!composed.ok) {
      reportRenderFeatureExecutionError(
        internals,
        {
          featureIdentity:
            'detail' in composed.error &&
            composed.error.detail !== undefined &&
            'featureIdentity' in composed.error.detail
              ? composed.error.detail.featureIdentity
              : 'render-feature-unknown',
          order:
            'detail' in composed.error &&
            composed.error.detail !== undefined &&
            'order' in composed.error.detail
              ? composed.error.detail.order
              : -1,
        },
        composed.error,
      );
      featureGraphState.composition = undefined;
      return null;
    }
    featureGraphState.composition = composed.value;
    const finalCompile = perFrameGraph.compile({
      backendKind: internals.device.caps.backendKind,
      caps: internals.device.caps,
      device: internals.device,
    });
    if (!finalCompile.ok) {
      const owner = graphCompileOwner(featureGraphState.contributions, finalCompile.error.detail);
      if (owner !== undefined) {
        reportRenderFeatureExecutionError(
          internals,
          owner,
          new RenderFeatureStageFailedError(
            owner.featureIdentity,
            owner.order,
            'contribute',
            'next-frame',
          ),
        );
        featureGraphState.composition = undefined;
        return null;
      }
      internals.errorRegistry.fire(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'render feature graph contribution compile succeeds',
          hint: 'inspect detail.error for the render-graph compile failure code',
          detail: {
            error: {
              code: finalCompile.error.code,
              message: `${finalCompile.error.code}: ${finalCompile.error.expected}`,
            },
          },
        }),
      );
      return null;
    }
  } else if (featureGraphState.composition !== undefined) {
    const updated = featureGraphState.composition.update(featureGraphState.contributions);
    if (updated.topologyChanged) {
      retirePerFrameGraph(frameState);
      featureGraphState.composition = undefined;
      return null;
    }
  }

  // Update swap-chain size + recompile on resize.
  const needsRecompile = perFrameGraph.setSwapChainSize(targetW, targetH);
  if (needsRecompile) {
    const rcRes = perFrameGraph.compile({
      backendKind: internals.device.caps.backendKind,
      caps: internals.device.caps,
      device: internals.device,
    });
    if (!rcRes.ok) {
      const owner = graphCompileOwner(featureGraphState.contributions, rcRes.error.detail);
      if (owner !== undefined) {
        reportRenderFeatureExecutionError(
          internals,
          owner,
          new RenderFeatureStageFailedError(
            owner.featureIdentity,
            owner.order,
            'contribute',
            'next-frame',
          ),
        );
        featureGraphState.composition = undefined;
        return null;
      }
      internals.errorRegistry.fire(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'render-graph recompile on resize succeeds',
          hint: 'inspect detail.error for the render-graph compile failure code',
          detail: {
            error: {
              code: rcRes.error.code,
              message: `${rcRes.error.code}: ${rcRes.error.expected}`,
            },
          },
        }),
      );
      return null;
    }
  }
  return perFrameGraph;
}

function executeGraphOwnedRenderFeaturePass(
  context: RenderPipelineContext,
  contributionPass: RenderFeatureContributionPass<RenderFeaturePassContext>,
  resolveContext: ResolveContext,
  execute: (context: RenderFeaturePassContext) => void,
): void {
  const resolvedWrites = contributionPass.descriptor.writes
    .map((name) => resolveContext.resolve(name))
    .filter((view): view is unknown => view !== undefined);
  const resolvedDepth = contributionPass.descriptor.reads
    .map((name) => resolveContext.resolve(name))
    .find((view): view is unknown => view !== undefined);
  const colorViews = resolvedWrites.length > 0 ? resolvedWrites : [context.view];
  if (
    contributionPass.graphics !== undefined &&
    (contributionPass.graphicsState === undefined ||
      contributionPass.resolvedGraphics === undefined)
  ) {
    throw new RenderFeatureStageFailedError(
      contributionPass.featureIdentity,
      contributionPass.order,
      'record',
      'next-frame',
    );
  }
  const activePass = context.encoder.beginRenderPass({
    label: contributionPass.name,
    colorAttachments: colorViews.map((view) => ({
      view: view as unknown as GPUTextureView,
      loadOp: 'load',
      storeOp: 'store',
    })),
    ...(resolvedDepth !== undefined
      ? {
          depthStencilAttachment: {
            view: resolvedDepth as unknown as GPUTextureView,
            depthLoadOp: 'load',
            depthStoreOp: 'store',
            stencilLoadOp: 'load',
            stencilStoreOp: 'store',
          },
        }
      : {}),
  });
  try {
    if (contributionPass.graphics !== undefined) {
      const state = contributionPass.graphicsState;
      const resolvedGraphics = contributionPass.resolvedGraphics;
      if (state === undefined || resolvedGraphics === undefined) return;
      const ledger: RenderFeatureGraphicsRecordingLedger = {
        pipeline: 0,
        binding: 0,
        vertex: 0,
        index: 0,
        draw: 0,
        setPipeline: (handle) => activePass.setPipeline(handle as RenderPipeline),
        setBindGroupAt: (index, handle) => activePass.setBindGroup(index, handle as BindGroup),
        setVertexBuffer: (slot, handle) => activePass.setVertexBuffer(slot, handle as Buffer),
        setIndexBuffer: (handle, format) => activePass.setIndexBuffer(handle as Buffer, format),
        recordDraw: (command) =>
          activePass.draw(
            command.vertexCount,
            command.instanceCount,
            command.firstVertex,
            command.firstInstance,
          ),
        recordDrawIndexed: (command) =>
          activePass.drawIndexed(
            command.indexCount,
            command.instanceCount,
            command.firstIndex,
            command.baseVertex,
            command.firstInstance,
          ),
      };
      const recorded = recordResolvedRenderFeatureGraphicsPass(
        contributionPass.featureIdentity,
        contributionPass.graphics,
        state,
        resolvedGraphics,
        ledger,
      );
      if (!recorded.ok) throw recorded.error;
    } else {
      execute({
        frame: { frameNumber: context.frameState.frameNumber },
        pass: {
          name: contributionPass.name,
          reads: contributionPass.descriptor.reads,
          writes: contributionPass.descriptor.writes,
        },
      });
    }
  } finally {
    activePass.end();
  }
}

export interface RenderFeatureGraphicsRecordingLedger {
  pipeline: number;
  binding: number;
  vertex: number;
  index: number;
  draw: number;
  setPipeline?: (handle: unknown) => void;
  setBindGroup?: (handle: unknown) => void;
  setBindGroupAt?: (index: number, handle: unknown) => void;
  setVertexBuffer?: (slot: number, handle: unknown) => void;
  setIndexBuffer?: (handle: unknown, format: 'uint16' | 'uint32') => void;
  recordDraw?: (
    command: Extract<
      RenderFeatureGraphicsPassDescriptor['draws'][number],
      { kind: 'draw' }
    >['command'],
  ) => void;
  recordDrawIndexed?: (
    command: Extract<
      RenderFeatureGraphicsPassDescriptor['draws'][number],
      { kind: 'draw-indexed' }
    >['command'],
  ) => void;
}

function resolvedResource(
  snapshot: PreparedGraphicsResolvedSnapshot,
  reference: RenderFeaturePreparedRef,
  kind: PreparedGraphicsResolvedResource['kind'],
): PreparedGraphicsResolvedResource | undefined {
  const resource = snapshot.resolve(reference);
  return resource?.kind === kind ? resource : undefined;
}

export function recordResolvedRenderFeatureGraphicsPass(
  featureIdentity: string,
  descriptor: RenderFeatureGraphicsPassDescriptor,
  state: RenderFeaturePreparedGraphicsState,
  resolved: PreparedGraphicsResolvedSnapshot,
  ledger: RenderFeatureGraphicsRecordingLedger,
): Result<{ readonly acceptedDrawCount: number }, RenderError> {
  const validated = validateRenderFeatureGraphicsPass(featureIdentity, descriptor, state);
  if (!validated.ok) return validated;
  const resolvedDraws: Array<{
    readonly pipeline: PreparedGraphicsResolvedResource;
    readonly bindings: readonly PreparedGraphicsResolvedResource[];
    readonly vertexData: readonly {
      readonly slot: number;
      readonly resource: PreparedGraphicsResolvedResource;
    }[];
    readonly indexData: PreparedGraphicsResolvedResource | undefined;
    readonly draw: (typeof descriptor.draws)[number];
  }> = [];
  for (const draw of descriptor.draws) {
    const pipeline = resolvedResource(resolved, draw.pipeline, 'pipeline');
    const bindings = draw.bindings.map((binding) =>
      resolvedResource(resolved, binding, 'bindings'),
    );
    const vertexData = draw.vertexData.map((vertex) => ({
      slot: vertex.slot,
      resource: resolvedResource(resolved, vertex.resource, 'vertex-data'),
    }));
    const indexData =
      draw.indexData === undefined
        ? undefined
        : resolvedResource(resolved, draw.indexData.resource, 'index-data');
    if (
      pipeline === undefined ||
      bindings.some((binding) => binding === undefined) ||
      vertexData.some((vertex) => vertex.resource === undefined) ||
      (draw.indexData !== undefined && indexData === undefined)
    ) {
      return err(new RenderFeatureStageFailedError(featureIdentity, -1, 'record', 'next-frame'));
    }
    resolvedDraws.push({
      pipeline,
      bindings: bindings as PreparedGraphicsResolvedResource[],
      vertexData: vertexData as {
        readonly slot: number;
        readonly resource: PreparedGraphicsResolvedResource;
      }[],
      indexData,
      draw,
    });
  }
  for (const resolvedDraw of resolvedDraws) {
    ledger.pipeline += 1;
    ledger.setPipeline?.(resolvedDraw.pipeline.handle);
    for (const [index, binding] of resolvedDraw.bindings.entries()) {
      ledger.binding += 1;
      if (ledger.setBindGroupAt !== undefined) {
        ledger.setBindGroupAt(index, binding.handle);
      } else {
        ledger.setBindGroup?.(binding.handle);
      }
    }
    for (const vertex of resolvedDraw.vertexData) {
      ledger.vertex += 1;
      ledger.setVertexBuffer?.(vertex.slot, vertex.resource.handle);
    }
    if (resolvedDraw.draw.kind === 'draw-indexed') {
      const indexData = resolvedDraw.draw.indexData;
      const indexHandle = resolvedDraw.indexData?.handle;
      if (indexData === undefined || indexHandle === undefined) {
        return err(new RenderFeatureStageFailedError(featureIdentity, -1, 'record', 'next-frame'));
      }
      ledger.index += 1;
      ledger.setIndexBuffer?.(indexHandle, indexData.format);
      ledger.draw += 1;
      ledger.recordDrawIndexed?.(resolvedDraw.draw.command);
    } else {
      ledger.draw += 1;
      ledger.recordDraw?.(resolvedDraw.draw.command);
    }
  }
  return ok(validated.value);
}

export function recordRenderFeatureGraphicsPass(
  featureIdentity: string,
  descriptor: RenderFeatureGraphicsPassDescriptor,
  state: RenderFeaturePreparedGraphicsState,
  ledger: RenderFeatureGraphicsRecordingLedger,
): Result<{ readonly acceptedDrawCount: number }, RenderError> {
  const validated = validateRenderFeatureGraphicsPass(featureIdentity, descriptor, state);
  if (!validated.ok) return validated;
  for (const draw of descriptor.draws) {
    ledger.pipeline += 1;
    ledger.setPipeline?.(draw.pipeline);
    for (const binding of draw.bindings) {
      ledger.binding += 1;
      ledger.setBindGroup?.(binding);
    }
    for (const vertex of draw.vertexData) {
      ledger.vertex += 1;
      ledger.setVertexBuffer?.(vertex.slot, vertex.resource);
    }
    if (draw.kind === 'draw-indexed') {
      if (draw.indexData === undefined) {
        return err(new RenderFeatureStageFailedError(featureIdentity, -1, 'record', 'next-frame'));
      }
      ledger.index += 1;
      ledger.setIndexBuffer?.(draw.indexData.resource, draw.indexData.format);
      ledger.draw += 1;
      ledger.recordDrawIndexed?.(draw.command);
    } else {
      ledger.draw += 1;
      ledger.recordDraw?.(draw.command);
    }
  }
  return ok(validated.value);
}

function reportRenderFeatureExecutionError(
  internals: RenderSystemInternals,
  owner: { readonly featureIdentity: string; readonly order: number },
  failure: unknown,
): void {
  const candidate =
    failure instanceof Error && typeof (failure as Partial<RenderError>).code === 'string'
      ? (failure as RenderError)
      : new RenderFeatureStageFailedError(
          owner.featureIdentity,
          owner.order,
          'contribute',
          'next-frame',
        );
  const error = internals.featureHost?.recordError(owner.featureIdentity, candidate) ?? candidate;
  internals.errorRegistry.fire(error);
}

function graphCompileOwner(
  contributions: readonly { readonly featureIdentity: string; readonly order: number }[],
  detail: unknown,
): { readonly featureIdentity: string; readonly order: number } | undefined {
  const text = JSON.stringify(detail);
  return contributions.find((contribution) => text.includes(contribution.featureIdentity));
}

/**
 * Fit the shadow atlas to the device's texture-dimension capability while
 * preserving the authored cascade count. The same effective size is threaded
 * through graph allocation and pass metadata. The wgpu GLES/WebGL2 fallback
 * reports a 2048px generic texture limit, but its depth32float render/sample
 * path is only reliable up to 1024px; reserve the backend's other half for
 * that depth-format limitation instead of creating an invalid bind group.
 */
export function resolveShadowMapSize(
  internals: RenderSystemInternals,
  lights: ExtractedLights,
): number | undefined {
  const requested = lights.shadowMapSize;
  if (!(requested !== undefined && requested > 0)) return requested;
  const cascades = Math.max(1, Math.min(4, Math.round(lights.cascadeCount ?? 1)));
  const tilesPerSide = Math.ceil(Math.sqrt(cascades));
  const maxDimension = internals.device.limits.maxTextureDimension2D;
  if (!(maxDimension > 0)) return Math.floor(requested);
  const backendKind = internals.device.caps?.backendKind;
  const depthTextureDimension =
    backendKind === 'wgpu-webgl2' ? Math.max(1, Math.floor(maxDimension / 2)) : maxDimension;
  const maxPerTile = Math.max(1, Math.floor(depthTextureDimension / tilesPerSide));
  return Math.max(1, Math.min(Math.floor(requested), maxPerTile));
}

/**
 * feat-20260704 M3/w18: build (memoized) + execute the per-frame render graph,
 * then finish + submit the shared frame encoder and reclaim retired transient
 * textures. Extracted verbatim from `recordFrame`. Returns whether that shared
 * encoder was actually submitted so callers can protect resources until the
 * queue completion barrier.
 *
 * feat-20260601 M1 / w7: the graph is built through the currently installed
 * RenderPipeline (forgeax::urp by default); `draw` nulls perFrameGraph on a
 * pipeline swap so the next frame rebuilds via the new impl (hot-swap), effect
 * toggles do not. graph.execute is the sole frame-recording path (AC-05).
 * Encoder semantics (RD-4): the shadow closure opens its own encoder + submit;
 * main/tonemap/FXAA share this `encoder`, finished + submitted once here.
 * bug-20260622 D-3: reclaimRetiredTransients is fire-and-forget with .catch —
 * the async onSubmittedWorkDone may resolve after the renderer/device is
 * disposed (test teardown), so the post-dispose rejection is swallowed.
 *
 * @internal
 */
export function executeFrameGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  passCtx: _InternalRenderPipelineContext,
  passData: RenderPipelineData,
  encoder: RhiCommandEncoder,
  profilePhase?: RecordProfilePhase,
): boolean {
  if (frameState.perFrameGraph === null) {
    frameState.perFrameGraph = frameState.activePipeline.buildGraph(passCtx, passData);
  }
  const graph = frameState.perFrameGraph;
  if (graph === null) return false;
  if (profilePhase === undefined) {
    graph.execute(passCtx);
  } else {
    graph.execute(passCtx, (passName, action) => {
      profilePhase(graphExecutionPhase(passName), action);
    });
  }

  const finishResult = encoder.finish();
  if (!finishResult.ok) {
    internals.errorRegistry.fire(finishResult.error);
    return false;
  }
  const cmd: CommandBuffer = finishResult.value;
  const submitResult = internals.device.queue.submit([cmd]);
  if (!submitResult.ok) {
    internals.errorRegistry.fire(submitResult.error);
    return false;
  }
  graph.reclaimRetiredTransients().catch(() => {});
  return true;
}
