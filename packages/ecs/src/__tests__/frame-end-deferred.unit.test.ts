import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { FixedUpdate, FrameEnd, Update } from '../schedule-token';
import { World } from '../world';

describe('FrameEnd deferred visibility', () => {
  it.each([0, 1, 3])('exposes deferred entities after %i fixed ticks', (fixedTicks) => {
    const Marker = defineComponent(`FrameEndDeferred${fixedTicks}`, {});
    const world = new World();
    let observed = 0;

    world.addSystem(Update, {
      name: 'producer',
      queries: [],
      fn: (_world, _queries, commands) => commands.spawn({ component: Marker, data: {} }),
    });
    world.addSystem(FixedUpdate, { name: 'fixed', queries: [], fn: () => {} });
    world.addSystem(FrameEnd, {
      name: 'observer',
      queries: [{ with: [Marker] }],
      fn: (_world, results) => {
        observed = results[0].length;
      },
    });

    expect(world.update(fixedTicks / 60).ok).toBe(true);
    expect(observed).toBe(1);
  });

  it('runs exactly once per outer update', () => {
    const world = new World();
    let frameEnds = 0;
    world.addSystem(FrameEnd, { name: 'frame-end', queries: [], fn: () => frameEnds++ });

    world.update(0).unwrap();
    world.update(1 / 60).unwrap();
    world.update(3 / 60).unwrap();

    expect(frameEnds).toBe(3);
  });
});
