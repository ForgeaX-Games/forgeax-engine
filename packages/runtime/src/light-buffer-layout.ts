// @forgeax/engine-runtime - host-side packing helpers for the
// PointLight + SpotLight std430 storage buffers + storage-buffer cap gate.
//
// Owns the byte-frozen std430 layout (D-S2):
//
//   PointLight (32 B / 8 floats):
//     [ 0..2 ] position vec3<f32>
//     [   3 ] invRangeSquared f32 (Bevy color_inverse_square_range.w)
//     [ 4..6 ] color vec3<f32> (host-pre-multiplied: color * intensity)
//     [   7 ] shadowAtlasLayer i32 (sentinel -1 = no shadow; 0..3 = atlas layer)
//             — feat-20260612-point-light-shadows-urp-hdrp M1 / T-M1-8 (D-2):
//             repurposes the prior `pointPadW` lane. The lane is written as
//             i32 via an Int32Array view of the same backing ArrayBuffer; the
//             shader reads `shadowAtlasLayer: i32` from byte 28..32 of struct
//             PointLight in common.wgsl. -1 (0xFFFFFFFF) is the no-shadow
//             sentinel — shader path samples shadow only when layer >= 0.
//
//   SpotLight (64 B / 16 floats):
//     [ 0..2 ] position vec3<f32>
//     [   3 ] invRangeSquared f32
//     [ 4..6 ] color vec3<f32> (host-pre-multiplied)
//     [   7 ] cosInner f32
//     [ 8..10] direction vec3<f32> (raw outgoing vector)
//     [  11 ] cosOuter f32
//     [12..14] pad f32 = 0 (std430 vec4 stride alignment)
//     [  15 ] shadowAtlasTile i32 (sentinel -1 = unassigned/clipped; 0..3 = tile)
//             — feat-20260625-spot-light-shadow-mapping M2 / w8 (D-4):
//             SpotLight GPU struct had no free pad lane (8 lanes full), so the
//             clip signal extends the struct to a 4th vec4 column. The lane is
//             written i32 via an Int32Array view of the same backing
//             ArrayBuffer; the shader reads `shadowAtlasTile: i32` from byte
//             60..64 of struct SpotLight (common.wgsl). -1 (0xFFFFFFFF) is the
//             unassigned/clipped sentinel — shader samples shadow only when
//             tile >= 0. Mirrors point's slot-7 shadowAtlasLayer pattern.
//
// Array header (16 B, std430 stride alignment):
//     [ 0 ] count u32 (number of valid slots in the trailing array)
//     [ 1..3 ] pad u32 = 0
//
// AC anchor: requirements AC-04 (c) + C-7 (16 B alignment); plan-strategy
// section 2 D-S2 (byte-frozen layout); research Finding 2 (Bevy
// invRangeSquared naming) + Finding 9 (Bevy storage buffer pattern).
//
// Cap gate: maxStorageBuffersPerShaderStage >= 4 (M3 occupies 3 storage
// entries: meshSSBO + pointLightsBuffer + spotLightsBuffer; default WebGPU
// minimum is 8, requirements assumption A-7 + plan R-4). The closed
// `RhiErrorCode` union has no `'rhi-not-supported'` member; the
// plan-strategy phrasing collapses onto the spec-aligned `'limit-exceeded'`
// arm which already documents "input value exceeded device.limits.<name>"
// (RhiError JSDoc on packages/rhi/src/errors.ts). Reusing `'limit-exceeded'`
// keeps `RhiErrorCode` count at 18 (AGENTS.md error model evolution
// contract: minor add-only; w20a explicitly forbids count drift).

import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import type { PointLightSnapshot, SpotLightSnapshot } from './render-system-extract';

// ── HDRP LightSlot cluster-forward unified struct ─────────────────────────────
// feat-20260608-cluster-lighting M4 / w16.
//
// LightSlot is the single std430 struct shared by point and spot lights in the
// HDRP cluster-forward path. Field layout is byte-frozen (AC-11 double-sided
// lock with WGSL hdrp-cluster-forward.wgsl LightSlot struct):
//
//   [ 0..2 ] position         vec3<f32>
//   [   3 ] invRangeSquared   f32
//   [ 4..6 ] color            vec3<f32>  (host pre-multiplied: color * intensity)
//   [   7 ] cosInner          f32         (point: 1.0)
//   [ 8..10] direction        vec3<f32>  (point: vec3(0))
//   [  11 ] cosOuter          f32         (point: 0.0)
//   [  12 ] kind              u32         (POINT = 0, SPOT = 1)
//   [13..15] pad              u32x3 = 0   (std430 vec4 stride alignment)
//
// Design: research Finding 1 (Bevy GpuClusteredLight 152B -> forgeax 64B),
// plan-strategy D-light-slot (kind bit-tag discriminant).
//
// The existing URP PointLight (32B) / SpotLight (48B) pack functions remain
// untouched; packLightSlot is the new HDRP-only entry.

/** Byte size of one HDRP LightSlot in std430 (16 x f32). AC-11 absolute-value lock. */
export const BYTES_PER_LIGHT_SLOT = 64;

/**
 * LightSlot kind discriminant — closed enum matching WGSL `KIND_POINT` / `KIND_SPOT`.
 * Values are u32 bit-tags (not sequential); AC-12 exhaustive switch.
 */
export const LightSlotKind = {
  POINT: 0,
  SPOT: 1,
} as const;
export type LightSlotKind = (typeof LightSlotKind)[keyof typeof LightSlotKind];

/**
 * Byte-offset layout of one LightSlot in std430 (16 f32 = 64 B).
 *
 * Mirrors the WGSL `LightSlot` struct field order byte-for-byte.
 * All offsets verified by w14 lightslot-layout.test.ts.
 *
 * feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-4 (plan-strategy §D-8):
 * the prior u32x3 pad lanes at byte 52..64 carry shadow-side data on the HDRP
 * path. `kind_and_pad.x = kind` (u32), `.y = shadowAtlasLayer` (i32, sentinel
 * -1 = no shadow / spot light), `.z = near` (f32 via bitcast), `.w = far`
 * (f32 via bitcast). The shader reads near/far through `bitcast<f32>(...)`
 * to keep the WGSL struct as `vec4<u32>` (alignment + naga_oil unchanged).
 */
export const LIGHTSLOT_LAYOUT = {
  byteSize: BYTES_PER_LIGHT_SLOT,
  positionOffset: 0,
  invRangeSquaredOffset: 12,
  colorOffset: 16,
  cosInnerOffset: 28,
  directionOffset: 32,
  cosOuterOffset: 44,
  kindOffset: 48,
  padOffset: 52,
  shadowAtlasLayerOffset: 52,
  shadowNearOffset: 56,
  shadowFarOffset: 60,
  floatCount: 16,
  vec4Count: 4,
} as const;

/**
 * Minimum storage-buffer count needed by the M3 record stage.
 *
 *   1. Mesh SSBO (entity_world + normalMatrix; per-renderable dynamic
 *      offset, 256 B stride).
 *   2. PointLight std430 array (this feat).
 *   3. SpotLight std430 array (this feat).
 *
 * Plan R-4 + plan-strategy section 4 risk table: assert >= 4 to keep the
 * head-room margin for todo-125 (cluster expansion lifts to 4-5 entries).
 */
export const STORAGE_BUFFER_MIN_REQUIRED = 4;

/** Byte size of one PointLight std430 slot (vec4 * 2). */
export const POINT_LIGHT_STD430_BYTES = 32;
/**
 * Byte size of one SpotLight std430 slot (vec4 * 4).
 *
 * feat-20260625-spot-light-shadow-mapping M2 / w8 (D-4): grew 48 -> 64 to make
 * room for the `shadowAtlasTile: i32` clip-signal lane (slot 15). Slots 0..11
 * keep the prior layout; slots 12..14 are vec4-alignment padding.
 */
export const SPOT_LIGHT_STD430_BYTES = 64;

/** Sentinel value for SpotLight slot[15] meaning "no shadow / clipped". */
export const SPOT_LIGHT_SHADOW_TILE_SENTINEL = -1;
/** Byte size of the array header (count u32 + 12 B pad to 16 B stride). */
export const LIGHT_ARRAY_HEADER_BYTES = 16;
/** Maximum number of slots packed in the first-slice cap layout (D-S3). */
export const LIGHT_ARRAY_MAX_SLOTS = 4;

/** Sentinel value for PointLight slot[7] / LightSlot pad meaning "no shadow". */
export const POINT_LIGHT_SHADOW_LAYER_SENTINEL = -1;

/**
 * Pack one PointLightSnapshot into 8 floats / 32 B byte-for-byte std430.
 *
 * Returns a fresh `Float32Array` per call; `Float32Array.byteLength === 32`
 * by construction (Float32Array(8).buffer.byteLength === 32). Slot 7
 * (byte 28..32) carries `shadowAtlasLayer: i32` (sentinel -1 = no shadow,
 * 0..3 = cube_array atlas layer index for shadow casters). The lane is
 * written through an Int32Array view of the same backing ArrayBuffer so the
 * shader's `i32` read at byte 28..32 of `struct PointLight` (common.wgsl)
 * sees the correct two's-complement bits (-1 = 0xFFFFFFFF).
 */
export function packPointLight(snap: PointLightSnapshot): Float32Array {
  const out = new Float32Array(8);
  out[0] = snap.position[0] ?? 0;
  out[1] = snap.position[1] ?? 0;
  out[2] = snap.position[2] ?? 0;
  out[3] = snap.invRangeSquared;
  out[4] = snap.color[0] ?? 0;
  out[5] = snap.color[1] ?? 0;
  out[6] = snap.color[2] ?? 0;
  // Slot 7: shadowAtlasLayer i32 via Int32Array view (sentinel -1 default).
  const i32 = new Int32Array(out.buffer);
  i32[7] = snap.shadowAtlasLayer ?? POINT_LIGHT_SHADOW_LAYER_SENTINEL;
  return out;
}

/**
 * Pack one SpotLightSnapshot into 16 floats (64 B byte-for-byte std430).
 *
 * cosInner / cosOuter ride the otherwise-padding `.w` lanes of the
 * `color` and `direction` vec4 columns (AC-04 c + plan D-S2 16 B alignment
 * via packing rather than padding rows). Slot 15 carries `shadowAtlasTile: i32`
 * (sentinel -1 = unassigned/clipped, 0..3 = atlas tile) written through an
 * Int32Array view so the shader's `i32` read at byte 60..64 of struct SpotLight
 * (common.wgsl) sees the correct two's-complement bits (-1 = 0xFFFFFFFF).
 * Slots 12..14 stay zero (vec4-alignment padding). feat-20260625 M2 / w8 (D-4).
 */
export function packSpotLight(snap: SpotLightSnapshot): Float32Array {
  const out = new Float32Array(16);
  out[0] = snap.position[0] ?? 0;
  out[1] = snap.position[1] ?? 0;
  out[2] = snap.position[2] ?? 0;
  out[3] = snap.invRangeSquared;
  out[4] = snap.color[0] ?? 0;
  out[5] = snap.color[1] ?? 0;
  out[6] = snap.color[2] ?? 0;
  out[7] = snap.cosInner;
  out[8] = snap.direction[0] ?? 0;
  out[9] = snap.direction[1] ?? 0;
  out[10] = snap.direction[2] ?? 0;
  out[11] = snap.cosOuter;
  // Slots 12..14 stay zero (vec4-alignment padding).
  // Slot 15: shadowAtlasTile i32 via Int32Array view (sentinel -1 default).
  const i32 = new Int32Array(out.buffer);
  i32[15] = snap.shadowAtlasTile ?? SPOT_LIGHT_SHADOW_TILE_SENTINEL;
  return out;
}

/**
 * Pack the 16-byte std430 array header (count u32 + 12 B pad) for the
 * point/spot light storage buffers.
 *
 * Returns a fresh `ArrayBuffer` so callers can either re-view it as
 * `Uint8Array` for `queue.writeBuffer` or as `Uint32Array` for in-place
 * inspection.
 */
export function packLightArrayHeader(count: number): ArrayBuffer {
  const buf = new ArrayBuffer(LIGHT_ARRAY_HEADER_BYTES);
  const u32 = new Uint32Array(buf);
  u32[0] = count >>> 0;
  // Slots 1..3 stay zero (12 B pad to 16 B stride alignment).
  return buf;
}

/**
 * Cap gate at createRenderer time: check whether the device has enough
 * storage-buffer slots for the PBR pipeline (M3 requires
 * `STORAGE_BUFFER_MIN_REQUIRED = 4`). Returns a three-way signal:
 *
 *  - `Result.ok(true)`  — storage buffer capable (cap >= 4);
 *  - `Result.ok(false)` — no storage buffer capability at all (cap === 0);
 *    consumer walks the uniform-fallback path;
 *  - `Result.err(RhiError)` — cap in (0, 4); not enough storage slots to run
 *    but also not a clean zero-cap uniform-fallback case (e.g. downlevel
 *    adapter with 1-3 slots). The error carries `'limit-exceeded'` with
 *    `LimitExceededDetail` shape.
 *
 * Uniform-fallback path decision (plan D-5): `cap === 0` is the wgpu
 * WebGL2 backend signal (`downlevel_webgl2_defaults().limits.
 * maxStorageBuffersPerShaderStage = 0`). Uniform fallback covers pointLight
 * + spotLight + meshes + instances + skin palette — every storage-buffer
 * entry in the PBR pipeline switches to `uniform`.
 */
/**
 * Optional shadow info attached to a HDRP LightSlot for point lights with a
 * companion `PointLightShadow` component. Sentinel `layer = -1` (the default
 * when the snapshot has no shadow) makes the shader skip cube_array sampling
 * and stay on the unshadowed `evalPoint` path.
 *
 * `near` / `far` ride the otherwise-pad lanes (`kind_and_pad.zw` in the WGSL
 * struct, byte 56..64) and feed the depth-ref reconstruction in
 * `evalPointShadowed`. Spot lights (and shadow-less point lights) leave these
 * lanes zero per std430 init.
 */
export interface PointShadowSlotInfo {
  readonly shadowAtlasLayer: number;
  readonly near: number;
  readonly far: number;
}

/**
 * Pack one PointLightSnapshot or SpotLightSnapshot into a 64-byte LightSlot
 * (16 floats, std430). Point lights fill `cosInner=1.0`, `direction=vec3(0)`,
 * `cosOuter=0.0`, `kind=POINT(0)`. Spot lights fill all fields verbatim.
 *
 * feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-4 (plan-strategy §D-8):
 * the optional `shadow` info threads through to bytes 52..64 as
 * `(shadowAtlasLayer i32, near f32, far f32)`. The shader reads `near`/`far`
 * through `bitcast<f32>(kind_and_pad.zw)` so the WGSL struct stays
 * `kind_and_pad: vec4<u32>` (alignment + naga_oil compose unchanged). When
 * `shadow` is undefined (no PointLightShadow) the lanes default to
 * `(layer = -1, 0, 0)` -- shader gates on `layer >= 0` so unshadowed lights
 * stay on the `evaluate_point_light` path. Spot lights ignore the lanes.
 *
 * Returns a fresh `Float32Array(16)` per call.
 */
export function packLightSlot(
  snap: PointLightSnapshot | SpotLightSnapshot,
  shadow?: PointShadowSlotInfo,
): Float32Array {
  const out = new Float32Array(16);
  // position (vec3<f32> + invRangeSquared at lane .w)
  out[0] = snap.position[0] ?? 0;
  out[1] = snap.position[1] ?? 0;
  out[2] = snap.position[2] ?? 0;
  out[3] = snap.invRangeSquared;
  // color (vec3<f32> + cosInner at lane .w)
  out[4] = snap.color[0] ?? 0;
  out[5] = snap.color[1] ?? 0;
  out[6] = snap.color[2] ?? 0;
  out[7] = snap.kind === 'point' ? 1.0 : snap.cosInner;
  // direction (vec3<f32> + cosOuter at lane .w)
  out[8] = snap.kind === 'point' ? 0 : (snap.direction[0] ?? 0);
  out[9] = snap.kind === 'point' ? 0 : (snap.direction[1] ?? 0);
  out[10] = snap.kind === 'point' ? 0 : (snap.direction[2] ?? 0);
  out[11] = snap.kind === 'point' ? 0.0 : snap.cosOuter;
  // kind (u32) at byte 48
  out[12] = snap.kind === 'point' ? LightSlotKind.POINT : LightSlotKind.SPOT;
  // Pad lanes 13..15 carry shadow info on the HDRP path (T-M4-4).
  // Sentinel default: layer = -1 (no shadow). near/far stay zero.
  const i32 = new Int32Array(out.buffer);
  if (snap.kind === 'point' && shadow !== undefined) {
    i32[13] = shadow.shadowAtlasLayer;
    out[14] = shadow.near;
    out[15] = shadow.far;
  } else {
    i32[13] = POINT_LIGHT_SHADOW_LAYER_SENTINEL;
    // out[14] / out[15] remain zero (Float32Array zero-init).
  }
  return out;
}

export function assertStorageBufferCap(cap: number): Result<boolean, RhiError> {
  if (cap >= STORAGE_BUFFER_MIN_REQUIRED) {
    return ok(true);
  }
  if (cap === 0) {
    return ok(false);
  }
  return err(
    new RhiError({
      code: 'limit-exceeded',
      expected: `device.limits.maxStorageBuffersPerShaderStage >= ${STORAGE_BUFFER_MIN_REQUIRED}, or exactly 0 for uniform-fallback path`,
      hint: `device.limits.maxStorageBuffersPerShaderStage = ${cap} < ${STORAGE_BUFFER_MIN_REQUIRED} and != 0. WebGPU spec default minimum is 8; this may be a downlevel adapter with partial storage support. Wait for todo-125 multi-light-pack which collapses point + spot into a single cluster storage buffer (1 entry instead of 2) for 2-3 buffer environments.`,
      detail: {
        maxStorageBufferBindingSize: cap,
        requestedBytes: STORAGE_BUFFER_MIN_REQUIRED,
      },
    }),
  );
}
