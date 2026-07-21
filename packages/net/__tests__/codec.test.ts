import { describe, expect, it } from 'vitest';
import { decodeReplicationBatch, encodeReplicationBatch } from '../src/replication/codec';
import { DEFAULT_REPLICATION_LIMITS, REPLICATION_PROTOCOL_VERSION } from '../src/replication/constants';

describe('canonical replication codec', () => {
  const batch = {
    version: REPLICATION_PROTOCOL_VERSION,
    fingerprint: 'a1b2c3d4',
    tick: 7,
    full: true,
    entities: [
      {
        id: 1,
        kind: 'upsert' as const,
        components: [{ name: 'PositionCodec', data: { x: 1, y: 2 } }],
      },
    ],
  };

  it('emits stable bytes for an equivalent ordered batch', () => {
    const first = encodeReplicationBatch(batch, DEFAULT_REPLICATION_LIMITS);
    const second = encodeReplicationBatch({ ...batch }, DEFAULT_REPLICATION_LIMITS);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).toEqual(second.value);
  });

  it('round-trips version, fingerprint, tick, and ordered records', () => {
    const encoded = encodeReplicationBatch(batch, DEFAULT_REPLICATION_LIMITS);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    const decoded = decodeReplicationBatch(encoded.value, DEFAULT_REPLICATION_LIMITS);
    expect(decoded).toEqual({ ok: true, value: batch });
  });

  it('round-trips allowlisted buffer and numeric typed-array payloads', () => {
    const typedBatch = {
      ...batch,
      entities: [
        {
          ...batch.entities[0]!,
          components: [{ name: 'PositionCodec', data: { bytes: new Uint8Array([1, 2]), coords: new Float32Array([1.5, 2.5]), signed: new Int8Array([-1, 1]), clamped: new Uint8ClampedArray([0, 255]) } }],
        },
      ],
    };
    const encoded = encodeReplicationBatch(typedBatch, DEFAULT_REPLICATION_LIMITS);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    const decoded = decodeReplicationBatch(encoded.value, DEFAULT_REPLICATION_LIMITS);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const data = decoded.value.entities[0]!.components[0]!.data;
    expect(data.bytes).toEqual(new Uint8Array([1, 2]));
    expect(data.coords).toEqual(new Float32Array([1.5, 2.5]));
    expect(data.signed).toEqual(new Int8Array([-1, 1]));
    expect(data.clamped).toEqual(new Uint8ClampedArray([0, 255]));
  });

  it('rejects malformed typed-array tags before yielding a batch', () => {
    const malformed = { ...batch, entities: [{ ...batch.entities[0]!, components: [{ name: 'PositionCodec', data: { bytes: { $typedArray: 'Uint8Array', values: [1, 'bad'] } } }] }] };
    const decoded = decodeReplicationBatch(new TextEncoder().encode(JSON.stringify(malformed)), DEFAULT_REPLICATION_LIMITS);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.code).toBe('decode-invalid-payload');
  });

  it('rejects a component removal that carries replacement data', () => {
    const malformed = {
      ...batch,
      entities: [{ id: 1, kind: 'upsert', components: [{ name: 'PositionCodec', operation: 'remove', data: { x: 1 } }] }],
    };
    const decoded = decodeReplicationBatch(
      new TextEncoder().encode(JSON.stringify(malformed)),
      DEFAULT_REPLICATION_LIMITS,
    );
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.code).toBe('decode-invalid-payload');
  });

  it('rejects unknown and truncated payloads with structured decode errors', () => {
    const unknown = decodeReplicationBatch(new Uint8Array([0xff]), DEFAULT_REPLICATION_LIMITS);
    const truncated = decodeReplicationBatch(new TextEncoder().encode('{'), DEFAULT_REPLICATION_LIMITS);
    expect(unknown.ok).toBe(false);
    expect(truncated.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('decode-invalid-payload');
      expect(unknown.error.expected).not.toHaveLength(0);
      expect(unknown.error.hint).not.toHaveLength(0);
    }
  });

  it.each([
    { ...batch, entities: [null] },
    { ...batch, entities: [{ id: 1, kind: 'upsert', components: [null] }] },
    { ...batch, entities: [{ id: 1, kind: 'upsert', components: [{ name: 'PositionCodec', data: null }] }] },
  ])('rejects malformed decoded records before replica validation', (malformed) => {
    const bytes = new TextEncoder().encode(JSON.stringify(malformed));
    const decoded = decodeReplicationBatch(bytes, DEFAULT_REPLICATION_LIMITS);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.code).toBe('decode-invalid-payload');
    expect(decoded.error.detail).toMatchObject({ reason: expect.any(String) });
  });

  it('enforces declared message, entity, component, string, buffer, and array limits', () => {
    const limits = {
      maxMessageBytes: 4096,
      maxEntities: 0,
      maxComponentOperations: 0,
      maxStringBytes: 1,
      maxBufferBytes: 1,
      maxArrayElements: 0,
    };
    const encoded = encodeReplicationBatch(batch, limits);
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.error.code).toBe('decode-limit-exceeded');
    expect(encoded.error.detail.limit).toBe('maxEntities');
  });
});
