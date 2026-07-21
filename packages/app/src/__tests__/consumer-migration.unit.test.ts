import { Time, Update, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';

describe('callback consumer migration', () => {
  it('registers character-style per-frame work as an Update system reading Time', () => {
    const world = new World();
    let observed = 0;
    world
      .addSystem(Update, {
        name: 'character-drive',
        queries: [],
        fn: () => {
          observed = world.getResource(Time).delta;
        },
      })
      .unwrap();

    world.update(1 / 60).unwrap();
    expect(observed).toBeCloseTo(1 / 60);
  });
});
