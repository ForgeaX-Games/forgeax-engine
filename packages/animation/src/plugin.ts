import { ok } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { registerAdvanceAnimationPlayer } from './systems/advance-animation-player';
import { registerEvaluateAnimationGraph } from './systems/evaluate-animation-graph';

export function animationPlugin(): Plugin {
  return {
    name: 'animation',
    build(world) {
      registerEvaluateAnimationGraph(world);
      registerAdvanceAnimationPlayer(world);
      return ok(undefined);
    },
  };
}
