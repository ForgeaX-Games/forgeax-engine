// decode-accessor.ts - glTF 2.0 accessor decoder (w9).
//
// Pure helper that walks one accessor and returns the typed array view of
// its dense values. Tier-B v1 accepts only the dense, fixed-stride,
// non-sparse, non-morph subset; everything else returns
// `gltf-accessor-type-mismatch` with the reason discriminator.
//
// glTF 2.0 spec section 3.6 (accessor):
//   - componentType  : 5120 I8 / 5121 U8 / 5122 I16 / 5123 U16 / 5125 U32 / 5126 F32
//   - type           : 'SCALAR' / 'VEC2' / 'VEC3' / 'VEC4' / 'MAT2' / 'MAT3' / 'MAT4'
//   - bufferView     : index into bufferViews[]
//   - byteOffset     : within bufferView
//   - count          : number of elements
//   - sparse         : OOS (Tier-B v1 reject)
//   - bufferView.byteStride : when set and != element_size -> interleaved (OOS reject)
//
// The U8 -> U16 widening for INDICES is handled inline (a 1-byte index
// stream is rewritten into a fresh Uint16Array). U16 and U32 index streams
// pass through at their source width; `MeshAsset.indices` is
// `Uint16Array | Uint32Array` end-to-end (mesh-bin serializes iwidth 2|4,
// GPU runtime auto-selects the index format), and bridge.ts narrows U32 to
// U16 losslessly when the merged mesh's maxIndex fits.
//
// Producers MUST use `decodeAccessor` rather than reading typed arrays
// directly so the closed `GltfErrorCode` surface (charter proposition 4)
// is the only public failure path.

import { err, type GltfError, gltfErr, ok, type Result } from './errors.js';

/** glTF 2.0 component-type IDs (KHR spec section 3.6 table 4). */
export const COMPONENT_TYPE = {
  I8: 5120,
  U8: 5121,
  I16: 5122,
  U16: 5123,
  U32: 5125,
  F32: 5126,
} as const;
export type ComponentTypeId = (typeof COMPONENT_TYPE)[keyof typeof COMPONENT_TYPE];

/** Number of components per element for each glTF accessor `type` literal. */
const TYPE_COMPONENT_COUNT: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

/** Byte size of one component for each component type. */
const COMPONENT_BYTE_SIZE: Readonly<Record<number, number>> = {
  [COMPONENT_TYPE.I8]: 1,
  [COMPONENT_TYPE.U8]: 1,
  [COMPONENT_TYPE.I16]: 2,
  [COMPONENT_TYPE.U16]: 2,
  [COMPONENT_TYPE.U32]: 4,
  [COMPONENT_TYPE.F32]: 4,
};

/** Minimal accessor JSON shape touched by the decoder. */
export interface AccessorJson {
  readonly bufferView: number;
  readonly byteOffset?: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: string;
  readonly sparse?: unknown;
}

/** Minimal bufferView JSON shape touched by the decoder. */
export interface BufferViewJson {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride?: number;
}

/**
 * Caller intent flag: when this accessor backs a mesh `INDICES` slot, U8
 * indices auto-widen to U16 (Tier-B v1 mesh asset stores U16 only).
 */
export type AccessorRole = 'attribute' | 'indices' | 'joints';

export interface DecodeAccessorInput {
  readonly accessorIndex: number;
  readonly accessor: AccessorJson;
  readonly bufferView: BufferViewJson;
  readonly buffer: Uint8Array;
  readonly role: AccessorRole;
}

export type DecodedAccessor =
  | { readonly kind: 'f32'; readonly data: Float32Array }
  | { readonly kind: 'u16'; readonly data: Uint16Array }
  | { readonly kind: 'u32'; readonly data: Uint32Array };

/**
 * Decode a dense glTF accessor into the typed array view of its values.
 * Rejects sparse / morph / interleaved / unknown-componentType variants
 * with `gltf-accessor-type-mismatch`. Out-of-range byte slices return
 * `gltf-buffer-out-of-bounds`.
 *
 * `morph` is signalled by the caller (mesh primitive iteration in
 * parseGltf) by passing an accessor reached via a `targets[]` slot - the
 * decoder cannot infer it from the accessor JSON alone, so this function
 * surfaces the reason via the `morph` parameter when the caller has
 * already detected it.
 */
export function decodeAccessor(
  input: DecodeAccessorInput,
  flags: { readonly morph?: boolean } = {},
): Result<DecodedAccessor, GltfError> {
  const { accessorIndex, accessor, bufferView, buffer, role } = input;

  if (flags.morph === true) {
    return err(
      gltfErr('gltf-accessor-type-mismatch', {
        accessorIndex,
        reason: 'morph',
      }),
    );
  }

  if ('sparse' in accessor && accessor.sparse !== undefined) {
    return err(
      gltfErr('gltf-accessor-type-mismatch', {
        accessorIndex,
        reason: 'sparse',
      }),
    );
  }

  const componentByteSize = COMPONENT_BYTE_SIZE[accessor.componentType];
  const componentCount = TYPE_COMPONENT_COUNT[accessor.type];
  if (componentByteSize === undefined || componentCount === undefined) {
    return err(
      gltfErr('gltf-accessor-type-mismatch', {
        accessorIndex,
        reason: 'unknownComponentType',
      }),
    );
  }
  const elementSize = componentByteSize * componentCount;
  const byteStride = bufferView.byteStride;
  if (byteStride !== undefined && byteStride !== elementSize) {
    return err(
      gltfErr('gltf-accessor-type-mismatch', {
        accessorIndex,
        reason: 'interleaved',
      }),
    );
  }

  const accessorByteOffset = accessor.byteOffset ?? 0;
  const bufferViewByteOffset = bufferView.byteOffset ?? 0;
  const totalByteLength = elementSize * accessor.count;
  if (accessorByteOffset + totalByteLength > bufferView.byteLength) {
    return err(
      gltfErr('gltf-buffer-out-of-bounds', {
        accessor: accessorIndex,
        byteOffset: bufferViewByteOffset + accessorByteOffset,
        byteLength: totalByteLength,
        bufferIndex: bufferView.buffer,
      }),
    );
  }
  const absoluteOffset = bufferViewByteOffset + accessorByteOffset;
  if (absoluteOffset + totalByteLength > buffer.byteLength) {
    return err(
      gltfErr('gltf-buffer-out-of-bounds', {
        accessor: accessorIndex,
        byteOffset: absoluteOffset,
        byteLength: totalByteLength,
        bufferIndex: bufferView.buffer,
      }),
    );
  }

  // U8 INDICES auto-widen to U16 (Tier-B v1 mesh asset stores U16 only).
  if (role === 'indices' && accessor.componentType === COMPONENT_TYPE.U8) {
    const widened = new Uint16Array(accessor.count);
    for (let i = 0; i < accessor.count; i++) {
      widened[i] = buffer[absoluteOffset + i] ?? 0;
    }
    return ok({ kind: 'u16', data: widened });
  }
  // U8 JOINTS auto-widen to U16 (Tier-B v1 mesh asset stores U16 only).
  // Reuses the indices widen pattern (E-5) but JOINTS_0 is VEC4 (componentCount=4),
  // not SCALAR like INDICES; total values = accessor.count * componentCount.
  if (role === 'joints' && accessor.componentType === COMPONENT_TYPE.U8) {
    const totalValues = accessor.count * componentCount;
    const widened = new Uint16Array(totalValues);
    for (let i = 0; i < totalValues; i++) {
      widened[i] = buffer[absoluteOffset + i] ?? 0;
    }
    return ok({ kind: 'u16', data: widened });
  }
  if (accessor.componentType === COMPONENT_TYPE.F32) {
    // Copy out (rather than alias) so callers may safely mutate / persist
    // the result independent of the underlying GLB BIN chunk lifetime.
    const out = new Float32Array(accessor.count * componentCount);
    const src = new Float32Array(buffer.buffer, buffer.byteOffset + absoluteOffset, out.length);
    out.set(src);
    return ok({ kind: 'f32', data: out });
  }
  if (accessor.componentType === COMPONENT_TYPE.U16) {
    const out = new Uint16Array(accessor.count * componentCount);
    const src = new Uint16Array(buffer.buffer, buffer.byteOffset + absoluteOffset, out.length);
    out.set(src);
    return ok({ kind: 'u16', data: out });
  }
  if (accessor.componentType === COMPONENT_TYPE.U32) {
    const out = new Uint32Array(accessor.count * componentCount);
    const src = new Uint32Array(buffer.buffer, buffer.byteOffset + absoluteOffset, out.length);
    out.set(src);
    return ok({ kind: 'u32', data: out });
  }
  // I8 / I16 not used by Tier-B v1 (POSITION/INDICES only) - reject
  // explicitly so any future caller that tries to decode them sees the
  // closed-union failure path (charter proposition 4).
  return err(
    gltfErr('gltf-accessor-type-mismatch', {
      accessorIndex,
      reason: 'unknownComponentType',
    }),
  );
}
