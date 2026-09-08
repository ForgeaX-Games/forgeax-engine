import { Update } from '@forgeax/engine-ecs';
import { INPUT_BACKEND_KEY, InputFrameStartScan, InputSet } from '@forgeax/engine-input';
import type { Plugin } from '@forgeax/engine-plugin';

/** Project one Host-owned input provider into reversible World contributions. */
export function inputPlugin(): Plugin {
  return {
    name: 'input',
    inject: ['world', 'input'],
    apply(ctx) {
      const world = ctx.world;
      const input = ctx.input;
      if (input === undefined) throw new Error('Cordis activated input without its provider');
      ctx.effect(() => {
        world.insertResource(INPUT_BACKEND_KEY, input);
        return () => {
          world.removeResource(INPUT_BACKEND_KEY);
        };
      }, 'input/resource');
      ctx.effect(() => {
        world.addSystems(Update, InputSet, [InputFrameStartScan]).unwrap();
        return () => world.removeSystem(Update, InputFrameStartScan.name);
      }, 'input/frame-start-scan');
    },
  };
}
