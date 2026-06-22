// @forgeax/engine-runtime - Skin palette buffer allocator (M2 / T-24).
//
// Per-renderer mutable state: vertex-stage palette buffer(s) holding
// pre-multiplied joint matrices (M_i = joint_world * IBM_i) for every
// skinned entity in a frame. Two backends (split at construction by
// `useStorageBuffer`):
//
//   STORAGE PATH  (`useStorageBuffer = true`, `maxStorageBuffersPerShaderStage
//                  >= 8` — i.e. WebGPU spec default device).
//     One shared GPU buffer grows at 1.5x (Bevy skin.rs alignment,
//     plan-strategy D-4). Every entity's slice is `{ buffer: shared,
//     byteOffset: cursor }`. Record-stage builds ONE BG against the
//     shared buffer + `bindingWindowBytes` entry size; per-draw
//     `setBindGroup(_, bg, [_, dynOffset = slice.byteOffset])` slides
//     the static window across the buffer. WebGPU rule
//     `dynOffset + entry.size <= buffer.size` is satisfied because the
//     allocator extends `buffer.size` to `cursor + bindingWindowBytes`
//     after every slice.
//
//   UNIFORM PATH  (`useStorageBuffer = false`, browser uniform fallback —
//                  `maxStorageBuffersPerShaderStage = 0`).
//     `maxUniformBufferBindingSize` floor is 16 KiB; the static binding
//     window alone is 16320 B, leaving room for ZERO additional
//     entities behind a shared dynOffset. The shared-BG model collapses,
//     so each entity gets its OWN small UBO of size = `bindingWindowBytes`
//     (= MAX_JOINTS * 64 = 16320, which is `<= maxUniformBufferBindingSize`).
//     Slice returns `{ buffer: per-entity, byteOffset: 0 }`. Record-stage
//     BG cache key includes `slice.buffer` so each entity gets its own
//     BG (cached per-buffer pointer; pool reuse keeps createBuffer
//     amortized across frames).
//
//   Concept that does NOT branch by path: `bindingWindowBytes`. It is
//   the static `pbr-skin-mesh-array-bgl @binding(1)` BG entry size,
//   identical on both paths (WGSL declares the same layout). Record-
//   stage uses it verbatim when constructing the BG. dynOffset[1]
//   on the uniform path is always 0 (entry size already equals buffer
//   size); on the storage path it walks 0, 1536, 3072, ... .
//
// CPU pre-multiply (path-agnostic): writeJointPalette(slice, ibm, jointWorld)
//   -> mat4 per joint: M_i = joint_world_i * IBM_i
//   -> queue.writeBuffer(slice.buffer, slice.byteOffset, payload).
//
// feat-20260523-skin-skeleton-animation M2 / T-24;
// feat-20260612-skin-palette-per-frame-upload M6 (uniform fallback split).

import type { Mat4 } from '@forgeax/engine-math';
import { mat4 } from '@forgeax/engine-math';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { SkinPaletteOverflowError } from '../errors';
import type { SkinPaletteSlice } from '../render-system-extract';

const MAT4_BYTES = 64; // 16 f32 * 4 bytes
// MAX_JOINTS = 255 matches `pbr-skin-mesh-array-bgl @binding(1)` static BG
// entry size: 255 * 64 = 16320 B. The number is the MAX joints any single
// skinned entity may have. On the storage path the shared buffer holds
// many entities back-to-back; on the uniform path each entity owns one
// 16320 B buffer.
const MAX_JOINTS = 255;
const BINDING_WINDOW_BYTES = MAX_JOINTS * MAT4_BYTES; // 16320

// STORAGE = 0x80, UNIFORM = 0x40, COPY_DST = 0x08 (WebGPU spec).
const STORAGE_USAGE = 0x80 | 0x08;
const UNIFORM_USAGE = 0x40 | 0x08;

export interface SkinPaletteAllocator {
  /**
   * Static BG entry size for `pbr-skin-mesh-array-bgl @binding(1)`. Always
   * `MAX_JOINTS * 64 = 16320`; consumers (record stage) bind this size
   * when building the BG. Path-independent.
   */
  readonly bindingWindowBytes: number;
  /**
   * True when this allocator is in storage-path mode (single shared
   * buffer + dynOffset). False on the uniform fallback (per-entity
   * buffer + dynOffset always 0). Record-stage reads this only for
   * shape assertions in tests; production code branches via
   * `slice.buffer` identity (shared vs per-entity), not this flag.
   */
  readonly useStorageBuffer: boolean;
  /**
   * Allocate a slice for `jointCount` joints. Returns the buffer + byte
   * offset the record stage should bind. Storage path returns the same
   * shared buffer for every call; uniform path mints (or pool-reuses) a
   * per-entity buffer and returns it with `byteOffset: 0`. Both paths
   * guarantee BG validation: storage extends the shared buffer's size,
   * uniform sizes the per-entity buffer to exactly `bindingWindowBytes`.
   *
   * @throws if storage path buffer would exceed
   *         `device.limits.maxStorageBufferBindingSize`
   */
  allocateSlice(jointCount: number): SkinPaletteSlice;
  /**
   * Write joint matrices into the slice's buffer at the slice's offset.
   * Computes M_i = jointWorldTransforms[i] * ibm[i] per joint.
   *
   * `jointWorlds[i]` is taken straight from `Skin.joints[i]` entity's
   * `Transform.world` view (a 16-float column-major Float32Array
   * written by propagateTransforms); zero recompose, premultiplies
   * directly against the IBM.
   */
  writeJointPalette(
    slice: SkinPaletteSlice,
    ibms: readonly Float32Array[],
    jointWorlds: readonly Mat4[],
  ): void;
  /**
   * Reset for next frame. Storage path: cursor rewinds, shared buffer
   * stays. Uniform path: per-entity buffer cursor rewinds (pool entries
   * stay allocated and round-robin to the next frame's first entity).
   */
  resetForFrame(): void;
}

export function createSkinPaletteAllocator(
  device: RhiDevice,
  maxBindingSize: number,
  useStorageBuffer = true,
): SkinPaletteAllocator {
  // Storage path: shared buffer state.
  let storageBuffer: Buffer | null = null;
  let storageCapacity = 0;
  let storageCursor = 0;

  // Uniform path: per-entity buffer pool. `pool` is the pre-allocated
  // 16320 B UBO ring; `poolCursor` advances per allocateSlice within a
  // frame and rewinds in resetForFrame, so a 3-entity scene reuses 3
  // entries across frames (createBuffer fires only when the per-frame
  // entity count grows past the historical max). 16320 B / entry
  // bounded by maxUniformBufferBindingSize (>= 16384 by spec floor).
  const pool: Buffer[] = [];
  let poolCursor = 0;

  function ensureStorageCapacity(needed: number): void {
    if (storageBuffer !== null && needed <= storageCapacity) return;
    let newCapacity = storageCapacity === 0 ? BINDING_WINDOW_BYTES : storageCapacity;
    while (newCapacity < needed) {
      // 1.5x grow, then next multiple of 256 for alignment (plan-strategy D-4).
      newCapacity = (newCapacity + (newCapacity >> 1) + 255) & ~255;
    }
    if (newCapacity > maxBindingSize) {
      throw new SkinPaletteOverflowError(newCapacity, maxBindingSize);
    }
    const bufRes = device.createBuffer({
      label: 'skin-palette',
      size: newCapacity,
      usage: STORAGE_USAGE,
      mappedAtCreation: false,
    });
    if (!bufRes.ok) throw bufRes.error;
    storageBuffer = bufRes.value;
    storageCapacity = newCapacity;
  }

  function acquirePoolBuffer(): Buffer {
    if (poolCursor < pool.length) {
      const reused = pool[poolCursor];
      // biome-ignore lint/style/noNonNullAssertion: poolCursor < pool.length guarantees the slot is set
      return reused!;
    }
    if (BINDING_WINDOW_BYTES > maxBindingSize) {
      throw new SkinPaletteOverflowError(BINDING_WINDOW_BYTES, maxBindingSize);
    }
    const bufRes = device.createBuffer({
      label: 'skin-palette',
      size: BINDING_WINDOW_BYTES,
      usage: UNIFORM_USAGE,
      mappedAtCreation: false,
    });
    if (!bufRes.ok) throw bufRes.error;
    pool.push(bufRes.value);
    return bufRes.value;
  }

  function allocateSlice(jointCount: number): SkinPaletteSlice {
    if (useStorageBuffer) {
      // Storage path: shared buffer + dynOffset window.
      // WebGPU validates `dynOffset + entry.size <= buffer.size` per
      // setBindGroup, so the buffer must extend a full BINDING_WINDOW_BYTES
      // past `byteOffset` -- not just `jointCount * 64`. Pre-M6 used the
      // latter and tripped `Dynamic Offset[1] out of bounds` on entity 2+.
      const offset = storageCursor;
      const needed = offset + BINDING_WINDOW_BYTES;
      ensureStorageCapacity(needed);
      // biome-ignore lint/style/noNonNullAssertion: ensureStorageCapacity throws if buffer cannot be created
      const buffer = storageBuffer!;
      // Cursor advances by the actual joint footprint -- subsequent slices
      // pack tightly. Only the last slice's window may overhang into
      // uninitialized buffer space, which is benign (shader reads only
      // `jointCount` matrices).
      storageCursor = offset + jointCount * MAT4_BYTES;
      return { jointCount, byteOffset: offset, buffer };
    }
    // Uniform fallback: each slice gets its own 16320 B UBO.
    const buffer = acquirePoolBuffer();
    poolCursor += 1;
    return { jointCount, byteOffset: 0, buffer };
  }

  function writeJointPalette(
    slice: SkinPaletteSlice,
    ibms: readonly Float32Array[],
    jointWorlds: readonly Mat4[],
  ): void {
    const count = Math.min(slice.jointCount, ibms.length, jointWorlds.length);
    if (count === 0) return;
    const payload = new Float32Array(count * 16);
    const temp = mat4.create();
    const ibm = mat4.create();
    const ibmNums = ibm as unknown as number[];
    for (let i = 0; i < count; i++) {
      const ibmFlat = ibms[i];
      const jw = jointWorlds[i];
      if (ibmFlat === undefined || jw === undefined) continue;
      for (let k = 0; k < 16; k++) {
        ibmNums[k] = ibmFlat[k] ?? 0;
      }
      mat4.multiply(temp, jw, ibm);
      const base = i * 16;
      for (let j = 0; j < 16; j++) {
        payload[base + j] = (temp as unknown as number[])[j] ?? 0;
      }
    }
    const res = device.queue.writeBuffer(slice.buffer, slice.byteOffset, payload);
    if (!res.ok) throw res.error;
  }

  function resetForFrame(): void {
    storageCursor = 0;
    poolCursor = 0;
  }

  return {
    bindingWindowBytes: BINDING_WINDOW_BYTES,
    useStorageBuffer,
    allocateSlice,
    writeJointPalette,
    resetForFrame,
  };
}
