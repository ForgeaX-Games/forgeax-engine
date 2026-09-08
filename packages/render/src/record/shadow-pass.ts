import {
  type BindGroup,
  type BindGroupEntry,
  type Buffer,
  type RenderPipeline,
  RhiError,
  type RhiQueue,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import type { PassSelector } from '@forgeax/engine-types';
import { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { assembleMaterialWithSkylightEntries } from '../ibl/skylight-bind-group';
import type { InstanceBufferCacheEntry } from '../instance-buffer-cache';
import { buildPbrMaterialUserRegionEntries } from '../pbr-pipeline';
import type { DispatchEntry, ExtractedLights } from '../render-system-extract';
import { matchPass } from '../systems/pass-selector';
import { worldEntityKey } from './frame-snapshot';
import {
  getOrCreateFromChain,
  getOrCreatePerEntity,
  MAX_UNIFORM_INSTANCES,
  MESH_PER_ENTITY_STRIDE,
  packInstanceStorageBuffer,
} from './mesh-ssbo';
import type { _InternalRenderPipelineContext } from './render-context';
import { STANDARD_PBR_UBO_SIZE } from './render-context';
import { POINTS_LINES_VIEW_BYTES, pointShadowViewOffset, VIEW_UNIFORM_BYTES } from './view-ubo';

export const SHADOW_CASTER_SLOT_STRIDE = 256;
export const SHADOW_CASTER_BUFFER_SIZE = SHADOW_CASTER_SLOT_STRIDE * 8;

export function directionalShadowCasterOffset(cascadeIndex: number): number {
  return SHADOW_CASTER_SLOT_STRIDE * cascadeIndex;
}

export function spotShadowCasterOffset(tile: number): number {
  return SHADOW_CASTER_SLOT_STRIDE * (4 + tile);
}

export function writeShadowCasterUniforms(
  queue: RhiQueue,
  buffer: Buffer,
  lights: ExtractedLights,
): void {
  for (let cascade = 0; cascade < 4; cascade += 1) {
    const written = queue.writeBuffer(
      buffer,
      directionalShadowCasterOffset(cascade),
      new Uint32Array([cascade, 0, 0, 0]),
    );
    if (!written.ok) throw written.error;
  }
  for (const snapshot of lights.spot) {
    const tile = snapshot.shadowAtlasTile;
    if (tile < 0 || tile >= 4 || snapshot.lightViewProj === undefined) continue;
    const offset = spotShadowCasterOffset(tile);
    const header = queue.writeBuffer(buffer, offset, new Uint32Array([0, 1, 0, 0]));
    if (!header.ok) throw header.error;
    const matrix = queue.writeBuffer(buffer, offset + 16, snapshot.lightViewProj);
    if (!matrix.ok) throw matrix.error;
  }
}

function ensureTypedShadowViewBg(
  c: _InternalRenderPipelineContext,
  viewOffset: number,
  cascadeOffset: number,
  variant: string,
): BindGroup | null {
  const { runtime, frameState, pipelineState } = c;
  const shadowSampler = pipelineState.perPassResources.shadowSampler;
  if (shadowSampler === null) return null;
  try {
    return getOrCreateFromChain(
      frameState.viewBindGroupCache,
      [
        pipelineState.viewUniformBuffer,
        pipelineState.pointLightsBuffer,
        pipelineState.spotLightsBuffer,
        pipelineState.shadowFallbackTextureView,
        shadowSampler,
        pipelineState.shadowAtlasFallbackTextureView,
        pipelineState.shadowParamsBuffer,
        pipelineState.shadowCasterCascadeBuffer,
        pipelineState.shadowFallbackTextureView,
        pipelineState.pointsLinesViewBuffer ?? pipelineState.viewUniformBuffer,
      ],
      variant,
      () => {
        const created = runtime.device.createBindGroup({
          label: variant,
          layout: pipelineState.viewBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: pipelineState.viewUniformBuffer,
                  offset: viewOffset,
                  size: VIEW_UNIFORM_BYTES,
                },
              },
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
              resource: { kind: 'sampler', value: shadowSampler },
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
                value: {
                  buffer: pipelineState.shadowCasterCascadeBuffer,
                  offset: cascadeOffset,
                  size: POINTS_LINES_VIEW_BYTES,
                },
              },
            },
            {
              binding: 8,
              resource: { kind: 'textureView', value: pipelineState.shadowFallbackTextureView },
            },
            {
              binding: 10,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: pipelineState.pointsLinesViewBuffer ?? pipelineState.viewUniformBuffer,
                  size: 80,
                },
              },
            },
          ],
        });
        if (!created.ok) throw created.error;
        return created.value;
      },
      c.bindGroupCounts,
    );
  } catch (error) {
    if (error instanceof RhiError) {
      runtime.errorRegistry.fire(error);
      return null;
    }
    throw error;
  }
}

function shadowShaderMap(c: _InternalRenderPipelineContext): ReadonlyMap<number, string> {
  const shaders = new Map<number, string>();
  for (const entry of c.dispatch) {
    if (entry.tags.LightMode === 'ShadowCaster' && entry.materialShaderId !== undefined) {
      shaders.set(entry.renderableIndex, entry.materialShaderId);
    }
  }
  return shaders;
}

function shadowPipeline(c: _InternalRenderPipelineContext): RenderPipeline | null {
  return (
    c.runtime.getMaterialShaderPipeline?.(
      'forgeax::default-shadow-caster',
      false,
      undefined,
      'triangle-list',
      undefined,
      undefined,
      'shadow-caster',
    ) ?? null
  );
}

export function encodeDirectionalShadowPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  cascadeIndex: number,
  viewport: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
): void {
  if (c.directionalShadowCacheReuse || c.meshBindGroup === null) return;
  const pipeline = shadowPipeline(c);
  const viewBg = ensureTypedShadowViewBg(
    c,
    0,
    directionalShadowCasterOffset(cascadeIndex),
    `view-shadow-directional-${cascadeIndex}`,
  );
  const materialBg = ensureSpotShadowMaterialBg(c);
  if (pipeline === null || viewBg === null || materialBg === null) return;
  c.frameState.directionalShadowCacheRecorded = true;
  pass.setViewport(viewport.x, viewport.y, viewport.w, viewport.h, 0, 1);
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, viewBg, [0]);
  pass.setBindGroup(1, materialBg, [0]);
  recordShadowCasterDraws(
    c,
    pass,
    pipeline,
    c.meshBindGroup,
    buildMatchedRenderableIndices(c.dispatch, { LightMode: ['ShadowCaster'] }),
    shadowShaderMap(c),
  );
}

export function encodePointShadowPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  snapshotIndex: number,
  face: number,
): void {
  const snapshot = c.frameState.pointShadowSnapshots[snapshotIndex];
  if (snapshot === undefined || c.meshBindGroup === null) return;
  const pipeline = shadowPipeline(c);
  const viewBg = ensureTypedShadowViewBg(
    c,
    pointShadowViewOffset(snapshot.shadowAtlasLayer, face),
    0,
    `view-shadow-point-${snapshot.shadowAtlasLayer}-${face}`,
  );
  const materialBg = ensureSpotShadowMaterialBg(c);
  if (pipeline === null || viewBg === null || materialBg === null) return;
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, viewBg, [0]);
  pass.setBindGroup(1, materialBg, [0]);
  recordShadowCasterDraws(
    c,
    pass,
    pipeline,
    c.meshBindGroup,
    buildMatchedRenderableIndices(c.dispatch, { LightMode: ['ShadowCaster'] }),
    shadowShaderMap(c),
  );
}

export function encodeSpotShadowPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  snapshotIndex: number,
): void {
  const snapshot = c.frameState.spotShadowSnapshots.filter(
    (candidate) => candidate.shadowAtlasTile >= 0 && candidate.lightViewProj !== undefined,
  )[snapshotIndex];
  if (
    snapshot === undefined ||
    snapshot.shadowAtlasTile < 0 ||
    snapshot.lightViewProj === undefined ||
    c.meshBindGroup === null
  ) {
    return;
  }
  const pipeline = shadowPipeline(c);
  const viewBg = ensureTypedShadowViewBg(
    c,
    0,
    spotShadowCasterOffset(snapshot.shadowAtlasTile),
    `view-shadow-spot-${snapshot.shadowAtlasTile}`,
  );
  const materialBg = ensureSpotShadowMaterialBg(c);
  if (pipeline === null || viewBg === null || materialBg === null) return;
  const tileSize = c.pipelineState.perPassResources.shadowMapSize;
  const tile = snapshot.shadowAtlasTile;
  pass.setViewport(
    (tile % 2) * tileSize,
    Math.floor(tile / 2) * tileSize,
    tileSize,
    tileSize,
    0,
    1,
  );
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, viewBg, [0]);
  pass.setBindGroup(1, materialBg, [0]);
  // Reuse the shared caster recorder. The compact spot-only loop used to
  // depend on instance bindings created by a directional pass, so a scene
  // containing only a SpotLight opened the atlas pass but emitted no caster
  // draws.
  recordShadowCasterDraws(
    c,
    pass,
    pipeline,
    c.meshBindGroup,
    buildMatchedRenderableIndices(c.dispatch, { LightMode: ['ShadowCaster'] }),
    shadowShaderMap(c),
  );
}

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
 * Build the material handles whose dispatch entries match a graph pass.
 *
 * A renderable can own more than one material pass, so renderable-level
 * filtering is insufficient for geometry recording: a Deferred graph pass
 * must not draw the same renderable's Forward-only material.  Keep the
 * renderable key in the result so mixed-material meshes retain their
 * per-submesh routing.
 */
export function buildMatchedMaterialHandlesByRenderable(
  dispatch: readonly DispatchEntry[],
  selector: PassSelector,
): ReadonlyMap<number, ReadonlySet<number>> | null {
  if (dispatch.length === 0) return null;
  const matched = filterDispatchBySelector(dispatch, selector);
  const handlesByRenderable = new Map<number, Set<number>>();
  for (const entry of matched) {
    const handles = handlesByRenderable.get(entry.renderableIndex);
    if (handles === undefined) {
      handlesByRenderable.set(entry.renderableIndex, new Set([entry.materialHandle]));
    } else {
      handles.add(entry.materialHandle);
    }
  }
  return handlesByRenderable;
}

/**
 * feat-20260704 M3/w20: per-entity directional shadow-caster draw loop,
 * extracted verbatim from {@link encodeDirectionalShadowPass}. Walks `c.validatedOrdered`,
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
  const { runtime, pipelineState, validatedOrdered } = c;
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

  for (let i = 0; i < validatedOrdered.length; i++) {
    const entry = validatedOrdered[i];
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
          ? GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST
          : GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST;
        const instancePayload = uniformFallback
          ? shadowInst.transforms
          : packInstanceStorageBuffer(shadowInst.transforms);
        const requestedBytes = instancePayload.byteLength;
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
            instancePayload,
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
 * Build (or reuse) the dummy `shadow-material-singleton` @group(1) BG for the
 * spot shadow caster pass. The vertex-only shadow_caster shader never consumes
 * @group(1) but the PSO's BGL must validate. Reuses the same singleton Map
 * entry encodeDirectionalShadowPass / encodePointShadowPass write so the three paths share
 * one allocation per frame (D-6).
 */
function ensureSpotShadowMaterialBg(c: _InternalRenderPipelineContext): BindGroup | null {
  const { runtime, frameState, pipelineState } = c;
  const cached = frameState.singletonMaterialCache.get('shadow-material-singleton');
  if (cached !== undefined) return cached;
  const fb = pipelineState.skylightFallback;
  const fallbackEntries: BindGroupEntry[] = buildPbrMaterialUserRegionEntries().map((entry) => {
    if (entry.buffer !== undefined) {
      return {
        binding: entry.binding,
        resource: {
          kind: 'buffer' as const,
          value: {
            buffer: pipelineState.materialUniformBuffer.buffer,
            offset: 0,
            size: STANDARD_PBR_UBO_SIZE,
          },
        },
      };
    }
    if (entry.sampler !== undefined) {
      return {
        binding: entry.binding,
        resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
      };
    }
    return {
      binding: entry.binding,
      resource: {
        kind: 'textureView' as const,
        value:
          entry.binding === 6
            ? pipelineState.defaultNormalTextureView
            : pipelineState.fallbackTextureView,
      },
    };
  });
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
