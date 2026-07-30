import type { Handle } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { ParticleEffectPlayer } from '../index.js';

describe('ParticleEffectPlayer public type shape', () => {
  it('contains only the author-intent schema fields', () => {
    expectTypeOf<keyof typeof ParticleEffectPlayer.schema>().toEqualTypeOf<
      'effect' | 'playing' | 'seed' | 'timeScale'
    >();
    expectTypeOf<
      typeof ParticleEffectPlayer.schema.effect
    >().toEqualTypeOf<'shared<ParticleEffectAsset>'>();
    expectTypeOf<typeof ParticleEffectPlayer.schema.playing>().toEqualTypeOf<'bool'>();
    expectTypeOf<typeof ParticleEffectPlayer.schema.seed>().toEqualTypeOf<'u32'>();
    expectTypeOf<typeof ParticleEffectPlayer.schema.timeScale>().toEqualTypeOf<'f32'>();
  });

  it('derives the shared effect handle from the ECS schema', () => {
    type Data = import('@forgeax/engine-ecs').ShapeOf<typeof ParticleEffectPlayer.schema>;
    expectTypeOf<Data['effect']>().toEqualTypeOf<Handle<'ParticleEffectAsset', 'shared'>>();
    expectTypeOf<Data['playing']>().toEqualTypeOf<boolean>();
    expectTypeOf<Data['seed']>().toEqualTypeOf<number>();
    expectTypeOf<Data['timeScale']>().toEqualTypeOf<number>();
  });
});
