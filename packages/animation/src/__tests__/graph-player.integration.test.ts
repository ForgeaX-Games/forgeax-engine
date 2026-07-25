import { Update, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { animationPlugin } from '../index';

describe('animation graph World chain', () => {
  it('registers systems on a real World schedule', async () => {
    const world = new World();
    expect((await animationPlugin().build(world)).ok).toBe(true);
    expect(() => world.update(1 / 60)).not.toThrow();
    void Update;
  });
});
