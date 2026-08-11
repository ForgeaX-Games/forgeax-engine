import { describe, expect, it } from 'vitest';
import { createSimulationTrace, replaySimulationTrace, validateSimulationTrace } from '../trace';

describe('SimulationTrace continuity', () => {
  it('accepts a zero-tick trace and preserves its record boundary', () => {
    const trace = createSimulationTrace(12).finish();

    expect(trace.ok).toBe(true);
    if (!trace.ok) return;
    expect(trace.value.recordTick).toBe(12);
    expect(trace.value.samples).toEqual([]);
    expect(validateSimulationTrace(trace.value).ok).toBe(true);
  });

  it('rejects missing, duplicate, and out-of-order ticks while recording', () => {
    const recorder = createSimulationTrace(4);

    expect(recorder.append({ tick: 5, input: { edge: 'press' } }).ok).toBe(true);
    const missing = recorder.append({ tick: 7, input: { edge: 'hold' } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('simulation-trace-invalid');

    const duplicate = recorder.append({ tick: 5, input: { edge: 'press' } });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.detail.path).toBe('samples[1].tick');
  });

  it('rejects a damaged trace before replay invokes its consumer', () => {
    const damaged = {
      recordTick: 8,
      samples: [
        { tick: 9, input: { value: 1 } },
        { tick: 11, input: { value: 2 } },
      ],
    };
    const consumed: unknown[] = [];

    const replay = replaySimulationTrace(damaged, (sample) => consumed.push(sample.input));

    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.error.code).toBe('simulation-trace-invalid');
      expect(replay.error.detail.path).toBe('samples[1].tick');
    }
    expect(consumed).toEqual([]);
  });

  it('finishes once and replays a validated trace in tick order', () => {
    const recorder = createSimulationTrace(0);
    recorder.append({ tick: 1, input: { value: 'a' } });
    recorder.append({ tick: 2, input: { value: 'b' } });
    const finished = recorder.finish();

    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(recorder.finish().ok).toBe(false);
    expect(recorder.append({ tick: 3, input: { value: 'c' } }).ok).toBe(false);

    const consumed: unknown[] = [];
    expect(replaySimulationTrace(finished.value, (sample) => consumed.push(sample.input)).ok).toBe(
      true,
    );
    expect(consumed).toEqual([{ value: 'a' }, { value: 'b' }]);
  });
});
