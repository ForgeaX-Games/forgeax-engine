import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { Update } from '../schedule-token';
import { World } from '../world';

describe('component lifecycle hooks', () => {
  it('fires add and insert for new rows, then discard and insert on set', () => {
    const events: string[] = [];
    const Hooked = defineComponent(
      'ComponentHooksUnitSet',
      { key: 'u32', value: 'f32' },
      {
        onAdd: (_entity, value) => events.push(`add:${value.key}`),
        onInsert: (_entity, value) => events.push(`insert:${value.key}`),
        onDiscard: (_entity, value) => events.push(`discard:${value.key}`),
        onRemove: (_entity, value) => events.push(`remove:${value.key}`),
      },
    );
    const world = new World();
    const entity = world.spawn({ component: Hooked, data: { key: 1, value: 0 } }).unwrap();

    world.set(entity, Hooked, { key: 2, value: 3 }).unwrap();

    expect(events).toEqual(['add:1', 'insert:1', 'discard:1', 'insert:2']);
  });

  it('fires discard before removeComponent and despawn with the old value', () => {
    const events: string[] = [];
    const Hooked = defineComponent(
      'ComponentHooksUnitRemove',
      { key: 'u32' },
      {
        onDiscard: (_entity, value) => events.push(`discard:${value.key}`),
        onRemove: (_entity, value) => events.push(`remove:${value.key}`),
      },
    );
    const world = new World();
    const removed = world.spawn({ component: Hooked, data: { key: 7 } }).unwrap();
    const retired = world.spawn({ component: Hooked, data: { key: 9 } }).unwrap();

    world.removeComponent(removed, Hooked).unwrap();
    world.despawn(retired).unwrap();

    expect(events).toEqual(['discard:7', 'remove:7', 'discard:9', 'remove:9']);
  });

  it('fires add and insert for deferred materialization', () => {
    const events: string[] = [];
    const Hooked = defineComponent(
      'ComponentHooksUnitDeferred',
      { key: 'u32' },
      {
        onAdd: (_entity, value) => events.push(`add:${value.key}`),
        onInsert: (_entity, value) => events.push(`insert:${value.key}`),
      },
    );
    const world = new World();
    world
      .addSystem(Update, {
        name: 'component-hooks-deferred-test',
        queries: [],
        fn: (_world, _queryResults, commands) => {
          commands.spawn({ component: Hooked, data: { key: 11 } });
        },
      })
      .unwrap();
    world.update(0.016).unwrap();

    expect(events).toEqual(['add:11', 'insert:11']);
  });
});
