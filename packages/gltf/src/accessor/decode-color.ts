import { err, gltfErr, ok, type Result } from '../errors.js';
import type { AccessorJson, BufferViewJson } from './decode-accessor.js';

export interface DecodeColorAccessorInput {
  readonly accessorIndex: number;
  readonly accessor: AccessorJson;
  readonly bufferView: BufferViewJson;
  readonly buffer: Uint8Array;
  readonly bufferIndex?: number;
  readonly semantic: 'COLOR_0';
}

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;

function unsupported(
  input: DecodeColorAccessorInput,
  reason: 'component' | 'type' | 'normalized' | 'sparse' | 'morph',
) {
  return err(
    gltfErr('gltf-color-accessor-unsupported', {
      semantic: input.semantic,
      accessorIndex: input.accessorIndex,
      reason,
      expectedType: 'VEC3 or VEC4',
      expectedComponent: 'FLOAT or normalized UNSIGNED_BYTE/UNSIGNED_SHORT',
      ...(reason === 'normalized' ? { expectedNormalized: true } : {}),
    }),
  );
}

function malformed(
  input: DecodeColorAccessorInput,
  reason: 'count' | 'bounds' | 'finite' | 'range' | 'reference',
) {
  return err(
    gltfErr('gltf-color-accessor-malformed', {
      semantic: input.semantic,
      accessorIndex: input.accessorIndex,
      reason,
      ...(reason === 'count'
        ? { expectedCount: 'matches POSITION vertex count and is greater than zero' }
        : {}),
      ...(reason === 'range' || reason === 'finite'
        ? { expectedRange: '[0,1] finite linear values' }
        : {}),
    }),
  );
}

/** Decode one dense glTF COLOR_0 accessor into linear RGBA float values. */
export function decodeColorAccessor(
  input: DecodeColorAccessorInput,
  flags: { readonly morph?: boolean } = {},
): Result<Float32Array, import('../errors.js').GltfError> {
  const { accessor, bufferView, buffer } = input;
  if (flags.morph === true) return unsupported(input, 'morph');
  if (accessor.sparse !== undefined) return unsupported(input, 'sparse');

  if (accessor.type !== 'VEC3' && accessor.type !== 'VEC4') return unsupported(input, 'type');
  if (!Number.isSafeInteger(accessor.count) || accessor.count <= 0)
    return malformed(input, 'count');

  let componentByteSize: 1 | 2 | 4;
  if (accessor.componentType === FLOAT) componentByteSize = 4;
  else if (accessor.componentType === UNSIGNED_BYTE) componentByteSize = 1;
  else if (accessor.componentType === UNSIGNED_SHORT) componentByteSize = 2;
  else return unsupported(input, 'component');

  if (accessor.componentType === FLOAT) {
    if (accessor.normalized !== undefined) return unsupported(input, 'normalized');
  } else if (accessor.normalized !== true) {
    return unsupported(input, 'normalized');
  }

  const componentCount = accessor.type === 'VEC3' ? 3 : 4;
  const elementByteLength = componentByteSize * componentCount;
  const byteStride = bufferView.byteStride ?? elementByteLength;
  if (
    !Number.isSafeInteger(byteStride) ||
    byteStride < elementByteLength ||
    byteStride % componentByteSize !== 0
  ) {
    return malformed(input, 'bounds');
  }
  if (input.bufferIndex !== undefined && bufferView.buffer !== input.bufferIndex) {
    return malformed(input, 'reference');
  }

  const accessorByteOffset = accessor.byteOffset ?? 0;
  const viewByteOffset = bufferView.byteOffset ?? 0;
  const lastElementEnd = accessorByteOffset + byteStride * (accessor.count - 1) + elementByteLength;
  if (
    !Number.isSafeInteger(accessorByteOffset) ||
    accessorByteOffset < 0 ||
    lastElementEnd > bufferView.byteLength
  ) {
    return malformed(input, 'bounds');
  }
  const absoluteLastElementEnd = viewByteOffset + lastElementEnd;
  if (
    !Number.isSafeInteger(viewByteOffset) ||
    viewByteOffset < 0 ||
    absoluteLastElementEnd > buffer.byteLength
  ) {
    return malformed(input, 'bounds');
  }

  const output = new Float32Array(accessor.count * 4);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const base = viewByteOffset + accessorByteOffset;
  for (let vertex = 0; vertex < accessor.count; vertex++) {
    const sourceOffset = base + vertex * byteStride;
    for (let component = 0; component < componentCount; component++) {
      const byteOffset = sourceOffset + component * componentByteSize;
      let value: number;
      if (accessor.componentType === FLOAT) value = view.getFloat32(byteOffset, true);
      else if (accessor.componentType === UNSIGNED_BYTE) value = view.getUint8(byteOffset) / 255;
      else value = view.getUint16(byteOffset, true) / 65535;
      if (!Number.isFinite(value)) return malformed(input, 'finite');
      if (value < 0 || value > 1) return malformed(input, 'range');
      output[vertex * 4 + component] = value;
    }
    if (componentCount === 3) output[vertex * 4 + 3] = 1;
  }
  return ok(output);
}
