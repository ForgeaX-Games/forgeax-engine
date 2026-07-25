import { animationPlugin } from '@forgeax/engine-animation';
import { World } from '@forgeax/engine-ecs';
import { scenePlugin } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';

describe('scene plugin policy', () => {
  it('can be composed on a host-owned world', async () => {
    const world = new World();
    const result = await scenePlugin().build(world);
    expect(result.ok).toBe(true);
  });
});

it('extracted animation plugin has a stable build contract', () => {
  expect(animationPlugin().name).toBe('animation');
});
