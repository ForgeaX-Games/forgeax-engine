import { describe, expect, it } from 'vitest';
import { FrameEnd, Update } from '../schedule-token';
import { World } from '../world';

describe('FrameEnd error and lifecycle boundaries', () => {
  it('preserves FrameEnd DAG order and forwards Result errors to the handler', () => {
    const world = new World();
    const trace: string[] = [];
    const errors: string[] = [];
    world.setErrorHandler((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        errors.push(String(error.code));
      }
    });

    world.addSystem(FrameEnd, {
      name: 'frame-end-first',
      queries: [],
      before: ['frame-end-last'],
      fn: () => trace.push('first'),
    });
    world.addSystem(FrameEnd, {
      name: 'frame-end-last',
      queries: [],
      fn: () => trace.push('last'),
    });
    world.addSystem(Update, {
      name: 'update-error',
      queries: [],
      fn: () => ({ ok: false, error: { code: 'frame-end-test-error' } }),
    });

    expect(world.update().ok).toBe(true);
    expect(trace).toEqual(['first', 'last']);
    expect(errors).toEqual(['frame-end-test-error']);
  });

  it('does not run FrameEnd for an inactive world that is not updated', () => {
    const world = new World();
    let publishes = 0;
    world.addSystem(FrameEnd, { name: 'frame-end', queries: [], fn: () => publishes++ });

    expect(publishes).toBe(0);
    expect(world.inspect().scheduleSystemCount(FrameEnd)).toBe(1);
  });

  it('leaves an empty schedule and its error path harmless', () => {
    const world = new World();
    world.setErrorHandler(() => {
      throw new Error('empty FrameEnd must not call the handler');
    });

    expect(world.update().ok).toBe(true);
    expect(world.inspect().scheduleSystemCount(FrameEnd)).toBe(0);
  });
});
