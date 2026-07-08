// instance-decode.ts — group-3 binding-0 InstanceData buffer decoder (M3).
//
// forgeax engine convention (hardcoded, SSOT: packages/shader/src/common.wgsl:374-390):
//   struct InstanceData {
//     localFromInstance : mat4x4<f32>,      // 64 B column-major
//     region            : vec4<f32>,        // +16 B when PER_INSTANCE_REGION == true
//   };
//   @group(3) @binding(0) var<storage, read> instances : array<InstanceData>;
//
// Stride variants (bufferSize / instanceCount):
//   64  → variant='mat4'         (localFromInstance only)
//   80  → variant='mat4+region'  (localFromInstance + per-instance atlas region)
//   else → 'unexpected-stride'  (refuse to guess — silent misdecoding is worse)
//
// Related: requirements AC-03 / AC-04 / AC-05 + boundary table; plan-strategy §5.3.

import type { HandleId, InspectBindingEntry, Tape } from '@forgeax/engine-rhi-debug';
import type { CreateDescriptor, DrawEntry } from '@forgeax/engine-rhi-debug/frame-model';
import { getBufferBlobData } from './buffer-content';

/**
 * Row cap for the UI table — long instance arrays hang the browser
 * (requirements §6.2 rollback trigger). Callers see `truncated: true`
 * with `instances.length === INSTANCE_MAX_ROWS`.
 */
export const INSTANCE_MAX_ROWS = 256;

/** Two InstanceData layouts, discriminated by stride against the SSOT struct. */
export type InstanceDataVariant = 'mat4' | 'mat4+region';

export interface DecodedInstance {
  readonly index: number;
  /** [tx, ty, tz] read directly from mat4 floats 12/13/14 (column-major translation). */
  readonly position: readonly [number, number, number];
  /** Column-length scale: [|col0|, |col1|, |col2|] using the first three components. */
  readonly scale: readonly [number, number, number];
  /**
   * Quaternion [x, y, z, w] derived from the unit-column rotation matrix via
   * Shoemake's trace-branch. Rounded to 4 decimals (AC-05). Degrades to
   * identity `[0, 0, 0, 1]` when any scale component is zero (singular mat4).
   */
  readonly rotation: readonly [number, number, number, number];
  /** Per-instance atlas region [uMin, vMin, uW, vH] — present on 'mat4+region' only. */
  readonly region?: readonly [number, number, number, number];
}

export type InstanceDecodeResult =
  | {
      readonly kind: 'ok';
      readonly variant: InstanceDataVariant;
      readonly instances: readonly DecodedInstance[];
      /** True when instanceCount > INSTANCE_MAX_ROWS — only the first 256 rows are decoded. */
      readonly truncated: boolean;
    }
  /** No group-3 binding-0 / resource is not a buffer / instanceCount === 0. */
  | { readonly kind: 'none' }
  /** Binding + resource present, but tape blobPool has no bytes for this handle. */
  | { readonly kind: 'no-blob' }
  /** Buffer bytes ≥ 64 * instanceCount but not a whole multiple of 64 or 80. */
  | { readonly kind: 'unexpected-stride'; readonly strideBytes: number }
  /** Buffer bytes < 64 * instanceCount — too small even for the mat4 variant. */
  | {
      readonly kind: 'buffer-truncated';
      readonly gotBytes: number;
      readonly expectedBytes: number;
    };

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Decode the InstanceData array bound at `@group(3) @binding(0)` for a draw.
 *
 * Priority order:
 *   1. Missing binding / non-buffer resource / instanceCount === 0 → 'none'
 *   2. Buffer has no blobPool entry                                → 'no-blob'
 *   3. bytes < 64 * instanceCount                                  → 'buffer-truncated'
 *   4. bytes === 64 * instanceCount                                → variant='mat4'
 *   5. bytes === 80 * instanceCount                                → variant='mat4+region'
 *   6. Else                                                        → 'unexpected-stride'
 *
 * The 64-B floor gate keeps the three failure modes disjoint: undersized
 * buffers land as 'buffer-truncated', over/mis-sized as 'unexpected-stride'.
 */
export function decodeInstanceData(
  draw: DrawEntry,
  tape: Tape,
  resources: ReadonlyMap<HandleId, CreateDescriptor>,
): InstanceDecodeResult {
  const binding = findInstanceBinding(draw.bindings);
  if (!binding) return { kind: 'none' };

  const resource = resources.get(binding.handleId);
  if (!resource || resource.kind !== 'createBuffer') return { kind: 'none' };

  const instanceCount = draw.drawCall.instanceCount ?? 0;
  if (instanceCount === 0) return { kind: 'none' };

  const bytes = getBufferBlobData(tape, binding.handleId);
  if (!bytes) return { kind: 'no-blob' };

  const gotBytes = bytes.byteLength;
  const expectedMat4 = 64 * instanceCount;
  const expectedMat4Region = 80 * instanceCount;

  let stride: number;
  let variant: InstanceDataVariant;
  if (gotBytes === expectedMat4) {
    stride = 64;
    variant = 'mat4';
  } else if (gotBytes === expectedMat4Region) {
    stride = 80;
    variant = 'mat4+region';
  } else if (gotBytes < expectedMat4) {
    return { kind: 'buffer-truncated', gotBytes, expectedBytes: expectedMat4 };
  } else {
    return { kind: 'unexpected-stride', strideBytes: Math.floor(gotBytes / instanceCount) };
  }

  const rowCap = Math.min(instanceCount, INSTANCE_MAX_ROWS);
  const truncated = instanceCount > INSTANCE_MAX_ROWS;
  const dv = new DataView(bytes);
  const instances: DecodedInstance[] = [];
  for (let i = 0; i < rowCap; i++) {
    const base = i * stride;
    const trs = decodeMat4TRS(dv, base);
    if (variant === 'mat4+region') {
      instances.push({
        index: i,
        position: trs.position,
        scale: trs.scale,
        rotation: trs.rotation,
        region: readVec4(dv, base + 64),
      });
    } else {
      instances.push({
        index: i,
        position: trs.position,
        scale: trs.scale,
        rotation: trs.rotation,
      });
    }
  }

  return { kind: 'ok', variant, instances, truncated };
}

function findInstanceBinding(
  bindings: readonly InspectBindingEntry[],
): InspectBindingEntry | undefined {
  for (const b of bindings) {
    if (b.groupIndex === 3 && b.entryIndex === 0) return b;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internal math — column-major mat4 → translation / scale / quaternion
// ---------------------------------------------------------------------------

interface Mat4TRS {
  readonly position: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
}

/**
 * Extract translation / column-length scale / quaternion from a column-major
 * mat4 at DataView byte offset `base`.
 *
 * Layout (WGSL `mat4x4<f32>`, column-major, 16 floats):
 *   col0 = m[0..3], col1 = m[4..7], col2 = m[8..11], col3 = m[12..15] (translation).
 *
 * If any column has zero length (singular mat4), rotation degrades to identity
 * — position and scale still resolve. Rotation output is 4-decimal-rounded.
 */
export function decodeMat4TRS(dv: DataView, base: number): Mat4TRS {
  const c0x = dv.getFloat32(base + 0, true);
  const c0y = dv.getFloat32(base + 4, true);
  const c0z = dv.getFloat32(base + 8, true);
  const c1x = dv.getFloat32(base + 16, true);
  const c1y = dv.getFloat32(base + 20, true);
  const c1z = dv.getFloat32(base + 24, true);
  const c2x = dv.getFloat32(base + 32, true);
  const c2y = dv.getFloat32(base + 36, true);
  const c2z = dv.getFloat32(base + 40, true);
  const tx = dv.getFloat32(base + 48, true);
  const ty = dv.getFloat32(base + 52, true);
  const tz = dv.getFloat32(base + 56, true);

  const sx = Math.hypot(c0x, c0y, c0z);
  const sy = Math.hypot(c1x, c1y, c1z);
  const sz = Math.hypot(c2x, c2y, c2z);

  if (sx === 0 || sy === 0 || sz === 0) {
    return {
      position: [tx, ty, tz],
      scale: [sx, sy, sz],
      rotation: [0, 0, 0, 1],
    };
  }

  // Rotation matrix R[row][col] — columns of the mat4 divided by their scale.
  const r00 = c0x / sx;
  const r10 = c0y / sx;
  const r20 = c0z / sx;
  const r01 = c1x / sy;
  const r11 = c1y / sy;
  const r21 = c1z / sy;
  const r02 = c2x / sz;
  const r12 = c2y / sz;
  const r22 = c2z / sz;

  return {
    position: [tx, ty, tz],
    scale: [sx, sy, sz],
    rotation: matrixToQuaternion(r00, r01, r02, r10, r11, r12, r20, r21, r22),
  };
}

/**
 * Shoemake trace-branch quaternion extraction from a 3x3 rotation matrix.
 * Inputs are `R[row][col]` (row-major logical indexing). Output `[x, y, z, w]`
 * is 4-decimal-rounded per AC-05.
 */
function matrixToQuaternion(
  r00: number,
  r01: number,
  r02: number,
  r10: number,
  r11: number,
  r12: number,
  r20: number,
  r21: number,
  r22: number,
): [number, number, number, number] {
  const trace = r00 + r11 + r22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2; // s = 4w
    w = 0.25 * s;
    x = (r21 - r12) / s;
    y = (r02 - r20) / s;
    z = (r10 - r01) / s;
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2; // s = 4x
    w = (r21 - r12) / s;
    x = 0.25 * s;
    y = (r01 + r10) / s;
    z = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2; // s = 4y
    w = (r02 - r20) / s;
    x = (r01 + r10) / s;
    y = 0.25 * s;
    z = (r12 + r21) / s;
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2; // s = 4z
    w = (r10 - r01) / s;
    x = (r02 + r20) / s;
    y = (r12 + r21) / s;
    z = 0.25 * s;
  }

  return [round4(x), round4(y), round4(z), round4(w)];
}

function readVec4(dv: DataView, base: number): [number, number, number, number] {
  return [
    dv.getFloat32(base + 0, true),
    dv.getFloat32(base + 4, true),
    dv.getFloat32(base + 8, true),
    dv.getFloat32(base + 12, true),
  ];
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
