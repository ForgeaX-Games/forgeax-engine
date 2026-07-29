import { describe, expect, it } from 'vitest';
import { Disabled, defineComponent, Entity, World } from '../index';
import { createQueryState, queryRun } from '../query';

const Target = defineComponent('EntityDisablingTarget', { value: 'u32' });

function count(state: ReturnType<typeof createQueryState>, world: World): number {
  let total = 0;
  queryRun(state, world, (bundle) => {
    total += bundle.Entity?.self?.length ?? 0;
  });
  return total;
}

describe('Disabled default query filter', () => {
  it('excludes disabled entities while explicit Disabled queries include them', () => {
    const world = new World();
    world.spawn({ component: Target, data: { value: 1 } }).unwrap();
    world
      .spawn({ component: Target, data: { value: 2 } }, { component: Disabled, data: {} })
      .unwrap();

    const active = createQueryState({ with: [Target, Entity] });
    const disabled = createQueryState({ with: [Target, Disabled, Entity] });

    expect(count(active, world)).toBe(1);
    expect(count(disabled, world)).toBe(1);
  });

  it('recomputes the default filter when an entity is disabled and re-enabled', () => {
    const world = new World();
    const entity = world.spawn({ component: Target, data: { value: 1 } }).unwrap();
    const active = createQueryState({ with: [Target, Entity] });

    expect(count(active, world)).toBe(1);
    world.addComponent(entity, { component: Disabled, data: {} }).unwrap();
    expect(count(active, world)).toBe(0);
    world.removeComponent(entity, Disabled).unwrap();
    expect(count(active, world)).toBe(1);
  });
});
