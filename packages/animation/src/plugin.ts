import type { Component, World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { AnimationPlayer } from './animation-player';
import { AnimatedBy, AnimationTargetId, AnimationTargets } from './animation-target';
import { registerAdvanceAnimationPlayer } from './systems/advance-animation-player';
import {
  type AnimationPayloadLookup,
  registerEvaluateAnimationGraph,
} from './systems/evaluate-animation-graph';

const ANIMATION_COMPONENTS: readonly Component[] = [
  AnimationPlayer,
  AnimatedBy,
  AnimationTargetId,
  AnimationTargets,
];

function registerAnimationComponents(world: World): () => void {
  const leases = ANIMATION_COMPONENTS.map((component) =>
    world.components.register(component).unwrap(),
  );
  return () => {
    for (let index = leases.length - 1; index >= 0; index -= 1) leases[index]?.dispose();
  };
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    animationPayloads?: AnimationPayloadLookup;
  }
}

/** Provide the realm's asset-backed animation payload resolver. */
export function animationPayloadsPlugin(lookup: AnimationPayloadLookup): Plugin {
  return {
    name: 'animation-payloads',
    provide: 'animationPayloads',
    apply(ctx) {
      ctx.provide('animationPayloads', lookup);
    },
  };
}

/** Install animation behavior from declared World and payload services. */
export function animationRuntimePlugin(): Plugin {
  return {
    name: 'animation',
    inject: ['world', 'animationPayloads'],
    apply(ctx) {
      ctx.effect(() => registerAnimationComponents(ctx.world), 'animation/components');
      ctx.effect(
        () => registerEvaluateAnimationGraph(ctx.world, ctx.animationPayloads),
        'animation/evaluate-graph',
      );
      ctx.effect(() => registerAdvanceAnimationPlayer(ctx.world), 'animation/advance-player');
    },
  };
}

export function animationPlugin(lookup?: AnimationPayloadLookup): Plugin {
  return {
    name: 'animation',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => registerAnimationComponents(ctx.world), 'animation/components');
      ctx.effect(
        () => registerEvaluateAnimationGraph(ctx.world, lookup),
        'animation/evaluate-graph',
      );
      ctx.effect(() => registerAdvanceAnimationPlayer(ctx.world), 'animation/advance-player');
    },
  };
}
