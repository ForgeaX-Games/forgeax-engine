import { World } from '@forgeax/engine-ecs';
import { INPUT_BACKEND_KEY } from '@forgeax/engine-input';
import { describe, expect, it } from 'vitest';

import { inputPlugin } from '../src/plugin-factories';

describe('inputPlugin SystemSet registration', () => {
  it('records InputFrameStartScan in the input set', () => {
    const world = new World();
    world.insertResource(INPUT_BACKEND_KEY, {} as never);

    const result = inputPlugin().build(world);

    expect(result.ok).toBe(true);
    expect(
      world.inspect().systems.find((system) => system.name === 'input-frame-start-scan')?.sets,
    ).toContain('input');
  });
});
