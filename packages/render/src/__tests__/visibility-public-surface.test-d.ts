import { createQueryState, Entity, queryRun, World } from '@forgeax/engine-ecs';
import {
  Visibility,
  type VisibilityState,
  VisibilityStateValue,
  visibilityStateFromU32,
} from '@forgeax/engine-render';
import { expectTypeOf } from 'vitest';

const world = new World();
const entity = world.spawn({ component: Visibility, data: {} }).unwrap();

expectTypeOf(VisibilityStateValue.inherited).toEqualTypeOf<0>();
expectTypeOf(VisibilityStateValue.hidden).toEqualTypeOf<1>();
expectTypeOf(VisibilityStateValue.visible).toEqualTypeOf<2>();
expectTypeOf(visibilityStateFromU32(0)).toEqualTypeOf<VisibilityState | undefined>();
expectTypeOf(visibilityStateFromU32(99)).toEqualTypeOf<VisibilityState | undefined>();

world.set(entity, Visibility, { state: VisibilityStateValue.visible });

const query = createQueryState({ with: [Visibility, Entity] });
queryRun(query, world, (bundle) => {
  const rawState = bundle.Visibility.state[0];
  const decodedState = visibilityStateFromU32(rawState ?? VisibilityStateValue.inherited);
  expectTypeOf(decodedState).toEqualTypeOf<VisibilityState | undefined>();
});
