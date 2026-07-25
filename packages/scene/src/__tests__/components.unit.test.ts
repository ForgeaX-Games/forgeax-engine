import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, Children, Name, Transform } from '../index';

describe('scene component roster', () => {
  it('exports exactly the four scene components', () => {
    expect(Object.keys({ Name, Transform, ChildOf, Children }).sort()).toEqual([
      'ChildOf',
      'Children',
      'Name',
      'Transform',
    ]);
  });

  it('registers and spawns in a headless world', () => {
    const world = new World();
    const entity = world
      .spawn(
        { component: Name, data: { value: 'root' } },
        { component: Transform, data: {} },
        { component: Children, data: {} },
      )
      .unwrap();
    expect(world.get(entity, Name).unwrap().value).toBe('root');
  });
});
