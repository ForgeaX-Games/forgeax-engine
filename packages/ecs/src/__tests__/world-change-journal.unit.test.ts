import { describe, expect, it } from 'vitest';
import { componentId, defineComponent } from '../component';
import { encodeEntity } from '../entity-handle';
import { createWorldProjection } from '../projection';
import { World } from '../world';
import { WorldChangeJournal, type WorldChangeRecord } from '../world-change-journal';
import { worldInternal } from '../world-internal';

describe('WorldChangeJournal', () => {
  it('returns only records after the supplied cursor', () => {
    const journal = new WorldChangeJournal(4);
    const cursor = journal.cursor();
    const first = encodeEntity(7, 0);
    const second = encodeEntity(9, 0);

    journal.append({ kind: 'component-changed', entity: first, componentId: 3 });
    journal.append({ kind: 'entity-removed', entity: second });

    expect(journal.readAfter(cursor)).toEqual({
      status: 'ok',
      cursor: 2,
      records: [
        { sequence: 1, kind: 'component-changed', entity: first, componentId: 3 },
        { sequence: 2, kind: 'entity-removed', entity: second },
      ],
    });
    expect(journal.readAfter(2)).toEqual({ status: 'ok', cursor: 2, records: [] });
  });

  it('reports overflow instead of returning an incomplete delta', () => {
    const journal = new WorldChangeJournal(2);
    const cursor = journal.cursor();
    const first = encodeEntity(1, 0);
    const second = encodeEntity(2, 0);
    const third = encodeEntity(3, 0);

    journal.append({ kind: 'component-changed', entity: first, componentId: 1 });
    journal.append({ kind: 'component-changed', entity: second, componentId: 1 });
    journal.append({ kind: 'component-changed', entity: third, componentId: 1 });

    expect(journal.readAfter(cursor)).toEqual({
      status: 'overflow',
      cursor: 3,
      oldestAvailable: 2,
    });
  });
});

describe('World mutation journal', () => {
  it('projects narrow component evidence without exposing journal records', () => {
    const Value = defineComponent('ProjectionValue', { value: 'u32' });
    const world = new World();
    const projection = createWorldProjection(world, { components: [Value] });
    const entity = world.spawn({ component: Value, data: { value: 1 } }).unwrap();

    const result = projection.poll();
    expect(result.status).toBe('delta');
    if (result.status !== 'delta') return;
    expect(result.changes).toEqual([
      { entity, kind: 'component-added', component: Value, componentId: componentId(Value) },
    ]);
    expect(result.changes[0]).not.toHaveProperty('sequence');
    expect(result.changes[0]).not.toHaveProperty('table');
    expect(result.changes[0]).not.toHaveProperty('column');
  });

  it('publishes component lifecycle and entity removal as ordered evidence', () => {
    const Marker = defineComponent('WorldJournalMarker', { value: 'f32' });
    const Extra = defineComponent('WorldJournalExtra', { value: 'u32' });
    const world = new World();
    const cursor = world[worldInternal].getChangeCursor();

    const entity = world.spawn({ component: Marker, data: { value: 1 } }).unwrap();
    world.set(entity, Marker, { value: 2 }).unwrap();
    world.addComponent(entity, { component: Extra, data: { value: 3 } }).unwrap();
    world.removeComponent(entity, Extra).unwrap();
    world.despawn(entity).unwrap();

    const result = world[worldInternal].readChangesSince(cursor);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(
      result.records.map((record: WorldChangeRecord) => ({
        kind: record.kind,
        entity: record.entity,
        componentId: record.componentId,
      })),
    ).toEqual([
      { kind: 'component-added', entity, componentId: 0 },
      { kind: 'component-added', entity, componentId: componentId(Marker) },
      { kind: 'component-changed', entity, componentId: componentId(Marker) },
      { kind: 'component-added', entity, componentId: componentId(Extra) },
      { kind: 'component-removed', entity, componentId: componentId(Extra) },
      { kind: 'entity-removed', entity, componentId: undefined },
    ]);
  });
});
