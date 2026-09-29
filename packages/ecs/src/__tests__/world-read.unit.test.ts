import { describe, expect, it } from 'vitest';
import { defineRelationship } from '../relationship-index';
import { World } from '../world';
import { worldRead } from '../world-read';

const relationship = defineRelationship({
  sourceName: 'WorldReadSource',
  sourceField: 'target',
  targetName: 'WorldReadTargets',
  targetField: 'sources',
});

describe('World semantic read seam', () => {
  it('reads relationship facts without exposing a storage view', () => {
    const world = new World();
    const target = world.spawn().unwrap();
    const source = world.spawn({ component: relationship.source, data: { target } }).unwrap();

    expect(world[worldRead].getFieldValue(source, relationship.source, 'target')).toBe(
      target as number,
    );
    expect(world[worldRead].getArrayLength(target, relationship.target, 'sources')).toBe(1);
    expect(world[worldRead].getArrayElement(target, relationship.target, 'sources', 0)).toBe(
      source as number,
    );
    expect(world[worldRead].getArrayElement(target, relationship.target, 'sources', 1)).toBe(
      undefined,
    );
  });
});
