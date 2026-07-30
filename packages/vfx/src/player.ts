import { defineComponent, type ShapeOf } from '@forgeax/engine-ecs';

/** ECS author intent for one shared particle effect. */
export const ParticleEffectPlayer = defineComponent('ParticleEffectPlayer', {
  effect: { type: 'shared<ParticleEffectAsset>' },
  playing: { type: 'bool', default: true },
  seed: { type: 'u32', default: 0 },
  timeScale: { type: 'f32', default: 1 },
});

/** The four serializable fields stored by {@link ParticleEffectPlayer}. */
export type ParticleEffectPlayerData = ShapeOf<typeof ParticleEffectPlayer.schema>;
