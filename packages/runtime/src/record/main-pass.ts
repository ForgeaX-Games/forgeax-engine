import { probeVideoHighPerfUpload } from '@forgeax/engine-graphics-extras';
import { type BindGroup, RhiError, type RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import type { Handle, PassSelector } from '@forgeax/engine-types';
import { createHdrpUnifiedBindGroup, getOrCreateHdrpBuffers } from '../hdrp-buffers';
import { getOrCreateIblCache } from '../ibl/IblPipelineCache';
import { buildBeginRenderPassDescriptor } from '../pipeline-spec';
import type { _InternalRenderPipelineContext } from '../render-pipeline-context';
import { STANDARD_PBR_UBO_SIZE } from '../render-system';
import type { MaterialSnapshot } from '../render-system-extract';
import { recordGeometryDraws } from './main-pass-geometry';
import {
  applyParamSnapshotToUbo,
  buildPbrMaterialUboPayload,
  buildPerSubmeshMaterialBg as buildPerSubmeshMaterialBgImpl,
  detectNineSliceScaleTooSmall,
  type PerSubmeshMaterialBgDeps,
  residentTextureView,
} from './main-pass-material';
import { recordSpritePass } from './main-pass-sprite-draws';
import { buildMatchedRenderableIndices } from './shadow-pass';

/**
 * feat-20260529-rendergraph-pass-abstraction M4 / w13b: main forward
 * (geometry) pass recording, extracted verbatim from recordFrame. Uses the
 * SHARED frame encoder (c.encoder); the geometry + optional LDR sprite-split
 * sub-pass write into geometryColorView (HDR target or swap-chain view).
 * Driven by the render-graph 'main' pass execute closure.
 */
export function recordMainPass(c: _InternalRenderPipelineContext, selector?: PassSelector): void {
  const {
    runtime,
    world,
    store,
    pipelineState,
    encoder,
    clear,
    geometryColorView,
    geometryDepthView,
    validatedOrdered,
    viewBindGroup,
    meshBindGroup,
    frameState,
    bindGroupCounts,
    skylight,
    skylightCount,
    skyboxActive,
    splitLdrSprite,
    msaaActive,
    geometryColorResolveView,
    dispatch,
    hdrpClusterBindGroup,
  } = c;
  // bug-20260615 M3 / m3-1: sampleCount is threaded through every
  // getMaterialShaderPipeline call site so the cache key / builder
  // disambiguate count=1 vs count=4 PSOs. Derived from the per-camera
  // msaaActive boolean (already on the context).
  const sampleCount = msaaActive ? 4 : 1;
  // feat-20260623-world-space-video-asset M4 / w17 (D-2 / AC-09): high-perf
  // GPUExternalTexture upload availability for video sources, resolved by the
  // explicit RhiCaps-based capability probe. The probe checks
  // backendKind==='webgpu' AND `importExternalTexture` method presence; the
  // latter is absent today (OOS-5), so this is false and the general
  // copyExternalImageToTexture path (w16) is the sole route. The branch exists
  // so the AC-09 two-path reserved hook is code-review-verifiable, not a TODO.
  const videoHighPerfAvailable = probeVideoHighPerfUpload(runtime.device);
  // feat-20260609-hdrp-cluster-fragment-ggx M4 / w16: HDRP active swaps the
  // group(2) bindGroup for the unified 7-entry layout (mesh SSBO at binding 0
  // + cluster 4 buffer at bindings 3..6). The dynamic offset
  // (`i * MESH_PER_ENTITY_STRIDE`) stays valid because the unified BGL binds
  // the SAME mesh SSBO at binding 0; the cluster-forward shader reads the
  // cluster bindings off the rest of the layout. Plan D-1 (URP path zero
  // change) is preserved — when `!isHdrpActive` the URP `meshBindGroup`
  // path runs verbatim.
  // feat-20260612-hdrp-ssao wiring fix: when the HDRP forward pass resolved a
  // real `ssaoBlurred` view (stashed on ctx by the pass execute closure), build
  // the unified group(2) bind group with that view at binding 7 so fs_main reads
  // the actual occlusion factor instead of the 1x1 white fallback. The default
  // `hdrpClusterBindGroup` (built ahead of graph.execute) always carries the
  // fallback because the transient SSAO texture does not exist that early.
  // Built per frame (the SSAO target is a graph transient, so no cross-frame
  // cache); HDRP-only and SSAO-only, so URP and SSAO-off paths are untouched.
  let hdrpSsaoBindGroup: BindGroup | null = null;
  if (
    frameState.isHdrpActive &&
    hdrpClusterBindGroup !== null &&
    c.hdrpSsaoBlurredView !== undefined
  ) {
    const hdrpBuffers = getOrCreateHdrpBuffers(
      runtime,
      frameState.installedPipelineConfig?.clusterGrid,
    );
    if (hdrpBuffers !== null) {
      hdrpSsaoBindGroup = createHdrpUnifiedBindGroup(
        runtime,
        hdrpBuffers,
        pipelineState.meshStorageBuffer.buffer,
        { enabled: true, ssaoBlurredView: c.hdrpSsaoBlurredView },
      );
    }
  }
  const meshGroup2: BindGroup | null =
    frameState.isHdrpActive && hdrpClusterBindGroup !== null
      ? (hdrpSsaoBindGroup ?? hdrpClusterBindGroup)
      : meshBindGroup;
  // ── Geometry (main colour) pass ──────────────────────────────────
  // D-2: tracks whether the geometry pass was explicitly ended inside
  // the `if (validatedOrdered.length > 0)` block (sprite split path),
  // to avoid a double-end at the unconditional `pass.end()` below.
  let geometryPassEnded = false;
  // feat-20260531-skybox-env-background M2 / w8: condition main colour
  // loadOp on skyboxActive (AC-05). When skybox is active, the skybox
  // pass writes the far plane + cubemap colour to hdrColor before main;
  // main must load (not clear) to composite geometry on top. Depth
  // loadOp stays 'clear' -- skybox does not write depth, so main's
  // depth test naturally covers skybox pixels with foreground geometry.
  const mainColorLoadOp = skyboxActive ? 'load' : 'clear';
  // feat-20260604 M2 / w9-w10: MSAA resolve placement. When MSAA is active the
  // geometry pass writes a count=4 multisample target. The resolve to the
  // single-sample output (LDR swap-chain view / HDR hdrColor) happens at the
  // LAST pass that writes that multisample target: the main pass itself when
  // there is no LDR sprite split, or the sprite sub-pass end when there is
  // (F-1 -- geometry + sprites share one multisample texture; resolving at the
  // main pass would drop the sprites drawn after). The sprite sub-pass is
  // LDR-only, so under HDR the main pass always resolves.
  const mainPassResolves = msaaActive && geometryColorResolveView !== null && !splitLdrSprite;
  // forward main pass: depth24plus-stencil8 auto-emits stencil ops via the
  // helper's stencil-op gate (plan-strategy M4 R3/R5 stencil-op SSOT).
  // mainColorLoadOp toggles between 'clear' and 'load' (skyboxActive case).
  const pass: RhiRenderPassEncoder = encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      {
        colorFormats: ['rgba16float'],
        depthFormat: 'depth24plus-stencil8',
        sampleCount: msaaActive ? 4 : 1,
      },
      {
        colorViews: [geometryColorView],
        depthView: geometryDepthView,
        ...(mainPassResolves ? { resolveTargets: [geometryColorResolveView] } : {}),
      },
      'forward',
      {
        colorLoadOp: mainColorLoadOp,
        clearColor: { r: clear[0] ?? 0, g: clear[1] ?? 0, b: clear[2] ?? 0, a: clear[3] ?? 1 },
      },
    ) as never,
  );

  // Geometry submission block: setPipeline + 4 bind groups + per-entity
  // material uploads + drawIndexed.

  // feat-20260609 M2: filter entities by pass selector.
  const matchedIndices =
    selector !== undefined ? buildMatchedRenderableIndices(dispatch, selector) : null;

  if (validatedOrdered.length > 0) {
    const MATERIAL_PER_ENTITY_STRIDE = 256;
    // feat-20260518-pbr-direct-lighting-mvp M5 / w22.10 (D-4 + D-9 +
    // AC-07 std140): per-entity material slice grew from 32 B (legacy
    // baseColor:vec4 + metallic + roughness + 8B padding) to 48 B
    // mirroring the post-w22.10 `Material` WGSL struct field-for-field
    // (see STANDARD_PBR_UBO_SIZE JSDoc in render-system.ts). The dynamic-
    // offset stride stays 256 B (D-P9 256-byte minimum alignment); only
    // the BindGroup entry's `size` swaps to 48 to match the new struct.
    const MATERIAL_SLICE = STANDARD_PBR_UBO_SIZE;
    // feat-20260515 M3 / T-M3-05 (research F-6 fix): materialBindGroup now
    // carries 3 entries -- the per-entity material UBO (binding 0,
    // dynamic-offset retained from D-P9), the default sampler (binding 1,
    // pipelineState.defaultSampler from createRenderer; research F-5
    // linear min/mag/mipmap + repeat addressMode), and the texture-view
    // (binding 2, resolved from MaterialSnapshot.baseColorTexture via
    // AssetRegistry.getTextureGpuView when present, falling back to the
    // pipelineState.fallbackTextureView 1x1 white pixel).
    //
    // The first validated renderable's material is sampled to choose the
    // texture-view (M3 milestone simplification; M5 lifts this to
    // per-entity slot writes once UV-driven sampling lands).
    //
    // feat-20260517-merge-mesh-renderer-material-renderer M3 / w10
    // (this commit): the prior structural cast over `firstMaterial`
    // (used to reach `baseColorTexture` before the snapshot carried
    // it as a first-class field) is removed in favour of direct
    // snapshot field access. `MaterialSnapshot` (extract-stage SSOT)
    // already declares `baseColorTexture` (M2 / w6); record reads it
    // directly with no asset registry round-trip and no cast --
    // Pipeline Isolation: extract owns the asset to snapshot
    // translation; record consumes the snapshot POD only (charter
    // proposition 5 consistent abstraction; AC-07 reverse-grep gate
    // `scripts/forgeax/check-render-record-no-material-asset-get.mjs`
    // forbids both the cast pattern and any direct material asset
    // typed-lookup regrowth in this file).
    // bug-20260522-per-entity-material-texture-binding D-1/D-2:
    // the pre-loop `firstMaterial` / `materialTextureView` / `
    // baseMaterialEntries` / single shared `materialBindGroup` are
    // removed. Each entity now creates its own per-entity material BG
    // inside the draw loop, resolving binding=2 from its own
    // `entry.source.material.baseColorTexture` (mirroring sprite path).
    //
    // feat-20260520-skylight-ibl-cubemap M3 round-4 / t48 amend: the
    // 14-entry merged BG (7 material + 7 Skylight) is now assembled per
    // entity inside the draw loop. The Skylight part stays scene-level
    // (single `skylightResources` resolved once below); only the first 7
    // material entries are rebuilt per-entity with the correct
    // per-entity textureView at binding=2.
    const skylightFallback = pipelineState.skylightFallback;
    if (skylightFallback === null) {
      throw new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'pipelineState.skylightFallback != null when PBR pipeline is active',
        hint: 'createRenderer must allocate skylightFallback alongside the PBR pipeline (D-5 round-4)',
      });
    }
    // feat-20260520-skylight-ibl-cubemap M4 round-4 / t60 (D-5 round-4):
    // select active vs fallback Skylight resources by `skylightCount` from
    // the extract stage. Active path reaches into the per-device
    // `IblPipelineCache` slots (irradianceView / prefilterView / brdfLutView)
    // populated by the internal equirect-to-cubemap projection; fallback uses the
    // 1x1-zero identity bundle that converges ambient to 0 (D-4 physical
    // convergence -- no `if (hasSkylight)` shader branch).
    // The samplers are reused from `skylightFallback.sampler` for both
    // paths (linear / clamp-to-edge is correct for IBL cube + 2D LUT
    // sampling either way). The intensity uniform is rewritten per-frame
    // when active so `sampleIblSpecular * intensity` carries the user's
    // Skylight.intensity value; fallback keeps intensity=0 (createSkylightFallback
    // seed) so ambient = 0 even when the same buffer is shared.
    let activeViews: { irr: unknown; pref: unknown; brdf: unknown } | undefined;
    // Per-frame Skylight uniform: std140 16 B = [intensity, colorR, colorG,
    // colorB]. Default to all-zero so a transition from "has Skylight" ->
    // "no Skylight" does not leak the prior frame's ambient (intensity 0
    // muzzles everything, including the white fallback irradiance cube).
    {
      const zeroPayload = new Float32Array([0, 0, 0, 0]);
      runtime.device.queue.writeBuffer(
        // biome-ignore lint/suspicious/noExplicitAny: opaque Buffer handle
        skylightFallback.intensityBuffer as any,
        0,
        zeroPayload,
      );
    }
    if (skylight !== undefined && skylightCount >= 1) {
      // A Skylight exists. Write its intensity + color regardless of whether
      // a cubemap is bound: with a cubemap the IBL views below light the
      // ambient; WITHOUT one, the white fallback irradiance cube + this color
      // give an instant solid-color ambient (downstream integration #4) with
      // no async precompute. The white fallback only contributes when a
      // Skylight is present because the zero-payload above sets intensity 0
      // when no Skylight exists.
      const [cr, cg, cb] = skylight.color;
      const uniformPayload = new Float32Array([skylight.intensity, cr, cg, cb]);
      runtime.device.queue.writeBuffer(
        // biome-ignore lint/suspicious/noExplicitAny: opaque Buffer handle
        skylightFallback.intensityBuffer as any,
        0,
        uniformPayload,
      );
      // biome-ignore lint/suspicious/noExplicitAny: device is the opaque RhiDevice
      const cache = getOrCreateIblCache(runtime.device as any);
      if (
        cache.irradianceView !== undefined &&
        cache.prefilterView !== undefined &&
        cache.brdfLutView !== undefined
      ) {
        activeViews = {
          irr: cache.irradianceView,
          pref: cache.prefilterView,
          brdf: cache.brdfLutView,
        };
      }
    }
    const skylightResources =
      activeViews !== undefined
        ? {
            irradianceView: activeViews.irr as never,
            irradianceSampler: skylightFallback.sampler,
            prefilterView: activeViews.pref as never,
            prefilterSampler: skylightFallback.sampler,
            brdfLutView: activeViews.brdf as never,
            brdfLutSampler: skylightFallback.sampler,
            intensityBuffer: skylightFallback.intensityBuffer,
          }
        : {
            irradianceView: skylightFallback.irradianceView,
            irradianceSampler: skylightFallback.sampler,
            prefilterView: skylightFallback.prefilterView,
            prefilterSampler: skylightFallback.sampler,
            brdfLutView: skylightFallback.brdfLutView,
            brdfLutSampler: skylightFallback.sampler,
            intensityBuffer: skylightFallback.intensityBuffer,
          };
    // Per-entity material uploads (D-P9 retained path).
    // feat-20260613 fix-issue-1 (D-8 channelMap split): the payload mirrors
    // the post-split sidecar paramSchema for default-standard-pbr (10 numeric
    // entries packed std140 across 80 B):
    //   [0..3]   baseColor          vec4<f32>     (offset 0)
    //   [4]      metallic           f32           (offset 16)
    //   [5]      roughness          f32           (offset 20)
    //   [6]      metallicChannel    f32           (offset 24)
    //   [7]      roughnessChannel   f32           (offset 28)
    //   [8]      aoChannel          f32           (offset 32)
    //   [9]      extraChannel       f32           (offset 36)
    //   [12..14] emissive           vec3<f32>     (offset 48, vec3 align=16)
    //   [15]     emissiveIntensity  f32           (offset 60)
    //   [16]     occlusionStrength  f32           (offset 64)
    // Channel selectors default to (B,G,R,_) = (2,1,0,0) per glTF 2.0
    // KHR_materials_pbrSpecularGlossiness ARM packing; the fragment casts
    // each f32 to u32 at the pick_channel call site. The full 80 B is
    // overwritten per-entity so unlit entities still produce a deterministic
    // payload (charter P3 explicit failure: zero-init via fresh ArrayBuffer).
    //
    // feat-20260608 M5 amend / w16-a: per-submesh material UBO slot.
    // Each entity now allocates `entry.source.materials.length` consecutive
    // 256 B slots (one per submesh material). `materialSlotStart[i]` is the
    // first-slot index (cumulative sum) so the j-th material of entity i
    // lands at `(materialSlotStart[i] + j) * MATERIAL_PER_ENTITY_STRIDE`.
    // Sprite entities and the legacy single-material path collapse to one
    // slot (length=1), preserving the byte-stable single-material layout
    // that render-system-record-pbr-ubo-stable.test.ts pins.
    const materialSlotStart: number[] = new Array(validatedOrdered.length);
    {
      let cursor = 0;
      for (let i = 0; i < validatedOrdered.length; i++) {
        materialSlotStart[i] = cursor;
        const e = validatedOrdered[i];
        if (e === undefined) continue;
        // Sprite path stays single-slot regardless of materials.length
        // (sprite per-submesh is OOS-1; plan-strategy D-10: judgement key
        // migrated to materialShaderId post-feat-20260625 M3 / w13).
        // feat-20260624 M1' / t7: sprite-lit shares the single-slot rule.
        const slotsForEntity =
          e.source.material.materialShaderId === 'forgeax::sprite' ||
          e.source.material.materialShaderId === 'forgeax::sprite-lit'
            ? 1
            : e.source.materials.length;
        cursor += slotsForEntity;
      }
    }
    // feat-city-glb Bug 5 (per-submesh transparency): shared per-submesh
    // material bind-group assembly, called by BOTH the geometry pass and the
    // LDR blend sub-pass so a transparent PBR submesh binds the identical
    // metallic/roughness/normal/emissive/occlusion + uvSet + Skylight layout
    // the geometry pass uses (the sub-pass previously bound a sprite-only BG,
    // which cannot render a PBR decal). Captures only frame-stable closure
    // state; the caller passes the per-submesh material snapshot + entityKey
    // (for video texture routing) and sets the dynamic UBO offset itself.
    const perSubmeshMaterialBgDeps: PerSubmeshMaterialBgDeps = {
      runtime,
      pipelineState,
      world,
      store,
      materialSlice: MATERIAL_SLICE,
      videoHighPerfAvailable,
      skylightResources,
      materialBgShared: frameState.materialBgShared,
      bindGroupCounts,
    };
    const buildPerSubmeshMaterialBg = (
      submeshMaterial: MaterialSnapshot,
      entityKey: number,
    ): BindGroup =>
      buildPerSubmeshMaterialBgImpl(perSubmeshMaterialBgDeps, submeshMaterial, entityKey);
    for (let i = 0; i < validatedOrdered.length; i++) {
      const entry = validatedOrdered[i];
      if (entry === undefined) continue;
      const entitySlotStart = materialSlotStart[i] ?? 0;

      // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w13 (D-2):
      // single unified Material UBO write path. Sprite materials now flow
      // through the same `buildPbrMaterialUboPayload` baseline +
      // `applyParamSnapshotToUbo` generic std140 overlay every other
      // paramSchema-driven material uses. Extract folds the sprite-specific
      // user inputs into the UBO-aligned paramSnapshot vec4 entries
      // (colorTint / region / pivotAndSize / slicesAndMode); the writer
      // walks `derive(paramSchema).uboLayout.entries` and writes each at
      // its std140 offset. The legacy sprite-specific UBO builder + the
      // sprite-vs-PBR branch are gone (AC-03).
      const matsArr = entry.source.materials;
      for (let mk = 0; mk < matsArr.length; mk++) {
        const mat = matsArr[mk];
        if (mat === undefined) continue;
        const slotPayload = buildPbrMaterialUboPayload(mat);
        // Schema-driven paramSnapshot overlay generalised in feat-20260625
        // M1 / w3: the writer walks `derive(paramSchema).uboLayout.entries`
        // and writes each numeric field at its std140 offset (plan-strategy
        // section 2 D-2). The engine's stock PBR material ships
        // `paramSnapshot: undefined`, so this is a no-op on the default
        // PBR path -- the explicit field writes in buildPbrMaterialUboPayload
        // already cover every byte. User shaders carrying a paramSnapshot
        // (including the post-ablation sprite path) get their fields
        // written at the derive-computed offsets; R-H gate keeps the
        // helper snapshot-only, no asset get.
        const materialShaderId = mat.materialShaderId;
        const schema =
          materialShaderId !== undefined ? runtime.getParamSchema?.(materialShaderId) : undefined;
        applyParamSnapshotToUbo(slotPayload, schema, mat.paramSnapshot);

        // Missing-texture detection: structural debug-pink fallback overrides
        // the baseColor/colorTint slot when a bound baseColorTexture handle
        // resolves to no GPU view. Runs for every textured material path
        // (sprite / sprite-lit / standard-pbr / pbr-skin / unlit) — the bound
        // texture would otherwise silently fall back to the 1x1 white view in
        // the per-submesh BG (main-pass-material.ts), rendering flat with no
        // warn / RhiError. Mirroring the telemetry here makes a missing/failed
        // GLB texture immediately diagnosable instead of a silent flat render
        // (feat-future-pbr-missing-texture-fallback-explicit; feedback
        // 2026-07-04-glb-pbr-textures-not-applied-flat-render).
        //
        // Reads only `mat.baseColorTexture` + the GPU view registry (plan R-H
        // gate: no asset.get<MaterialAsset> reach-back). The debug-pink write
        // lands on f32[0..2], which is baseColor.rgb for the PBR/skin UBO and
        // colorTint.rgb for the sprite UBO — same offset, so one override
        // covers both.
        {
          const matHandleRaw = mat.baseColorTexture as Handle<'TextureAsset', 'shared'> | undefined;
          if (matHandleRaw !== undefined) {
            const view = residentTextureView(world, store, runtime, matHandleRaw);
            if (view === undefined) {
              const rawId = matHandleRaw as unknown as number;
              if (!frameState.warnedMissingBaseColorTextureHandles.has(rawId)) {
                frameState.warnedMissingBaseColorTextureHandles.add(rawId);
                console.warn(
                  `[forgeax] baseColor texture ${rawId} missing GPU view, rendering debug pink (shader=${materialShaderId ?? '<none>'} entityIndex=${entry.renderableIndex})`,
                );
              }
              runtime.errorRegistry.fire(
                new RhiError({
                  code: 'asset-not-registered',
                  expected: 'material baseColor TextureAsset uploaded to GPU',
                  hint: 'register + uploadTexture the baseColor texture before draw([world], { owner: 0 }); rendering falls back to debug pink until then',
                  detail: { assetHandle: rawId },
                }),
              );
              // Debug pink override on slot 0 baseColor/colorTint.rgb (alpha preserved).
              const payloadF32 = new Float32Array(slotPayload);
              payloadF32[0] = 1.0;
              payloadF32[1] = 0.4;
              payloadF32[2] = 0.7;
            }
          }
        }

        // Sprite-only paramSnapshot-derived detection (9-slice geometry).
        if (materialShaderId === 'forgeax::sprite' || materialShaderId === 'forgeax::sprite-lit') {
          // 9-slice scale-too-small detection: anchors sourced from the
          // post-w12 paramSnapshot.slicesAndMode vec4 entry.
          const slicesAndMode = mat.paramSnapshot?.slicesAndMode as readonly number[] | undefined;
          if (slicesAndMode !== undefined && slicesAndMode.length >= 4) {
            const slicesArr: readonly [number, number, number, number] = [
              slicesAndMode[0] ?? 0,
              slicesAndMode[1] ?? 0,
              slicesAndMode[2] ?? 0,
              slicesAndMode[3] ?? 0,
            ];
            const anyNonZero =
              slicesArr[0] !== 0 || slicesArr[1] !== 0 || slicesArr[2] !== 0 || slicesArr[3] !== 0;
            if (anyNonZero) {
              detectNineSliceScaleTooSmall(
                entry.source.transform.world,
                slicesArr,
                entry.renderableIndex,
                frameState.warnedNineSliceScaleEntities,
                runtime.metrics,
              );
            }
          }
        }

        const subMatUpload = runtime.device.queue.writeBuffer(
          pipelineState.materialUniformBuffer.buffer,
          (entitySlotStart + mk) * MATERIAL_PER_ENTITY_STRIDE,
          new Uint8Array(slotPayload),
        );
        if (!subMatUpload.ok) throw subMatUpload.error;
      }
    }

    pass.setBindGroup(0, viewBindGroup as BindGroup);

    // Track which (mesh-vertex-buffer, mesh-index-buffer, pipeline) combo
    // was last bound so consecutive entities sharing the same combo skip
    // the redundant rebinds (cheap GPU cost; net wins on workloads where
    // most entities share BUILTIN_CUBE + unlit). Initial nulls force the
    // first iteration to bind unconditionally.
    // M-3 / w12: vertexBuffer/indexBuffer state locals migrate to GpuBuffer.
    recordGeometryDraws(
      c,
      pass,
      matchedIndices,
      materialSlotStart,
      sampleCount,
      meshGroup2,
      buildPerSubmeshMaterialBg,
    );

    // D-2: LDR sprite pass. Runs after the geometry pass when there are
    // sprite entities in the draw list and the LDR path is active.
    // The geometry pass used the bgra8unorm-srgb sRGB view (hardware sRGB
    // encoding for unlit/standard/pbr output). The sprite pass uses the
    // bgra8unorm storage view (loadOp=load) so the sprite LDR pipeline
    // (target=bgra8unorm, blend=premultiplied-alpha) can write over the
    // already-encoded geometry pixels. Depth is loaded from the geometry
    // pass so sprite-vs-mesh occlusion (depthCompare=less-equal) is
    // preserved (plan-strategy §2 D-2 + §4 R-4).
    geometryPassEnded = recordSpritePass(
      c,
      pass,
      matchedIndices,
      materialSlotStart,
      sampleCount,
      buildPerSubmeshMaterialBg,
      skylightResources,
    );
  } // end if (validatedOrdered.length > 0) -- Case E falls through to pass.end()

  if (!geometryPassEnded) {
    pass.end();
  }
}
