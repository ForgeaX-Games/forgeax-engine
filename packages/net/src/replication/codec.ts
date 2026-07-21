import { err, ok, type Result } from '@forgeax/engine-types';
import { REPLICATION_PROTOCOL_VERSION } from './constants';
import { NetError } from './errors';
import type { ReplicationLimits } from './profile';

export type NetEntityId = number & { readonly __netEntityId: unique symbol };
export interface ReplicationComponentRecord {
  readonly name: string;
  readonly operation?: 'replace' | 'remove';
  readonly data: Record<string, unknown>;
}
export interface ReplicationEntityRecord {
  readonly id: number;
  readonly kind: 'upsert' | 'despawn';
  readonly components: readonly ReplicationComponentRecord[];
}
export interface ReplicationBatch {
  readonly version: number;
  readonly fingerprint: string;
  readonly tick: number;
  readonly full: boolean;
  readonly entities: readonly ReplicationEntityRecord[];
}

const TYPED_ARRAYS = {
  Float32Array,
  Float64Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Uint8Array,
  Uint8ClampedArray,
  Uint16Array,
  Uint32Array,
} as const;
type TypedArrayName = keyof typeof TYPED_ARRAYS;
type PortableTypedArray = InstanceType<(typeof TYPED_ARRAYS)[TypedArrayName]>;

function typedArrayName(value: unknown): TypedArrayName | undefined {
  for (const [name, typedArrayConstructor] of Object.entries(TYPED_ARRAYS) as [
    TypedArrayName,
    (typeof TYPED_ARRAYS)[TypedArrayName],
  ][]) {
    if (value instanceof typedArrayConstructor) return name;
  }
  return undefined;
}

function canonicalize(value: unknown): unknown {
  const name = typedArrayName(value);
  if (name !== undefined)
    return { $typedArray: name, values: Array.from(value as PortableTypedArray) };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function reviveTypedArrays(
  value: unknown,
): { readonly value: unknown } | { readonly reason: string } {
  if (Array.isArray(value)) {
    const values: unknown[] = [];
    for (const item of value) {
      const revived = reviveTypedArrays(item);
      if ('reason' in revived) return revived;
      values.push(revived.value);
    }
    return { value: values };
  }
  if (value === null || typeof value !== 'object') return { value };
  const record = value as Record<string, unknown>;
  if ('$typedArray' in record || 'values' in record) {
    if (
      Object.keys(record).length !== 2 ||
      typeof record.$typedArray !== 'string' ||
      !Array.isArray(record.values)
    )
      return { reason: 'typed-array tag must contain only an allowlisted name and values array' };
    const typedArrayConstructor = TYPED_ARRAYS[record.$typedArray as TypedArrayName];
    if (
      typedArrayConstructor === undefined ||
      record.values.some((item) => typeof item !== 'number')
    )
      return { reason: 'typed-array tag contains an unsupported type or non-numeric value' };
    return { value: new typedArrayConstructor(record.values) };
  }
  const revived: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    const nested = reviveTypedArrays(item);
    if ('reason' in nested) return nested;
    revived[key] = nested.value;
  }
  return { value: revived };
}
function limitError(limit: string, actual: number, maximum: number): NetError {
  return new NetError({
    code: 'decode-limit-exceeded',
    expected: `${limit} must not exceed ${maximum}`,
    hint: 'reduce the replicated payload or configure matching declared limits',
    detail: { limit, actual, maximum },
  });
}
function validateLimits(
  batch: ReplicationBatch,
  bytes: Uint8Array | undefined,
  limits: ReplicationLimits,
): NetError | null {
  if (bytes !== undefined && bytes.byteLength > limits.maxMessageBytes)
    return limitError('maxMessageBytes', bytes.byteLength, limits.maxMessageBytes);
  if (batch.entities.length > limits.maxEntities)
    return limitError('maxEntities', batch.entities.length, limits.maxEntities);
  let operations = 0;
  const visit = (value: unknown): NetError | null => {
    if (
      typeof value === 'string' &&
      new TextEncoder().encode(value).byteLength > limits.maxStringBytes
    )
      return limitError(
        'maxStringBytes',
        new TextEncoder().encode(value).byteLength,
        limits.maxStringBytes,
      );
    const typedArray = typedArrayName(value);
    if (typedArray !== undefined) {
      const contents = value as PortableTypedArray;
      if (contents.byteLength > limits.maxBufferBytes)
        return limitError('maxBufferBytes', contents.byteLength, limits.maxBufferBytes);
      if (contents.length > limits.maxArrayElements)
        return limitError('maxArrayElements', contents.length, limits.maxArrayElements);
      return null;
    }
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayElements)
        return limitError('maxArrayElements', value.length, limits.maxArrayElements);
      for (const item of value) {
        const problem = visit(item);
        if (problem) return problem;
      }
    }
    if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array))
      for (const item of Object.values(value as Record<string, unknown>)) {
        const problem = visit(item);
        if (problem) return problem;
      }
    return null;
  };
  for (const entity of batch.entities) {
    operations += entity.components.length;
    for (const component of entity.components) {
      const problem = visit(component.data);
      if (problem) return problem;
    }
  }
  return operations > limits.maxComponentOperations
    ? limitError('maxComponentOperations', operations, limits.maxComponentOperations)
    : null;
}
function parse(
  bytes: Uint8Array,
): { readonly batch: ReplicationBatch } | { readonly reason: string } {
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const revived = reviveTypedArrays(decoded);
    if ('reason' in revived) return revived;
    if (revived.value === null || typeof revived.value !== 'object')
      return { reason: 'batch must be an object' };
    const batch = revived.value as Partial<ReplicationBatch>;
    if (
      !Array.isArray(batch.entities) ||
      typeof batch.fingerprint !== 'string' ||
      !Number.isSafeInteger(batch.tick) ||
      !Number.isSafeInteger(batch.version) ||
      typeof batch.full !== 'boolean'
    )
      return { reason: 'batch envelope has an invalid field type' };
    for (const [entityIndex, entity] of batch.entities.entries()) {
      if (entity === null || typeof entity !== 'object')
        return { reason: `entity record ${entityIndex} must be an object` };
      const record = entity as Partial<ReplicationEntityRecord>;
      if (
        !Number.isSafeInteger(record.id) ||
        (record.kind !== 'upsert' && record.kind !== 'despawn') ||
        !Array.isArray(record.components)
      )
        return { reason: `entity record ${entityIndex} has an invalid field type` };
      for (const [componentIndex, component] of record.components.entries()) {
        if (component === null || typeof component !== 'object')
          return { reason: `component record ${entityIndex}:${componentIndex} must be an object` };
        const entry = component as Partial<ReplicationComponentRecord>;
        if (
          typeof entry.name !== 'string' ||
          entry.name.length === 0 ||
          (entry.operation !== undefined &&
            entry.operation !== 'replace' &&
            entry.operation !== 'remove') ||
          entry.data === null ||
          typeof entry.data !== 'object' ||
          Array.isArray(entry.data) ||
          (entry.operation === 'remove' && Object.keys(entry.data).length !== 0)
        )
          return {
            reason: `component record ${entityIndex}:${componentIndex} has an invalid field type`,
          };
      }
    }
    return { batch: batch as ReplicationBatch };
  } catch {
    return { reason: 'payload is not valid JSON' };
  }
}
export function encodeReplicationBatch(
  batch: ReplicationBatch,
  limits: ReplicationLimits,
): Result<Uint8Array, NetError> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(batch)));
  const failure = validateLimits(batch, bytes, limits);
  return failure ? err(failure) : ok(bytes);
}
export function decodeReplicationBatch(
  bytes: Uint8Array,
  limits: ReplicationLimits,
): Result<ReplicationBatch, NetError> {
  if (bytes.byteLength > limits.maxMessageBytes)
    return err(limitError('maxMessageBytes', bytes.byteLength, limits.maxMessageBytes));
  const parsed = parse(bytes);
  if ('reason' in parsed || parsed.batch.version !== REPLICATION_PROTOCOL_VERSION)
    return err(
      new NetError({
        code: 'decode-invalid-payload',
        expected: `a version ${REPLICATION_PROTOCOL_VERSION} canonical replication batch`,
        hint: 'send bytes produced by the replication codec for the negotiated protocol',
        detail: {
          reason:
            'reason' in parsed
              ? parsed.reason
              : 'batch protocol version does not match the decoder',
        },
      }),
    );
  const failure = validateLimits(parsed.batch, bytes, limits);
  return failure ? err(failure) : ok(parsed.batch);
}
