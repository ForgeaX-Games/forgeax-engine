import { describe, expectTypeOf, it } from 'vitest';
import { defineComponent } from '../component';
import { Entity } from '../entity';
import { createQueryState, queryRun } from '../query';
import { Update } from '../schedule-token';
import { World } from '../world';

const Position = defineComponent('ConsumerPosition', { x: { type: 'f32' }, y: { type: 'f32' } });

describe('consumer inference remains native at every ECS callback boundary', () => {
  it('infers addSystem, queryRun, and direct World access without assertions', () => {
    const world = new World();
    const entity = world.spawn({ component: Position, data: { x: 1, y: 2 } }).unwrap();
    const direct = world.get(entity, Position).unwrap().x;
    expectTypeOf(direct).toEqualTypeOf<number>();

    world.addSystem(Update, {
      name: 'consumer-inference',
      queries: [{ with: [Position, Entity] }],
      fn: (_world, results) => {
        const x = results[0]?.[0]?.ConsumerPosition?.x;
        if (x) expectTypeOf(x).toEqualTypeOf<Float32Array>();
      },
    });

    const state = createQueryState({ with: [Position, Entity] });
    queryRun(state, world, (bundle) => {
      if (bundle.ConsumerPosition)
        expectTypeOf(bundle.ConsumerPosition.x).toEqualTypeOf<Float32Array>();
      if (bundle.Entity) expectTypeOf(bundle.Entity.self).toEqualTypeOf<Uint32Array>();
    });
  });
});
