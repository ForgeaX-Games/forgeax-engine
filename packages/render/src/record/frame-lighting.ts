// @forgeax/engine-runtime - RenderSystem record stage: per-frame lighting.
// feat-20260704 M5/w31: further-split from frame.ts (AC-05 <=1500 lines/file).
// Pure leaf helpers invoked once each from recordFrame; behavior verbatim.

import { mat4, vec3 } from '@forgeax/engine-math';
import { type BindGroup, RhiError, type TextureView } from '@forgeax/engine-rhi';
import { bin } from '../cluster-binner';
import {
  HdrpIndexListOverflowError,
  HdrpLightBudgetExceededError,
  PointShadowAtlasBoundsViolationError,
  PointShadowAtlasUninitializedError,
} from '../errors/render';
import {
  createHdrpUnifiedBindGroup,
  getOrCreateHdrpBuffers,
  HDRP_UNIFORM_LIGHT_CAPACITY,
  packClusterUniform,
} from '../hdrp-buffers';
import { LIGHT_INDEX_LIST_CAPACITY } from '../hdrp-pipeline';
import {
  LIGHT_ARRAY_HEADER_BYTES,
  LIGHT_ARRAY_MAX_SLOTS,
  POINT_LIGHT_STD430_BYTES,
  packLightArrayHeader,
  packLightSlot,
  packPointLight,
  packSpotLight,
  SPOT_LIGHT_STD430_BYTES,
} from '../light-buffer-layout';
import type { PipelineState, RenderSystemInternals } from '../render-system';
import type {
  CameraSnapshot,
  DirectionalLightSnapshot,
  ExtractedLights,
  RenderableSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
} from '../render-system-extract';
import { ShadowAtlas } from '../shadow-atlas';
import { getOrCreateSsaoBuffers } from '../ssao-buffers';

import type { BindGroupCounts, RenderFrameState } from './frame-snapshot';
import {
  computeProjectionMatrix,
  computeViewMatrix,
  isLitMaterialSnapshot,
  warnMultiLightDirectional,
  warnMultiLightPoint,
  warnMultiLightSpot,
} from './helpers';
import { getOrCreateFromChain, MESH_SSBO_BYTES, MESH_UBO_FULL_ARRAY_BYTES } from './mesh-ssbo';

/**
 * feat-20260704 M3/w18: per-frame bind-group cache resolution, extracted
 * verbatim from `recordFrame`. Walks the handle-identity WeakMap caches
 * (feat-20260531 M2 + feat-20260622 M3) to resolve or lazily create the view
 * (@group 0), mesh (@group 2), and — when HDRP is active — HDRP-unified cluster
 * bind groups. Returns all three (null when `hasValidated` is false, the Case E
 * clear-pass-only path). No new mutable state: `bindGroupCounts` accounting +
 * cache maps are threaded through explicitly.
 *
 * @internal
 */
export function buildPerFrameBindGroups(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  hasValidated: boolean,
  bindGroupCounts: BindGroupCounts,
): {
  viewBindGroup: BindGroup | null;
  meshBindGroup: BindGroup | null;
  hdrpClusterBindGroup: BindGroup | null;
} {
  // View main (#1) chain = b0(viewUniformBuffer), b1(pointLightsBuffer),
  // b2(spotLightsBuffer), b3(graph shadowDepth view or
  // shadowFallbackTextureView), b4(shadowSampler), b5(atlas view), b6
  // (shadowParams); variant 'view-main'.
  // Mesh (#2) chain = inner b0 buffer (meshStorageBuffer.buffer); variant 'mesh'.
  let viewBindGroup: BindGroup | null = null;
  let meshBindGroup: BindGroup | null = null;
  // feat-20260609-hdrp-cluster-fragment-ggx M4 / w19: HDRP unified group(2)
  // BindGroup. Non-null when `frameState.isHdrpActive` AND HDRP buffer
  // allocation succeeded; consumed by recordMainPass at `setBindGroup(2, ...)`.
  let hdrpClusterBindGroup: BindGroup | null = null;
  if (hasValidated) {
    // M5-T1: shadow atlas view sourced directly from render-graph
    // (`addColorTarget('shadowDepth', ...)` declared in `urp-pipeline.ts`).
    // Graph owns the texture lifecycle; record-stage reads the resolved
    // view each frame (D-2 SSOT). When the graph has not allocated the
    // target (castShadow:false or shadowMapSize=0),
    // `getColorTargetView` returns undefined and we fall through to the
    // 1x1 fallback view that keeps the BGL satisfied.
    const graphShadowView = frameState.perFrameGraph?.getColorTargetView('shadowDepth') as
      | TextureView
      | undefined;
    const b3View =
      graphShadowView !== undefined ? graphShadowView : pipelineState.shadowFallbackTextureView;
    // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: bind the real
    // ShadowAtlas cube_array view when point shadows are active in this
    // frame; otherwise the 1x1x6 fallback (cleared to 1.0 = fully lit).
    const pointShadowAtlas = frameState.pointShadowAtlas;
    const atlasViewMaybe = pointShadowAtlas?.isAllocated() ? pointShadowAtlas.getAtlasView() : null;
    const b5View =
      atlasViewMaybe !== null ? atlasViewMaybe : pipelineState.shadowAtlasFallbackTextureView;
    // feat-20260625-spot-light-shadow-mapping M2 / w21 (D-1 fragment side +
    // D-5): bind the real `spotShadowDepth` 2D atlas view (graph-owned) when
    // spot shadows run this frame; otherwise the 1x1 depth fallback cleared to
    // 1.0 (fully lit) — same `texture_depth_2d` shape as binding 3, so it
    // satisfies the BGL without a dedicated spot fallback allocation. binding
    // 9 always binds the real spotLightViewProj UBO (zeroed lanes are safe via
    // the shadowAtlasTile >= 0 shader gate).
    const graphSpotShadowView = frameState.perFrameGraph?.getColorTargetView('spotShadowDepth') as
      | TextureView
      | undefined;
    const b8View =
      graphSpotShadowView !== undefined
        ? graphSpotShadowView
        : pipelineState.shadowFallbackTextureView;
    viewBindGroup = getOrCreateFromChain(
      frameState.viewBindGroupCache,
      [
        pipelineState.viewUniformBuffer,
        pipelineState.pointLightsBuffer,
        pipelineState.spotLightsBuffer,
        b3View,
        pipelineState.perPassResources.shadowSampler,
        b5View,
        pipelineState.shadowParamsBuffer,
        b8View,
      ],
      'view-main',
      () => {
        const viewBindGroupResult = internals.device.createBindGroup({
          label: 'pbr-view-bg',
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
              resource: {
                kind: 'textureView',
                value: b3View,
              },
            },
            {
              binding: 4,
              resource: {
                kind: 'sampler',
                value: pipelineState.perPassResources.shadowSampler,
              },
            },
            // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1:
            // cube_array shadow atlas view (real ShadowAtlas when point
            // shadows are active; else 1x1x6 fallback).
            {
              binding: 5,
              resource: {
                kind: 'textureView',
                value: b5View,
              },
            },
            // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1:
            // shadowParams UBO (`array<vec4<f32>, 4>` = 64 B). Lane N
            // stores `(near, far, 1/(far-near), 0)` for the point light
            // with shadowAtlasLayer === N. Updated per frame from
            // `pointShadowSnapshots` below.
            {
              binding: 6,
              resource: {
                kind: 'buffer',
                value: { buffer: pipelineState.shadowParamsBuffer },
              },
            },
            // feat-20260613-csm-cascaded-shadow-maps M5 / w28 (rebased to
            // binding 7 on 2026-06-13 to make room for point-shadow 5/6):
            // forward shaders declare binding 7 in common.wgsl (shared
            // view BGL) but never reference it; only shadow_caster.wgsl
            // reads it. Host writes a stable singleton buffer so every
            // forward bind group entry stays populated.
            {
              binding: 7,
              resource: {
                kind: 'buffer',
                value: { buffer: pipelineState.shadowCasterCascadeBuffer },
              },
            },
            // feat-20260625-spot-light-shadow-mapping M3 / w21 (D-5):
            // spot shadow 2D atlas (real spotShadowDepth view when spot
            // shadows run this frame, else the 1x1 depth fallback). Always-on.
            {
              binding: 8,
              resource: {
                kind: 'textureView',
                value: b8View,
              },
            },
            // feat-20260625-spot-light-shadow-mapping w25: the per-spot
            // fragment-read lightViewProj matrices fold into the View UBO
            // (binding 0, `view.spotLightViewProj`) — no standalone binding 9
            // (WebGL2 fragment uniform-buffer budget). binding 8 is the last.
          ],
        });
        if (!viewBindGroupResult.ok) throw viewBindGroupResult.error;
        return viewBindGroupResult.value;
      },
      bindGroupCounts,
    );

    // M3 / w10 (D-3 hard constraint): use the inner `.buffer` as the
    // WeakMap chain key so the cache tracks the underlying GPU buffer
    // identity. The wrapper object's identity is stable across grow
    // events; using the wrapper would defeat AC-07 cache invalidation.
    meshBindGroup = getOrCreateFromChain(
      frameState.meshBindGroupCache,
      [pipelineState.meshStorageBuffer.buffer],
      'mesh',
      () => {
        // bug-20260610: WebGL2 fallback path needs the binding to cover the
        // whole `array<Mesh, 128>` uniform buffer (14336 B) instead of a
        // single dynamic-offset slot (112 B). `caps.storageBuffer === false`
        // is the same proxy createRenderer uses to pick the uniform variant.
        const meshBindSize = internals.device.caps.storageBuffer
          ? MESH_SSBO_BYTES
          : MESH_UBO_FULL_ARRAY_BYTES;
        const meshBindGroupResult = internals.device.createBindGroup({
          label: 'pbr-mesh-bg',
          layout: pipelineState.meshBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: pipelineState.meshStorageBuffer.buffer,
                  offset: 0,
                  size: meshBindSize,
                },
              },
            },
          ],
        });
        if (!meshBindGroupResult.ok) throw meshBindGroupResult.error;
        return meshBindGroupResult.value;
      },
      bindGroupCounts,
    );

    // feat-20260609-hdrp-cluster-fragment-ggx M4 / w19: when HDRP is active,
    // build the unified group(2) BindGroup that carries the mesh SSBO at
    // binding 0 + the 4 cluster buffers at bindings 3..6. The bindGroup
    // shares the mesh SSBO with URP's `meshBindGroup` (same `meshStorageBuffer.buffer`
    // + same per-entity stride), so the dynamic offset issued at
    // `setBindGroup(2, ...)` covers binding 0 of either layout. Cached
    // alongside `meshBindGroupCache` keyed on the mesh SSBO + cluster
    // buffer identities; cache invalidates on a buffer-grow event the same
    // way the mesh path does (handle id rotation).
    if (frameState.isHdrpActive) {
      const hdrpBuffers = getOrCreateHdrpBuffers(
        internals,
        frameState.installedPipelineConfig?.clusterGrid,
      );
      if (hdrpBuffers !== null) {
        // D-3: buffer dimension uses the inner `.buffer` (same constraint
        // as the mesh path) so a grow event rotates the chain key.
        hdrpClusterBindGroup = getOrCreateFromChain(
          frameState.meshBindGroupCache,
          [
            pipelineState.meshStorageBuffer.buffer,
            hdrpBuffers.lightDataBuffer,
            hdrpBuffers.clusterGridBuffer,
            hdrpBuffers.lightIndexListBuffer,
            hdrpBuffers.clusterUniformBuffer,
          ],
          'hdrp-unified',
          () => {
            const bg = createHdrpUnifiedBindGroup(
              internals,
              hdrpBuffers,
              pipelineState.meshStorageBuffer.buffer,
            );
            if (bg === null) {
              throw new RhiError({
                code: 'webgpu-runtime-error',
                expected: 'HDRP unified BindGroup creation succeeds when HDRP is active',
                hint: 'inspect prior errorRegistry events for createBindGroup failure detail',
              });
            }
            return bg;
          },
          bindGroupCounts,
        );
      }
    }
  }
  return { viewBindGroup, meshBindGroup, hdrpClusterBindGroup };
}

/**
 * feat-20260704 M3/w18: per-frame lighting preparation, extracted verbatim from
 * `recordFrame`. (1) URP-only multi-light warn-once (directional / point / spot
 * over `LIGHT_ARRAY_MAX_SLOTS`; HDRP gated off — 256 SSBO lights). (2) pin the
 * point + spot shadow snapshot lists onto frameState for the URP shadow caster
 * pass closures + lazy-allocate the point-shadow cube_array atlas on first
 * non-empty frame (AC-09 zero-shadow zero-alloc). (3) destructure ExtractedLights
 * into the directional-fallback `light` (zero-intensity Case C default), point /
 * spot arrays, and totalLightCount.
 *
 * @internal
 */
export function prepareFrameLighting(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  lights: ExtractedLights,
): {
  light: DirectionalLightSnapshot;
  pointLights: ExtractedLights['point'];
  spotLights: ExtractedLights['spot'];
  totalLightCount: number;
} {
  if (lights.directionalCount > 1) {
    warnMultiLightDirectional(frameState, lights.directionalCount);
  }
  // feat-20260621-merge-directionallightshadow-into-directionallight M3 / m3-t2:
  // the AC-04/AC-22 "shadow disabled by missing component" once-warn is gone.
  // After merging DirectionalLightShadow into DirectionalLight there is no
  // orphan-shadow / missing-companion configuration to warn about -- castShadow
  // defaults true on the single component, so the warn condition can never
  // arise. The error class + RuntimeErrorCode member have been removed in M4 (m4-t2).

  // feat-20260608-cluster-lighting M6 / w23 (F-4 fix): URP-only multi-light
  // warn. HDRP supports 256 punctual lights via SSBO; the 4-slot first-slice
  // cap is irrelevant under HDRP, so gate on `!isHdrpActive` to silence noise.
  // Sibling tweak-20260608-rhi-hdr-renderable-caps-and-warn-once (#320)
  // extracted the warn into warnMultiLight{Point,Spot} helpers (warn-once
  // dedup); we keep the helpers and add the HDRP gate on top.
  if (!frameState.isHdrpActive) {
    if (lights.point.length > LIGHT_ARRAY_MAX_SLOTS) {
      warnMultiLightPoint(frameState, lights.point.length);
    }
    if (lights.spot.length > LIGHT_ARRAY_MAX_SLOTS) {
      warnMultiLightSpot(frameState, lights.spot.length);
    }
  }

  // feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-2 (plan-strategy §D-1):
  // project lights.pointShadow onto frameState so the URP point shadow caster
  // pass can read the snapshot list during graph execute. Lazy-allocate the
  // cube_array atlas on first non-empty frame; zero-shadow scenes never
  // touch the GPU here (AC-09). The snapshot list is stable for the
  // duration of recordFrame; the URP `addPointShadowPass` gate at
  // buildGraph time reads the same list to decide whether to insert the
  // shadow pass declaration into the graph.
  frameState.pointShadowSnapshots = lights.pointShadow;
  // feat-20260625-spot-light-shadow-mapping M2 / w9 (D-2): pin the spot
  // snapshots for the spotShadowDepth caster pass closure. The spot atlas is
  // a graph-owned color target (declared in urp-pipeline buildGraph), not a
  // runtime ShadowAtlas, so no allocation happens here — the graph compile
  // owns the depth texture lifetime. recordSpotShadowPass reads this list.
  frameState.spotShadowSnapshots = lights.spot;
  if (lights.pointShadow.length > 0) {
    if (frameState.pointShadowAtlas === null) {
      const firstSnap = lights.pointShadow[0];
      const faceSize = firstSnap?.mapSize ?? 512;
      frameState.pointShadowAtlas = new ShadowAtlas(internals.device, {
        faceSize,
        layers: 4,
      });
    }
    try {
      frameState.pointShadowAtlas.ensure();
    } catch (e) {
      if (
        e instanceof PointShadowAtlasUninitializedError ||
        e instanceof PointShadowAtlasBoundsViolationError
      ) {
        internals.errorRegistry.fire(e);
      } else {
        throw e;
      }
    }
  }

  // ExtractedLights three-arm consumption (R-10 preparation; M2 / w16):
  //
  //   - lights.directional : feeds the View UBO at slot [16..23]
  //                          (lightDir + lightColor; existing path).
  //   - lights.point[]     : packed into pointLightsBuffer (std430).
  //   - lights.spot[]      : packed into spotLightsBuffer (std430).
  //
  // Each variant carries the discriminant `kind` so the record-time packing
  // call sites can run exhaustive switch (charter P2 + AC-03).
  const directionalLight: DirectionalLightSnapshot | undefined = lights.directional;
  const pointLights = lights.point;
  const spotLights = lights.spot;

  // Case C: 0 DirectionalLight = legitimate scene; the View UBO falls
  // back to a zero-intensity directional payload so the shader's
  // `view.lightDir * view.lightColor` term contributes nothing
  // (physically-correct black under standard, untouched under unlit).
  const light: DirectionalLightSnapshot = directionalLight ?? {
    kind: 'directional' as const,
    direction: vec3.create(0, -1, 0),
    color: vec3.create(0, 0, 0),
    intensity: 0,
  };

  const totalLightCount =
    (directionalLight !== undefined ? 1 : 0) + pointLights.length + spotLights.length;

  return { light, pointLights, spotLights, totalLightCount };
}

/**
 * feat-20260704 M3/w18: per-frame full rewrite of the PointLight + SpotLight
 * std430 storage buffers, extracted verbatim from `recordFrame`.
 *
 * feat-20260519-light-casters-point-spot-pbr M3 / w20 (D-S1 + D-S2 + D-S6):
 * header (16 B count u32 + 12 B pad) at offset 0 + first-slice cap N=4 slots
 * packed sequentially. The N>4 fail-fast upstream ensures the counts are <= 4
 * when the listener registry consumed the structured error; the slice keeps
 * the buffer write bounded even if downstream listeners ignore the RhiError
 * (charter P9 graceful degradation: surplus entities dropped, frame records).
 *
 * @internal
 */
export function writePointSpotLightBuffers(
  internals: RenderSystemInternals,
  pipelineState: PipelineState,
  lights: ExtractedLights,
): void {
  const pointSlots = lights.point.slice(0, LIGHT_ARRAY_MAX_SLOTS);
  const pointHeader = packLightArrayHeader(pointSlots.length);
  const pointHeaderUpload = internals.device.queue.writeBuffer(
    pipelineState.pointLightsBuffer,
    0,
    new Uint8Array(pointHeader),
  );
  if (!pointHeaderUpload.ok) throw pointHeaderUpload.error;
  for (let i = 0; i < pointSlots.length; i++) {
    const slot = pointSlots[i];
    if (slot === undefined) continue;
    const packed = packPointLight(slot);
    const offset = LIGHT_ARRAY_HEADER_BYTES + i * POINT_LIGHT_STD430_BYTES;
    const writeRes = internals.device.queue.writeBuffer(
      pipelineState.pointLightsBuffer,
      offset,
      packed,
    );
    if (!writeRes.ok) throw writeRes.error;
  }
  const spotSlots = lights.spot.slice(0, LIGHT_ARRAY_MAX_SLOTS);
  const spotHeader = packLightArrayHeader(spotSlots.length);
  const spotHeaderUpload = internals.device.queue.writeBuffer(
    pipelineState.spotLightsBuffer,
    0,
    new Uint8Array(spotHeader),
  );
  if (!spotHeaderUpload.ok) throw spotHeaderUpload.error;
  for (let i = 0; i < spotSlots.length; i++) {
    const slot = spotSlots[i];
    if (slot === undefined) continue;
    const packed = packSpotLight(slot);
    const offset = LIGHT_ARRAY_HEADER_BYTES + i * SPOT_LIGHT_STD430_BYTES;
    const writeRes = internals.device.queue.writeBuffer(
      pipelineState.spotLightsBuffer,
      offset,
      packed,
    );
    if (!writeRes.ok) throw writeRes.error;
  }
}

/**
 * feat-20260704 M3/w18: write the point-shadow params UBO (bound at viewBg
 * binding 6), extracted verbatim from `recordFrame`.
 *
 * feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: 4 lanes x vec4<f32>;
 * lane[shadowAtlasLayer] = (near, far, 1/(far-near), 0). Lanes for non-shadow
 * slots stay zero (the WGSL sample path is gated by PointLight.shadowAtlasLayer
 * >= 0). Always writes the full 64 B so stale non-zero lanes from a previous
 * frame's allocation cannot poison the current frame.
 *
 * @internal
 */
export function writeShadowParamsBuffer(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
): void {
  const SHADOW_PARAMS_LANE_COUNT = 4;
  const SHADOW_PARAMS_FLOATS_PER_LANE = 4;
  const shadowParamsArr = new Float32Array(
    SHADOW_PARAMS_LANE_COUNT * SHADOW_PARAMS_FLOATS_PER_LANE,
  );
  for (let i = 0; i < frameState.pointShadowSnapshots.length; i++) {
    const ps = frameState.pointShadowSnapshots[i];
    if (ps === undefined) continue;
    const layer = ps.shadowAtlasLayer;
    if (layer < 0 || layer >= SHADOW_PARAMS_LANE_COUNT) continue;
    const base = layer * SHADOW_PARAMS_FLOATS_PER_LANE;
    const near = ps.nearPlane;
    const far = ps.farPlane;
    const invSpan = far > near ? 1 / (far - near) : 0;
    shadowParamsArr[base] = near;
    shadowParamsArr[base + 1] = far;
    shadowParamsArr[base + 2] = invSpan;
    shadowParamsArr[base + 3] = 0;
  }
  const shadowParamsWriteRes = internals.device.queue.writeBuffer(
    pipelineState.shadowParamsBuffer,
    0,
    shadowParamsArr,
  );
  if (!shadowParamsWriteRes.ok) {
    internals.errorRegistry.fire(shadowParamsWriteRes.error);
  }
}

/**
 * feat-20260704 M3/w18: zero-light standard-material once-warn, extracted
 * verbatim from `recordFrame`.
 *
 * feat-20260520-skylight-ibl-cubemap M4 / t27 (AC-10): fires once per
 * RenderSystem lifetime when the 0-light three-condition conjunction holds — no
 * Skylight, 0 direct light (totalLightCount === 0), AND at least one lit
 * (standard / PBR) material (which renders black with no light). A lit material
 * carries a materialShaderId !== 'forgeax::default-unlit'; the default mid-grey
 * unlit fallback has no materialShaderId, so the conjunction excludes both unlit
 * and default materials. Suppressed under NODE_ENV=production.
 *
 * @internal
 */
export function warnZeroLightStandard(
  frameState: RenderFrameState,
  renderables: readonly RenderableSnapshot[],
  skylight: SkylightSnapshot | undefined,
  totalLightCount: number,
): void {
  const hasStandardMaterial = renderables.some((r) => isLitMaterialSnapshot(r.material));
  if (
    skylight === undefined &&
    totalLightCount === 0 &&
    hasStandardMaterial &&
    !frameState.warnedZeroLightStandard
  ) {
    frameState.warnedZeroLightStandard = true;
    const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
    if (env?.env?.NODE_ENV !== 'production') {
      console.warn(
        '[forgeax] standard material renders black with 0 lights of any type (no Skylight, and directional + point + spot all empty); spawn at least one light (Skylight, DirectionalLight, PointLight, or SpotLight) or switch material to an unlit shader (Materials.unlit(...)). See AGENTS.md section Breaking changes 2026-05-19.',
      );
    }
  }
}

/**
 * feat-20260704 M3/w18: HDRP per-frame CPU cluster binning + light-data /
 * cluster-grid / light-index-list / cluster-uniform / SSAO uniform buffer
 * uploads. Extracted verbatim from `recordFrame`. Runs only when the HDRP
 * pipeline is active and there is at least one punctual light; otherwise it is
 * a no-op (URP / SSAO-off paths untouched).
 *
 * feat-20260608-cluster-lighting M5 / w21 + M6 / w23 + r2 fix-up: fail-soft
 * semantics preserved verbatim — index-list-overflow and light-budget-exceeded
 * fire once per frame (via `frameState.hdrpOncePerFrameFired`) and continue
 * rendering.
 *
 * @internal
 */
export function writeHdrpClusterAndSsaoBuffers(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  pointLights: ExtractedLights['point'],
  spotLights: ExtractedLights['spot'],
): void {
  const hdrpLightCount = pointLights.length + spotLights.length;
  if (!(frameState.isHdrpActive && hdrpLightCount > 0)) return;
  const HDRP_LIGHT_BUDGET = 256;
  let effectivePointLights = pointLights;
  let effectiveSpotLights = spotLights;
  if (hdrpLightCount > HDRP_LIGHT_BUDGET) {
    if (!frameState.hdrpOncePerFrameFired.has('hdrp-light-budget-exceeded')) {
      frameState.hdrpOncePerFrameFired.add('hdrp-light-budget-exceeded');
      internals.errorRegistry.fire(
        new HdrpLightBudgetExceededError(hdrpLightCount, HDRP_LIGHT_BUDGET),
      );
    }
    if (pointLights.length >= HDRP_LIGHT_BUDGET) {
      effectivePointLights = pointLights.slice(0, HDRP_LIGHT_BUDGET);
      effectiveSpotLights = [];
    } else {
      effectivePointLights = pointLights;
      effectiveSpotLights = spotLights.slice(0, HDRP_LIGHT_BUDGET - pointLights.length);
    }
  }

  const hdrpLights: Array<{ position: Float32Array; range: number }> = [];
  for (const pl of effectivePointLights) {
    const range =
      Number.isFinite(pl.invRangeSquared) && pl.invRangeSquared > 0
        ? Math.sqrt(1 / pl.invRangeSquared)
        : 1000;
    hdrpLights.push({ position: pl.position as unknown as Float32Array, range });
  }
  for (const sl of effectiveSpotLights) {
    const range =
      Number.isFinite(sl.invRangeSquared) && sl.invRangeSquared > 0
        ? Math.sqrt(1 / sl.invRangeSquared)
        : 1000;
    hdrpLights.push({ position: sl.position as unknown as Float32Array, range });
  }

  const clusterGrid = frameState.installedPipelineConfig?.clusterGrid ?? {
    x: 16,
    y: 9,
    z: 24,
  };
  const gridX = clusterGrid.x;
  const gridY = clusterGrid.y;
  const gridZ = clusterGrid.z;
  const clusterCount = gridX * gridY * gridZ;

  const projMatrix = computeProjectionMatrix(camera);
  const viewMatrix = computeViewMatrix(camera);

  const clusterGridBuf = new Uint32Array(clusterCount * 2);
  const lightIndexListBuf = new Uint32Array(LIGHT_INDEX_LIST_CAPACITY);

  const binResult = bin(
    hdrpLights as unknown as Array<{
      position: import('@forgeax/engine-math').Vec3;
      range: number;
    }>,
    viewMatrix,
    projMatrix,
    { x: gridX, y: gridY, z: gridZ },
    camera.near,
    camera.far,
    clusterGridBuf,
    lightIndexListBuf,
    LIGHT_INDEX_LIST_CAPACITY,
  );

  if (!binResult.ok && !frameState.hdrpOncePerFrameFired.has('hdrp-index-list-overflow')) {
    frameState.hdrpOncePerFrameFired.add('hdrp-index-list-overflow');
    const detail = binResult.error.detail;
    internals.errorRegistry.fire(new HdrpIndexListOverflowError(detail.actual, detail.capacity));
  }

  // Falsify injection point: FORGEAX_HDRP_FALSIFY_CLUSTER_GRID_ZERO
  // zeroes the cluster_grid buffer so every fragment culls every light.
  // Used by hello-hdrp-lighting smoke FALSIFY=cluster-grid-zero to
  // prove the smoke has discriminability (must FAIL vs baseline).
  // Read process via globalThis to keep this file @types/node-free.
  const envFalsify = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  if (envFalsify?.FORGEAX_HDRP_FALSIFY_CLUSTER_GRID_ZERO) {
    clusterGridBuf.fill(0);
  }

  const hdrpBuffers = getOrCreateHdrpBuffers(internals, clusterGrid);
  if (hdrpBuffers !== null) {
    const lightCapacity = hdrpBuffers.storageBuffer ? 256 : HDRP_UNIFORM_LIGHT_CAPACITY;
    const lightDataPayload = new Float32Array(lightCapacity * 16);
    let slotIdx = 0;
    for (const pl of effectivePointLights) {
      if (slotIdx >= lightCapacity) break;
      // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-4
      // (plan-strategy §D-8): thread the optional shadow info through
      // packLightSlot. PointLightSnapshot.shadowAtlasLayer is set by
      // extract's join pass when the entity carries PointLightShadow;
      // sentinel -1 means no shadow (unshadowed evalPoint path).
      const layer = pl.shadowAtlasLayer;
      const packed =
        layer !== undefined &&
        layer >= 0 &&
        pl.shadowNear !== undefined &&
        pl.shadowFar !== undefined
          ? packLightSlot(pl, {
              shadowAtlasLayer: layer,
              near: pl.shadowNear,
              far: pl.shadowFar,
            })
          : packLightSlot(pl);
      lightDataPayload.set(packed, slotIdx * 16);
      slotIdx += 1;
    }
    for (const sl of effectiveSpotLights) {
      if (slotIdx >= lightCapacity) break;
      const packed = packLightSlot(sl);
      lightDataPayload.set(packed, slotIdx * 16);
      slotIdx += 1;
    }
    const lightDataUpload = internals.device.queue.writeBuffer(
      hdrpBuffers.lightDataBuffer,
      0,
      lightDataPayload,
    );
    if (!lightDataUpload.ok) internals.errorRegistry.fire(lightDataUpload.error);

    if (hdrpBuffers.storageBuffer) {
      const clusterGridUpload = internals.device.queue.writeBuffer(
        hdrpBuffers.clusterGridBuffer,
        0,
        clusterGridBuf,
      );
      if (!clusterGridUpload.ok) internals.errorRegistry.fire(clusterGridUpload.error);

      const lightIndexListUpload = internals.device.queue.writeBuffer(
        hdrpBuffers.lightIndexListBuffer,
        0,
        lightIndexListBuf,
      );
      if (!lightIndexListUpload.ok) internals.errorRegistry.fire(lightIndexListUpload.error);
    }

    // scope-amend-webgl2-ubo: SSAO intensity is folded into the
    // cluster_uniform .w lane (formerly pad), removing the dedicated
    // @binding(9) UBO that pushed fragment-stage UBO count past
    // WebGL2's max_uniform_buffers_per_shader_stage=11. Disabled-SSAO
    // path writes 0 so `mix(1.0, ssao*ao, 0.0) = 1.0` in the lighting
    // shader (no PSO recompile across enable/disable).
    const clusterSsaoConfig = frameState.installedPipelineConfig?.ssao;
    const clusterSsaoIntensity =
      clusterSsaoConfig !== undefined && clusterSsaoConfig.enabled === true
        ? (clusterSsaoConfig.intensity ?? 1.0)
        : 0;
    const clusterUniformPayload = packClusterUniform(
      { x: gridX, y: gridY, z: gridZ },
      camera.near,
      camera.far,
      clusterSsaoIntensity,
      Math.min(effectivePointLights.length + effectiveSpotLights.length, lightCapacity),
    );
    const clusterUniformUpload = internals.device.queue.writeBuffer(
      hdrpBuffers.clusterUniformBuffer,
      0,
      new Uint8Array(clusterUniformPayload),
    );
    if (!clusterUniformUpload.ok) internals.errorRegistry.fire(clusterUniformUpload.error);
  }

  // ── feat-20260612-hdrp-ssao M1 / w6 + M7 / w33 ───────────────
  // Per-frame SSAO uniform write (plan-strategy D-1 + D-C):
  //   view + projection + inverseProjection at offsets 0/64/128 +
  //   intensityPad (vec4 — x=intensity, yzw padding) at offset 192;
  //   total 256 B (matches host SSAO_UNIFORM_BYTES + WGSL struct).
  // Single writeBuffer covers all four fields so one queue entry
  // updates the entire UBO.
  // Separate from View UBO (592 B invariant); does not affect
  // material PSO bytecode.
  //
  // Writes when HDRP is active; config.ssao?.enabled guard comes in
  // M4 / w19 after the config.ssao type narrowing is added.
  {
    const ssaoBufs = getOrCreateSsaoBuffers(internals);
    if (ssaoBufs !== null) {
      const sProj = computeProjectionMatrix(camera);
      const sView = computeViewMatrix(camera);
      // inverseProjection = inverse(projection): NDC -> view-space.
      const invProjOnly = mat4.create();
      mat4.invert(invProjOnly, sProj);

      // Float32Array of 64 (256 B): 3 mat4 (48) + intensityPad vec4 (4)
      // + 12 trailing padding floats. We only fill the declared region.
      const ssaoUniformPayload = new Float32Array(64);
      ssaoUniformPayload.set(sView as unknown as Float32Array, 0);
      ssaoUniformPayload.set(sProj as unknown as Float32Array, 16);
      ssaoUniformPayload.set(invProjOnly as unknown as Float32Array, 32);
      // intensityPad.x = config.ssao.intensity ?? 1.0 (LO 5.9 default).
      // yzw remain 0 from Float32Array zero-init.
      const ssaoConfig = frameState.installedPipelineConfig?.ssao;
      const intensity =
        ssaoConfig !== undefined && ssaoConfig.enabled === true
          ? (ssaoConfig.intensity ?? 1.0)
          : 1.0;
      ssaoUniformPayload[48] = intensity;

      const ssaoUniformRes = internals.device.queue.writeBuffer(
        ssaoBufs.uniformBuffer,
        0,
        ssaoUniformPayload,
      );
      if (!ssaoUniformRes.ok) internals.errorRegistry.fire(ssaoUniformRes.error);
    }
  }

  void binResult;
}

/**
 * feat-20260704 M3/w18: resolve `tonemapActive` + `skyboxActive` for this
 * frame, extracted verbatim from `recordFrame`.
 *
 * feat-20260519-tonemap-reinhard-mvp: tonemap is active when the camera carries
 * `tonemap !== 'none'` (routes geometry into the HDR offscreen target + a
 * fullscreen tonemap pass). feat-20260531-skybox-env-background M2 / w9: skybox
 * is active only when a SkyboxBackground entity is present AND tonemap is active
 * (hdrColor is only allocated on the tonemap path). M3 / w20: once-warn when
 * tonemap is 'none' but a skybox exists (config issue, not resource-timing —
 * no structured error). M3 / w18: skybox degrades to clear-colour for a frame
 * while its cubemap view is not yet resident (lazy equirect projection pending
 * / failed; the lazy trigger owns the fire-once-on-failed error).
 *
 * @internal
 */
export function resolveSkyboxActive(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  camera: CameraSnapshot,
  skybox: SkyboxSnapshot | undefined,
): { tonemapActive: boolean; skyboxActive: boolean } {
  const tonemapActive = camera.tonemap !== 'none';
  let skyboxActive = skybox !== undefined && tonemapActive;
  // feat-20260531-skybox-env-background M3 / w20: once-warn when camera
  // tonemap is 'none' but a SkyboxBackground entity exists. The skybox
  // pass requires the HDR render target allocated by the tonemap path;
  // without it the skybox is skipped for this frame. This is a config
  // issue, not a resource-timing issue -- don't fire a structured error
  // (plan-strategy D-2 NOTE, charter P3 non-silent).
  if (skybox !== undefined && !tonemapActive && !frameState.warnedSkyboxTonemapNone) {
    frameState.warnedSkyboxTonemapNone = true;
    console.warn(
      '[forgeax] SkyboxBackground: skybox requires tonemap active (camera.tonemap !== "none") to write HDR target. The skybox pass will be skipped for this frame.',
    );
  }
  // feat-20260531-skybox-env-background M3 / w18: degradation when cubemap
  // GPU view is not ready. getCubemapGpuView returns undefined if the
  // equirect-to-cube upload has not completed yet.
  if (skybox !== undefined && tonemapActive) {
    // biome-ignore lint/suspicious/noExplicitAny: branded Handle cast from snapshot raw number
    const cubemapView = internals.gpuStore.getCubemapGpuView(skybox.equirectHandle as any);
    if (cubemapView === undefined) {
      // The skybox reuses the Skylight's equirect handle; the cubemap
      // projection is driven lazily by the single trigger in `driveLazy
      // EquirectProjection` above (it owns the fire-and-forget launch AND the
      // fire-once-on-failed structured error). While the projection is
      // pending or has failed the cube view is not resident, so the skybox
      // pass degrades to the clear-colour background for this frame
      // (charter P3: it activates once the shared projection flips to
      // 'ready'). No error is fired here -- 'pending' is a normal transition
      // (firing per frame would flood the channel), and 'failed' is reported
      // once by the lazy trigger. (feat-20260630 M3 / w18.)
      skyboxActive = false;
    }
  }
  return { tonemapActive, skyboxActive };
}
