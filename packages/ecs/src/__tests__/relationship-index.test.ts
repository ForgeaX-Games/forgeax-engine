import { describe, expect, it } from 'vitest';
import { componentSchema } from '../component';
import { componentDefinition } from '../component-schema';
import { defineRelationship, RelationshipIndex, relationshipRole } from '../relationship-index';
import { World } from '../world';

describe('relationship index', () => {
  it('keeps source writable and target materialized/read-only by role', () => {
    const pair = defineRelationship({
      sourceName: 'IndexSource',
      sourceField: 'target',
      targetName: 'IndexTargets',
      targetField: 'sources',
    });
    expect(relationshipRole(pair.source)?.kind).toBe('source');
    expect(relationshipRole(pair.target)?.kind).toBe('target');
    expect(componentDefinition(pair.target).fields.sources?.transient).toBe(true);
    expect(componentSchema(pair.target).sources).toBe('array<entity>');
  });

  it('stores only source slots; World owns the materialized target array', () => {
    const index = new RelationshipIndex();
    const parentA = 1 as never;
    const parentB = 2 as never;
    const first = 11 as never;
    const second = 12 as never;
    index.attach(first, parentA, 0);
    index.attach(second, parentA, 1);
    expect(index.slotOf(second)).toBe(1);
    expect(index.detach(first)).toBe(true);
    index.updateSlot(second, parentA, 0);
    expect(index.slotOf(second)).toBe(0);
    index.reparent(second, parentB, 0);
    expect(index.targetOf(second)).toBe(parentB);
    expect(index.epoch).toBeGreaterThan(0);
  });

  it('recovers only from the supplied R source records', () => {
    const index = new RelationshipIndex();
    index.recover([
      [11 as never, 1 as never],
      [12 as never, 1 as never],
    ]);
    expect(index.slotOf(11 as never)).toBe(0);
    expect(index.slotOf(12 as never)).toBe(1);
    expect(index.targetOf(12 as never)).toBe(1);
  });

  it('materializes the target and rejects direct target writes', () => {
    const pair = defineRelationship({
      sourceName: 'WorldSource',
      sourceField: 'target',
      targetName: 'WorldTargets',
      targetField: 'sources',
    });
    const world = new World();
    const target = world.spawn().unwrap();
    const source = world.spawn({ component: pair.source, data: { target } }).unwrap();
    expect(world.get(target, pair.target).unwrap().sources).toContain(source);
    // @ts-expect-error relationship targets are read-only projections.
    expect(world.set(target, pair.target, { sources: [] }).ok).toBe(false);
    // @ts-expect-error relationship targets are read-only projections.
    expect(world.removeComponent(target, pair.target).ok).toBe(false);
    // @ts-expect-error relationship targets are read-only projections.
    expect(world.addComponent(target, { component: pair.target, data: { sources: [] } }).ok).toBe(
      false,
    );
    world.spawn({ component: pair.target, data: { sources: [] } });
  });
});
