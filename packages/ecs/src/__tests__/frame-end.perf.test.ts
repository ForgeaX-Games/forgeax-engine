import { describe, expect, it } from 'vitest';
import { FrameEnd, type ScheduleToken, Update } from '../schedule-token';
import { World } from '../world';

const WARMUP_ROUNDS = 3;
// More rounds make the tail statistic resilient to one scheduler/GC pause on
// the shared self-hosted runner while keeping this sub-second perf gate cheap.
const SAMPLE_ROUNDS = 31;
// Keep each timed batch long enough to amortize sub-millisecond timer and
// scheduler noise; the ratio gate remains unchanged.
const INNER_REPEATS = 50_000;
const RATIO_GATE = 1.5;

function createWorld(secondSchedule: ScheduleToken): World {
  const world = new World();
  world.addSystem(Update, {
    name: 'perf-update',
    queries: [],
    fn: () => {},
  });
  world.addSystem(secondSchedule, {
    name: secondSchedule === FrameEnd ? 'perf-frame-end' : 'perf-control-update',
    queries: [],
    fn: () => {},
  });
  return world;
}

function runUpdates(world: World): number {
  let sink = 0;
  for (let i = 0; i < INNER_REPEATS; i++) {
    sink += Number(world.update(1 / 60).ok);
  }
  return sink;
}

function percentile(samples: number[], quantile: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

describe('FrameEnd ECS performance ratio', () => {
  it(`keeps FrameEnd incremental cost within ${RATIO_GATE}x of an equal-size control`, () => {
    const control = createWorld(Update);
    const candidate = createWorld(FrameEnd);
    for (let round = 0; round < WARMUP_ROUNDS; round++) {
      runUpdates(control);
      runUpdates(candidate);
    }

    const controlTimes: number[] = [];
    const candidateTimes: number[] = [];
    let sink = 0;
    for (let round = 0; round < SAMPLE_ROUNDS; round++) {
      const first = round % 2 === 0;
      const run = (world: World, samples: number[]) => {
        const start = performance.now();
        sink += runUpdates(world);
        samples.push(performance.now() - start);
      };
      if (first) {
        run(control, controlTimes);
        run(candidate, candidateTimes);
      } else {
        run(candidate, candidateTimes);
        run(control, controlTimes);
      }
    }

    const controlP50 = percentile(controlTimes, 0.5);
    const candidateP50 = percentile(candidateTimes, 0.5);
    const controlP95 = percentile(controlTimes, 0.95);
    const candidateP95 = percentile(candidateTimes, 0.95);
    const p50Ratio = candidateP50 / controlP50;
    const p95Ratio = candidateP95 / controlP95;
    // biome-ignore lint/suspicious/noConsole: ratio is the acceptance evidence.
    console.info(
      `[FrameEnd perf ratio] control_p50=${controlP50.toFixed(3)}ms candidate_p50=${candidateP50.toFixed(3)}ms p50_ratio=${p50Ratio.toFixed(3)} control_p95=${controlP95.toFixed(3)}ms candidate_p95=${candidateP95.toFixed(3)}ms p95_ratio=${p95Ratio.toFixed(3)}`,
    );

    expect(sink).toBe(SAMPLE_ROUNDS * INNER_REPEATS * 2);
    expect(p50Ratio).toBeLessThanOrEqual(RATIO_GATE);
    expect(p95Ratio).toBeLessThanOrEqual(RATIO_GATE);
  });
});
