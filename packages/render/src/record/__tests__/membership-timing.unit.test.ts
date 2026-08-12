import type {
  Buffer,
  CommandBuffer,
  QuerySet,
  RhiCommandEncoder,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMembershipTiming,
  MEMBERSHIP_TIMING_REASON_CODES,
  MEMBERSHIP_TIMING_REASON_MAPPING,
  MEMBERSHIP_TIMING_REASON_SCHEMA,
} from '../membership-timing';

function device(caps: Partial<RhiDevice['caps']>): RhiDevice {
  return { caps } as unknown as RhiDevice;
}

type FakeBuffer = Buffer & { data: Uint8Array; label: string; destroyed: boolean };

function fakeGpuDevice(
  options: {
    queueCompletion?: Promise<void>;
    mapErrorLabel?: string;
    rangeErrorLabel?: string;
    failBufferLabel?: string;
    timestampTicks?: readonly [bigint, bigint];
    timestampPeriodNanoseconds?: number | null;
    writeTimestampError?: string;
    resolveError?: string;
  } = {},
) {
  const buffers: FakeBuffer[] = [];
  const state = {
    destroyedBuffers: [] as FakeBuffer[],
    destroyedQuerySets: [] as QuerySet[],
    queueCompletion: options.queueCompletion ?? Promise.resolve(),
  };
  const makeBuffer = (label: string, size: number): FakeBuffer => {
    const value = { data: new Uint8Array(size), label, destroyed: false } as FakeBuffer;
    buffers.push(value);
    return value;
  };
  const rawDeviceValue = {
    caps: {
      backendKind: 'webgpu',
      compute: true,
      timestampQuery: true,
      timestampPeriodNanoseconds:
        options.timestampPeriodNanoseconds === undefined ? 2 : options.timestampPeriodNanoseconds,
    },
    queue: {
      onSubmittedWorkDone: () => state.queueCompletion,
    },
    createBuffer: (descriptor: { label?: string; size?: number }) => {
      const buffer = makeBuffer(descriptor.label ?? 'unnamed', descriptor.size ?? 0);
      return { ok: true, value: buffer };
    },
    destroyBuffer: (buffer: FakeBuffer) => {
      if (!buffer.destroyed) {
        buffer.destroyed = true;
        state.destroyedBuffers.push(buffer);
      }
      return { ok: true, value: undefined };
    },
    createQuerySet: () => {
      const querySet = {} as QuerySet;
      return { ok: true, value: querySet };
    },
    destroyQuerySet: (querySet: QuerySet) => {
      state.destroyedQuerySets.push(querySet);
      return { ok: true, value: undefined };
    },
  };
  const deviceValue = rawDeviceValue as unknown as RhiDevice;
  const encoder = {
    writeTimestamp: () => {
      if (options.writeTimestampError !== undefined) throw new Error(options.writeTimestampError);
    },
    resolveQuerySet: (
      _querySet: QuerySet,
      _first: number,
      _count: number,
      destination: FakeBuffer,
    ) => {
      if (options.resolveError !== undefined)
        return { ok: false, error: { hint: options.resolveError } };
      const timestamps = new BigUint64Array(destination.data.buffer);
      timestamps[0] = options.timestampTicks?.[0] ?? 10n;
      timestamps[1] = options.timestampTicks?.[1] ?? 20n;
      return { ok: true, value: undefined };
    },
    copyBufferToBuffer: (
      source: FakeBuffer,
      sourceOffset: number,
      destination: FakeBuffer,
      destinationOffset: number,
      size: number,
    ) => {
      destination.data.set(
        source.data.subarray(sourceOffset, sourceOffset + size),
        destinationOffset,
      );
    },
  } as unknown as RhiCommandEncoder;
  const originalCreateBuffer = rawDeviceValue.createBuffer;
  rawDeviceValue.createBuffer = (descriptor: { label?: string; size?: number }) => {
    if (options.failBufferLabel === descriptor.label)
      return {
        ok: false,
        error: { hint: 'fake buffer allocation failure' },
      } as unknown as ReturnType<typeof originalCreateBuffer>;
    const result = originalCreateBuffer(descriptor);
    Object.assign(result.value, {
      mapAsync: async () => {
        if (options.mapErrorLabel === result.value.label)
          return { ok: false, error: { hint: 'fake map failure' } };
        return {
          ok: true,
          value: {
            getMappedRange: (offset = 0, size = result.value.data.byteLength) =>
              options.rangeErrorLabel === result.value.label
                ? { ok: false, error: { hint: 'fake range failure' } }
                : {
                    ok: true,
                    value: result.value.data.buffer.slice(offset, offset + size),
                  },
            unmap: () => {},
          },
        };
      },
    });
    return result;
  };
  return {
    device: deviceValue,
    encoder,
    state,
    sourceBuffer: (label: string, bytes: number[]) => {
      const buffer = makeBuffer(label, bytes.length);
      buffer.data.set(bytes);
      return buffer;
    },
  };
}

function recordGpuSource(fake: ReturnType<typeof fakeGpuDevice>) {
  return {
    clusterGridBuffer: fake.sourceBuffer(
      'cluster-grid',
      [1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0],
    ),
    clusterGridBytes: 16,
    lightIndexListBuffer: fake.sourceBuffer('light-index-list', [9, 0, 0, 0, 10, 0, 0, 0]),
    lightIndexListBytes: 8,
    lightCount: 32,
    grid: { x: 2, y: 2, z: 1 },
    attemptedTotal: 2,
    writtenTotal: 2,
    capacity: 65536,
    overflow: false,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('membership timing contract', () => {
  it('keeps the reason vocabulary closed and exhaustively mapped', () => {
    expect(Object.keys(MEMBERSHIP_TIMING_REASON_MAPPING).sort()).toEqual(
      [...MEMBERSHIP_TIMING_REASON_CODES].sort(),
    );
  });

  it('refuses unsupported GPU timing before query allocation', () => {
    const timing = createMembershipTiming(
      device({
        backendKind: 'wgpu-webgl2',
        compute: false,
        timestampQuery: false,
        timestampPeriodNanoseconds: null,
      }),
      { mode: 'gpu' },
    );
    const result = timing.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timestamp-query-unsupported');
  });

  it('keeps CPU control independent of timestamps', async () => {
    const timing = createMembershipTiming(
      device({
        backendKind: 'null',
        compute: true,
        timestampQuery: false,
        timestampPeriodNanoseconds: null,
      }),
      { mode: 'cpu-control' },
    );
    expect(timing.start().ok).toBe(true);
    timing.recordMembershipOutput({
      schemaVersion: 1,
      lightCount: 32,
      grid: { x: 16, y: 9, z: 24 },
      clusterOffsetsAndCounts: [0, 1],
      attemptedTotal: 1,
      writtenTotal: 1,
      capacity: 65536,
      overflow: false,
      lightIndexPrefix: [0],
    });
    timing.markEncodeFinished();
    timing.markSubmitStarted();
    timing.markSubmitted({} as CommandBuffer);
    const result = await timing.finish();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.actualProducer).toBe('cpu');
      expect(result.value.gpu).toBeNull();
      expect(result.value.membership?.lightCount).toBe(32);
    }
  });

  it('exports the Render-owned reason schema projection', () => {
    expect(MEMBERSHIP_TIMING_REASON_SCHEMA.$id).toBe(
      'https://forgeax.dev/schemas/render/membership-timing-reason-code.schema.json',
    );
    expect(MEMBERSHIP_TIMING_REASON_SCHEMA.enum).toEqual(MEMBERSHIP_TIMING_REASON_CODES);
  });

  it('rejects invalid pending bounds', () => {
    const timing = createMembershipTiming(
      device({
        backendKind: 'webgpu',
        compute: true,
        timestampQuery: true,
        timestampPeriodNanoseconds: 1,
      }),
      { mode: 'gpu', maxPendingCaptures: 9 },
    );
    const result = timing.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-options');
  });

  it('brackets the real producer and reads canonical membership output before releasing resources', async () => {
    const fake = fakeGpuDevice();
    const timing = createMembershipTiming(fake.device, { mode: 'gpu' });
    expect(timing.start().ok).toBe(true);
    timing.recordGpuMembershipSource(recordGpuSource(fake));
    timing.beforeMembership(fake.encoder);
    timing.afterMembership(fake.encoder);
    timing.markEncodeFinished();
    timing.markSubmitStarted();
    timing.markSubmitted({} as CommandBuffer);

    const result = await timing.finish();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.actualProducer).toBe('gpu');
      expect(result.value.gpu?.rawBeginTick).toBe('10');
      expect(result.value.gpu?.rawEndTick).toBe('20');
      expect(result.value.membership?.clusterOffsetsAndCounts).toEqual([1, 2, 3, 4]);
      expect(result.value.membership?.lightIndexPrefix).toEqual([9, 10]);
      expect(result.value.dispatchId).toBe('membership-1:hdrp-cluster-membership');
      expect(result.value.submissionToken).toBe('membership-1:submission');
      expect(result.value.cpu.encode?.durationNanoseconds).not.toBeNull();
      expect(result.value.cpu.submit?.durationNanoseconds).not.toBeNull();
      expect(result.value.async.queueCompletion?.durationNanoseconds).not.toBeNull();
      expect(result.value.async.readback?.durationNanoseconds).not.toBeNull();
    }
    expect(fake.state.destroyedBuffers).toHaveLength(4);
    expect(fake.state.destroyedQuerySets).toHaveLength(1);
  });

  it.each([
    [[0n, 0n], 'zero timestamps'],
    [[10n, 10n], 'equal timestamps'],
    [[20n, 10n], 'reversed timestamps'],
  ] as const)('rejects %s as timestamp-range-invalid', async (timestampTicks, _label) => {
    const fake = fakeGpuDevice({ timestampTicks });
    const timing = createMembershipTiming(fake.device, { mode: 'gpu' });
    expect(timing.start().ok).toBe(true);
    timing.recordGpuMembershipSource(recordGpuSource(fake));
    timing.beforeMembership(fake.encoder);
    timing.afterMembership(fake.encoder);
    timing.markEncodeFinished();
    timing.markSubmitted({} as CommandBuffer);

    const result = await timing.finish();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timestamp-range-invalid');
  });

  it.each([
    [
      'write',
      fakeGpuDevice({ writeTimestampError: 'timestamp write failed' }),
      'timestamp-write-unavailable',
    ],
    ['resolve', fakeGpuDevice({ resolveError: 'resolve failed' }), 'terminal-record-incomplete'],
    [
      'readback range',
      fakeGpuDevice({ rangeErrorLabel: 'membership-timing-readback' }),
      'readback-map-failed',
    ],
  ] as const)('rejects %s failures with the owning reason', async (_label, fake, expected) => {
    const timing = createMembershipTiming(fake.device, { mode: 'gpu' });
    expect(timing.start().ok).toBe(true);
    timing.recordGpuMembershipSource(recordGpuSource(fake));
    timing.beforeMembership(fake.encoder);
    timing.afterMembership(fake.encoder);
    timing.markEncodeFinished();
    timing.markSubmitted({} as CommandBuffer);

    const result = await timing.finish();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(expected);
  });

  it.each([
    0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    null,
  ] as const)('refuses a non-positive or non-finite timestamp period: %s', (timestampPeriodNanoseconds) => {
    const fake = fakeGpuDevice({ timestampPeriodNanoseconds });
    const timing = createMembershipTiming(fake.device, { mode: 'gpu' });
    const result = timing.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timestamp-period-unavailable');
  });

  it('destroys the first membership readback when the second allocation fails', async () => {
    const fake = fakeGpuDevice({ failBufferLabel: 'membership-index-list-readback' });
    const timing = createMembershipTiming(fake.device, { mode: 'gpu' });
    expect(timing.start().ok).toBe(true);
    timing.recordGpuMembershipSource(recordGpuSource(fake));
    const result = await timing.finish();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('terminal-record-incomplete');
    expect(fake.state.destroyedBuffers).toHaveLength(3);
    expect(fake.state.destroyedQuerySets).toHaveLength(1);
  });

  it.each([
    ['submit', 'queue-submit-failed'],
    ['encode', 'terminal-record-incomplete'],
  ] as const)('preserves the %s terminal reason and releases its handles', async (failure, expected) => {
    const fake = fakeGpuDevice();
    const timing = createMembershipTiming(fake.device, { mode: 'gpu' });
    expect(timing.start().ok).toBe(true);
    if (failure === 'submit') timing.markSubmitFailed('fake submit failure');
    else timing.markEncodeFailed('fake encoder finish failure');
    const result = await timing.finish();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(expected);
    expect(fake.state.destroyedBuffers).toHaveLength(2);
    expect(fake.state.destroyedQuerySets).toHaveLength(1);
  });

  it('maps queue completion and readback failures without leaking resources', async () => {
    const queueFailure = fakeGpuDevice({
      queueCompletion: Promise.reject(new Error('queue failed')),
    });
    const queueTiming = createMembershipTiming(queueFailure.device, { mode: 'gpu' });
    expect(queueTiming.start().ok).toBe(true);
    queueTiming.recordGpuMembershipSource(recordGpuSource(queueFailure));
    queueTiming.beforeMembership(queueFailure.encoder);
    queueTiming.afterMembership(queueFailure.encoder);
    queueTiming.markSubmitted({} as CommandBuffer);
    const queueResult = await queueTiming.finish();
    expect(queueResult.ok).toBe(false);
    if (!queueResult.ok) expect(queueResult.error.code).toBe('queue-completion-failed');
    expect(queueFailure.state.destroyedBuffers).toHaveLength(4);

    const mapFailure = fakeGpuDevice({ mapErrorLabel: 'membership-timing-readback' });
    const mapTiming = createMembershipTiming(mapFailure.device, { mode: 'gpu' });
    expect(mapTiming.start().ok).toBe(true);
    mapTiming.recordGpuMembershipSource(recordGpuSource(mapFailure));
    mapTiming.beforeMembership(mapFailure.encoder);
    mapTiming.afterMembership(mapFailure.encoder);
    mapTiming.markSubmitted({} as CommandBuffer);
    const mapResult = await mapTiming.finish();
    expect(mapResult.ok).toBe(false);
    if (!mapResult.ok) expect(mapResult.error.code).toBe('readback-map-failed');
    expect(mapFailure.state.destroyedBuffers).toHaveLength(4);
  });

  it('keeps timed-out asynchronous work pending until queue completion releases it', async () => {
    vi.useFakeTimers();
    let resolveQueue!: () => void;
    const queueCompletion = new Promise<void>((resolve) => {
      resolveQueue = resolve;
    });
    const fake = fakeGpuDevice({ queueCompletion });
    const timing = createMembershipTiming(fake.device, { mode: 'gpu' });
    expect(timing.start().ok).toBe(true);
    timing.recordGpuMembershipSource(recordGpuSource(fake));
    timing.beforeMembership(fake.encoder);
    timing.afterMembership(fake.encoder);
    timing.markSubmitted({} as CommandBuffer);
    const finished = timing.finish();
    await vi.advanceTimersByTimeAsync(2_001);
    const result = await finished;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('capture-timeout');
    expect(fake.state.destroyedBuffers).toHaveLength(0);
    resolveQueue();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.state.destroyedBuffers).toHaveLength(4);
    expect(fake.state.destroyedQuerySets).toHaveLength(1);
  });

  it('fences recovery and disposal to the owning device generation', async () => {
    const oldDevice = fakeGpuDevice();
    const newDevice = fakeGpuDevice();
    const timing = createMembershipTiming(oldDevice.device, { mode: 'gpu' });
    expect(timing.start().ok).toBe(true);
    timing.bindDevice(newDevice.device);
    const stale = await timing.finish();
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('stale-device-generation');
    expect(oldDevice.state.destroyedBuffers).toHaveLength(2);
    expect(oldDevice.state.destroyedQuerySets).toHaveLength(1);

    expect(timing.start().ok).toBe(true);
    timing.dispose();
    const disposed = await timing.finish();
    expect(disposed.ok).toBe(false);
    if (!disposed.ok) expect(disposed.error.code).toBe('capture-disposed');
    expect(newDevice.state.destroyedBuffers).toHaveLength(2);
    expect(newDevice.state.destroyedQuerySets).toHaveLength(1);
  });

  it('terminalizes active captures on device loss before recovery rebinding', async () => {
    const oldDevice = fakeGpuDevice();
    const newDevice = fakeGpuDevice();
    const timing = createMembershipTiming(oldDevice.device, { mode: 'gpu' });
    expect(timing.start().ok).toBe(true);
    timing.markDeviceLost('fake device lost');
    const lost = await timing.finish();
    expect(lost.ok).toBe(false);
    if (!lost.ok) expect(lost.error.code).toBe('device-lost');
    expect(oldDevice.state.destroyedBuffers).toHaveLength(2);
    expect(oldDevice.state.destroyedQuerySets).toHaveLength(1);
    const blocked = timing.start();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('device-lost');
    timing.bindDevice(newDevice.device);
    expect(timing.start().ok).toBe(true);
  });

  it('does not destroy async resources until disposed work has stopped publishing', async () => {
    let resolveQueue!: () => void;
    const queueCompletion = new Promise<void>((resolve) => {
      resolveQueue = resolve;
    });
    const fake = fakeGpuDevice({ queueCompletion });
    const timing = createMembershipTiming(fake.device, { mode: 'gpu' });
    expect(timing.start().ok).toBe(true);
    timing.recordGpuMembershipSource(recordGpuSource(fake));
    timing.beforeMembership(fake.encoder);
    timing.afterMembership(fake.encoder);
    timing.markSubmitted({} as CommandBuffer);
    timing.dispose();
    const disposed = await timing.finish();
    expect(disposed.ok).toBe(false);
    if (!disposed.ok) expect(disposed.error.code).toBe('capture-disposed');
    expect(fake.state.destroyedBuffers).toHaveLength(0);
    resolveQueue();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.state.destroyedBuffers).toHaveLength(4);
    expect(fake.state.destroyedQuerySets).toHaveLength(1);
  });
});
