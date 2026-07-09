import {
  type BindGroup,
  type Buffer,
  type RenderPipeline,
  RhiError,
  type RhiRenderPassEncoder,
  type TextureView,
} from '@forgeax/engine-rhi';
import type { PassSelector } from '@forgeax/engine-types';
import {
  PointShadowAtlasBoundsViolationError,
  PointShadowAtlasUninitializedError,
} from '../errors/render';
import { GpuBuffer } from '../gpu-resource';
import {
  assembleMaterialWithSkylightEntries,
  type EmissiveAoBindGroupResources,
} from '../ibl/skylight-bind-group';
import type { InstanceBufferCacheEntry } from '../instance-buffer-cache';
import { buildBeginRenderPassDescriptor } from '../pipeline-spec';
import type { _InternalRenderPipelineContext } from '../render-pipeline-context';
import { STANDARD_PBR_UBO_SIZE } from '../render-system';
import type { DispatchEntry } from '../render-system-extract';
import { matchPass } from '../systems/pass-selector';
import { worldEntityKey } from './frame-snapshot';
import {
  COPY_DST_USAGE,
  getOrCreateFromChain,
  getOrCreatePerEntity,
  MAX_UNIFORM_INSTANCES,
  MESH_PER_ENTITY_STRIDE,
  STORAGE_USAGE,
  UNIFORM_USAGE,
} from './mesh-ssbo';

/**
 * feat-20260609 M2: filter dispatch entries by a {@link PassSelector}.
 *
 * Each dispatch entry carries `tags` (a free key-value map) sourced from the
 * material's per-pass tags.  The selector is matched entry-by-entry via
 * {@link matchPass}; entries whose tags satisfy the selector are returned.
 * An empty selector returns the input array unchanged (match-all semantics).
 *
 * @param dispatch Per-frame dispatch entries (from the extract stage).
 * @param selector Pipeline-specific pass selector (e.g. `{ LightMode: ['Forward'] }`).
 * @returns Dispatch entries whose tags match the selector.
 */
export function filterDispatchBySelector(
  dispatch: readonly DispatchEntry[],
  selector: PassSelector,
): readonly DispatchEntry[] {
  if (Object.keys(selector).length === 0) return dispatch;
  return dispatch.filter((e) => matchPass(e.tags, selector));
}

/**
 * feat-20260609 M2: build a set of renderable indices whose dispatch entries
 * match the given selector.  Used by the record pass closures to skip entities
 * that do not belong to the current pass.
 *
 * Returns null when the dispatch array is empty (no dispatch-based filtering
 * to apply — draw all entities).  Returns an empty set when dispatch is
 * non-empty but no entries matched (draw nothing).  Returns a populated set
 * when at least one dispatch entry matched.
 */
export function buildMatchedRenderableIndices(
  dispatch: readonly DispatchEntry[],
  selector: PassSelector,
): Set<number> | null {
  // PRODUCTION INVARIANT: in real frames extractFrame always populates
  // dispatch[] for every visible renderable (Forward + ShadowCaster tags
  // emitted per validated entity, including the default-material handle=0
  // path — see render-system-extract.ts default-material dispatch emission).
  // The empty-dispatch null fallback below exists ONLY for unit-test
  // fixtures that mock dispatch out (early w-* tests written before
  // dispatch existed). Returning null causes the downstream loop to skip
  // selector filtering, preserving back-compat for those fixtures. If a
  // future refactor moves dispatch population earlier or makes it
  // conditional, the test fixtures should be updated rather than this
  // fallback widened to production.
  if (dispatch.length === 0) return null;
  const filtered = filterDispatchBySelector(dispatch, selector);
  const set = new Set<number>();
  for (const e of filtered) {
    set.add(e.renderableIndex);
  }
  return set;
}

/**
 * feat-20260529-rendergraph-pass-abstraction M4 / w13b: shadow depth pass
 * recording, extracted verbatim from recordFrame. Renders shadow casters
 * into the shadow depth RT using an INDEPENDENT command encoder + its own
 * queue.submit (RD-4: this independent-encoder boundary is the runtime-side
 * manual barrier that synchronizes the depth-texture write with the
 * subsequent sample in the main pass). Driven by the render-graph 'shadow'
 * pass execute closure.
 */
export function recordShadowPass(
  c: _InternalRenderPipelineContext,
  selector?: PassSelector,
  viewport?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  cascadeIndex: number = 0,
): void {
  const { runtime, pipelineState, validated, meshBindGroup, dispatch, frameState } = c;
  // feat-20260613-csm-cascaded-shadow-maps M5 / w28: write the per-pass
  // cascade index to the shared shadowCasterCascadeBuffer. The shadow
  // pass below uses an INDEPENDENT command encoder + own queue.submit, so
  // queue.writeBuffer here lands serially against this pass's submit
  // even when N cascades are recorded back-to-back -- each pass's submit
  // sees its own index.
  const cascadeIdxPayload = new Uint32Array([cascadeIndex >>> 0, 0, 0, 0]);
  const cascadeWriteResult = runtime.device.queue.writeBuffer(
    pipelineState.shadowCasterCascadeBuffer,
    0,
    cascadeIdxPayload,
  );
  if (!cascadeWriteResult.ok) throw cascadeWriteResult.error;
  // w10 shadow depth pass: uses a separate command encoder so Dawn/WebGPU
  // can synchronize the depth texture write (RenderAttachment) with the
  // subsequent read (TextureBinding in the geometry pass). Sharing an
  // encoder triggers "usage includes writable usage and another usage in
  // the same synchronization scope" validation error.
  // feat-20260609 M4 / T-010: shadow PSO via frameState.pipelineCache lookup
  // (same path as forward passes — charter P4 consistent abstraction).
  // getMaterialShaderPipeline lazily builds + caches PSO keyed on
  // (shaderId, isHdr, renderState, topology, indexFormat, variantSet, passKind).
  const shadowPipeline =
    runtime.getMaterialShaderPipeline?.(
      'forgeax::default-shadow-caster',
      false, // isHdr — shadow depth pass is always LDR
      undefined, // renderState — vertex-only shader, no render state
      'triangle-list', // topology — shadow PSO targets triangle-list
      undefined, // indexFormat — triangle-list ignores strip index width
      undefined, // variantSet — shadow_caster.wgsl has no group(2) bindings
      'shadow-caster', // passKind — distinguishes from forward PSO
    ) ?? null;
  // M5-T1: shadow depth target read directly from render-graph
  // (`addColorTarget('shadowDepth', ...)` declared in `urp-pipeline.ts`;
  // D-2 SSOT). Returns undefined when the graph has not allocated the
  // target (castShadow:false or shadowMapSize=0); the
  // gate below (`shadowView !== null`) is preserved by coalescing
  // undefined to null.
  const shadowView =
    (frameState.perFrameGraph?.getColorTargetView('shadowDepth') as TextureView | undefined) ??
    null;
  // feat-20260609 M2: filter entities by pass selector.
  const matchedIndices =
    selector !== undefined ? buildMatchedRenderableIndices(dispatch, selector) : null;

  // bug-20260619-csm RC-3 (AC-10, D-3): map each renderable to its
  // ShadowCaster pass shader so the depth pass selects the per-entity PSO
  // (mirrors the forward pass's per-entity PSO selection — charter P4).
  // A material with a custom ShadowCaster shader (e.g. an alpha-test cutout
  // that calls `discard`) gets its own fragment-carrying PSO; default
  // casters resolve to `forgeax::default-shadow-caster` (vertex-only), so
  // there is no regression for the built-in materials. Built from the
  // dispatch entries tagged `LightMode: 'ShadowCaster'` (extract already
  // populates `materialShaderId` per pass).
  const shadowShaderByRenderableIdx = new Map<number, string>();
  for (const de of dispatch) {
    if (de.tags.LightMode === 'ShadowCaster' && de.materialShaderId !== undefined) {
      shadowShaderByRenderableIdx.set(de.renderableIndex, de.materialShaderId);
    }
  }

  if (shadowPipeline !== null && shadowView !== null && validated.length > 0) {
    // feat-20260529-rendergraph-pass-abstraction M4 / w14 (RD-4 verification
    // point): this INDEPENDENT 'render-system-shadow' command encoder + its
    // own queue.submit below is the runtime-side manual barrier that splits
    // the shadowDepth write (here) from the main pass sample. The render-
    // graph mirrors the same shadow -> main hazard as an explicit barrier on
    // wgpu-native (barrier-backend-kind.test.ts w14); on webgpu / wgpu-webgl2
    // the encoder boundary alone provides synchronization. main / tonemap /
    // FXAA stay on the shared frame encoder (c.encoder), submitted once.
    const shadowEncResult = runtime.device.createCommandEncoder({
      label: 'render-system-shadow',
    });
    if (shadowEncResult.ok) {
      const shadowEnc = shadowEncResult.value;

      // M2 / w8: shadow view (#3) cache lookup with 'view-shadow'
      // variant discriminator (AC-06: distinct key from 'view-main').
      // b3 is always shadowFallbackTextureView (not the actual shadow
      // map — WebGPU forbids writing to and sampling from the same
      // texture in the same synchronization scope). Handles are all
      // init-time stable, so the WeakMap chain hits from frame 2 onward.
      const shadowViewBg = getOrCreateFromChain(
        c.frameState.viewBindGroupCache,
        [
          pipelineState.viewUniformBuffer,
          pipelineState.pointLightsBuffer,
          pipelineState.spotLightsBuffer,
          pipelineState.shadowFallbackTextureView,
          pipelineState.perPassResources.shadowSampler,
          pipelineState.shadowAtlasFallbackTextureView,
          pipelineState.shadowParamsBuffer,
          pipelineState.shadowFallbackTextureView,
        ],
        'view-shadow',
        () => {
          const shadowViewBgResult = runtime.device.createBindGroup({
            label: 'shadow-view-bg',
            layout: pipelineState.viewBindGroupLayout,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.viewUniformBuffer },
                },
              },
              {
                binding: 1,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.pointLightsBuffer },
                },
              },
              {
                binding: 2,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.spotLightsBuffer },
                },
              },
              {
                binding: 3,
                resource: { kind: 'textureView', value: pipelineState.shadowFallbackTextureView },
              },
              {
                binding: 4,
                resource: { kind: 'sampler', value: pipelineState.perPassResources.shadowSampler },
              },
              // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1:
              // shadowViewBg uses the cube_array fallback at binding 5
              // (NOT the real ShadowAtlas atlas view) because the directional
              // shadow caster is reading depth from b3 -- but mixing the
              // real atlas view here would put the cube_array under both a
              // sample and a write attachment hazard during the SAME frame
              // (point shadow caster pass writes the atlas; here we only
              // need a valid bind to satisfy the BGL shape, never sample it
              // in shadow_caster.wgsl).
              {
                binding: 5,
                resource: {
                  kind: 'textureView',
                  value: pipelineState.shadowAtlasFallbackTextureView,
                },
              },
              {
                binding: 6,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.shadowParamsBuffer },
                },
              },
              // feat-20260613-csm-cascaded-shadow-maps M5 / w28 (rebased to
              // binding 7 on 2026-06-13): per-pass cascade-index uniform
              // consumed by shadow_caster.vs_main.
              {
                binding: 7,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.shadowCasterCascadeBuffer },
                },
              },
              // feat-20260625-spot-light-shadow-mapping M3 / w21 (D-5): spot
              // shadow 2D atlas. The shadow-view BG always binds the 1x1 depth
              // fallback (NOT the real spotShadowDepth view) — the spot caster
              // pass write-attaches that atlas, so sampling it here would create
              // a same-frame write+sample hazard; shadow_caster.wgsl never reads
              // binding 8 anyway, this entry only satisfies the BGL shape.
              {
                binding: 8,
                resource: {
                  kind: 'textureView',
                  value: pipelineState.shadowFallbackTextureView,
                },
              },
              // feat-20260625-spot-light-shadow-mapping w25: spot lightViewProj
              // matrices folded into the View UBO (binding 0) — no binding 9.
              // binding 8 is the last shared view-BG entry.
            ],
          });
          if (!shadowViewBgResult.ok) throw shadowViewBgResult.error;
          return shadowViewBgResult.value;
        },
        c.bindGroupCounts,
      );

      // Dummy material bind group for @group(1) — not consumed by the
      // shadow-caster shader but must match the pipeline's
      // materialBindGroupLayout (14 entries: material 0..6 + Skylight
      // 7..13 per feat-20260520-skylight-ibl-cubemap D-5 round-4).
      //
      // D-6 / AC-05: all handles are init-time stable pipelineState defaults
      // + skylightFallback resources, so this BG is a true singleton (no
      // entityKey).  It lives in its own flat singletonMaterialCache
      // Map<variant, BindGroup> under 'shadow-material-singleton' — hit from
      // frame 2 onward, and cleanPerEntityCache never touches it (it is not
      // in any per-entity Map).
      const shadowMaterialBaseEntries = [
        {
          binding: 0,
          resource: {
            kind: 'buffer' as const,
            value: {
              buffer: pipelineState.materialUniformBuffer.buffer,
              offset: 0,
              size: STANDARD_PBR_UBO_SIZE,
            },
          },
        },
        {
          binding: 1,
          resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
        },
        {
          binding: 2,
          resource: {
            kind: 'textureView' as const,
            value: pipelineState.defaultWhiteTextureView,
          },
        },
        {
          binding: 3,
          resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
        },
        {
          binding: 4,
          resource: {
            kind: 'textureView' as const,
            value: pipelineState.defaultWhiteTextureView,
          },
        },
        {
          binding: 5,
          resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
        },
        {
          binding: 6,
          resource: {
            kind: 'textureView' as const,
            value: pipelineState.defaultNormalTextureView,
          },
        },
      ];
      const shadowSkyFb = pipelineState.skylightFallback;
      const shadowEmissiveAo: EmissiveAoBindGroupResources = {
        emissiveSampler: pipelineState.defaultSampler,
        emissiveView: pipelineState.defaultWhiteTextureView,
        occlusionSampler: pipelineState.defaultSampler,
        occlusionView: pipelineState.defaultWhiteTextureView,
      };
      const shadowMergedEntries =
        shadowSkyFb !== null
          ? assembleMaterialWithSkylightEntries(
              shadowMaterialBaseEntries,
              {
                irradianceView: shadowSkyFb.irradianceView,
                irradianceSampler: shadowSkyFb.sampler,
                prefilterView: shadowSkyFb.prefilterView,
                prefilterSampler: shadowSkyFb.sampler,
                brdfLutView: shadowSkyFb.brdfLutView,
                brdfLutSampler: shadowSkyFb.sampler,
                intensityBuffer: shadowSkyFb.intensityBuffer,
              },
              shadowEmissiveAo,
            )
          : shadowMaterialBaseEntries;
      // D-6 / AC-05: the one true singleton material BG lives in its own flat
      // Map<variant, BindGroup> (no entityKey, no handle chain). Cache hit
      // from frame 2 onward; the cleanPerEntityCache eviction never touches it.
      let shadowMaterialBg = c.frameState.singletonMaterialCache.get('shadow-material-singleton');
      if (shadowMaterialBg === undefined) {
        const shadowMaterialBgResult = runtime.device.createBindGroup({
          label: 'shadow-material-bg',
          layout: pipelineState.materialBindGroupLayout,
          entries: shadowMergedEntries,
        });
        if (!shadowMaterialBgResult.ok) throw shadowMaterialBgResult.error;
        shadowMaterialBg = shadowMaterialBgResult.value;
        c.bindGroupCounts.createBindGroup += 1;
        c.bindGroupCounts.keys.push('shadow-material-singleton');
        c.frameState.singletonMaterialCache.set('shadow-material-singleton', shadowMaterialBg);
      }

      // feat-20260604-instances-per-instance-transform-shader-group3-bin M2 / w12 (D-1 (C)):
      // shadow pass per-instance channel alignment — replaces the identity singleton
      // @group(3) binding with per-entity instance buffer + drawIndexed(instanceCount).
      //
      // C1: inside the shadow loop, resolve the per-entity instance buffer (reuse
      // frameState.instanceBuffers cache, or build+upload fresh). When entry has no
      // Instances component, fall back to identityInstanceBuffer + instanceCount=1.
      // C2: shadowPass.drawIndexed(indexCount, instanceCount, 0, 0, 0) with real
      // inst.instanceCount (not hardcoded 1).
      //
      // R2-1 (Reviewer note): the shadow encoder finishes BEFORE the main pass builds
      // frameState.instanceBuffers (main pass at ~:2950), so we build/upload per-entity
      // instance buffers INSIDE the shadow loop — shadow reads current-frame data.

      const shadowPass: RhiRenderPassEncoder = shadowEnc.beginRenderPass(
        buildBeginRenderPassDescriptor(
          { colorFormats: [], depthFormat: 'depth32float', sampleCount: 1 },
          { colorViews: [], depthView: shadowView },
          'shadow-caster',
          { depthLoadOp: cascadeIndex === 0 ? 'clear' : 'load' },
        ) as never,
      );

      shadowPass.setPipeline(shadowPipeline);
      // feat-20260613 M6 / w20 (D-4): per-cascade viewport always applies.
      // viewport clips the depth rasterization to one atlas tile so N
      // cascades share a single atlas depth texture. The pre-CSM
      // single-cascade fallback (full-RT pass when viewport === undefined)
      // is gone — urp-pipeline always passes a viewport per cascade and
      // any other caller is expected to follow the same contract. The
      // signature remains a defaulted parameter so compute callers can
      // still pass `{ x: 0, y: 0, w: mapSize, h: mapSize }` for a single-
      // tile render.
      const tileViewport: NonNullable<typeof viewport> = viewport ?? {
        x: 0,
        y: 0,
        w: pipelineState.perPassResources.shadowMapSize,
        h: pipelineState.perPassResources.shadowMapSize,
      };
      shadowPass.setViewport(tileViewport.x, tileViewport.y, tileViewport.w, tileViewport.h, 0, 1);
      shadowPass.setBindGroup(0, shadowViewBg);
      shadowPass.setBindGroup(1, shadowMaterialBg, [0]);

      recordShadowCasterDraws(
        c,
        shadowPass,
        shadowPipeline,
        meshBindGroup as BindGroup,
        matchedIndices,
        shadowShaderByRenderableIdx,
      );

      shadowPass.end();

      const shadowFinishResult = shadowEnc.finish();
      if (shadowFinishResult.ok) {
        runtime.device.queue.submit([shadowFinishResult.value]);
      } else {
        runtime.errorRegistry.fire(shadowFinishResult.error);
      }
    } else {
      runtime.errorRegistry.fire(shadowEncResult.error);
    }
  }
}

/**
 * feat-20260704 M3/w20: per-entity directional shadow-caster draw loop,
 * extracted verbatim from {@link recordShadowPass}. Walks `c.validated`,
 * selects the per-entity shadow PSO (default vertex-only caster or a custom
 * cutout caster), binds the per-entity mesh dynamic-offset + instance buffer,
 * and issues the per-submesh depth draws. `shadowPass` view/material bind
 * groups (@group 0/1) are already set by the caller; this loop owns @group
 * 2/3 + the vertex/index/pipeline de-dup state. Receives the explicit
 * `_InternalRenderPipelineContext` (`c`) plus the caller-resolved shadow
 * pipeline, mesh bind group, pass-selector match set, and per-renderable
 * custom-caster shader map so no cross-function mutable state is introduced.
 */
function recordShadowCasterDraws(
  c: _InternalRenderPipelineContext,
  shadowPass: RhiRenderPassEncoder,
  shadowPipeline: RenderPipeline,
  shadowMeshBindGroup: BindGroup,
  matchedIndices: Set<number> | null,
  shadowShaderByRenderableIdx: ReadonlyMap<number, string>,
): void {
  const { runtime, pipelineState, validated } = c;
  // M-3 / w12: vertexBuffer/indexBuffer state locals migrate to GpuBuffer
  // (the wrapper) -- the de-dup compare uses wrapper identity (one wrapper
  // per RHI handle from gpuStore), and `.handle` is passed to the RHI
  // setVertexBuffer / setIndexBuffer call.
  let shadowLastVertexBuffer: GpuBuffer | null = null;
  let shadowLastIndexBuffer: GpuBuffer | null = null;
  // bug-20260619-csm RC-3 (D-3): track the currently-bound shadow PSO so
  // per-entity setPipeline only fires on change (same de-dup discipline as
  // vertex/index buffers above). The default-shadow-caster PSO is already
  // bound by the setPipeline call above; the loop switches to a custom
  // ShadowCaster PSO when a material supplies one.
  let shadowLastPipeline: RenderPipeline = shadowPipeline;

  for (let i = 0; i < validated.length; i++) {
    const entry = validated[i];
    if (entry === undefined) continue;

    // feat-20260609 M2: skip entities that don't match the pass selector.
    if (matchedIndices !== null && !matchedIndices.has(entry.renderableIndex)) continue;

    // bug-20260619-csm RC-3 (AC-10, D-3): resolve the per-entity shadow
    // PSO from its ShadowCaster shader id. Default casters keep the
    // vertex-only `forgeax::default-shadow-caster` PSO bound above; a
    // material with a custom ShadowCaster shader (cutout alpha-test) gets
    // its own fragment-carrying PSO so `discard` runs in the depth pass.
    const entryShadowShaderId = shadowShaderByRenderableIdx.get(entry.renderableIndex);
    let entryShadowPipeline = shadowPipeline;
    if (
      entryShadowShaderId !== undefined &&
      entryShadowShaderId !== 'forgeax::default-shadow-caster'
    ) {
      // Custom ShadowCaster PSO; same cache path as the default above
      // (passKind 'shadow-caster'). On a cache miss (async build in
      // flight / build failure) fall back to the default PSO so the
      // caster still writes depth rather than dropping its draw.
      entryShadowPipeline =
        runtime.getMaterialShaderPipeline?.(
          entryShadowShaderId,
          false, // isHdr — shadow depth pass is always LDR
          undefined, // renderState
          'triangle-list', // topology — shadow PSO targets triangle-list
          undefined, // indexFormat
          undefined, // variantSet — shadow caster has no variant axes
          'shadow-caster', // passKind
        ) ?? shadowPipeline;
    }
    if (entryShadowPipeline !== shadowLastPipeline && entryShadowPipeline !== null) {
      shadowPass.setPipeline(entryShadowPipeline);
      shadowLastPipeline = entryShadowPipeline;
    }

    // feat-20260604-mesh-topology-debug-draw M5 / w14 (AC-09, D-A6): the
    // shadow caster PSO is triangle-list; it only projects triangle faces.
    // line-list / line-strip / point-list meshes have no surface to cast a
    // shadow, so skip them here. triangle-strip is still a face topology
    // and projects (the shadow PSO's fixed triangle-list rasterizes its
    // expanded triangles correctly enough for the depth pass).
    //
    // feat-20260608 M4 / w16: per-submesh shadow draw — iterate submeshes
    // and skip non-triangle submeshes individually (each submesh may differ).
    const shadowSubmeshes = entry.mesh.submeshes;
    const hasAnyShadowSubmesh = shadowSubmeshes.some(
      (sm) => sm.topology === 'triangle-list' || sm.topology === 'triangle-strip',
    );
    if (!hasAnyShadowSubmesh) {
      continue;
    }

    if (entry.mesh.vertexBuffer !== shadowLastVertexBuffer) {
      shadowPass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
      shadowLastVertexBuffer = entry.mesh.vertexBuffer;
    }
    if (entry.mesh.indexed && entry.mesh.indexBuffer !== shadowLastIndexBuffer) {
      // indexed=true implies indexBuffer is non-null GpuBuffer.
      if (entry.mesh.indexBuffer !== null) {
        shadowPass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
        shadowLastIndexBuffer = entry.mesh.indexBuffer;
      }
    }

    shadowPass.setBindGroup(2, shadowMeshBindGroup, [i * MESH_PER_ENTITY_STRIDE]);

    // C1 + C2 (w12): per-entity instance buffer + instanceCount
    let shadowInstanceBuffer: Buffer = pipelineState.identityInstanceBuffer;
    let shadowInstanceCount = 1;
    const shadowInst = entry.source.instances;
    if (shadowInst !== undefined) {
      const uniformFallback = runtime.device.caps.storageBuffer === false;
      // Over-cap uniform fallback can't fit the per-instance window — bind
      // identity and let the shader collapse (same semantics as the main
      // pass). Otherwise build/upload the per-entity instance buffer: storage
      // by default, uniform when the device lacks storage buffers.
      if (uniformFallback && shadowInst.instanceCount > MAX_UNIFORM_INSTANCES) {
        shadowInstanceCount = shadowInst.instanceCount;
        shadowInstanceBuffer = pipelineState.identityInstanceBuffer;
      } else {
        const bufUsage = uniformFallback
          ? UNIFORM_USAGE | COPY_DST_USAGE
          : STORAGE_USAGE | COPY_DST_USAGE;
        const requestedBytes = shadowInst.transforms.byteLength;
        const cached = c.frameState.instanceBuffers.get(
          worldEntityKey(entry.source.worldId, shadowInst.cacheKey),
        );
        let active: InstanceBufferCacheEntry | null = null;
        if (
          cached !== undefined &&
          cached.uploadedArchVersion === shadowInst.archVersion &&
          cached.uploadedByteLength === requestedBytes
        ) {
          active = cached;
        } else if (requestedBytes > 0) {
          const bufRes = runtime.device.createBuffer({
            size: requestedBytes,
            usage: bufUsage,
            mappedAtCreation: false,
          });
          if (!bufRes.ok) {
            runtime.errorRegistry.fire(bufRes.error);
          } else {
            // feat-20260619 M4 / F12: destroy the old cached buffer
            // before replacing it with the new one (D-6).
            if (cached !== undefined && !cached.buffer.isDestroyed) {
              const r = cached.buffer.destroy();
              if (!r.ok) runtime.errorRegistry.fire(r.error);
            }
            const newBuffer = new GpuBuffer(runtime.device, bufRes.value);
            active = {
              buffer: newBuffer,
              uploadedArchVersion: shadowInst.archVersion,
              uploadedByteLength: requestedBytes,
            };
            c.frameState.instanceBuffers.set(
              worldEntityKey(entry.source.worldId, shadowInst.cacheKey),
              active,
            );
          }
        }
        if (active !== null) {
          const writeRes = runtime.device.queue.writeBuffer(
            active.buffer.handle,
            0,
            shadowInst.transforms,
          );
          if (!writeRes.ok) {
            runtime.errorRegistry.fire(writeRes.error);
          } else {
            shadowInstanceBuffer = active.buffer.handle;
            shadowInstanceCount = Math.max(1, shadowInst.instanceCount);
          }
        }
      }
    }

    // Bind per-entity instances BG for @group(3) (or fallback identity).
    // D-4: write end of the HDRP shadow-instances producer/consumer pair.
    // outerKey = worldEntityKey(entry.source.worldId, entry.source.entityKey),
    // handle = shadowInstanceBuffer; the HDRP main pass read end (:3820 below)
    // must look up the same (compositeKey, instBuffer) leaf or the shadow
    // instances silently drop.
    const shadowInstancesBg = getOrCreatePerEntity(
      c.frameState.instancesBgPerEntity,
      worldEntityKey(entry.source.worldId, entry.source.entityKey),
      [shadowInstanceBuffer],
      'shadow-instances',
      () => {
        const result = runtime.device.createBindGroup({
          label: 'shadow-instances-bg',
          layout: pipelineState.instancesBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: { buffer: shadowInstanceBuffer },
              },
            },
          ],
        });
        if (!result.ok) throw result.error;
        return result.value;
      },
      c.bindGroupCounts,
    );

    shadowPass.setBindGroup(3, shadowInstancesBg);
    // feat-20260608 M4 / w16: per-submesh shadow draw loop.
    // Only draw submeshes whose topology is triangle-list or triangle-strip
    // (line-list / point-list submeshes cast no shadow and are skipped).
    for (const sm of shadowSubmeshes) {
      if (sm.topology !== 'triangle-list' && sm.topology !== 'triangle-strip') {
        continue;
      }
      if (entry.mesh.indexed) {
        shadowPass.drawIndexed(sm.indexCount, shadowInstanceCount, sm.indexOffset, 0, 0);
      } else {
        shadowPass.draw(sm.vertexCount, shadowInstanceCount, 0, 0);
      }
    }
  }
}

/**
 * feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-2 (plan-strategy §D-1
 * + §D-3 + AC-04). Records the 6 x N point-shadow caster passes — one render
 * pass per (shadow-casting point light, cube face) pair — that write per-light
 * cube_array atlas depth. Driven by the URP `addPointShadowPass` graph closure;
 * gated upstream on `frameState.pointShadowSnapshots.length > 0` (AC-09 zero-
 * shadow zero-pass).
 *
 * Pass count = 6 * N where N = `frameState.pointShadowSnapshots.length`. Each
 * pass opens an INDEPENDENT command encoder + queue.submit so Dawn / WebGPU
 * synchronizes the depth-write boundary with the subsequent atlas sample in
 * the forward pass (RD-4 manual barrier; same pattern as `recordShadowPass`).
 *
 * Round-2 F-3 fix-up: actual geometry walk + draw landed. Per face we
 * (1) write the face VP mat4 into `viewUniformBuffer` at offset 112 (the
 * `lightSpaceMatrix` slot) — `forgeax::default-shadow-caster` reads
 * `view.lightSpaceMatrix * worldPos` and the encoder boundary serializes
 * the queue.writeBuffer with the subsequent draw, so each face sees its own
 * VP without needing a per-face UBO bind. (2) Reuse the directional shadow
 * caster PSO + cached `shadow-view-bg` / `shadow-material-singleton` /
 * `shadow-mesh-bg` already built by `recordShadowPass`. (3) After all
 * (snapshot, face) passes complete, restore `viewUniformBuffer.lightSpaceMatrix`
 * to the directional value the main forward pass needs (the queue.submit
 * ordering guarantees the restore lands before the main encoder runs).
 *
 * Caveat: the cached `view-shadow` BG binds `shadowAtlasFallbackTextureView`
 * at binding 5 (NOT the real ShadowAtlas atlas view) so the BG is valid even
 * while the real atlas faces are being written through the depth attachment;
 * the shadow_caster.wgsl shader never samples binding 5 anyway (vertex-only
 * pipeline).
 *
 * No new shader / no new PSO / no new BGL is required for this round; the
 * change is purely runtime wiring. A dedicated `forgeax::default-point-
 * shadow-caster` PSO with a per-face VP UBO + dynamic offset would let the
 * pass run without touching `viewUniformBuffer.lightSpaceMatrix` and could
 * be considered for a follow-on optimization milestone (`OOS-future`).
 */
export function recordPointShadowPass(c: _InternalRenderPipelineContext): void {
  const { runtime, frameState, validated, meshBindGroup, pipelineState } = c;
  const snapshots = frameState.pointShadowSnapshots;
  if (snapshots.length === 0) return;
  const atlas = frameState.pointShadowAtlas;
  if (atlas === null || !atlas.isAllocated()) return;

  // Reuse the directional shadow caster PSO -- its WGSL reads
  // `view.lightSpaceMatrix * worldPos` which is exactly what we need once we
  // overwrite the slot per face below.
  const shadowPipeline =
    runtime.getMaterialShaderPipeline?.(
      'forgeax::default-shadow-caster',
      false,
      undefined,
      'triangle-list',
      undefined,
      undefined,
      'shadow-caster',
    ) ?? null;
  if (shadowPipeline === null) return;

  // Snapshot the directional lightSpaceMatrix so we can restore it after the
  // 6 x N face passes. recordShadowPass already wrote `viewUniformBuffer` at
  // offset 112 above; mirror its source in `pipelineState.perPassResources`
  // (cached by the directional path for Inspector consumption -- charter P4
  // single SSOT). When no directional shadow is active the slot was zeroed
  // by the viewPayload write at recordFrame top; we restore zeros.
  const restoreLightSpaceMatrix = pipelineState.perPassResources.shadowLightSpaceMatrix;
  const RESTORE_LSM_BYTES = 64; // mat4 = 16 floats x 4 B
  const VIEW_UBO_LSM_OFFSET = 112;

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    if (snap === undefined) continue;
    for (let face = 0; face < 6; face++) {
      // (1) Overwrite viewUniformBuffer.lightSpaceMatrix with this face's VP.
      // shadowMatrices is Float32Array(96) = 6 mat4 in [+X,-X,+Y,-Y,+Z,-Z];
      // pull the 16-float subarray for this face.
      const faceVp = snap.shadowMatrices.subarray(face * 16, (face + 1) * 16);
      const lsmWriteRes = runtime.device.queue.writeBuffer(
        pipelineState.viewUniformBuffer,
        VIEW_UBO_LSM_OFFSET,
        faceVp,
      );
      if (!lsmWriteRes.ok) {
        runtime.errorRegistry.fire(lsmWriteRes.error);
        continue;
      }

      const encResult = runtime.device.createCommandEncoder({
        label: `point-shadow-l${snap.shadowAtlasLayer}-f${face}`,
      });
      if (!encResult.ok) {
        runtime.errorRegistry.fire(encResult.error);
        continue;
      }
      const enc = encResult.value;
      let view: TextureView;
      try {
        view = atlas.faceView(snap.shadowAtlasLayer, face);
      } catch (e) {
        if (
          e instanceof PointShadowAtlasUninitializedError ||
          e instanceof PointShadowAtlasBoundsViolationError
        ) {
          runtime.errorRegistry.fire(e);
        } else {
          throw e;
        }
        continue;
      }
      const pass = enc.beginRenderPass(
        buildBeginRenderPassDescriptor(
          { colorFormats: [], depthFormat: 'depth32float', sampleCount: 1 },
          { colorViews: [], depthView: view },
          'point-shadow-caster',
        ) as never,
      );

      // (2) Bind the same shadow PSO + view BG + material BG + mesh BG cached
      // by recordShadowPass earlier in this frame. The shadow path's view BG
      // binds the cube_array fallback at binding 5, so this BG is safe to
      // use while the real atlas faces are render-attached here.
      pass.setPipeline(shadowPipeline);
      // Look up the shadow view BG built earlier this frame by recordShadowPass.
      // `view-shadow` is the cache variant; keyed by the same handle objects.
      // If the directional shadow path wasn't taken (castShadow:false),
      // shadow-view-bg was never built -- skip the geometry walk in that case
      // (the depth attachment was still cleared above which is the AC-04
      // "atlas face cleared to far" minimum guarantee).
      // Build (or reuse) the shadow-view BG. If the directional shadow path
      // already populated it earlier this frame, the cache hits; otherwise
      // (castShadow:false -- recordShadowPass never
      // ran) we build it on-demand here so the point shadow caster has a
      // valid b0 view BG even on directional-shadow-free scenes.
      const cachedShadowViewBg = getOrCreateFromChain(
        frameState.viewBindGroupCache,
        [
          pipelineState.viewUniformBuffer,
          pipelineState.pointLightsBuffer,
          pipelineState.spotLightsBuffer,
          pipelineState.shadowFallbackTextureView,
          pipelineState.perPassResources.shadowSampler,
          pipelineState.shadowAtlasFallbackTextureView,
          pipelineState.shadowParamsBuffer,
          pipelineState.shadowCasterCascadeBuffer,
          pipelineState.shadowFallbackTextureView,
        ],
        'view-shadow',
        () => {
          const r = runtime.device.createBindGroup({
            label: 'shadow-view-bg',
            layout: pipelineState.viewBindGroupLayout,
            entries: [
              {
                binding: 0,
                resource: { kind: 'buffer', value: { buffer: pipelineState.viewUniformBuffer } },
              },
              {
                binding: 1,
                resource: { kind: 'buffer', value: { buffer: pipelineState.pointLightsBuffer } },
              },
              {
                binding: 2,
                resource: { kind: 'buffer', value: { buffer: pipelineState.spotLightsBuffer } },
              },
              {
                binding: 3,
                resource: { kind: 'textureView', value: pipelineState.shadowFallbackTextureView },
              },
              {
                binding: 4,
                resource: { kind: 'sampler', value: pipelineState.perPassResources.shadowSampler },
              },
              {
                binding: 5,
                resource: {
                  kind: 'textureView',
                  value: pipelineState.shadowAtlasFallbackTextureView,
                },
              },
              {
                binding: 6,
                resource: { kind: 'buffer', value: { buffer: pipelineState.shadowParamsBuffer } },
              },
              // feat-20260625-spot-light-shadow-mapping M2 / w21 + w25: this
              // on-demand shadow-view BG builder previously stopped at binding 6,
              // predating the cascade UBO (binding 7) and the spot binding 8. It
              // shares the 'view-shadow' cache variant with the directional
              // shadow-pass builder above, so it must produce a BGL-identical bind
              // group; bindings 7/8 are added here in lock-step (BGL declares
              // 0..8 — the former binding 9 spot lightViewProj UBO folded into the
              // View UBO in w25 for the WebGL2 fragment uniform-buffer budget).
              {
                binding: 7,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.shadowCasterCascadeBuffer },
                },
              },
              {
                binding: 8,
                resource: {
                  kind: 'textureView',
                  value: pipelineState.shadowFallbackTextureView,
                },
              },
            ],
          });
          if (!r.ok) throw r.error;
          return r.value;
        },
        c.bindGroupCounts,
      );
      // Same on-demand build for the dummy material BG (the shadow_caster
      // shader does not consume @group(1) but the PSO requires the BGL
      // to validate). Reuse the same singleton Map entry recordShadowPass
      // writes so the two paths share one allocation per frame (D-6).
      let cachedShadowMaterialBg = frameState.singletonMaterialCache.get(
        'shadow-material-singleton',
      );
      if (cachedShadowMaterialBg === undefined) {
        const buildShadowMaterialSingleton = (): BindGroup => {
          const fb = pipelineState.skylightFallback;
          const fallbackEntries = [
            {
              binding: 0,
              resource: {
                kind: 'buffer' as const,
                value: {
                  buffer: pipelineState.materialUniformBuffer.buffer,
                  offset: 0,
                  size: STANDARD_PBR_UBO_SIZE,
                },
              },
            },
            {
              binding: 1,
              resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
            },
            {
              binding: 2,
              resource: { kind: 'textureView' as const, value: pipelineState.fallbackTextureView },
            },
            {
              binding: 3,
              resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
            },
            {
              binding: 4,
              resource: {
                kind: 'textureView' as const,
                value: pipelineState.defaultNormalTextureView,
              },
            },
            {
              binding: 5,
              resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
            },
            {
              binding: 6,
              resource: { kind: 'textureView' as const, value: pipelineState.fallbackTextureView },
            },
          ];
          const merged =
            fb !== null
              ? assembleMaterialWithSkylightEntries(
                  fallbackEntries,
                  {
                    irradianceView: fb.irradianceView,
                    irradianceSampler: fb.sampler,
                    prefilterView: fb.prefilterView,
                    prefilterSampler: fb.sampler,
                    brdfLutView: fb.brdfLutView,
                    brdfLutSampler: fb.sampler,
                    intensityBuffer: fb.intensityBuffer,
                  },
                  {
                    emissiveSampler: pipelineState.defaultSampler,
                    emissiveView: pipelineState.defaultWhiteTextureView,
                    occlusionSampler: pipelineState.defaultSampler,
                    occlusionView: pipelineState.defaultWhiteTextureView,
                  },
                )
              : fallbackEntries;
          const r = runtime.device.createBindGroup({
            label: 'shadow-material-bg',
            layout: pipelineState.materialBindGroupLayout,
            entries: merged,
          });
          if (!r.ok) throw r.error;
          return r.value;
        };
        cachedShadowMaterialBg = buildShadowMaterialSingleton();
        c.bindGroupCounts.createBindGroup += 1;
        c.bindGroupCounts.keys.push('shadow-material-singleton');
        frameState.singletonMaterialCache.set('shadow-material-singleton', cachedShadowMaterialBg);
      }
      if (meshBindGroup === null) {
        pass.end();
        const finishOnly = enc.finish();
        if (!finishOnly.ok) {
          runtime.errorRegistry.fire(finishOnly.error);
          continue;
        }
        const submitOnly = runtime.device.queue.submit([finishOnly.value]);
        if (!submitOnly.ok) {
          runtime.errorRegistry.fire(submitOnly.error);
        }
        continue;
      }
      pass.setBindGroup(0, cachedShadowViewBg);
      pass.setBindGroup(1, cachedShadowMaterialBg, [0]);

      // (3) Iterate the validated entries and emit one drawIndexed per
      // shadow-casting submesh. Same shape as the directional shadow loop;
      // the per-instance instance buffers built earlier this frame in
      // recordShadowPass are reused (cached on frameState.instanceBuffers).
      let lastVB: GpuBuffer | null = null;
      let lastIB: GpuBuffer | null = null;
      for (let ei = 0; ei < validated.length; ei++) {
        const entry = validated[ei];
        if (entry === undefined) continue;
        const submeshes = entry.mesh.submeshes;
        const hasTriangle = submeshes.some(
          (sm) => sm.topology === 'triangle-list' || sm.topology === 'triangle-strip',
        );
        if (!hasTriangle) continue;
        if (entry.mesh.vertexBuffer !== lastVB) {
          pass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
          lastVB = entry.mesh.vertexBuffer;
        }
        if (entry.mesh.indexed && entry.mesh.indexBuffer !== lastIB && entry.mesh.indexBuffer) {
          pass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
          lastIB = entry.mesh.indexBuffer;
        }
        pass.setBindGroup(2, meshBindGroup, [ei * MESH_PER_ENTITY_STRIDE]);
        // Resolve the per-entity instance BG cached by recordShadowPass.
        const inst = entry.source.instances;
        let instCount = 1;
        let instBufferKey: object = pipelineState.identityInstanceBuffer as unknown as object;
        if (inst !== undefined) {
          const cached = frameState.instanceBuffers.get(
            worldEntityKey(entry.source.worldId, inst.cacheKey),
          );
          if (
            cached !== undefined &&
            cached.uploadedArchVersion === inst.archVersion &&
            cached.uploadedByteLength === inst.transforms.byteLength
          ) {
            instBufferKey = cached.buffer.handle as unknown as object;
            instCount = Math.max(1, inst.instanceCount);
          }
        }
        // D-4 read end: look up the leaf recordShadowPass wrote at :3439
        // with the SAME (entityKey, instBuffer) pair. The single-handle chain
        // stores the variant->BindGroup leaf Map directly under the buffer
        // handle in the inner WeakMap, so the variant lookup is the third
        // step. The inner WeakMap value is opaque (`unknown`); the 1-handle
        // shadow-instances chain guarantees it is the leaf Map here.
        const shadowInstLeaf = frameState.instancesBgPerEntity
          .get(worldEntityKey(entry.source.worldId, entry.source.entityKey))
          ?.get(instBufferKey) as Map<string, BindGroup> | undefined;
        const cachedInstBg = shadowInstLeaf?.get('shadow-instances');
        if (cachedInstBg === undefined) continue; // recordShadowPass should have populated it
        pass.setBindGroup(3, cachedInstBg);
        for (const sm of submeshes) {
          if (sm.topology !== 'triangle-list' && sm.topology !== 'triangle-strip') continue;
          if (entry.mesh.indexed) {
            pass.drawIndexed(sm.indexCount, instCount, sm.indexOffset, 0, 0);
          } else {
            pass.draw(sm.vertexCount, instCount, 0, 0);
          }
        }
      }

      pass.end();
      const finishResult = enc.finish();
      if (!finishResult.ok) {
        runtime.errorRegistry.fire(finishResult.error);
        continue;
      }
      const submitResult = runtime.device.queue.submit([finishResult.value]);
      if (!submitResult.ok) {
        runtime.errorRegistry.fire(submitResult.error);
      }
    }
  }

  // (4) Restore viewUniformBuffer.lightSpaceMatrix to the directional value
  // (or zero if no directional shadow this frame). The main forward pass
  // builds its own viewBg from the SAME viewUniformBuffer + reads
  // view.lightSpaceMatrix for directional shadow factor reconstruction.
  const restoreBuf = new Float32Array(16);
  if (restoreLightSpaceMatrix !== null) {
    for (let i = 0; i < 16; i++) restoreBuf[i] = restoreLightSpaceMatrix[i] ?? 0;
  }
  // restoreBuf is already exactly 16 floats x 4 B = 64 B; no size override needed.
  void RESTORE_LSM_BYTES;
  const restoreRes = runtime.device.queue.writeBuffer(
    pipelineState.viewUniformBuffer,
    VIEW_UBO_LSM_OFFSET,
    restoreBuf,
  );
  if (!restoreRes.ok) {
    runtime.errorRegistry.fire(restoreRes.error);
  }
}

/**
 * Build (or reuse) the shared `view-shadow` @group(0) BG for the spot shadow
 * caster pass. Reuses the exact same cache key + entry shape as recordShadowPass
 * / recordPointShadowPass so all three shadow paths share one allocation per
 * frame (D-6). Returns null on a createBindGroup failure (fired to the error
 * registry). The shadow_caster vertex shader reads only binding 0 (view UBO,
 * carrying the spot matrix via shadowCasterCascade at binding 7) — bindings
 * 3/5 bind fallback views since the depth attachment is written here.
 */
function ensureSpotShadowViewBg(c: _InternalRenderPipelineContext): BindGroup | null {
  const { runtime, frameState, pipelineState } = c;
  try {
    return getOrCreateFromChain(
      frameState.viewBindGroupCache,
      [
        pipelineState.viewUniformBuffer,
        pipelineState.pointLightsBuffer,
        pipelineState.spotLightsBuffer,
        pipelineState.shadowFallbackTextureView,
        pipelineState.perPassResources.shadowSampler,
        pipelineState.shadowAtlasFallbackTextureView,
        pipelineState.shadowParamsBuffer,
        pipelineState.shadowCasterCascadeBuffer,
        pipelineState.shadowFallbackTextureView,
      ],
      'view-shadow',
      () => {
        const r = runtime.device.createBindGroup({
          label: 'shadow-view-bg',
          layout: pipelineState.viewBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: { kind: 'buffer', value: { buffer: pipelineState.viewUniformBuffer } },
            },
            {
              binding: 1,
              resource: { kind: 'buffer', value: { buffer: pipelineState.pointLightsBuffer } },
            },
            {
              binding: 2,
              resource: { kind: 'buffer', value: { buffer: pipelineState.spotLightsBuffer } },
            },
            {
              binding: 3,
              resource: { kind: 'textureView', value: pipelineState.shadowFallbackTextureView },
            },
            {
              binding: 4,
              resource: { kind: 'sampler', value: pipelineState.perPassResources.shadowSampler },
            },
            {
              binding: 5,
              resource: {
                kind: 'textureView',
                value: pipelineState.shadowAtlasFallbackTextureView,
              },
            },
            {
              binding: 6,
              resource: { kind: 'buffer', value: { buffer: pipelineState.shadowParamsBuffer } },
            },
            {
              binding: 7,
              resource: {
                kind: 'buffer',
                value: { buffer: pipelineState.shadowCasterCascadeBuffer },
              },
            },
            // feat-20260625-spot-light-shadow-mapping M3 / w21 (D-5): spot
            // shadow 2D atlas. The spot caster pass write-attaches
            // spotShadowDepth, so bind the 1x1 fallback here (the caster shader
            // never samples binding 8 — this entry only satisfies the BGL).
            {
              binding: 8,
              resource: {
                kind: 'textureView',
                value: pipelineState.shadowFallbackTextureView,
              },
            },
            // feat-20260625-spot-light-shadow-mapping w25: spot lightViewProj
            // matrices folded into the View UBO (binding 0) — no binding 9.
            // binding 8 is the last shared view-BG entry.
          ],
        });
        if (!r.ok) throw r.error;
        return r.value;
      },
      c.bindGroupCounts,
    );
  } catch (e) {
    if (e instanceof RhiError) {
      runtime.errorRegistry.fire(e);
      return null;
    }
    throw e;
  }
}

/**
 * Build (or reuse) the dummy `shadow-material-singleton` @group(1) BG for the
 * spot shadow caster pass. The vertex-only shadow_caster shader never consumes
 * @group(1) but the PSO's BGL must validate. Reuses the same singleton Map
 * entry recordShadowPass / recordPointShadowPass write so the three paths share
 * one allocation per frame (D-6).
 */
function ensureSpotShadowMaterialBg(c: _InternalRenderPipelineContext): BindGroup | null {
  const { runtime, frameState, pipelineState } = c;
  const cached = frameState.singletonMaterialCache.get('shadow-material-singleton');
  if (cached !== undefined) return cached;
  const fb = pipelineState.skylightFallback;
  const fallbackEntries = [
    {
      binding: 0,
      resource: {
        kind: 'buffer' as const,
        value: {
          buffer: pipelineState.materialUniformBuffer.buffer,
          offset: 0,
          size: STANDARD_PBR_UBO_SIZE,
        },
      },
    },
    { binding: 1, resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler } },
    {
      binding: 2,
      resource: { kind: 'textureView' as const, value: pipelineState.fallbackTextureView },
    },
    { binding: 3, resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler } },
    {
      binding: 4,
      resource: { kind: 'textureView' as const, value: pipelineState.defaultNormalTextureView },
    },
    { binding: 5, resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler } },
    {
      binding: 6,
      resource: { kind: 'textureView' as const, value: pipelineState.fallbackTextureView },
    },
  ];
  const merged =
    fb !== null
      ? assembleMaterialWithSkylightEntries(
          fallbackEntries,
          {
            irradianceView: fb.irradianceView,
            irradianceSampler: fb.sampler,
            prefilterView: fb.prefilterView,
            prefilterSampler: fb.sampler,
            brdfLutView: fb.brdfLutView,
            brdfLutSampler: fb.sampler,
            intensityBuffer: fb.intensityBuffer,
          },
          {
            emissiveSampler: pipelineState.defaultSampler,
            emissiveView: pipelineState.defaultWhiteTextureView,
            occlusionSampler: pipelineState.defaultSampler,
            occlusionView: pipelineState.defaultWhiteTextureView,
          },
        )
      : fallbackEntries;
  const r = runtime.device.createBindGroup({
    label: 'shadow-material-bg',
    layout: pipelineState.materialBindGroupLayout,
    entries: merged,
  });
  if (!r.ok) {
    runtime.errorRegistry.fire(r.error);
    return null;
  }
  c.bindGroupCounts.createBindGroup += 1;
  c.bindGroupCounts.keys.push('shadow-material-singleton');
  frameState.singletonMaterialCache.set('shadow-material-singleton', r.value);
  return r.value;
}

/**
 * feat-20260625-spot-light-shadow-mapping M2 / w11 (D-1 + D-2). Records the
 * spot-light shadow caster passes — one render pass per castShadow spot (cap 4)
 * — that write each spot's perspective depth into its `spotShadowDepth` atlas
 * tile. Driven by the URP `addSpotShadowPass` graph closure; reads
 * `frameState.spotShadowSnapshots`.
 *
 * Per spot with `shadowAtlasTile >= 0` (castShadow + non-degenerate dir + not
 * clipped) and a valid `lightViewProj`:
 *   (1) Write the spot perspective matrix into `shadowCasterCascadeBuffer`
 *       (D-1: spotLightViewProj lane at byte 16) and set `isSpot = 1` so the
 *       shadow_caster vertex shader routes through the spot matrix instead of
 *       the directional `view.lightViewProj_A..D` slots. The per-pass
 *       independent command encoder + queue.submit serialize each host write
 *       against that pass's GPU read.
 *   (2) Open an INDEPENDENT command encoder targeting the spotShadowDepth view
 *       with `depthLoadOp = (first valid tile ? clear : load)` — independent
 *       clear counting decoupled from the directional cascadeIndex (D-2). Set a
 *       per-tile viewport (col = tile % 2, row = tile / 2).
 *   (3) Reuse the vertex-only `forgeax::default-shadow-caster` PSO + the cached
 *       `view-shadow` BG + `shadow-material-singleton` + meshBindGroup built by
 *       recordShadowPass (or built on-demand here when no directional shadow
 *       ran this frame).
 *
 * AC-03 zero-shadow zero-pass: early-returns when no spot has a valid tile, so
 * castShadow:false scenes (all tile=-1) record zero spot passes. After the
 * loop, `isSpot` is reset to 0 so the next directional cascade pass (or next
 * frame) sees the directional routing.
 */
export function recordSpotShadowPass(c: _InternalRenderPipelineContext): void {
  const { runtime, frameState, meshBindGroup, pipelineState } = c;
  const snapshots = frameState.spotShadowSnapshots;
  // AC-03: skip entirely when no spot projects a shadow this frame.
  const casters = snapshots.filter((s) => s.shadowAtlasTile >= 0 && s.lightViewProj !== undefined);
  if (casters.length === 0) return;
  if (meshBindGroup === null) return;

  const shadowPipeline =
    runtime.getMaterialShaderPipeline?.(
      'forgeax::default-shadow-caster',
      false,
      undefined,
      'triangle-list',
      undefined,
      undefined,
      'shadow-caster',
    ) ?? null;
  if (shadowPipeline === null) return;

  const spotView =
    (frameState.perFrameGraph?.getColorTargetView('spotShadowDepth') as TextureView | undefined) ??
    null;
  if (spotView === null) return;

  const shadowViewBg = ensureSpotShadowViewBg(c);
  const shadowMaterialBg = ensureSpotShadowMaterialBg(c);
  if (shadowViewBg === null || shadowMaterialBg === null) return;

  const tileCtx: SpotTileContext = {
    spotView,
    shadowViewBg,
    shadowMaterialBg,
    shadowPipeline,
    meshBindGroup,
    tileSize: pipelineState.perPassResources.shadowMapSize,
  };

  let clearedAtlas = false;
  for (let ci = 0; ci < casters.length; ci++) {
    const snap = casters[ci];
    if (snap === undefined || snap.lightViewProj === undefined) continue;
    if (recordSpotTile(c, snap.lightViewProj, snap.shadowAtlasTile, clearedAtlas, tileCtx)) {
      clearedAtlas = true;
    }
  }

  // Reset isSpot so the next directional cascade pass / next frame routes
  // through view.lightViewProj_A..D again (D-1).
  const resetPayload = new Uint32Array([0, 0, 0, 0]);
  const resetWrite = runtime.device.queue.writeBuffer(
    pipelineState.shadowCasterCascadeBuffer,
    0,
    resetPayload,
  );
  if (!resetWrite.ok) runtime.errorRegistry.fire(resetWrite.error);
}

/** Per-tile resources shared across the spot caster passes in one frame. */
interface SpotTileContext {
  readonly spotView: TextureView;
  readonly shadowViewBg: BindGroup;
  readonly shadowMaterialBg: BindGroup;
  readonly shadowPipeline: NonNullable<
    ReturnType<NonNullable<_InternalRenderPipelineContext['runtime']['getMaterialShaderPipeline']>>
  >;
  readonly meshBindGroup: BindGroup;
  readonly tileSize: number;
}

/**
 * Render one spot's perspective depth into its atlas tile. Writes isSpot=1 +
 * the spot matrix into the cascade UBO (D-1), opens an independent encoder with
 * a per-tile viewport, and clears the atlas on the first tile / loads on the
 * rest (D-2). Returns true when this pass cleared the atlas (so the caller
 * tracks the clear/load boundary). Errors fire to the registry and return the
 * incoming `alreadyCleared` unchanged.
 */
function recordSpotTile(
  c: _InternalRenderPipelineContext,
  lightViewProj: Float32Array,
  tile: number,
  alreadyCleared: boolean,
  ctx: SpotTileContext,
): boolean {
  const { runtime, pipelineState } = c;
  // D-1: cascade UBO byte offset of the spotLightViewProj mat4 lane (16 B for
  // index/isSpot/2pad vec4, then the mat4). isSpot lane is u32 word 1.
  const SPOT_LVP_OFFSET = 16;

  const headerWrite = runtime.device.queue.writeBuffer(
    pipelineState.shadowCasterCascadeBuffer,
    0,
    new Uint32Array([0, 1, 0, 0]), // index=0, isSpot=1, pad
  );
  if (!headerWrite.ok) {
    runtime.errorRegistry.fire(headerWrite.error);
    return alreadyCleared;
  }
  const matWrite = runtime.device.queue.writeBuffer(
    pipelineState.shadowCasterCascadeBuffer,
    SPOT_LVP_OFFSET,
    lightViewProj,
  );
  if (!matWrite.ok) {
    runtime.errorRegistry.fire(matWrite.error);
    return alreadyCleared;
  }

  const encResult = runtime.device.createCommandEncoder({ label: `spot-shadow-tile${tile}` });
  if (!encResult.ok) {
    runtime.errorRegistry.fire(encResult.error);
    return alreadyCleared;
  }
  const enc = encResult.value;
  const pass: RhiRenderPassEncoder = enc.beginRenderPass(
    buildBeginRenderPassDescriptor(
      { colorFormats: [], depthFormat: 'depth32float', sampleCount: 1 },
      { colorViews: [], depthView: ctx.spotView },
      'shadow-caster',
      { depthLoadOp: alreadyCleared ? 'load' : 'clear' },
    ) as never,
  );

  pass.setPipeline(ctx.shadowPipeline);
  const col = tile % 2;
  const row = Math.floor(tile / 2);
  pass.setViewport(col * ctx.tileSize, row * ctx.tileSize, ctx.tileSize, ctx.tileSize, 0, 1);
  pass.setBindGroup(0, ctx.shadowViewBg);
  pass.setBindGroup(1, ctx.shadowMaterialBg, [0]);
  recordSpotShadowGeometry(c, pass, ctx.meshBindGroup);

  pass.end();
  const finishResult = enc.finish();
  if (!finishResult.ok) {
    runtime.errorRegistry.fire(finishResult.error);
    return alreadyCleared;
  }
  const submitResult = runtime.device.queue.submit([finishResult.value]);
  if (!submitResult.ok) runtime.errorRegistry.fire(submitResult.error);
  return true;
}

/**
 * Walk the validated renderables and emit shadow-caster draws for the current
 * spot tile pass. Triangle topologies only (line/point meshes cast no shadow).
 * Reuses the per-entity instance BGs cached by recordShadowPass; falls back to
 * the identity instance buffer when none is cached.
 */
function recordSpotShadowGeometry(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  meshBindGroup: BindGroup,
): void {
  const { frameState, validated, pipelineState } = c;
  let lastVB: GpuBuffer | null = null;
  let lastIB: GpuBuffer | null = null;
  for (let ei = 0; ei < validated.length; ei++) {
    const entry = validated[ei];
    if (entry === undefined) continue;
    const submeshes = entry.mesh.submeshes;
    const hasTriangle = submeshes.some(
      (sm) => sm.topology === 'triangle-list' || sm.topology === 'triangle-strip',
    );
    if (!hasTriangle) continue;
    if (entry.mesh.vertexBuffer !== lastVB) {
      pass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
      lastVB = entry.mesh.vertexBuffer;
    }
    if (entry.mesh.indexed && entry.mesh.indexBuffer !== lastIB && entry.mesh.indexBuffer) {
      pass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
      lastIB = entry.mesh.indexBuffer;
    }
    pass.setBindGroup(2, meshBindGroup, [ei * MESH_PER_ENTITY_STRIDE]);
    const inst = entry.source.instances;
    let instCount = 1;
    let instBufferKey: object = pipelineState.identityInstanceBuffer as unknown as object;
    if (inst !== undefined) {
      const cached = frameState.instanceBuffers.get(
        worldEntityKey(entry.source.worldId, inst.cacheKey),
      );
      if (
        cached !== undefined &&
        cached.uploadedArchVersion === inst.archVersion &&
        cached.uploadedByteLength === inst.transforms.byteLength
      ) {
        instBufferKey = cached.buffer.handle as unknown as object;
        instCount = Math.max(1, inst.instanceCount);
      }
    }
    const spotInstLeaf = frameState.instancesBgPerEntity
      .get(worldEntityKey(entry.source.worldId, entry.source.entityKey))
      ?.get(instBufferKey) as Map<string, BindGroup> | undefined;
    const cachedInstBg = spotInstLeaf?.get('shadow-instances');
    if (cachedInstBg === undefined) continue;
    pass.setBindGroup(3, cachedInstBg);
    for (const sm of submeshes) {
      if (sm.topology !== 'triangle-list' && sm.topology !== 'triangle-strip') continue;
      if (entry.mesh.indexed) {
        pass.drawIndexed(sm.indexCount, instCount, sm.indexOffset, 0, 0);
      } else {
        pass.draw(sm.vertexCount, instCount, 0, 0);
      }
    }
  }
}
