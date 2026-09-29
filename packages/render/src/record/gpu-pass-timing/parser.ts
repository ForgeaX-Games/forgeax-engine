import { err, ok, type Result } from '@forgeax/engine-types';
import type { GpuPassTimingMeasuredEntry } from './contract.js';
import type { GpuPassTimingReason } from './errors.js';

export interface GpuPassTimingTickInput {
  readonly beginningTick: string;
  readonly endTick: string;
  readonly timestampPeriodNanoseconds: number;
}

export type GpuPassTimingTickResult = Omit<
  GpuPassTimingMeasuredEntry,
  'passName' | 'passKind' | 'executionIndex' | 'measurementSource'
>;

function failure(
  code: GpuPassTimingReason['code'],
  expected: string,
  hint: string,
  detail: { readonly [key: string]: null | boolean | number | string },
): GpuPassTimingReason {
  return { code, expected, hint, detail };
}

function decimal(value: string): bigint | undefined {
  return /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : undefined;
}

export function parseGpuPassTimingTicks(
  input: GpuPassTimingTickInput,
): Result<GpuPassTimingTickResult, GpuPassTimingReason> {
  const period = input.timestampPeriodNanoseconds;
  if (!Number.isFinite(period) || period <= 0) {
    return err(
      failure(
        'timestamp-period-unavailable',
        'timestampPeriodNanoseconds is finite and greater than zero',
        'use a device with a trustworthy positive timestamp period',
        { timestampPeriodNanoseconds: period },
      ),
    );
  }
  const beginning = decimal(input.beginningTick);
  const end = decimal(input.endTick);
  if (beginning === undefined || end === undefined) {
    return err(
      failure(
        'timestamp-range-invalid',
        'raw timestamp ticks are unsigned decimal strings',
        'retain the GPU u64 readback as a decimal string before parsing',
        { beginningTick: input.beginningTick, endTick: input.endTick },
      ),
    );
  }
  if (end < beginning) {
    return err(
      failure(
        'timestamp-range-invalid',
        'end tick is greater than or equal to beginning tick',
        'discard the readback and wait for a later receipt',
        { beginningTick: input.beginningTick, endTick: input.endTick },
      ),
    );
  }
  const delta = end - beginning;
  if (delta > BigInt(Number.MAX_SAFE_INTEGER)) {
    return err(
      failure(
        'timestamp-range-invalid',
        'tick delta converts to a safe finite duration',
        'use a bounded timestamp range or capture a later receipt',
        { beginningTick: input.beginningTick, endTick: input.endTick },
      ),
    );
  }
  const durationNanoseconds = Number(delta) * period;
  if (
    !Number.isFinite(durationNanoseconds) ||
    !Number.isSafeInteger(Math.round(durationNanoseconds))
  ) {
    return err(
      failure(
        'timestamp-range-invalid',
        'derived duration is finite and safely representable',
        'use a smaller tick range or a trustworthy timestamp period',
        { timestampPeriodNanoseconds: period },
      ),
    );
  }
  return ok({
    status: 'measured',
    beginningTick: input.beginningTick,
    endTick: input.endTick,
    durationNanoseconds,
    ...(delta === 0n ? { timerResolution: 'equal-ticks' as const } : {}),
  });
}
