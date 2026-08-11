import { err, ok, type Result } from '@forgeax/engine-types';
import {
  SIMULATION_RECORD_FORMAT_VERSION,
  type SimulationClockProjection,
  type SimulationError,
  type SimulationErrorFor,
  type SimulationRecordInput,
  type SimulationRecordInvalidDetail,
  type SimulationRecordV1,
} from './types';

const RECORD_PREFIX = 'simulation-v1:';

function invalid(
  path: string,
  expected: string,
  received?: unknown,
): SimulationErrorFor<'simulation-record-invalid'> {
  const detail: SimulationRecordInvalidDetail = { path, expected, received };
  const error = new Error(
    `Invalid simulation record at ${path}`,
  ) as SimulationErrorFor<'simulation-record-invalid'>;
  Object.assign(error, {
    code: 'simulation-record-invalid',
    expected,
    hint: `Repair ${path} and create a new SimulationRecordV1 before restoring.`,
    detail,
  });
  return error;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function hash(value: unknown): string {
  const text = JSON.stringify(stableValue(value));
  let state = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    state ^= text.charCodeAt(index);
    state = Math.imul(state, 16777619) >>> 0;
  }
  return state.toString(16).padStart(8, '0');
}

/** Derive a stable diagnostic fingerprint from the portable record projection. */
export function simulationRecordFingerprint(input: SimulationRecordInput): string {
  return `${RECORD_PREFIX}${hash({
    formatVersion: SIMULATION_RECORD_FORMAT_VERSION,
    ...input,
  })}`;
}

function validateClock(
  clock: SimulationClockProjection,
  recordTick: number,
): SimulationError | null {
  const values = [
    ['clock.time.delta', clock?.time?.delta],
    ['clock.time.elapsed', clock?.time?.elapsed],
    ['clock.fixed.delta', clock?.fixed?.delta],
    ['clock.fixed.tick', clock?.fixed?.tick],
    ['clock.fixed.overstep', clock?.fixed?.overstep],
    ['clock.fixed.droppedSeconds', clock?.fixed?.droppedSeconds],
    ['clock.fixed.droppedUpdates', clock?.fixed?.droppedUpdates],
  ] as const;
  for (const [path, value] of values) {
    if (typeof value !== 'number' || !Number.isFinite(value))
      return invalid(path, 'a finite number', value);
  }
  if (clock.fixed.tick !== recordTick)
    return invalid('clock.fixed.tick', `recordTick (${recordTick})`, clock.fixed.tick);
  return null;
}

/** Validate the minimum record/restore path and return a closed structured error. */
export function validateSimulationRecordV1(
  value: unknown,
): Result<void, SimulationErrorFor<'simulation-record-invalid'>> {
  if (value === null || typeof value !== 'object') return err(invalid('$', 'an object', value));
  const record = value as Partial<SimulationRecordV1>;
  if (record.formatVersion !== SIMULATION_RECORD_FORMAT_VERSION) {
    return err(invalid('formatVersion', '1', record.formatVersion));
  }
  if (
    typeof record.recordTick !== 'number' ||
    !Number.isSafeInteger(record.recordTick) ||
    record.recordTick < 0
  ) {
    return err(invalid('recordTick', 'a non-negative safe integer', record.recordTick));
  }
  if (record.clock === undefined) return err(invalid('clock', 'SimulationClockProjection'));
  if (record.world?.entities === undefined) return err(invalid('world.entities', 'an array'));
  if (record.world.resources === undefined) return err(invalid('world.resources', 'an array'));
  if (!Array.isArray(record.participants)) return err(invalid('participants', 'an array'));
  if (!Array.isArray(record.trace)) return err(invalid('trace', 'an array'));
  if (typeof record.fingerprint !== 'string')
    return err(invalid('fingerprint', 'a simulation-v1 fingerprint'));
  const clockError = validateClock(record.clock, record.recordTick);
  if (clockError !== null)
    return err(clockError as SimulationErrorFor<'simulation-record-invalid'>);

  const expectedFingerprint = simulationRecordFingerprint({
    recordTick: record.recordTick,
    clock: record.clock,
    world: record.world,
    participants: record.participants,
    trace: record.trace,
  });
  if (record.fingerprint !== expectedFingerprint) {
    return err(invalid('fingerprint', expectedFingerprint, record.fingerprint));
  }

  let expectedTick = record.recordTick + 1;
  for (let index = 0; index < record.trace.length; index += 1) {
    const sample = record.trace[index];
    if (sample?.tick !== expectedTick) {
      return err(invalid(`trace[${index}].tick`, `${expectedTick}`, sample?.tick));
    }
    expectedTick += 1;
  }
  return ok(undefined);
}

/** Create and validate one ECS-owned record before any target World is touched. */
export function createSimulationRecordV1(
  input: SimulationRecordInput,
): Result<SimulationRecordV1, SimulationErrorFor<'simulation-record-invalid'>> {
  const record: SimulationRecordV1 = {
    ...input,
    formatVersion: SIMULATION_RECORD_FORMAT_VERSION,
    fingerprint: simulationRecordFingerprint(input),
  };
  const validation = validateSimulationRecordV1(record);
  return validation.ok ? ok(record) : validation;
}

export type {
  SimulationClockProjection,
  SimulationWorldProjection,
} from './types';
export { RECORD_PREFIX, SIMULATION_RECORD_FORMAT_VERSION };
