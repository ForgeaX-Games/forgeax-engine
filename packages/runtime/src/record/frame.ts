// @forgeax/engine-runtime - RenderSystem record stage: frame.
// Extracted from render-system-record.ts (feat-20260704 M3/w17, pure move).

import type { World } from '@forgeax/engine-ecs';
import { type RhiCommandEncoder, RhiError, type TextureView } from '@forgeax/engine-rhi';
import type { MaterialRenderState, MeshAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import type {
  _InternalRenderPipelineContext,
  RenderPipelineData,
} from '../render-pipeline-context';
import type { PipelineState, RenderSystemInternals } from '../render-system';
import type {
  CameraSnapshot,
  DispatchEntry,
  ExtractedLights,
  RenderableSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
} from '../render-system-extract';
// feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4 (D-1 record-stage
// fold operator). Pure linear-scan helper that groups transparent-dispatch
// entries with equal (Layer.value, sortKey, materialHandle) into FoldBucket
// descriptors. The drawIndexed swap (1 instanced draw per bucket vs N
// per-entity draws) hooks into the sprite-pass dispatch loop below
// (w4-record-swap), using {@link buildFoldDispatchPlan} to translate
// renderableIndex-keyed buckets into validatedOrdered-index-keyed
// head/skip maps.
import {
  buildFoldDispatchPlan,
  evaluateFoldBucketUniformCap,
  type FoldBucket,
  type FoldDispatchPlan,
  foldDispatchBuckets,
  incrementFoldedDrawsMetric,
} from '../render-system-fold';
import { resolveAssetHandle } from '../resolve-asset-handle';
import { getTransparentSortConfig } from '../systems/transparent-sort-config';
import {
  buildPerFrameBindGroups,
  prepareFrameLighting,
  resolveSkyboxActive,
  warnZeroLightStandard,
  writeHdrpClusterAndSsaoBuffers,
  writePointSpotLightBuffers,
  writeShadowParamsBuffer,
} from './frame-lighting';
import {
  type BindGroupCounts,
  type DispatchCounts,
  makeZeroCameraFallbackSnapshot,
  type RenderFrameState,
  type ValidatedRenderable,
} from './frame-snapshot';
import {
  acquireSwapChainTarget,
  ensurePerFrameGraph,
  executeFrameGraph,
  resolveGeometryTargetViews,
  writebackGraphViews,
} from './frame-targets';
import { driveLazyEquirectProjection, warnMultiSkybox, warnMultiSkylight } from './helpers';
import { BUILTIN_MESH_ID_MAX, NINESLICE_QUAD_RAW_ID } from './main-pass-material';
import { computeSplitLdrSprite } from './main-pass-sprite';
import { cleanPerEntityCache, ensureMeshSsboCapacity, uploadMeshSsboBatch } from './mesh-ssbo';
import { writeViewUbo } from './view-ubo';

export function recordFrame(
  internals: RenderSystemInternals,
  world: World,
  cameras: CameraSnapshot[],
  lights: ExtractedLights,
  renderables: RenderableSnapshot[],
  transparentDispatch: readonly DispatchEntry[],
  frameState: RenderFrameState,
  dispatchCounts: DispatchCounts,
  bindGroupCounts: BindGroupCounts,
  skylight: SkylightSnapshot | undefined,
  skylightCount: number,
  skybox: SkyboxSnapshot | undefined,
  skyboxCount: number,
  postProcessParams: ReadonlyMap<string, Uint8Array>,
): void {
  // The `try / finally` wrapper advances `frameState.frameNumber` exactly
  // once per `recordFrame` invocation regardless of which early-return
  // branch is taken (camera missing, cap exceeded, pipeline pending,
  // swap-chain unavailable, etc).
  // Case B: 0 Camera => fire onError diagnostic. After
  // feat-20260608-create-app-param-surface-trim / M1 / D-8, the frame
  // is NOT skipped: a synthetic CameraSnapshot is injected so the
  // downstream clear-pass-only path (Case E softening, D-Q7) still
  // paints the swap-chain with the `ZERO_CAMERA_CLEAR_FALLBACK` color
  // (`[0, 0, 0, 1]` opaque black; AC-05). The synthetic camera carries
  // identity-shaped projection / view inputs (fov=PI/4, aspect=1,
  // near=0.1, far=100) so the existing matrix math stays numerically
  // stable; no MeshRenderer entity will pass validation in this state
  // (no Camera = no scene), so geometry submission is a no-op and only
  // the swap-chain clear lands.
  let activeCameras = cameras;
  if (activeCameras.length === 0) {
    internals.errorRegistry.fire(
      new RhiError({
        code: 'render-system-no-camera',
        expected: 'world has at least one entity with Transform + Camera',
        hint: 'world.spawn({ component: Transform, data: { posX, posY, posZ, quatX, quatY, quatZ, quatW, scaleX, scaleY, scaleZ } }, { component: Camera, data: { fov, aspect, near, far, clearR, clearG, clearB, clearA } }) before renderer.draw(world)',
      }),
    );
    activeCameras = [makeZeroCameraFallbackSnapshot()];
  }
  try {
    // Case D: N>1 Camera => fire onError, use first hit (D-S7).
    if (activeCameras.length > 1) {
      internals.errorRegistry.fire(
        new RhiError({
          code: 'render-system-multi-camera',
          expected: 'world has exactly one entity with Transform + Camera',
          hint: 'remove duplicate Camera entities or wait for feat-future-multi-viewport',
        }),
      );
    }
    const camera = activeCameras[0];
    if (!camera) return;

    // Record-stage fold operator linear scan (groups transparent-sort entries
    // into fold buckets + records the fold-eligible count metric). Extracted to
    // computeFoldBuckets (M3/w18).
    const foldBuckets = computeFoldBuckets(world, frameState, transparentDispatch, renderables);

    void activeCameras; // referenced below

    // Multi-light warnings + point/spot shadow-snapshot pin + point-shadow atlas
    // ensure + ExtractedLights three-arm destructure (directional fallback,
    // point/spot arrays, totalLightCount). Extracted to prepareFrameLighting
    // (M3/w18) so recordFrame stays a skeleton.
    const { light, pointLights, spotLights, totalLightCount } = prepareFrameLighting(
      internals,
      frameState,
      lights,
    );

    // feat-20260520-skylight-ibl-cubemap M4 / t27 (AC-10 + F-4 nit):
    // 0-light three-condition conjunction (plan-strategy D-5):
    //   no Skylight (skylight === undefined)
    //   AND 0 direct light (totalLightCount === 0)
    //   AND StandardMaterial (renderables.some materialShaderId !== 'forgeax::default-unlit')
    // All three true -> black + warn. Any one false -> no warn.
    //
    // Multi-Skylight warn (F-4 nit + feat-20260630 M3 / w19): >1 Skylight
    // entity -> warn ONCE per RenderSystem lifetime (not per frame), naming the
    // winning entity handle so the scene author can tell which Skylight is used
    // (F-8: warn carries conflicting entity info). First Skylight (by archetype
    // order) wins.
    warnMultiSkylight(frameState, skylightCount, skylight?.entityHandle ?? 0);

    // Multi-SkyboxBackground warn (feat-20260630 M3 / w19): mirror the Skylight
    // once-warn + winning-entity-handle pattern. First SkyboxBackground (by
    // archetype order) wins.
    warnMultiSkybox(frameState, skyboxCount, skybox?.entityHandle ?? 0);

    // feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w18:
    // lazy equirect-to-cubemap projection trigger (the single per-frame driver;
    // plan-strategy D-4 + sequence diagram). The Skylight (or, when present
    // without one, the SkyboxBackground) supplies the equirect handle; both
    // reuse the same handle so a single projection serves IBL ambient + skybox.
    //   - handle 0          -> no equirect (solid-color ambient); skip
    //   - caps.rgba16float
    //     Renderable false  -> permanent white fallback; never project (AC-06,
    //                          the only IBL gate; no UA guard)
    //   - status undefined  -> first sight: resolve POD + fire-and-forget launch
    //                          (does NOT await; the store writes status:'pending'
    //                          synchronously so this launches exactly once)
    //   - status pending    -> projection in flight; white fallback this frame
    //                          (normal transition, not an error -- no fire)
    //   - status ready      -> real IBL bound by the recordMainPass cache check
    //   - status failed     -> fire EquirectProjectionFailedError ONCE per
    //                          handle (R-2/AC-09: store records failed
    //                          permanently and never retries; the latch keeps
    //                          the channel from flooding)
    const lazyEquirectHandle = skylight?.equirectHandle ?? skybox?.equirectHandle ?? 0;
    if (lazyEquirectHandle !== 0) {
      driveLazyEquirectProjection(internals, world, frameState, lazyEquirectHandle);
    }

    // feat-20260608-cluster-lighting M5 / w21 + M6 / w23: HDRP per-frame CPU
    // cluster binning + light-data / cluster-grid / SSAO buffer uploads. Runs
    // only when the HDRP pipeline is active and there is at least one punctual
    // light. Extracted to a sub-function (M3/w18) so recordFrame stays a
    // skeleton; fail-soft error semantics are preserved verbatim.
    writeHdrpClusterAndSsaoBuffers(internals, frameState, camera, pointLights, spotLights);

    // Zero-light standard-material once-warn (no Skylight + 0 direct light +
    // >=1 lit material -> black). Extracted to warnZeroLightStandard (M3/w18).
    warnZeroLightStandard(frameState, renderables, skylight, totalLightCount);

    // Case E (this commit): 0 renderables = legitimate scene (LO §1.1
    // hello-window minimum semantic). Mirrors the Case C softening for
    // 0 DirectionalLight (line 134 above; D-Q7). recordFrame() falls
    // through to encode + submit a clear-pass-only render pass so the
    // canvas is painted with `clearColor` even when no entity carries
    // MeshFilter + MeshRenderer. Geometry submission (mat4 uploads,
    // bind-group construction, vertex/index binding, drawIndexed) is
    // conditional on `validatedOrdered.length > 0` further down.

    const pipelineState = internals.getPipelineState();
    if (pipelineState === null) return;

    // Point-shadow params UBO write (per-layer near/far/invSpan). Extracted to
    // writeShadowParamsBuffer (M3/w18).
    writeShadowParamsBuffer(internals, frameState, pipelineState);

    // feat-20260625-spot-light-shadow-mapping w25 (scope-amend webkit-fallback):
    // the per-spot perspective `lightViewProj` matrices fold into the View UBO
    // tail (`view.spotLightViewProj`, floats 132..195 / bytes 528..784) and are
    // written as part of the per-frame viewPayload below — no standalone binding
    // 9 uniform buffer (it overflowed the WebGL2 fallback fragment uniform-buffer
    // budget). See the viewPayload construction (VIEW_PAYLOAD_FLOATS = 196).

    // Acquire the swap-chain texture + colour view + target dimensions (with
    // one reconfigure-and-retry on surface-outdated). Extracted to
    // acquireSwapChainTarget (M3/w18); returns null on unrecoverable failure
    // (context null / double getCurrentTexture fail / view creation fail), in
    // which case recordFrame bails after the finally-block frame advance.
    const swapTarget = acquireSwapChainTarget(internals, pipelineState);
    if (swapTarget === null) return;
    const currentTexture = swapTarget.currentTexture;
    const view = swapTarget.view;
    const targetW = swapTarget.targetW;
    const targetH = swapTarget.targetH;

    // M1 / w7: ensure the per-frame graph is built + compiled before any
    // resource resolution. buildGraph runs once per RenderSystem (memoized on
    // frameState.perFrameGraph; a pipeline swap or shadow-map-size drift nulls
    // it to force a rebuild) and allocates every addColorTarget via
    // compile(device). The view-resolution + passCtx-construction blocks below
    // read the resolved TextureViews from the compiled graph.
    //
    // w7-fix (round 3): the buildGraph call MUST receive a properly typed
    // RenderPipelineData object — the earlier round passed `undefined as
    // RenderPipelineData`, which made any custom pipeline reading
    // `data.config?.passCount` (the AC-03 documented surface) throw a
    // TypeError on `data.config`. Standard-forward also reads `data.shadowMapSize`
    // for shadowDepth sizing. We compute the topology-relevant subset of
    // RenderPipelineData here (camera + targetW/H + skylight + skybox
    // + tonemapActive + shadowMapSize + config) and stub validated /
    // validatedOrdered / skyboxActive / splitLdrSprite as their identity
    // values: those are per-frame *runtime* state, never used to shape
    // graph topology (a topology that branches on them would mean the
    // graph rebuilds every frame, defeating the memoization).
    // Build (memoized) + resize-recompile the per-frame render graph. Extracted
    // to ensurePerFrameGraph (M3/w18); returns null on unrecoverable state
    // (buildGraph produced null, or recompile-on-resize failed), in which case
    // recordFrame bails after the finally-block frame advance.
    const perFrameGraph = ensurePerFrameGraph(
      internals,
      frameState,
      pipelineState,
      camera,
      lights,
      skylight,
      skylightCount,
      skybox,
      targetW,
      targetH,
    );
    if (perFrameGraph === null) return;

    // M1 / w7: depth texture owned by render-graph (addColorTarget('depth', ...)).
    // The graph allocates + recompiles on resize; recordFrame reads the resolved
    // TextureView each frame via getColorTargetView.
    //
    // feat-20260609 framebuffers demo M5R2 / T-12-a: the 'depth' name is the
    // urp-pipeline convention; a custom pipeline may declare its own depth
    // target name (e.g. 'offscreenDepth') and route it through addScenePass
    // with `_routeFromOpts: true`. Allow undefined here — the legacy default
    // value of `depthView` reaches recordMainPass only as a fallback when
    // _routeFromOpts is unset (i.e. urp-pipeline path), in which case the
    // urp-pipeline always declares 'depth' and graphDepthView is non-null.
    // For the _routeFromOpts path the override replaces it, so a null carrier
    // is harmless.
    const graphDepthView =
      (frameState.perFrameGraph?.getColorTargetView('depth') as TextureView | undefined) ?? null;
    const depthView: TextureView | null = graphDepthView;
    // feat-20260608-create-app-param-surface-trim / M1 / D-1: clear-color
    // sourced from the active CameraSnapshot SoA columns (first-archetype-hit
    // per OOS-2). When the world had zero Camera entities, `camera` here is
    // the synthetic fallback snapshot built above (Case B), which carries
    // `ZERO_CAMERA_CLEAR_FALLBACK = [0, 0, 0, 1]` per D-8.
    const clear: readonly [number, number, number, number] = [
      camera.clearR,
      camera.clearG,
      camera.clearB,
      camera.clearA,
    ];

    // M1 / w7: shadow RT owned by render-graph (addColorTarget('shadowDepth', ...)).
    // The graph's compile phase allocates a depth32float texture; recordFrame reads
    // the resolved TextureView each frame. When shadowMapSize is 0/undefined the
    // shadow pass is skipped entirely (recordShadowPass gates on shadowView).
    const shadowMs = lights.shadowMapSize;
    const shadowView: TextureView | null =
      shadowMs !== undefined && shadowMs > 0
        ? ((frameState.perFrameGraph?.getColorTargetView('shadowDepth') as TextureView) ?? null)
        : null;

    // Write back graph-resolved TextureViews (depth / shadow / fxaa / hdr)
    // into perPassResources so downstream pass closures read them without
    // signature changes. Extracted to writebackGraphViews (M3/w18).
    writebackGraphViews(frameState, pipelineState, lights, shadowView, shadowMs, targetW, targetH);

    // Tonemap + skybox-active resolution (skybox requires tonemap HDR target +
    // a resident cubemap view). Extracted to resolveSkyboxActive (M3/w18).
    const { tonemapActive, skyboxActive } = resolveSkyboxActive(
      internals,
      frameState,
      camera,
      skybox,
    );

    // feat-20260604-learn-render-4.10-anti-aliasing-msaa M2 / w9 (D-6, C-9):
    // MSAA is a per-Camera switch derived from `camera.antialias`, never
    // stored separately. When active the geometry pass writes a count=4
    // multisample colour target and resolves to a single-sample output; the
    // record stage selects the `*Msaa` pipeline variants and the geometry
    // pass attaches the resolve target. When inactive every attachment +
    // pipeline stays single-sample (the pre-MSAA path is byte-for-byte
    // unchanged).
    // Geometry colour / depth / resolve / sprite-split target view resolution
    // (MSAA + tonemap routing) + MSAA writeback to perPassResources. Extracted
    // to resolveGeometryTargetViews (M3/w18) so recordFrame stays a skeleton.
    const {
      msaaActive,
      geometryColorView,
      geometryDepthView,
      geometryColorResolveView,
      ldrSpriteColorView,
    } = resolveGeometryTargetViews(
      internals,
      frameState,
      pipelineState,
      camera,
      view,
      depthView,
      tonemapActive,
      targetW,
      targetH,
    );

    // Validate renderable handles + collect render plan. Empty `renderables`
    // input or all-unregistered handles both produce `validatedOrdered.length === 0`,
    // which is the Case E (clear-pass-only) path.
    //
    // feat-20260520-2d-sprite-layer-mvp M-3 / w25 (@new-surface): per-entry
    // `renderableIndex` tracks the position into the original renderables[]
    // array so the bucket-aware reordering below can correlate
    // transparent-sort output (TransparentEntry.renderableIndex) back to
    // the validated row.
    // bug-20260527-renderstate-pipeline-dispatch-gap D-4:
    // build a renderableIndex -> renderState map from dispatch entries
    // so each ValidatedRenderable carries its per-material renderState
    // override without an O(n^2) back-scan in the draw loop.
    const validated = validateRenderables(
      internals,
      world,
      pipelineState,
      renderables,
      transparentDispatch,
    );

    // Per-frame cache clean-up: drop per-entity BG cache entries + instance
    // buffers whose entityKey is absent from the current validated set (despawn
    // eviction). Extracted to cleanPerFrameCaches (M3/w18).
    cleanPerFrameCaches(internals, frameState, validated);

    // Dispatch-ordered render plan: reorder validated renderables to dispatch
    // order, run the mesh-SSBO capacity gate (graceful truncation), and build
    // the fold dispatch plan. Extracted to buildDispatchPlan (M3/w18).
    const dispatchPlan = buildDispatchPlan(internals, validated, transparentDispatch, foldBuckets);
    const validatedOrdered = dispatchPlan.validatedOrdered;
    const foldDispatchPlan = dispatchPlan.foldDispatchPlan;

    // D-2 (bug-20260527): LDR sprite pass split, generalised feat-20260625
    // M2 / w7 via {@link computeSplitLdrSprite}; M3 w13 finalised by deleting
    // the legacy shadingModel arm — transparent is the single SSOT. AC-05
    // (non-sprite shader carrying transparent:true) trips the split too;
    // the unit suite render-system-record.test.ts 'transparent decouples
    // from sprite shader' locks the contract.
    //
    // When the LDR path (tonemapActive=false) has transparent entities in
    // the validated draw list, the render is split into two serial passes
    // sharing the same swap-chain texture:
    //   geometry pass    -- sRGB view (bgra8unorm-srgb), loadOp=clear,
    //                       opaque entities
    //   transparent pass -- unorm view (bgra8unorm), loadOp=load,
    //                       transparent / sprite entities
    // The sprite LDR pipeline targets bgra8unorm (blendable; D-1) so it
    // cannot share the same render pass with the bgra8unorm-srgb-targeted
    // geometry pipelines (WebGPU requires attachment view format ==
    // pipeline target format). bgra8unorm is the storage format of the
    // swap-chain texture and is always a valid view format (spec: storage
    // format is implicitly in viewFormats); no viewFormats change needed
    // (D-4).
    const splitLdrSprite = computeSplitLdrSprite(validatedOrdered, tonemapActive);
    let ldrSpriteUnormView: TextureView | null = null;
    if (splitLdrSprite) {
      const unormViewRes = internals.device.createTextureView(currentTexture, {});
      if (!unormViewRes.ok) {
        internals.errorRegistry.fire(unormViewRes.error);
        return;
      }
      ldrSpriteUnormView = unormViewRes.value;
    }

    // View / mesh uniform uploads are only needed when geometry will be drawn,
    // OR when a skybox is active (skybox pass reads inverseViewProj from
    // the View UBO). Skip the writeBuffer round-trips on the Case E
    // (clear-pass-only) path only when neither condition is met.
    // feat-20260531-skybox-env-background M2 / w6: gate relaxed from
    // `validatedOrdered.length > 0` to include skybox-only frames
    // (plan-strategy D-3, R-3).
    if (validatedOrdered.length > 0 || skyboxActive) {
      // View UBO + CSM/spot-shadow matrix pack: assembled + uploaded in one
      // queue.writeBuffer round-trip. Extracted to view-ubo.ts (M3/w18) so
      // recordFrame stays an orchestration skeleton (D-2).
      writeViewUbo(
        internals.device.queue,
        pipelineState.viewUniformBuffer,
        camera,
        light,
        lights,
        frameState.spotShadowSnapshots,
      );

      // Per-frame full rewrite of the PointLight + SpotLight std430 storage
      // buffers (header + first-slice cap N=4 slots). Extracted to
      // writePointSpotLightBuffers (M3/w18).
      writePointSpotLightBuffers(internals, pipelineState, lights);

      // Per-renderable entity_world upload (batched): all N mat4+normalMatrix
      // slots assembled into a single contiguous scratch buffer, then flushed
      // as one writeBuffer call. Extracted to mesh-ssbo.ts (M3/w21) so its
      // module-scoped scratch buffer co-locates with the other mesh-SSBO lets.
      uploadMeshSsboBatch(
        internals.device.queue,
        pipelineState.meshStorageBuffer,
        validatedOrdered,
        foldDispatchPlan,
      );
    }

    const encoderResult = internals.device.createCommandEncoder({ label: 'render-system-frame' });
    if (!encoderResult.ok) {
      internals.errorRegistry.fire(encoderResult.error);
      return;
    }
    const encoder: RhiCommandEncoder = encoderResult.value;

    // Per-frame bind group cache resolution (view / mesh / HDRP-cluster).
    // Extracted to buildPerFrameBindGroups (M3/w18) so recordFrame stays a
    // skeleton; returns null groups on the Case E (0-validated) path.
    const { viewBindGroup, meshBindGroup, hdrpClusterBindGroup } = buildPerFrameBindGroups(
      internals,
      frameState,
      pipelineState,
      validated.length > 0,
      bindGroupCounts,
    );

    // ── feat-20260529-rendergraph-pass-abstraction M4 / w13b ───────────
    // Declarative render-graph drives the per-frame passes. The graph
    // orchestrates which pass execute closures run (topological order from
    // reads/writes); each closure calls the verbatim-extracted pass
    // recorder with the shared RenderPipelineContext. All 4 per-frame passes
    // (shadow / main / tonemap / FXAA) now run as graph execute closures
    // (AC-04); graph.execute is the sole frame-recording path (AC-05).
    //
    // Encoder semantics (RD-4): the shadow closure opens its OWN command
    // encoder + queue.submit (manual barrier for depth write -> sample);
    // main/tonemap/FXAA share `encoder` (passCtx.encoder), finished +
    // submitted once at frame end.
    // feat-20260601 M2 / w12: the per-frame shared state is the clean
    // `RenderPipelineContext` - `internals` is replaced by the named `assets`
    // (CPU POD) / `store` (GPU residency) / `pipelineState` / `runtime` (device +
    // errorRegistry + shader-cache lookups) surfaces (`internals` itself satisfies
    // `RenderSystemRuntime` so `runtime: internals` is a zero-cost reference). The
    // 0-consumed `skyboxCount` residual is dropped.
    const passCtx: _InternalRenderPipelineContext = {
      assets: internals.assets,
      world,
      store: internals.gpuStore,
      pipelineState,
      runtime: internals,
      encoder,
      view,
      clear,
      targetW,
      targetH,
      currentTexture,
      camera,
      tonemapActive,
      geometryColorView,
      geometryDepthView,
      validated,
      validatedOrdered,
      viewBindGroup,
      meshBindGroup,
      frameState,
      dispatchCounts,
      bindGroupCounts,
      skylight,
      skylightCount,
      skyboxActive,
      skybox,
      splitLdrSprite,
      ldrSpriteUnormView,
      msaaActive,
      geometryColorResolveView,
      ldrSpriteColorView,
      postProcessParams,
      dispatch: transparentDispatch,
      hdrpClusterBindGroup,
      foldDispatchPlan,
    };
    // feat-20260601 M2 / w12 (D-B): the per-frame projected snapshot handed to
    // `buildGraph` as the second argument. Cross-frame-stable deps live on ctx;
    // these per-frame recomputed quantities live on data (the standard forward
    // pipeline's topology is frame-invariant so it ignores `data`; a custom
    // pipeline can shape its graph from it).
    const passData: RenderPipelineData = {
      camera,
      validated,
      validatedOrdered,
      targetW,
      targetH,
      skylight,
      skylightCount,
      skyboxActive,
      skybox,
      tonemapActive,
      splitLdrSprite,
      // feat-20260601 verify round 2 (D-C): the install-time config of the currently
      // active pipeline, threaded through `installPipeline` -> frameState ->
      // `buildGraph(ctx, data)`. A custom pipeline reads `data.config?.passCount` to size
      // its declared pass chain; the standard forward pipeline ignores it.
      config: frameState.installedPipelineConfig,
      // w7-fix (round 3): ECS-driven shadow map size for the urp
      // pipeline's shadowDepth color target sizing.
      shadowMapSize: lights.shadowMapSize,
      // M3 / w12: cascade count for atlas sizing + N-pass loop.
      cascadeCount: lights.cascadeCount,
    };

    // Build (memoized) + execute the per-frame graph, then finish + submit the
    // shared encoder + reclaim retired transients. Extracted to
    // executeFrameGraph (M3/w18).
    executeFrameGraph(internals, frameState, passCtx, passData, encoder);
  } finally {
    frameState.frameNumber += 1;
    // feat-20260608-cluster-lighting M5 / w22: clear HDRP once-per-frame fired
    // set so the next frame re-fires if the condition persists.
    frameState.hdrpOncePerFrameFired.clear();
  }
}

/**
 * feat-20260704 M3/w18: validate renderable handles + collect the render plan,
 * extracted verbatim from `recordFrame`. Empty `renderables` input or all-
 * unregistered handles both yield an empty result (the Case E clear-pass-only
 * path). Builds per-entry renderState / stencilReference overlays from the
 * transparent-dispatch entries, resolves each MeshFilter.assetHandle through
 * the AssetRegistry + GPU store (with the sprite 9-slice mesh swap), and fires
 * structured `asset-not-registered` errors for handles that fail to resolve.
 *
 * @internal
 */
function validateRenderables(
  internals: RenderSystemInternals,
  world: World,
  pipelineState: PipelineState,
  renderables: readonly RenderableSnapshot[],
  transparentDispatch: readonly DispatchEntry[],
): ValidatedRenderable[] {
  // bug-20260527-renderstate-pipeline-dispatch-gap D-4:
  // build a renderableIndex -> renderState map from dispatch entries
  // so each ValidatedRenderable carries its per-material renderState
  // override without an O(n^2) back-scan in the draw loop.
  const renderStateByRenderableIdx = new Map<number, MaterialRenderState | undefined>();
  for (const de of transparentDispatch) {
    if (de.renderableIndex !== undefined) {
      renderStateByRenderableIdx.set(de.renderableIndex, de.renderState);
    }
  }
  // w10: also build a renderableIndex -> stencilReference map from
  // dispatch entries for per-draw setStencilReference calls.
  const stencilRefByRenderableIdx = new Map<number, number | undefined>();
  for (const de of transparentDispatch) {
    if (de.renderableIndex !== undefined) {
      stencilRefByRenderableIdx.set(de.renderableIndex, de.stencilReference);
    }
  }
  const validated: ValidatedRenderable[] = [];
  for (let rIdx = 0; rIdx < renderables.length; rIdx++) {
    const r = renderables[rIdx];
    if (r === undefined) continue;
    const assetRes = resolveAssetHandle<MeshAsset>(world, toShared<'MeshAsset'>(r.assetHandle));
    if (!assetRes.ok) {
      internals.errorRegistry.fire(
        new RhiError({
          code: 'asset-not-registered',
          expected: 'MeshFilter.assetHandle in AssetRegistry',
          hint: 'use HANDLE_CUBE / HANDLE_TRIANGLE imports; custom mesh register path: feat-future-asset-system',
          detail: { assetHandle: r.assetHandle },
        }),
      );
      continue;
    }
    // feat-20260601-gpu-resource-store-extraction M1 (D-1): builtin meshes
    // (ids 1-4: CUBE/TRIANGLE/QUAD/SPHERE) keep the createRenderer step-3
    // direct-upload + `pipelineState.meshes` path -- they are NOT routed
    // through `ensureResident`. User-registered meshes pull through the store
    // on first access (the register->upload push was severed in this M1);
    // the POD fetched above (assetRes.value) is passed in, store holds no
    // registry ref (D-2). A first-access miss builds the GPU buffers; later
    // frames hit the O(1) cache.
    const meshAssetHandle = toShared<'MeshAsset'>(r.assetHandle);
    let meshHandles = internals.gpuStore.getMeshGpuHandles(meshAssetHandle);
    if (meshHandles === undefined && r.assetHandle > BUILTIN_MESH_ID_MAX) {
      const residentRes = internals.gpuStore.ensureResident(meshAssetHandle, assetRes.value);
      if (residentRes.ok) {
        meshHandles = residentRes.value;
      } else if (residentRes.error instanceof RhiError) {
        internals.errorRegistry.fire(residentRes.error);
      }
    }
    meshHandles = meshHandles ?? pipelineState.meshes.get(r.assetHandle);
    if (meshHandles === undefined) {
      internals.errorRegistry.fire(
        new RhiError({
          code: 'asset-not-registered',
          expected: 'GPU mesh buffers uploaded for assetHandle',
          hint: 'await renderer.ready before draw(world); ensure AssetRegistry.configureGpuDevice ran so user meshes are uploaded',
          detail: { assetHandle: r.assetHandle },
        }),
      );
      continue;
    }
    // feat-20260527-sprite-nineslice M2 / w11 (plan-strategy section D-2):
    // sprite branch with non-zero `slicesAndMode` (post-w12 paramSnapshot
    // entry name) overrides the user-supplied mesh handle (typically
    // HANDLE_QUAD = 3) with the 16-vertex / 54-index HANDLE_NINESLICE_QUAD
    // (id=5) topology so the vertex shader sees the 4x4 grid required for
    // 9-region anchor mapping. Default slicesAndMode ([0, 0, 0, 0]) keeps
    // the legacy HANDLE_QUAD path; a flip from zero to non-zero on the
    // same entity routes here per-frame so AI users can toggle 9-slice
    // on the fly without re-spawning the entity (charter F1 minimum
    // surface). The HANDLE_NINESLICE_QUAD GPU buffers are seeded by
    // createRenderer step-3.
    //
    // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w13: judgement
    // key migrated from `shadingModel === 'sprite'` to
    // `materialShaderId === 'forgeax::sprite'` (plan-strategy D-10); slices
    // sourced from `paramSnapshot.slicesAndMode` (post-w12 UBO-aligned
    // overlay path).
    //
    // feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / t7:
    // sprite-lit shares the sprite paramSchema (5 fields, t4 mirror) so
    // the 9-slices mesh swap applies identically.
    let effectiveMeshHandles = meshHandles;
    if (
      r.material.materialShaderId === 'forgeax::sprite' ||
      r.material.materialShaderId === 'forgeax::sprite-lit'
    ) {
      const slicesArr = r.material.paramSnapshot?.slicesAndMode as readonly number[] | undefined;
      if (
        slicesArr !== undefined &&
        slicesArr.length >= 4 &&
        (slicesArr[0] !== 0 || slicesArr[1] !== 0 || slicesArr[2] !== 0 || slicesArr[3] !== 0)
      ) {
        const nineSliceHandles = pipelineState.meshes.get(NINESLICE_QUAD_RAW_ID);
        if (nineSliceHandles !== undefined) {
          effectiveMeshHandles = nineSliceHandles;
        }
      }
    }
    validated.push({
      source: r,
      mesh: effectiveMeshHandles,
      renderableIndex: rIdx,
      renderState: renderStateByRenderableIdx.get(rIdx),
      stencilReference: stencilRefByRenderableIdx.get(rIdx),
    });
  }
  return validated;
}

/**
 * feat-20260704 M3/w18: build the dispatch-ordered render plan, extracted
 * verbatim from `recordFrame`. (1) M3/w26 dispatch-ordered reorder: reorder
 * `validated` to follow the transparent-dispatch order (extract-order fallback
 * for unmatched entries). (2) feat-20260608 mesh-SSBO capacity gate: size the
 * mesh-SSBO + material-UBO pair to the larger of entity vs cumulative
 * material-slot count, truncating on ceiling (graceful degradation). (3)
 * feat-20260622 fold dispatch plan: build + apply the WebGL2 uniform-cap
 * fallback + bump the folded-draws metric.
 *
 * @internal
 */
function buildDispatchPlan(
  internals: RenderSystemInternals,
  validated: readonly ValidatedRenderable[],
  transparentDispatch: readonly DispatchEntry[],
  foldBuckets: readonly FoldBucket[],
): { validatedOrdered: ValidatedRenderable[]; foldDispatchPlan: FoldDispatchPlan | null } {
  // M3 / w26: dispatch-ordered render. The dispatch list is pre-sorted
  // by queue (ascending, stable) by the extract stage per plan-strategy D-3.
  // Reorder validated renderables to follow the dispatch order, falling
  // back to extract order for renderables with no matching dispatch entry.
  let validatedOrdered: ValidatedRenderable[] = [...validated];
  if (transparentDispatch.length > 0) {
    const validatedByRenderableIdx = new Map<number, ValidatedRenderable>();
    const seen = new Set<number>();
    for (const v of validated) {
      validatedByRenderableIdx.set(v.renderableIndex, v);
    }
    const ordered: ValidatedRenderable[] = [];
    for (const de of transparentDispatch) {
      if (de.renderableIndex === undefined) continue;
      const v = validatedByRenderableIdx.get(de.renderableIndex);
      if (v !== undefined && !seen.has(de.renderableIndex)) {
        seen.add(de.renderableIndex);
        ordered.push(v);
      }
    }
    // Append any renderables not in the dispatch list (e.g. default-material entities)
    for (const v of validated) {
      if (!seen.has(v.renderableIndex)) {
        ordered.push(v);
      }
    }
    validatedOrdered = ordered;
  }

  // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M3 / T-M3-04:
  // ensure the mesh-SSBO + material-UBO buffer pair is large enough to hold
  // `validatedOrdered.length` slots BEFORE the first per-entity writeBuffer.
  // On `ok:false` the controller has already fired a structured RuntimeError
  // (`mesh-ssbo-ceiling-reached` / `mesh-ssbo-capacity-exceeded`); we truncate
  // the draw list to `degradedToSlotCount` (graceful degradation per
  // plan-strategy D-2): render the subset that fits, discard overflow, no
  // black frame. The helper is idempotent across same-frame re-calls (AC-09)
  // and short-circuits on length=0 / length<=slotCount (boundary table).
  //
  // bug-20260609: feat-20260608 M5 amend made the material UBO indexed by
  // cumulative *material-slot* count (one slot per submesh material),
  // which is >= entity count once any entity carries `materials.length>1`.
  // The mesh + material buffer pair share `slotCount` (single allocator),
  // so we size against the larger of the two requirements: entity count
  // (mesh-SSBO consumer) vs cumulative material-slot count (material-UBO
  // consumer). Sprite entities collapse to 1 slot per the materialSlotStart
  // computation below, mirroring the same rule (sprite per-submesh OOS-1;
  // post-w13 judgement key migrated to materialShaderId).
  //
  // feat-20260624 M1' / t7: sprite-lit treated identically to sprite
  // for material-slot accounting (paramSchema mirror, t4).
  let neededMaterialSlots = 0;
  for (const e of validatedOrdered) {
    if (e === undefined) continue;
    neededMaterialSlots +=
      e.source.material.materialShaderId === 'forgeax::sprite' ||
      e.source.material.materialShaderId === 'forgeax::sprite-lit'
        ? 1
        : e.source.materials.length;
  }
  const neededSlots = Math.max(validatedOrdered.length, neededMaterialSlots);
  const meshSsboCapResult = ensureMeshSsboCapacity(internals, neededSlots);
  if (!meshSsboCapResult.ok) {
    // Graceful degradation: truncate to pre-grow capacity, render the subset.
    validatedOrdered = validatedOrdered.slice(0, meshSsboCapResult.degradedToSlotCount);
  }

  // feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4-record-swap
  // (D-1): build the fold dispatch plan once `validatedOrdered` is final
  // (post truncation by mesh-SSBO capacity gate). The plan re-keys each
  // non-singleton bucket from `renderableIndex` to the validated-ordered
  // index `i` consumed by the dispatch loops; the loops use it to skip
  // non-head bucket members and emit one instanced drawIndexed per
  // bucket head. Empty plan (no fold-eligible buckets) is a byte-
  // identical no-op for the dispatch loops below (charter P3: silent
  // pass-through, no error path).
  let renderableToValidatedIdx: Map<number, number> | null = null;
  let foldDispatchPlan: FoldDispatchPlan | null = null;
  if (foldBuckets.length > 0) {
    renderableToValidatedIdx = new Map<number, number>();
    for (let i = 0; i < validatedOrdered.length; i++) {
      const e = validatedOrdered[i];
      if (e === undefined) continue;
      renderableToValidatedIdx.set(e.renderableIndex, i);
    }
    foldDispatchPlan = buildFoldDispatchPlan(foldBuckets, renderableToValidatedIdx);

    // feat-20260622 M2 / w11 (D-2 + D-9 + AC-05): WebGL2 uniform-fallback
    // per-bucket instance-count cap. When caps.storageBuffer===false AND
    // a fold bucket carries more than FOLD_UNIFORM_INSTANCE_CAP (128)
    // instances, fire RhiError({code:'instancing-exceeds-uniform-cap'})
    // AND remove the bucket from the dispatch plan so its members fall
    // through to the per-entity drawIndexed exit (the same exit the
    // mode-gate bypass uses — D-9 "shared fallback exit"). The frame
    // stays visually correct (charter proposition 9 graceful
    // degradation: no identity-collapse / black screen) while the cap
    // event surfaces structurally for AI users (proposition 4 explicit
    // failure on .code).
    //
    // Scope discrimination: tilemap-chunk-extract-system encodes
    // Layer.value = (layerOrder<<20) | (chunkIndex & 0xfffff), so a
    // bucket whose head entry carries non-zero low-20-bits is
    // definitively a tilemap-chunk dispatch site. Plain sprite buckets
    // use SPRITE_LAYER_VALUE = layerOrder<<20 (low-20 zero) by the
    // documented convention (apps/hello/asi-world main.ts pattern).
    // The chunkIndex===0 edge case maps to 'sprite' (the helper's
    // default branch) — a one-bucket ambiguity per layerOrder that is
    // acceptable for the AI-user affordance level (the error semantics
    // — "this bucket exceeded the cap" — is the actionable signal;
    // scope=sprite vs tilemap-chunk only refines the recovery hint).
    if (foldDispatchPlan.headBuckets.size > 0 && !internals.device.caps.storageBuffer) {
      const filteredHeads = new Map<number, FoldBucket>(foldDispatchPlan.headBuckets);
      const filteredSkips = new Set<number>(foldDispatchPlan.skipIndices);
      let filteredCount = foldDispatchPlan.foldedBucketCount;
      for (const [headIdx, bucket] of foldDispatchPlan.headBuckets) {
        const scope: 'sprite' | 'tilemap-chunk' =
          (bucket.layer & 0xfffff) !== 0 ? 'tilemap-chunk' : 'sprite';
        const decision = evaluateFoldBucketUniformCap(bucket, internals.device.caps, scope);
        if (decision.fallback && decision.error !== undefined) {
          internals.errorRegistry.fire(decision.error);
          filteredHeads.delete(headIdx);
          filteredCount -= 1;
          for (let j = 1; j < bucket.entries.length; j++) {
            const memberEntry = bucket.entries[j];
            if (memberEntry === undefined) continue;
            const memberValidatedIdx = renderableToValidatedIdx.get(memberEntry.renderableIndex);
            if (memberValidatedIdx !== undefined) {
              filteredSkips.delete(memberValidatedIdx);
            }
          }
        }
      }
      if (filteredCount !== foldDispatchPlan.foldedBucketCount) {
        foldDispatchPlan = {
          headBuckets: filteredHeads,
          skipIndices: filteredSkips,
          foldedBucketCount: filteredCount,
        };
      }
    }

    // feat-20260622-chunk-gpu-instancing-sprite-tilemap M3 / w13 (D-3 +
    // AC-06): increment `render.instancing.foldedDraws` once per fold-
    // eligible head bucket retained after the cap-fallback filter above.
    // The metric tracks instanced drawIndexed call count for this frame
    // — cap-overrun buckets routed through the per-entity fallback exit
    // are removed from `foldDispatchPlan` and therefore not counted, by
    // construction (M2 / w11 cap-fallback + plan-strategy D-3 semantics).
    // Singleton buckets (mode-bypass under D-5, or non-foldable under
    // mode 0) carry `bucketSize === 1` and never enter `headBuckets`, so
    // the per-entity drawIndexed path correctly does not count.
    // SSOT helper lives in `render-system-fold.ts` — engine code never
    // hardcodes the metric key string.
    incrementFoldedDrawsMetric(foldDispatchPlan, internals.metrics);
  }

  return { validatedOrdered, foldDispatchPlan };
}

/**
 * feat-20260704 M3/w18: per-frame cache clean-up (despawn eviction), extracted
 * verbatim from `recordFrame`.
 *
 * feat-20260531-per-frame-bind-group-cache M4 / w14 (D-5): drop per-entity BG
 * cache entries (materialBgPerEntity / instancesBgPerEntity) + instance buffers
 * whose outer-Map entityKey (packed Entity u32) is absent from the current
 * validated set, preventing unbounded growth after entity despawn. view + mesh
 * caches are frame-shared (keyed by GPU resource handle objects, WeakMap chains
 * naturally bounded) and are not touched. feat-20260619 M4 / F11: destroy the
 * GPU instance buffer before Map.delete (D-6 symmetric release); failure fires
 * errorRegistry + continues the sweep.
 *
 * @internal
 */
function cleanPerFrameCaches(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  validated: readonly ValidatedRenderable[],
): void {
  // Build a Set<number> of entityKeys from the validated renderables.
  // The entityKey is the packed Entity u32 (encodeEntity(indexSlot,
  // generation)) surfaced by D-1. Entries in the per-entity caches
  // whose outer-Map entityKey is NOT in this set are orphaned (their
  // entity has been despawned) and must be dropped.
  const validatedEntityKeys = new Set<number>();
  for (const v of validated) {
    validatedEntityKeys.add(v.source.entityKey);
  }

  // Clean per-entity material BG cache: drop outer-Map entries whose
  // entityKey is absent from the current validated set. The shared and
  // singleton material caches have no entityKey and are not touched here.
  cleanPerEntityCache(frameState.materialBgPerEntity, validatedEntityKeys);

  // Clean per-entity instances BG cache.
  cleanPerEntityCache(frameState.instancesBgPerEntity, validatedEntityKeys);

  // D-5 retrofit: instanceBuffers clean-up. The instanceBuffers Map is
  // keyed by `encacheKey` (packed Entity u32, same as entityKey on
  // RenderableSnapshot). Drop entries whose key is no longer in the
  // validated set (OQ-3 / R-4). feat-20260619 M4 / F11: destroy the GPU
  // buffer before Map.delete so despawned entities release their
  // instance-buffer backing memory symmetrically (D-6).
  for (const [key, entry] of frameState.instanceBuffers.entries()) {
    if (!validatedEntityKeys.has(key)) {
      if (!entry.buffer.isDestroyed) {
        const r = entry.buffer.destroy();
        if (!r.ok) internals.errorRegistry.fire(r.error);
      }
      frameState.instanceBuffers.delete(key);
    }
  }
}

/**
 * feat-20260704 M3/w18: record-stage fold operator linear scan, extracted
 * verbatim from `recordFrame`.
 *
 * feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4 + w5 (D-1, D-5):
 * groups transparent-sort-ordered dispatch entries with equal (Layer.value,
 * sortKey, materialHandle) into fold buckets. Mode-gate (D-5 extended): modes 0
 * (LAYER_Z) and 1 (LAYER_Y) fold using posZ/posY; modes 2/3 bypass per-entity
 * (each entry a singleton bucket). Records `frameState.lastFoldBucketCount` =
 * fold-eligible buckets (bucketSize > 1) for the AC-06 metric. Empty dispatch
 * short-circuits (test fixtures pass null world).
 *
 * @internal
 */
function computeFoldBuckets(
  world: World,
  frameState: RenderFrameState,
  transparentDispatch: readonly DispatchEntry[],
  renderables: readonly RenderableSnapshot[],
): readonly FoldBucket[] {
  if (transparentDispatch.length === 0) {
    frameState.lastFoldBucketCount = 0;
    return [];
  }
  const transparentSortCfg = getTransparentSortConfig(world);
  const foldBuckets = foldDispatchBuckets(
    transparentDispatch,
    transparentSortCfg.mode,
    renderables,
  );
  // Count only fold-eligible buckets (bucketSize > 1) so the metric
  // surfaces fold actually reducing draws — singleton buckets under
  // mode bypass do not change draw count, so they do not contribute.
  let foldEligibleCount = 0;
  for (const b of foldBuckets) {
    if (b.bucketSize > 1) foldEligibleCount += 1;
  }
  frameState.lastFoldBucketCount = foldEligibleCount;
  return foldBuckets;
}
