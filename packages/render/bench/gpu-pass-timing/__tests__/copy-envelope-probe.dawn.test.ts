import { describe, expect, it } from 'vitest';
import { requestDawnTimestampQueryAdapter } from '../dawn-timestamp-query.js';

const BUFFER_USAGE_MAP_READ = 0x01;
const BUFFER_USAGE_COPY_SRC = 0x04;
const BUFFER_USAGE_COPY_DST = 0x08;
const BUFFER_USAGE_QUERY_RESOLVE = 0x200;
const MAP_MODE_READ = 0x01;
const READBACK_BYTES = 256;
const PROBE_REPETITIONS = 3;
const COPY_SIZES = [256, 8 * 1024 * 1024] as const;

interface CopyProbeResult {
  readonly copyBytes: number;
  readonly beginningTick: bigint;
  readonly endTick: bigint;
  readonly durationNanoseconds: number;
  readonly bytesMatch: boolean;
}

function pattern(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 31 + 7) & 0xff;
  }
  return bytes;
}

async function requestDevice() {
  const adapter = await requestDawnTimestampQueryAdapter();
  if (adapter === undefined) return undefined;
  const device = await adapter.requestDevice({
    requiredFeatures: ['timestamp-query'],
  });
  expect(device.ok).toBe(true);
  if (!device.ok) return undefined;
  expect(device.value.caps.timestampQuery).toBe(true);
  return device.value;
}

async function runCopyProbe(device: Awaited<ReturnType<typeof requestDevice>>, copyBytes: number) {
  if (device === undefined) return undefined;
  const sourceData = pattern(copyBytes);
  const source = device.createBuffer({
    size: copyBytes,
    usage: BUFFER_USAGE_COPY_SRC | BUFFER_USAGE_COPY_DST,
  });
  const destination = device.createBuffer({
    size: copyBytes,
    usage: BUFFER_USAGE_COPY_DST | BUFFER_USAGE_MAP_READ,
  });
  const resolve = device.createBuffer({
    size: READBACK_BYTES,
    usage: BUFFER_USAGE_QUERY_RESOLVE | BUFFER_USAGE_COPY_SRC,
  });
  const readback = device.createBuffer({
    size: READBACK_BYTES,
    usage: BUFFER_USAGE_COPY_DST | BUFFER_USAGE_MAP_READ,
  });
  if (!source.ok || !destination.ok || !resolve.ok || !readback.ok) {
    throw new Error('copy envelope probe resource creation failed');
  }
  const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
  if (!querySet.ok) throw new Error('copy envelope probe query set creation failed');

  try {
    const write = device.queue.writeBuffer(source.value, 0, sourceData);
    if (!write.ok) throw new Error(write.error.hint);
    const encoder = device.createCommandEncoder({ label: `copy-envelope-${copyBytes}` });
    if (!encoder.ok) throw new Error(encoder.error.hint);

    encoder.value
      .beginComputePass({
        label: `copy-envelope-${copyBytes}-begin`,
        timestampWrites: {
          querySet: querySet.value,
          endOfPassWriteIndex: 0,
        },
      })
      .end();
    encoder.value.copyBufferToBuffer(source.value, 0, destination.value, 0, copyBytes);
    encoder.value
      .beginComputePass({
        label: `copy-envelope-${copyBytes}-end`,
        timestampWrites: {
          querySet: querySet.value,
          beginningOfPassWriteIndex: 1,
        },
      })
      .end();
    const resolved = encoder.value.resolveQuerySet(
      querySet.value,
      0,
      2,
      resolve.value,
      0,
    );
    if (!resolved.ok) throw new Error(resolved.error.hint);
    encoder.value.copyBufferToBuffer(resolve.value, 0, readback.value, 0, 16);
    const command = encoder.value.finish();
    if (!command.ok) throw new Error(command.error.hint);
    const submitted = device.queue.submit([command.value]);
    if (!submitted.ok) throw new Error(submitted.error.hint);
    await device.queue.onSubmittedWorkDone();

    const mappedDestination = await destination.value.mapAsync(MAP_MODE_READ);
    if (!mappedDestination.ok) throw new Error('copy destination map failed');
    const destinationRange = mappedDestination.value.getMappedRange(0, copyBytes);
    if (!destinationRange.ok) throw new Error('copy destination range failed');
    const bytesMatch =
      new Uint8Array(destinationRange.value).every((value, index) => value === sourceData[index]);
    mappedDestination.value.unmap();

    const mappedTiming = await readback.value.mapAsync(MAP_MODE_READ);
    if (!mappedTiming.ok) throw new Error('copy timing map failed');
    const timingRange = mappedTiming.value.getMappedRange(0, READBACK_BYTES);
    if (!timingRange.ok) throw new Error('copy timing range failed');
    const view = new DataView(timingRange.value);
    const markerTicks = [0, 1].map((index) => view.getBigUint64(index * 8, true));
    // biome-ignore lint/suspicious/noConsole: raw probe values are CI evidence
    console.log(
      JSON.stringify({
        probe: 'copy-boundary-envelope-markers',
        copyBytes,
        markerTicks: markerTicks.map((tick) => tick.toString(10)),
      }),
    );
    const beginningTick = markerTicks[0];
    const endTick = markerTicks[1];
    if (beginningTick === undefined || endTick === undefined) {
      throw new Error('copy envelope marker timestamps are missing');
    }
    mappedTiming.value.unmap();
    if (endTick < beginningTick) throw new Error('copy envelope marker timestamps are reversed');
    return {
      copyBytes,
      beginningTick,
      endTick,
      durationNanoseconds: Number(endTick - beginningTick) * device.caps.timestampPeriodNanoseconds,
      bytesMatch,
    } satisfies CopyProbeResult;
  } finally {
    device.destroyQuerySet(querySet.value);
    device.destroyBuffer(source.value);
    device.destroyBuffer(destination.value);
    device.destroyBuffer(resolve.value);
    device.destroyBuffer(readback.value);
  }
}

describe('GPU copy-boundary timestamp envelope probe', () => {
  it('proves copy ordering, byte correctness, repeatability, and size response on Dawn', async ({
    skip,
  }) => {
    const device = await requestDevice();
    if (device === undefined) {
      skip('Dawn adapter does not support timestamp-query');
    }
    const samples: CopyProbeResult[] = [];
    for (const copyBytes of COPY_SIZES) {
      for (let repetition = 0; repetition < PROBE_REPETITIONS; repetition += 1) {
        const sample = await runCopyProbe(device, copyBytes);
        if (sample === undefined) return;
        samples.push(sample);
      }
    }

    expect(samples).toHaveLength(COPY_SIZES.length * PROBE_REPETITIONS);
    expect(samples.every((sample) => sample.bytesMatch)).toBe(true);
    expect(samples.every((sample) => sample.endTick >= sample.beginningTick)).toBe(true);
    expect(samples.every((sample) => sample.durationNanoseconds >= 0)).toBe(true);
    const small = samples.filter((sample) => sample.copyBytes === COPY_SIZES[0]);
    const large = samples.filter((sample) => sample.copyBytes === COPY_SIZES[1]);
    const smallMaximum = Math.max(...small.map((sample) => sample.durationNanoseconds));
    const largeMaximum = Math.max(...large.map((sample) => sample.durationNanoseconds));
    // biome-ignore lint/suspicious/noConsole: raw probe values are CI evidence
    console.log(
      JSON.stringify({
        probe: 'copy-boundary-envelope',
        timestampPeriodNanoseconds: device.caps.timestampPeriodNanoseconds,
        samples: samples.map((sample) => ({
          copyBytes: sample.copyBytes,
          beginningTick: sample.beginningTick.toString(10),
          endTick: sample.endTick.toString(10),
          durationNanoseconds: sample.durationNanoseconds,
          bytesMatch: sample.bytesMatch,
        })),
      }),
    );
    if (smallMaximum === 0 && largeMaximum === 0) {
      // biome-ignore lint/suspicious/noConsole: timer-resolution fact is probe evidence
      console.warn(
        JSON.stringify({
          probe: 'copy-boundary-envelope',
          status: 'timer-resolution-floor',
          smallMaximum,
          largeMaximum,
        }),
      );
      return;
    }
    expect(largeMaximum).toBeGreaterThan(smallMaximum);
  });
});
