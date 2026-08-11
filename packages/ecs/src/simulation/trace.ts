import { err, ok, type Result } from '@forgeax/engine-types';
import { createSimulationError } from '../errors/simulation-errors';
import type { SimulationErrorFor, SimulationTraceSample } from './types';

type SimulationTraceError = SimulationErrorFor<'simulation-trace-invalid'>;

export interface SimulationTrace {
  readonly recordTick: number;
  readonly samples: readonly SimulationTraceSample[];
}

export interface SimulationTraceRecorder {
  readonly append: (sample: SimulationTraceSample) => Result<void, SimulationTraceError>;
  readonly finish: () => Result<SimulationTrace, SimulationTraceError>;
}

function invalid(path: string, expected: string, received?: unknown): SimulationTraceError {
  return createSimulationError('simulation-trace-invalid', { path, expected, received });
}

function validBoundary(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validateSimulationTrace(value: unknown): Result<void, SimulationTraceError> {
  if (value === null || typeof value !== 'object') {
    return err(invalid('$', 'a SimulationTrace object', value));
  }
  const trace = value as Partial<SimulationTrace>;
  if (!validBoundary(trace.recordTick)) {
    return err(invalid('recordTick', 'a non-negative safe integer', trace.recordTick));
  }
  if (!Array.isArray(trace.samples)) return err(invalid('samples', 'an array', trace.samples));
  let expectedTick = trace.recordTick + 1;
  for (let index = 0; index < trace.samples.length; index += 1) {
    const sample = trace.samples[index];
    if (sample === null || typeof sample !== 'object') {
      return err(invalid(`samples[${index}]`, 'a tick sample', sample));
    }
    if (sample.tick !== expectedTick) {
      return err(invalid(`samples[${index}].tick`, `${expectedTick}`, sample.tick));
    }
    expectedTick += 1;
  }
  return ok(undefined);
}

export function createSimulationTrace(recordTick: number): SimulationTraceRecorder {
  const samples: SimulationTraceSample[] = [];
  let finished = false;

  return {
    append(sample) {
      if (finished) return err(invalid('finish', 'an unfinished trace', 'finished'));
      const expectedTick = recordTick + samples.length + 1;
      if (sample.tick !== expectedTick) {
        return err(invalid(`samples[${samples.length}].tick`, `${expectedTick}`, sample.tick));
      }
      samples.push(Object.freeze({ tick: sample.tick, input: sample.input }));
      return ok(undefined);
    },
    finish() {
      if (finished) return err(invalid('finish', 'a trace finished exactly once', 'finished'));
      finished = true;
      const trace: SimulationTrace = Object.freeze({
        recordTick,
        samples: Object.freeze([...samples]),
      });
      return ok(trace);
    },
  };
}

export function replaySimulationTrace(
  trace: unknown,
  consume: (sample: SimulationTraceSample) => void,
): Result<void, SimulationTraceError> {
  const validation = validateSimulationTrace(trace);
  if (!validation.ok) return validation;
  for (const sample of (trace as SimulationTrace).samples) consume(sample);
  return ok(undefined);
}
