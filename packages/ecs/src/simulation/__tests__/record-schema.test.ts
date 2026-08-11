import { describe, expect, it } from 'vitest';
import {
  createSimulationRecordV1,
  SIMULATION_RECORD_FORMAT_VERSION,
  type SimulationClockProjection,
  type SimulationWorldProjection,
  validateSimulationRecordV1,
} from '../record';

const clock: SimulationClockProjection = {
  time: { delta: 0, elapsed: 0 },
  fixed: {
    delta: 1 / 60,
    tick: 0,
    overstep: 0,
    droppedSeconds: 0,
    droppedUpdates: 0,
  },
};

const emptyWorld: SimulationWorldProjection = {
  entities: [],
  resources: [],
};

describe('SimulationRecordV1 schema', () => {
  it('contains the version, boundary tick, clock, world, participants, trace, and fingerprint', () => {
    const result = createSimulationRecordV1({
      recordTick: 0,
      clock,
      world: emptyWorld,
      participants: [],
      trace: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.formatVersion).toBe(SIMULATION_RECORD_FORMAT_VERSION);
    expect(result.value.recordTick).toBe(0);
    expect(result.value.clock).toEqual(clock);
    expect(result.value.world).toEqual(emptyWorld);
    expect(result.value.participants).toEqual([]);
    expect(result.value.trace).toEqual([]);
    expect(result.value.fingerprint).toMatch(/^simulation-v1:/);
  });

  it('accepts an empty World, zero participants, and a zero-length trace as a normal record', () => {
    const result = createSimulationRecordV1({
      recordTick: 12,
      clock: { ...clock, fixed: { ...clock.fixed, tick: 12 } },
      world: emptyWorld,
      participants: [],
      trace: [],
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a partial record as one invalid value rather than returning a usable record', () => {
    const partial = {
      formatVersion: SIMULATION_RECORD_FORMAT_VERSION,
      recordTick: 2,
      clock,
      world: emptyWorld,
      participants: [],
      trace: [],
    };

    const validation = validateSimulationRecordV1(partial);
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.error.code).toBe('simulation-record-invalid');
    expect(validation.error.detail.path).toBe('fingerprint');
  });

  it('rejects mismatched record and fixed-clock ticks with a pinpointed path', () => {
    const result = createSimulationRecordV1({
      recordTick: 5,
      clock: { ...clock, fixed: { ...clock.fixed, tick: 4 } },
      world: emptyWorld,
      participants: [],
      trace: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('simulation-record-invalid');
    expect(result.error.detail.path).toBe('clock.fixed.tick');
  });
});
