import { describe, expect, it } from 'vitest';
import { FixedUpdate, Update } from '../schedule-token';
import { FixedTime, Time } from '../time';
import { World } from '../world';

describe('World time resources', () => {
  it('rejects negative, NaN, and infinite deltas without mutating time', () => {
    const world = new World();
    const before = world.getResource(Time);

    for (const delta of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = world.update(delta);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('time-delta-invalid');
        expect(result.error.expected).toBe('a finite delta greater than or equal to 0');
        expect(result.error.hint).toContain('world.update');
      }
    }

    expect(world.getResource(Time)).toEqual(before);
  });

  it('treats an omitted delta as zero while still running Update', () => {
    const world = new World();
    let updates = 0;
    world.addSystem(Update, { name: 'update', queries: [], fn: () => updates++ });

    expect(world.update().ok).toBe(true);
    expect(world.getResource(Time)).toMatchObject({ delta: 0, elapsed: 0 });
    expect(world.getResource(FixedTime).tick).toBe(0);
    expect(updates).toBe(1);
  });

  it('advances Time by an explicit positive delta', () => {
    const world = new World();

    expect(world.update(0.025).ok).toBe(true);
    expect(world.getResource(Time)).toMatchObject({ delta: 0.025, elapsed: 0.025 });
  });

  it('rejects an incoherent policy before writing protected resources', () => {
    const world = new World({
      time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4, maxDeltaSeconds: 0.05 },
    });
    const beforeTime = world.getResource(Time);
    const beforeFixed = world.getResource(FixedTime);

    const result = world.update(0.01);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('time-config-invalid');
      expect(result.error.expected).toContain('maxDeltaSeconds >=');
      expect(result.error.hint).toContain('maxDeltaSeconds');
    }
    expect(world.getResource(Time)).toEqual(beforeTime);
    expect(world.getResource(FixedTime)).toEqual(beforeFixed);
  });

  it('uses the clamped Time delta as the fixed accumulator input', () => {
    const world = new World();
    let fixedRuns = 0;
    world.addSystem(Update, { name: 'observe-time', queries: [], fn: () => {} });
    world.addSystem(FixedUpdate, { name: 'fixed', queries: [], fn: () => fixedRuns++ });

    expect(world.update(5).ok).toBe(true);
    const time = world.getResource(Time);
    const fixed = world.getResource(FixedTime);
    expect(time.delta).toBe(0.1);
    expect(fixed).toMatchObject({
      delta: 1 / 60,
      maxStepsPerUpdate: 4,
      droppedUpdates: 1,
    });
    expect(fixedRuns).toBe(4);
    expect(fixed.droppedSeconds).toBeCloseTo(1 / 60, 12);
  });
});
