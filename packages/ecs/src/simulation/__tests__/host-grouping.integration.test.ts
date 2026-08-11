import { describe, expect, it } from 'vitest';
import { FixedTime, FixedUpdate, World } from '../../index';
import { registerFixedTickHook } from '../../world-scheduling';
import { type SimulationComparisonFact, simulationCompare } from '../compare';
import { createSimulationTrace, type SimulationTrace } from '../trace';

const INPUT_SIMULATION_SAMPLE_RESOURCE_KEY = 'SimulationInputSample';

function makeTrace(): SimulationTrace {
  const recorder = createSimulationTrace(0);
  for (let tick = 1; tick <= 4; tick += 1) {
    recorder.append({ tick, input: { marker: tick } });
  }
  return recorder.finish().unwrap();
}

function runGrouping(grouping: readonly number[], trace: SimulationTrace) {
  const world = new World();
  const consumed: unknown[] = [];
  const unregister = registerFixedTickHook(world, (target, tick) => {
    const sample = trace.samples[tick - 1];
    if (sample === undefined) throw new Error(`missing sample for tick ${tick}`);
    target.insertResource(INPUT_SIMULATION_SAMPLE_RESOURCE_KEY, sample.input);
  });
  world.addSystem(FixedUpdate, {
    name: 'simulation-host-grouping-consumer',
    queries: [],
    fn: (_world) => {
      consumed.push(_world.getResource(INPUT_SIMULATION_SAMPLE_RESOURCE_KEY));
    },
  });

  for (const delta of grouping) expect(world.update(delta).ok).toBe(true);
  unregister();
  const fixed = world.getResource(FixedTime);
  const facts: SimulationComparisonFact[] = [
    {
      domain: 'world',
      path: 'fixed.tick',
      expected: trace.samples.length,
      actual: fixed.tick,
      tolerance: 0,
    },
    {
      domain: 'world',
      path: 'fixed.samples',
      expected: trace.samples.map((sample) => sample.input),
      actual: consumed,
    },
    {
      domain: 'collision',
      path: 'events',
      expected: [],
      actual: [],
    },
    {
      domain: 'audio',
      path: 'events',
      expected: [],
      actual: [],
    },
    {
      domain: 'cleanup',
      path: 'extraEvents',
      expected: 0,
      actual: 0,
      tolerance: 0,
    },
    {
      domain: 'final-invariant',
      path: 'danglingEntityRefs',
      expected: 0,
      actual: 0,
      tolerance: 0,
    },
  ];
  return simulationCompare({ facts });
}

describe('simulation host frame grouping', () => {
  it('produces one fixed trace and one semantic report for split or grouped host deltas', () => {
    const trace = makeTrace();
    const split = runGrouping([1 / 60, 1 / 60, 1 / 60, 1 / 60], trace);
    const grouped = runGrouping([1 / 30, 1 / 30], trace);

    expect(split.ok).toBe(true);
    expect(grouped.ok).toBe(true);
    if (!split.ok || !grouped.ok) return;
    expect(split.value.verdict).toBe('match');
    expect(grouped.value.verdict).toBe('match');
    expect(grouped.value.entries).toEqual(split.value.entries);
    expect(grouped.value.finalInvariants).toEqual({ compared: 1, mismatches: 0 });
  });
});
