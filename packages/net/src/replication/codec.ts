import { err, ok, type Result } from '@forgeax/engine-types';
import { REPLICATION_PROTOCOL_PREFIX, REPLICATION_PROTOCOL_VERSION } from './constants';
import { NetError } from './errors';
import type { ReplicationLimits } from './profile';
import type { ReplicationDataPacket, ReplicationEntityRecord, ReplicationPacket } from './protocol';

export type { ReplicationComponentRecord, ReplicationEntityRecord } from './protocol';

type PortableTypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array;

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

const PACKET_KINDS = [
  'session-open',
  'session-resume',
  'baseline',
  'delta',
  'ack',
  'rejection',
] as const satisfies readonly ReplicationPacket['kind'][];

const REPLICATION_ENTITY_KINDS = [
  'upsert',
  'despawn',
] as const satisfies readonly ReplicationEntityRecord['kind'][];

function isPacketKind(value: unknown): value is ReplicationPacket['kind'] {
  return PACKET_KINDS.some((kind) => kind === value);
}

function isReplicationEntityKind(value: unknown): value is ReplicationEntityRecord['kind'] {
  return REPLICATION_ENTITY_KINDS.some((kind) => kind === value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSessionId(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

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
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
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
  if ('$typedArray' in record) {
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

function invalid(reason: string): NetError {
  return new NetError({
    code: 'decode-invalid-payload',
    expected: `a version ${REPLICATION_PROTOCOL_VERSION} ${REPLICATION_PROTOCOL_PREFIX} packet`,
    hint: 'send bytes produced by the protocol-v2 replication codec',
    detail: { reason },
  });
}

function validateEntities(entities: readonly ReplicationEntityRecord[]): string | undefined {
  const ids = new Set<number>();
  for (const [entityIndex, entity] of entities.entries()) {
    if (
      entity === null ||
      typeof entity !== 'object' ||
      !isSafeNonNegativeInteger(entity.id) ||
      !isReplicationEntityKind(entity.kind) ||
      !Array.isArray(entity.components) ||
      ids.has(entity.id)
    )
      return `entity record ${entityIndex} has an invalid or duplicate identity`;
    ids.add(entity.id);
    for (const [componentIndex, component] of entity.components.entries()) {
      if (
        component === null ||
        typeof component !== 'object' ||
        typeof component.name !== 'string' ||
        component.name.length === 0 ||
        (component.operation !== undefined &&
          component.operation !== 'replace' &&
          component.operation !== 'remove') ||
        component.data === null ||
        typeof component.data !== 'object' ||
        Array.isArray(component.data) ||
        (component.operation === 'remove' && Object.keys(component.data).length !== 0)
      )
        return `component record ${entityIndex}:${componentIndex} has invalid fields`;
    }
  }
  return undefined;
}

function validatePacket(packet: ReplicationPacket): string | undefined {
  if (packet.version !== REPLICATION_PROTOCOL_VERSION)
    return 'packet protocol version is unsupported';
  if (!isPacketKind(packet.kind)) return 'packet kind is unsupported';
  if (!isSessionId(packet.sessionId)) return 'sessionId must be a positive safe integer';
  if (!isSafeNonNegativeInteger(packet.epoch)) return 'epoch must be a non-negative safe integer';
  if (packet.kind === 'session-open' || packet.kind === 'session-resume')
    return packet.sequence === 0 ? undefined : 'session control sequence must be zero';
  if (packet.kind === 'ack')
    return isSafeNonNegativeInteger(packet.acknowledgedSequence)
      ? undefined
      : 'acknowledgedSequence must be a non-negative safe integer';
  if (!isSafeNonNegativeInteger(packet.sequence) || packet.sequence === 0)
    return 'sequence must be a positive safe integer';
  if (packet.kind === 'baseline' && packet.sequence !== 1) return 'baseline sequence must be one';
  if (packet.kind === 'rejection') {
    if (!isPacketKind(packet.rejectedKind) || typeof packet.reason !== 'string')
      return 'rejection details are invalid';
    return undefined;
  }
  if (packet.kind !== 'baseline' && packet.kind !== 'delta')
    return 'packet kind does not carry a data payload';
  if (typeof packet.tick !== 'number' || !Number.isSafeInteger(packet.tick))
    return 'tick must be a safe integer';
  if (typeof packet.fingerprint !== 'string') return 'fingerprint must be a string';
  return validateEntities(packet.entities);
}

function validateLimits(
  packet: ReplicationDataPacket,
  bytes: Uint8Array | undefined,
  limits: ReplicationLimits,
): NetError | null {
  if (bytes !== undefined && bytes.byteLength > limits.maxMessageBytes)
    return limitError('maxMessageBytes', bytes.byteLength, limits.maxMessageBytes);
  if (packet.entities.length > limits.maxEntities)
    return limitError('maxEntities', packet.entities.length, limits.maxEntities);
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
  for (const entity of packet.entities) {
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
): { readonly packet: ReplicationPacket } | { readonly error: NetError } {
  const text = new TextDecoder().decode(bytes);
  const separator = text.indexOf('\n');
  if (separator < 0 || text.slice(0, separator) !== REPLICATION_PROTOCOL_PREFIX)
    return { error: invalid('packet prefix does not match protocol-v2') };
  try {
    const decoded: unknown = JSON.parse(text.slice(separator + 1));
    const revived = reviveTypedArrays(decoded);
    if ('reason' in revived) return { error: invalid(revived.reason) };
    if (revived.value === null || typeof revived.value !== 'object')
      return { error: invalid('packet must be an object') };
    const packet = revived.value as ReplicationPacket;
    const reason = validatePacket(packet);
    if (reason !== undefined) {
      if (typeof packet.version === 'number' && packet.version !== REPLICATION_PROTOCOL_VERSION)
        return {
          error: new NetError({
            code: 'protocol-unsupported-version',
            expected: `protocol version ${REPLICATION_PROTOCOL_VERSION}`,
            hint: 'upgrade the peer before sending replicated bytes',
            detail: {
              receivedVersion: packet.version,
              supportedVersion: REPLICATION_PROTOCOL_VERSION,
            },
          }),
        };
      return { error: invalid(reason) };
    }
    return { packet };
  } catch {
    return { error: invalid('payload is not valid JSON') };
  }
}

function isDataPacket(packet: ReplicationPacket): packet is ReplicationDataPacket {
  return packet.kind === 'baseline' || packet.kind === 'delta';
}

export function encodeReplicationPacket(
  packet: ReplicationPacket,
  limits: ReplicationLimits,
): Result<Uint8Array, NetError> {
  const reason = validatePacket(packet);
  if (reason !== undefined) return err(invalid(reason));
  const body = JSON.stringify(canonicalize(packet));
  const bytes = new TextEncoder().encode(`${REPLICATION_PROTOCOL_PREFIX}\n${body}`);
  const failure = isDataPacket(packet) ? validateLimits(packet, bytes, limits) : null;
  return failure ? err(failure) : ok(bytes);
}

export function decodeReplicationPacket(
  bytes: Uint8Array,
  limits: ReplicationLimits,
): Result<ReplicationPacket, NetError> {
  if (bytes.byteLength > limits.maxMessageBytes)
    return err(limitError('maxMessageBytes', bytes.byteLength, limits.maxMessageBytes));
  const parsed = parse(bytes);
  if ('error' in parsed) return err(parsed.error);
  const failure = isDataPacket(parsed.packet) ? validateLimits(parsed.packet, bytes, limits) : null;
  return failure ? err(failure) : ok(parsed.packet);
}
