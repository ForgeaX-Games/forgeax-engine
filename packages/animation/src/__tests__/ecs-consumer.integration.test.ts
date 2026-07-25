import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { animationPlugin } from '../plugin';

describe('animation ECS consumer', () => {
  it('accepts the plugin build callback from a real World', async () => {
    const result = await animationPlugin().build(new World());
    expect(result.ok).toBe(true);
  });
});
