import type { MaterialSnapshot, SpriteInstancesSnapshot } from '../render-system-extract';

// ─── feat-20260625 M3 / w11 — sprite-pass 80B interleaved upload helpers ─────
//
// Plan-strategy D-1 (interleaved single buffer 80B/instance) + D-9 (cacheKey
// = entity packed u32). The sprite-pass record stage consumes
// `SpriteInstancesSnapshot` (from render-system-extract) and produces a single
// GPU buffer interleaving mat4 transforms with vec4 regions per instance;
// the BGL stays untouched (D-1 single binding slot @group(3) @binding(0)).
//
// Layout (per instance, byte offset 0..80):
//   [0..64)  mat4 column-major (16 f32)
//   [64..80) region vec4 [uMin, vMin, uW, vH] (4 f32)
//   second instance starts at byte 80.
//
// The cache fingerprint is the triple `(cacheKey, archVersion, byteLength)`;
// `spriteInstancesCacheHit` is the boolean side of the fingerprint check the
// record stage runs once per sprite-pass entity. Pure functions — the GPU
// device + buffer wrapper layer stays out of this module so the unit test
// (w9) exercises both helpers without standing up a device mock.

/** Re-export of the extract-stage snapshot so test sites can build it. */
export type { SpriteInstancesSnapshot };

/**
 * Interleave SpriteInstances transforms (stride 16) and regions (stride 4)
 * into a single Float32Array with stride 20 (= 80 bytes per instance,
 * plan-strategy D-1). Callers feed the output buffer to
 * `device.queue.writeBuffer` against the per-entity GPU buffer slot.
 *
 * Pre-conditions guaranteed by render-system-extract M3 / w10:
 *   - `transforms.length` is a multiple of 16
 *   - `regions.length` is a multiple of 4
 *   - `transforms.length / 16 === regions.length / 4`
 *
 * Violations fire `sprite-instances-count-mismatch` at the extract entry and
 * never reach this helper. The helper itself does NOT re-validate the
 * pre-conditions — single-validator invariant (charter P4 explicit failure
 * routed once at the extract boundary; downstream consumers trust the
 * snapshot shape).
 *
 * @param transforms — packed mat4 (column-major) Float32Array (stride 16).
 * @param regions    — packed vec4 [uMin, vMin, uW, vH] Float32Array (stride 4).
 * @returns interleaved Float32Array with length `(transforms.length + regions.length)`.
 */
export function interleaveSpriteInstanceBuffer(
  transforms: Float32Array,
  regions: Float32Array,
): Float32Array {
  const count = transforms.length / 16;
  const out = new Float32Array(count * 20);
  for (let i = 0; i < count; i++) {
    const dstBase = i * 20;
    const tSrcBase = i * 16;
    const rSrcBase = i * 4;
    // mat4 (16 floats) — explicit loop avoids subarray copy overhead.
    for (let k = 0; k < 16; k++) out[dstBase + k] = transforms[tSrcBase + k] ?? 0;
    // region (4 floats).
    for (let k = 0; k < 4; k++) out[dstBase + 16 + k] = regions[rSrcBase + k] ?? 0;
  }
  return out;
}

/**
 * Boolean side of the per-entity sprite-pass GPU buffer cache fingerprint
 * check. Returns true iff the existing entry is byte-for-byte safe to reuse:
 *
 *   - `entry` exists (the entity has been recorded at least once);
 *   - `entry.uploadedArchVersion === snapshot.archVersion` (archetype
 *     storage has not been re-allocated since last upload);
 *   - `entry.uploadedByteLength === requestedBytes` (byte count matches the
 *     interleaved layout this frame would write).
 *
 * The record stage gates the `createBuffer + queue.writeBuffer` round on the
 * negation of this predicate; a hit short-circuits to a `writeBuffer`-only
 * refresh against the existing GPU buffer.
 *
 * @param entry — cached `InstanceBufferCacheEntry` for this `cacheKey`, or
 *   `undefined` if the entity has never been recorded.
 * @param snapshot — current frame's snapshot (carries `cacheKey + archVersion`).
 * @param requestedBytes — `transforms.byteLength + regions.byteLength` =
 *   80 * `instanceCount` for SpriteInstances (D-1 interleaved layout).
 */
export function spriteInstancesCacheHit(
  entry: import('../instance-buffer-cache').InstanceBufferCacheEntry | undefined,
  snapshot: SpriteInstancesSnapshot,
  requestedBytes: number,
): boolean {
  if (entry === undefined) return false;
  if (entry.uploadedArchVersion !== snapshot.archVersion) return false;
  if (entry.uploadedByteLength !== requestedBytes) return false;
  return true;
}

// === feat-20260625 M2 / w7 transparent-aware helpers ============================
//
// Three small pure helpers replace the inline sprite-specific switches inside
// recordFrame so the transparent / sprite / pipeline-miss paths become unit-
// testable without a GPU device (charter P2 structure-over-prose).
//
// Plan anchors:
//   - requirements AC-05 / AC-14
//   - plan-strategy section 2 D-3 (MaterialSnapshot.transparent drives split
//     + blend; charter P3 explicit failure on cache miss)
//   - plan-strategy section 5.6 gate R-H (helpers only read MaterialSnapshot
//     paramSnapshot / transparent fields; they MUST NOT touch
//     the MaterialAsset registry directly or cast over firstMaterial)

/**
 * Decides whether the LDR (tonemapActive=false) main pass needs the
 * sprite-style split into two serial sub-passes (geometry sRGB + transparent
 * unorm). Triggered by any validated dispatch entry carrying
 * `material.transparent === true` — derived by the extract stage from
 * `passes[0].renderState.blend !== undefined` (post-feat-20260626-collapse
 * SSOT, plan-strategy D-3; MaterialPassDescriptor no longer carries a
 * dedicated `transparent` field).
 *
 * feat-20260625-refactor-sprite-as-transparent-mesh M3 / w13: the M2 union
 * with `shadingModel === 'sprite'` is gone — sprite materials now declare
 * `transparent: true` on their pass descriptor (or extract folds it onto
 * `MaterialSnapshot.transparent`), so the legacy arm is redundant.
 *
 * @internal
 */
export function computeSplitLdrSprite(
  validatedOrdered: readonly (
    | {
        readonly source: {
          readonly material: MaterialSnapshot;
          readonly materials?: readonly MaterialSnapshot[];
        };
      }
    | undefined
  )[],
  tonemapActive: boolean,
): boolean {
  if (tonemapActive) return false;
  for (let i = 0; i < validatedOrdered.length; i++) {
    const v = validatedOrdered[i];
    if (v === undefined) continue;
    // feat-city-glb Bug 5 (per-submesh transparency): trip the split when ANY
    // submesh material is transparent, not just the entity-level material[0].
    // A multi-material mesh (e.g. opaque road + BLEND crosswalk decal submesh)
    // has an opaque material[0] but a transparent submesh that must route to
    // the blend sub-pass. Fall back to `material` when `materials` is absent
    // (single-material entities / test fixtures) — identical to the old check.
    const mats = v.source.materials;
    if (mats !== undefined) {
      for (let j = 0; j < mats.length; j++) {
        if (mats[j]?.transparent === true) return true;
      }
    } else if (v.source.material.transparent === true) {
      return true;
    }
  }
  return false;
}
