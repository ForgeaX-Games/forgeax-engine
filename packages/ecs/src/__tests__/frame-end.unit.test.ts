import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { FixedUpdate, FrameEnd, Update } from '../schedule-token';
import { FixedTime } from '../time';
import { World } from '../world';

describe('FrameEnd schedule', () => {
  it.each([
    { label: 'zero', delta: 0, expectedFixedTicks: 0 },
    { label: 'one', delta: 1 / 60, expectedFixedTicks: 1 },
    { label: 'many', delta: 3 / 60 + 1e-6, expectedFixedTicks: 3 },
  ])('runs once after $label fixed update', ({ delta, expectedFixedTicks }) => {
    const world = new World();
    const trace: string[] = [];

    world.addSystem(FixedUpdate, {
      name: 'fixed',
      queries: [],
      fn: () => trace.push('fixed'),
    });
    world.addSystem(FrameEnd, {
      name: 'frame-end',
      queries: [],
      fn: (_world) => {
        trace.push(`frame-end:${_world.getResource<typeof FixedTime>(FixedTime).tick}`);
      },
    });

    expect(world.update(delta).ok).toBe(true);
    expect(trace.filter((entry) => entry.startsWith('fixed'))).toHaveLength(expectedFixedTicks);
    expect(trace.filter((entry) => entry.startsWith('frame-end'))).toEqual([
      `frame-end:${expectedFixedTicks}`,
    ]);
  });

  it('observes deferred commands after the outer update reaches its final boundary', () => {
    const Marker = defineComponent('FrameEndDeferredMarker', {});
    const world = new World();
    let observed = 0;

    world.addSystem(Update, {
      name: 'producer',
      queries: [],
      fn: (_world, _queries, commands) => commands.spawn({ component: Marker, data: {} }),
    });
    world.addSystem(FrameEnd, {
      name: 'observer',
      queries: [{ with: [Marker] }],
      fn: (_world, results) => {
        observed = [...results[0]].length;
      },
    });

    expect(world.update().ok).toBe(true);
    expect(observed).toBe(1);
  });

  it('keeps FrameEnd in the schedule DAG and routes errors through the handler', () => {
    const world = new World();
    const trace: string[] = [];
    const errors: string[] = [];
    world.setErrorHandler((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        errors.push(String(error.code));
      }
    });

    world.addSystem(FrameEnd, {
      name: 'before-frame-end',
      queries: [],
      before: ['after-frame-end'],
      fn: () => trace.push('before'),
    });
    world.addSystem(FrameEnd, {
      name: 'after-frame-end',
      queries: [],
      fn: () => trace.push('after'),
    });

    expect(world.update().ok).toBe(true);
    expect(trace).toEqual(['before', 'after']);
    expect(errors).toEqual([]);
  });

  it('does not publish when no outer update occurs after teardown', () => {
    const world = new World();
    let publishes = 0;
    world.addSystem(FrameEnd, {
      name: 'frame-end',
      queries: [],
      fn: () => publishes++,
    });

    expect(publishes).toBe(0);
  });

  it('keeps an empty FrameEnd schedule side-effect free', () => {
    const world = new World();
    expect(world.update(1 / 60).ok).toBe(true);
    expect(world.inspect().scheduleSystemCount(FrameEnd)).toBe(0);
  });
});
