import {
  EXECUTION_CAPABILITY_NAMES,
  EXECUTION_REQUESTED_TIERS,
  EXECUTION_TIERS,
  type ExecutionReport,
} from './types';

export const EXECUTION_REPORT_SCHEMA_VERSION = 1 as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function isMeasurement(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['samples', 'p50', 'p95', 'p99', 'jitter'])) {
    return false;
  }
  return (
    Number.isInteger(value.samples) &&
    (value.samples as number) > 0 &&
    ['p50', 'p95', 'p99', 'jitter'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0,
    )
  );
}

export function isExecutionReport(value: unknown): value is ExecutionReport {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'requestedTier',
      'actualTier',
      'selectionReason',
      'sharedEvidencePassed',
      'capabilities',
      'engine',
      'world',
      'kernelDispatch',
      'performance',
      'audio',
      'fault',
    ])
  ) {
    return false;
  }
  const report = value as unknown as Partial<ExecutionReport>;
  if (report.schemaVersion !== EXECUTION_REPORT_SCHEMA_VERSION) return false;
  if (!EXECUTION_REQUESTED_TIERS.includes(report.requestedTier as never)) return false;
  if (report.actualTier !== null && !EXECUTION_TIERS.includes(report.actualTier as never)) {
    return false;
  }
  if (typeof report.sharedEvidencePassed !== 'boolean' || report.capabilities === undefined) {
    return false;
  }
  if (
    !EXECUTION_CAPABILITY_NAMES.every((name) => {
      const fact = report.capabilities?.[name];
      return typeof fact?.available === 'boolean' && typeof fact.reason === 'string';
    })
  )
    return false;
  const engine = report.engine;
  const world = report.world;
  const dispatch = report.kernelDispatch;
  const performance = report.performance;
  const audio = report.audio;
  if (!isRecord(engine) || !hasExactKeys(engine, ['realm', 'health'])) return false;
  if (!['host', 'worker'].includes(engine.realm as string)) return false;
  if (!['idle', 'starting', 'running', 'stopped', 'faulted'].includes(engine.health as string)) {
    return false;
  }
  if (
    !isRecord(world) ||
    !hasExactKeys(world, ['identity', 'health', 'partialWrite', 'retryable'])
  ) {
    return false;
  }
  if (world.identity !== null && typeof world.identity !== 'string') return false;
  if (!['healthy', 'poisoned'].includes(world.health as string)) return false;
  if (typeof world.partialWrite !== 'boolean' || typeof world.retryable !== 'boolean') return false;
  if (
    !isRecord(dispatch) ||
    !hasExactKeys(dispatch, ['eligible', 'usedShared', 'reason', 'dispatched', 'completed'])
  ) {
    return false;
  }
  if (typeof dispatch.eligible !== 'boolean' || typeof dispatch.usedShared !== 'boolean')
    return false;
  if (
    ![
      'no-eligible-kernel',
      'zero-work',
      'small-span',
      'forced-inline',
      'shared',
      'poisoned',
    ].includes(dispatch.reason as string)
  )
    return false;
  if (!Number.isInteger(dispatch.dispatched) || !Number.isInteger(dispatch.completed)) return false;
  if (
    !isRecord(performance) ||
    !hasExactKeys(performance, ['hostFrameMs', 'engineUpdateMs', 'kernelWaitMs', 'hostAudioMs'])
  )
    return false;
  for (const key of ['hostFrameMs', 'engineUpdateMs', 'kernelWaitMs', 'hostAudioMs'] as const) {
    const measurement = performance[key];
    if (measurement !== null && !isMeasurement(measurement)) return false;
  }
  if (
    !isRecord(audio) ||
    !hasExactKeys(audio, ['owner', 'contextState', 'activeSourceCount', 'lastError'])
  )
    return false;
  if (audio.owner !== 'host') return false;
  if (!['running', 'suspended', 'closed'].includes(audio.contextState as string)) return false;
  if (!Number.isInteger(audio.activeSourceCount) || (audio.activeSourceCount as number) < 0)
    return false;
  if (audio.lastError !== null) {
    if (!isRecord(audio.lastError)) return false;
    if (!hasExactKeys(audio.lastError, ['code', 'expected', 'hint', 'detail'])) return false;
    if (
      typeof audio.lastError.code !== 'string' ||
      typeof audio.lastError.expected !== 'string' ||
      typeof audio.lastError.hint !== 'string'
    )
      return false;
  }
  if (report.fault !== null) {
    if (!isRecord(report.fault)) return false;
    if (
      !hasExactKeys(report.fault, [
        'source',
        'code',
        'expected',
        'hint',
        'detail',
        'partialWrite',
        'retryable',
      ])
    )
      return false;
    if (
      !['bootstrap', 'handshake', 'runtime', 'kernel', 'world', 'rebuild'].includes(
        report.fault.source as string,
      )
    )
      return false;
    if (
      typeof report.fault.code !== 'string' ||
      typeof report.fault.expected !== 'string' ||
      typeof report.fault.hint !== 'string'
    )
      return false;
    if (
      typeof report.fault.partialWrite !== 'boolean' ||
      typeof report.fault.retryable !== 'boolean'
    )
      return false;
  }
  return true;
}
