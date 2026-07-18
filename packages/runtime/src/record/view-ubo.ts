// @forgeax/engine-runtime - RenderSystem record stage: view-ubo.
// feat-20260704 M3/w18: the View UBO + CSM/spot-shadow matrix pack assembly
// extracted verbatim from `recordFrame` (frame.ts). Builds the 196-float View
// UBO payload (worldViewProj, directional light, camera pos, per-cascade
// lightViewProj matrices, split planes, shadow bias, folded spot lightViewProj
// lanes) and flushes it in one queue.writeBuffer round-trip. Kept as a
// standalone function so recordFrame stays an orchestration skeleton (D-2).

import { mat4 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import type {
  CameraSnapshot,
  DirectionalLightSnapshot,
  ExtractedLights,
  SpotLightSnapshot,
} from '../render-system-extract';
import { clampPcfKernelSize } from './frame-snapshot';
import { computeProjectionMatrix, computeViewMatrix } from './helpers';

/**
 * feat-20260704 M3/w18: assemble + upload the per-frame View UBO payload.
 *
 * feat-20260518 M3 / w14 (AC-07 / AC-09): builds the full view UBO payload.
 * Single queue.writeBuffer covers the whole payload (one round-trip per frame,
 * charter P5 consistent abstraction). Outgoing-direction convention
 * (DirectionalLight @semantics outgoing): the host uploads light.direction
 * verbatim; the shader negates it internally via
 * `let l = normalize(-view.lightDir)` to get the L vector for BRDF (single
 * SSOT, no double-negation).
 *
 * feat-20260520-directional-light-shadow-mapping M1b / w7 + feat-20260613-csm
 * M4 / w16+w25: viewPayload is 196 floats. Layout matches common.wgsl View
 * struct byte-for-byte:
 *   [ 0..15] worldViewProj, [16..18] lightDir, [20..22] lightColor,
 *   [24..26] cameraPos, [28..43] lightViewProj0 (was lightSpaceMatrix),
 *   [44..59] inverseViewProj, [60..75] lightViewProj1,
 *   [76..91] lightViewProj2, [92..107] lightViewProj3,
 *   [108]/[112]/[116]/[120] splitPlanes (vec4 stride),
 *   [124] cascadeCount, [125] cascadeBlend,
 *   [126] depthBias, [127] normalBias, [128] pcfKernelSize (feat-20260621
 *   M3 / m3-t2-t3), [129..131] align pad,
 *   [132..195] spotLightViewProj array<mat4x4<f32>, 4> (feat-20260625 w25:
 *   folded from standalone binding 9 to fix WebGL2 fragment uniform-buffer
 *   overflow; lane N = spot with shadowAtlasTile === N, 16 f32 / lane,
 *   16 B-aligned at byte 528 = float 132).
 *
 * @internal
 */
export function writeViewUbo(
  queue: RhiQueue,
  viewUniformBuffer: Buffer,
  camera: CameraSnapshot,
  light: DirectionalLightSnapshot,
  lights: ExtractedLights,
  spotShadowSnapshots: readonly SpotLightSnapshot[],
): void {
  // Compose worldViewProj once per frame (view * proj).
  const projMatrix = computeProjectionMatrix(camera);
  const viewMatrix = computeViewMatrix(camera);
  const worldViewProj = mat4.create();
  mat4.multiply(worldViewProj, projMatrix, viewMatrix);

  const VIEW_PAYLOAD_FLOATS = 196;
  const viewPayload = new Float32Array(VIEW_PAYLOAD_FLOATS);
  for (let i = 0; i < 16; i++) viewPayload[i] = (worldViewProj as unknown as number[])[i] ?? 0;
  viewPayload[16] = (light.direction[0] ?? 0) * light.intensity;
  viewPayload[17] = (light.direction[1] ?? -1) * light.intensity;
  viewPayload[18] = (light.direction[2] ?? 0) * light.intensity;
  viewPayload[20] = light.color[0] ?? 0;
  viewPayload[21] = light.color[1] ?? 0;
  viewPayload[22] = light.color[2] ?? 0;
  viewPayload[24] = camera.position[0] ?? 0;
  viewPayload[25] = camera.position[1] ?? 0;
  viewPayload[26] = camera.position[2] ?? 0;
  // lightViewProj[0] at [28..43] (replaces lightSpaceMatrix).
  if (lights.lightViewProj !== undefined && lights.lightViewProj[0] !== undefined) {
    for (let i = 0; i < 16; i++) viewPayload[28 + i] = lights.lightViewProj[0][i] ?? 0;
  }
  // inverseViewProj at [44..59] — unchanged position.
  // Host pre-computes mat4.invert so the skybox fragment shader avoids
  // per-pixel matrix inversion (charter P4 consistent abstraction).
  const inverseViewProj = mat4.create();
  mat4.invert(inverseViewProj, worldViewProj);
  for (let i = 0; i < 16; i++)
    viewPayload[44 + i] = (inverseViewProj as unknown as number[])[i] ?? 0;
  // lightViewProj[1..3] at [60..107].
  if (lights.lightViewProj !== undefined) {
    for (let c = 1; c <= 3; c++) {
      const base = 60 + (c - 1) * 16;
      const lvp = lights.lightViewProj[c];
      if (lvp !== undefined) {
        for (let i = 0; i < 16; i++) viewPayload[base + i] = lvp[i] ?? 0;
      }
    }
  }
  // splitPlanes at [108], [112], [116], [120] (vec4 stride = 4 floats).
  if (lights.splitPlanes !== undefined) {
    for (let s = 0; s < 4; s++) {
      viewPayload[108 + s * 4] = lights.splitPlanes[s] ?? 0;
    }
  }
  // cascadeCount / cascadeBlend at [124..125].
  viewPayload[124] = lights.cascadeCount ?? 0;
  viewPayload[125] = lights.cascadeBlend ?? 0;
  // feat-20260621-merge-directionallightshadow-into-directionallight M3 /
  // m3-t2: shadow bias + PCF kernel width from the merged DirectionalLight
  // land in the formerly-free tail pad at floats [126/127/128] (bytes
  // 504/508/512). VIEW_PAYLOAD_FLOATS / VIEW_UBO_BYTES are unchanged --
  // the WGSL View struct (common.wgsl) appends matching f32 at the same
  // slots; the host tail pad shrinks 88 B -> 64 B, rest stays zero.
  // pcfKernelSize is host-clamped to the nearest valid odd kernel {1,3,5}
  // (cap 5, matching lighting-directional.wgsl MAX_PCF_HALF=2 from the
  // merged 5.3-production-shadow-demos AC-14 variant-free loop) so the
  // per-iteration radius clip has a fixed, legal bound; undefined
  // (no cast-shadow / no shadow fields) defaults to 3.
  viewPayload[126] = lights.depthBias ?? 0.005;
  viewPayload[127] = lights.normalBias ?? 0.05;
  viewPayload[128] = clampPcfKernelSize(lights.pcfKernelSize);

  // feat-20260625-spot-light-shadow-mapping w25 (scope-amend webkit-fallback):
  // spotLightViewProj array<mat4x4<f32>, 4> at floats [132..195] (byte 528,
  // 16 B-aligned after pcfKernelSize). Lane N = the spot with
  // `shadowAtlasTile === N` (cap = 4); the perspective matrix was already
  // computed by the extract stage (SpotLightSnapshot.lightViewProj) — record
  // never recomputes it (Derive). Lanes for non-shadow / clipped spots (tile
  // < 0 or lightViewProj undefined) stay zeroed; the WGSL sample path gates
  // on `SpotLight.shadowAtlasTile >= 0` so zeroed lanes are never read.
  // Folded from the former standalone binding 9 UBO to keep the WebGL2
  // fallback fragment uniform-buffer count <= 11 (GLES 3.0).
  {
    const SPOT_LVP_BASE_FLOAT = 132;
    const SPOT_LVP_LANE_COUNT = 4;
    const SPOT_LVP_FLOATS_PER_LANE = 16;
    const spotSnaps = spotShadowSnapshots;
    for (let i = 0; i < spotSnaps.length; i++) {
      const ss = spotSnaps[i];
      if (ss === undefined) continue;
      const tile = ss.shadowAtlasTile;
      if (tile < 0 || tile >= SPOT_LVP_LANE_COUNT) continue;
      const lvp = ss.lightViewProj;
      if (lvp === undefined) continue;
      const base = SPOT_LVP_BASE_FLOAT + tile * SPOT_LVP_FLOATS_PER_LANE;
      for (let f = 0; f < SPOT_LVP_FLOATS_PER_LANE; f++) {
        viewPayload[base + f] = lvp[f] ?? 0;
      }
    }
  }

  const viewUploadResult = queue.writeBuffer(viewUniformBuffer, 0, viewPayload);
  if (!viewUploadResult.ok) throw viewUploadResult.error;
}
