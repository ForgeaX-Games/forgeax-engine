import type { Handle } from '@forgeax/engine-types';
import { err, ok, type Result, toShared } from '@forgeax/engine-types';
import { type VfxError, vfxError } from './errors.js';

export interface ParticleBillboardAttributes {
  readonly position: Float32Array;
  readonly size: Float32Array;
  readonly color: Float32Array;
}

export interface ParticleMeshAttributes {
  readonly transform: Float32Array;
  readonly color: Float32Array;
}

export interface ParticleBillboardBatch {
  readonly kind: 'billboard';
  readonly material: Handle<'MaterialAsset', 'shared'>;
  readonly count: number;
  readonly attributes: ParticleBillboardAttributes;
}

export interface ParticleMeshBatch {
  readonly kind: 'mesh';
  readonly material: Handle<'MaterialAsset', 'shared'>;
  readonly mesh: Handle<'MeshAsset', 'shared'>;
  readonly count: number;
  readonly attributes: ParticleMeshAttributes;
}

export type ParticleOutputBatch = ParticleBillboardBatch | ParticleMeshBatch;

export interface ParticleRenderBatch {
  readonly batches: readonly ParticleOutputBatch[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(output: string, index: number, path: string): Result<never, VfxError> {
  return err(
    vfxError('vfx-batch-invalid', {
      output,
      index,
      path,
    }),
  );
}

function readHandle<T extends string>(
  value: unknown,
  output: string,
  index: number,
  path: string,
): Result<Handle<T, 'shared'>, VfxError> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return invalid(output, index, path);
  }
  return ok(toShared<T>(value));
}

function readCount(
  value: unknown,
  output: string,
  index: number,
  path: string,
): Result<number, VfxError> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return invalid(output, index, path);
  }
  return ok(value);
}

function readMaterial(
  value: unknown,
  output: string,
  index: number,
): Result<Handle<'MaterialAsset', 'shared'>, VfxError> {
  return readHandle<'MaterialAsset'>(value, output, index, `batches[${index}].material`);
}

function readFloat32(
  value: unknown,
  output: string,
  index: number,
  path: string,
): Result<Float32Array, VfxError> {
  if (!(value instanceof Float32Array)) return invalid(output, index, path);
  return ok(value);
}

function validateStride(
  attribute: Float32Array,
  count: number,
  stride: number,
  output: string,
  index: number,
  path: string,
): Result<Float32Array, VfxError> {
  if (attribute.length !== count * stride) return invalid(output, index, path);
  return ok(attribute);
}

function readAttribute(
  value: unknown,
  count: number,
  stride: number,
  output: string,
  index: number,
  path: string,
): Result<Float32Array, VfxError> {
  const attribute = readFloat32(value, output, index, path);
  if (!attribute.ok) return attribute;
  return validateStride(attribute.value, count, stride, output, index, path);
}

function readColor(
  value: unknown,
  count: number,
  output: string,
  index: number,
): Result<Float32Array, VfxError> {
  return readAttribute(value, count, 4, output, index, `batches[${index}].attributes.color`);
}

function readNamedAttribute(
  value: unknown,
  count: number,
  stride: number,
  output: string,
  index: number,
  name: string,
): Result<Float32Array, VfxError> {
  return readAttribute(value, count, stride, output, index, `batches[${index}].attributes.${name}`);
}

function validateBillboard(
  value: Record<string, unknown>,
  index: number,
): Result<ParticleBillboardBatch, VfxError> {
  const output = 'billboard';
  const material = readMaterial(value.material, output, index);
  if (!material.ok) return material;
  const count = readCount(value.count, output, index, `batches[${index}].count`);
  if (!count.ok) return count;
  if (!isRecord(value.attributes)) {
    return invalid(output, index, `batches[${index}].attributes`);
  }
  const position = readNamedAttribute(
    value.attributes.position,
    count.value,
    3,
    output,
    index,
    'position',
  );
  if (!position.ok) return position;
  const size = readAttribute(
    value.attributes.size,
    count.value,
    2,
    output,
    index,
    `batches[${index}].attributes.size`,
  );
  if (!size.ok) return size;
  const color = readColor(value.attributes.color, count.value, output, index);
  if (!color.ok) return color;
  return ok({
    kind: 'billboard',
    material: material.value,
    count: count.value,
    attributes: {
      position: position.value,
      size: size.value,
      color: color.value,
    },
  });
}

function validateMesh(
  value: Record<string, unknown>,
  index: number,
): Result<ParticleMeshBatch, VfxError> {
  const output = 'mesh';
  const material = readMaterial(value.material, output, index);
  if (!material.ok) return material;
  const mesh = readHandle<'MeshAsset'>(value.mesh, output, index, `batches[${index}].mesh`);
  if (!mesh.ok) return mesh;
  const count = readCount(value.count, output, index, `batches[${index}].count`);
  if (!count.ok) return count;
  if (!isRecord(value.attributes)) {
    return invalid(output, index, `batches[${index}].attributes`);
  }
  const transform = readNamedAttribute(
    value.attributes.transform,
    count.value,
    16,
    output,
    index,
    'transform',
  );
  if (!transform.ok) return transform;
  const color = readColor(value.attributes.color, count.value, output, index);
  if (!color.ok) return color;
  return ok({
    kind: 'mesh',
    material: material.value,
    mesh: mesh.value,
    count: count.value,
    attributes: {
      transform: transform.value,
      color: color.value,
    },
  });
}

function validateOutput(value: unknown, index: number): Result<ParticleOutputBatch, VfxError> {
  if (!isRecord(value)) return invalid('unknown', index, `batches[${index}]`);
  const output = typeof value.kind === 'string' ? value.kind : 'unknown';
  if (output === 'billboard') return validateBillboard(value, index);
  if (output === 'mesh') return validateMesh(value, index);
  return invalid(output, index, `batches[${index}].kind`);
}

export function validateParticleRenderBatch(value: unknown): Result<ParticleRenderBatch, VfxError> {
  if (!isRecord(value) || !Array.isArray(value.batches)) {
    return invalid('unknown', -1, 'batches');
  }
  const batches: ParticleOutputBatch[] = [];
  for (const [index, candidate] of value.batches.entries()) {
    const result = validateOutput(candidate, index);
    if (!result.ok) return result;
    batches.push(result.value);
  }
  return ok({ batches: Object.freeze(batches) });
}

export function createParticleRenderBatch(
  batches: readonly ParticleOutputBatch[],
): Result<ParticleRenderBatch, VfxError> {
  return validateParticleRenderBatch({ batches });
}
