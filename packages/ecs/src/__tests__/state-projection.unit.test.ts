import { expect, test } from 'vitest';
import { defineComponent } from '../component';
import { type EntityHandle, entityIndex } from '../entity-handle';
import { createStateProjection } from '../projection/state-projection';
import { World } from '../world';

const Position = defineComponent('ProjectionPosition', { x: 'f32' });
const Extra = defineComponent('ProjectionExtra', {});
const Selected = defineComponent('ProjectionSelected', {}, { storage: 'sparse' });

test('sparse scalar changes inspect one block; failed candidates and consumers remain independent', () => {
  const world = new World();
  const entities = Array.from({ length: 1024 }, (_, x) =>
    world.spawn({ component: Position, data: { x } }).unwrap(),
  );
  const first = createStateProjection(world, [Position]);
  const second = createStateProjection(world, [Position]);
  first.read().accept();
  second.read().accept();
  expect(first.read().scannedRows).toBe(0);
  const changedEntity = entities[511];
  if (changedEntity === undefined) throw new Error('missing fixture entity');
  world.set(changedEntity, Position, { x: 9 }).unwrap();
  const failed = first.read();
  expect(failed.indices).toEqual([entityIndex(changedEntity)]);
  expect(failed.scannedRows).toBe(256);
  const retry = first.read();
  expect(retry.indices).toEqual([entityIndex(changedEntity)]);
  retry.accept();
  expect(first.read().indices).toEqual([]);
  expect(second.read().indices).toEqual([entityIndex(changedEntity)]);
  expect(() => failed.accept()).toThrow();
});

test('migration, swap removal, generation reuse, sparse membership and deletion use final state', () => {
  const world = new World();
  const a = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  const b = world.spawn({ component: Position, data: { x: 2 } }).unwrap();
  const projection = createStateProjection(world, [Position, Selected]);
  projection.read().accept();
  world.addComponent(a, { component: Extra, data: {} }).unwrap();
  world.addComponent(a, { component: Selected, data: {} }).unwrap();
  world.despawn(b).unwrap();
  const replacement = world.spawn({ component: Position, data: { x: 3 } }).unwrap();
  const batch = projection.read();
  expect(new Set(batch.indices)).toEqual(new Set([entityIndex(a), entityIndex(b)]));
  expect(projection.entity(entityIndex(b))).toBe(replacement);
  batch.accept();
  world.removeComponent(a, Selected).unwrap();
  expect(projection.read().indices).toContain(entityIndex(a));
  projection.read().accept();
  world.despawn(a).unwrap();
  world.despawn(replacement).unwrap();
  const removed = projection.read();
  expect(new Set(removed.indices)).toEqual(new Set([entityIndex(a), entityIndex(b)]));
  removed.accept();
  expect(projection.read().indices).toEqual([]);
});

test('range writes publish their block summaries and invalidation preserves deletion evidence', () => {
  const world = new World();
  const entities = Array.from({ length: 600 }, () =>
    world.spawn({ component: Position, data: {} }).unwrap(),
  );
  const projection = createStateProjection(world, [Position]);
  projection.read().accept();
  for (const span of world
    .query({ write: [Position] })
    .unwrap()
    .spans()
    .unwrap())
    span.mut(Position).x.fill(4);
  expect(projection.read().indices).toHaveLength(600);
  projection.read().accept();
  const removedEntity = entities[0];
  if (removedEntity === undefined) throw new Error('missing fixture entity');
  world.despawn(removedEntity).unwrap();
  projection.invalidate();
  expect(projection.read().indices).toContain(entityIndex(removedEntity));
});

test.each([
  1, 17, 731, 65537,
])('matches an independent current-state oracle across skipped publications (seed %i)', (seed) => {
  let random = seed;
  const next = (limit: number) => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random % limit;
  };
  const world = new World();
  const projection = createStateProjection(world, [Position, Selected]);
  const live: EntityHandle[] = [];
  const accepted = new Map<number, { entity: number; x: number; selected: boolean }>();
  for (let step = 0; step < 800; step++) {
    const entity = live[next(Math.max(1, live.length))];
    const operation = next(6);
    if (entity === undefined || operation === 0)
      live.push(world.spawn({ component: Position, data: { x: next(100) } }).unwrap());
    else if (operation === 1) world.set(entity, Position, { x: next(100) }).unwrap();
    else if (operation === 2) {
      world.despawn(entity).unwrap();
      live.splice(live.indexOf(entity), 1);
    } else {
      const component = operation === 3 ? Extra : Selected;
      if (world.hasComponent(entity, component)) world.removeComponent(entity, component).unwrap();
      else world.addComponent(entity, { component, data: {} }).unwrap();
    }
    if (step % 7 !== 0) continue;
    if (step % 31 === 0) projection.invalidate();
    const candidate = projection.read();
    if (step % 11 === 0) continue;
    for (const index of candidate.indices) {
      const current = projection.entity(index);
      const position = current === undefined ? undefined : world.get(current, Position);
      if (current === undefined || !position?.ok) accepted.delete(index);
      else
        accepted.set(index, {
          entity: current,
          x: position.value.x,
          selected: world.hasComponent(current, Selected),
        });
    }
    candidate.accept();
    const oracle = new Map<number, { entity: number; x: number; selected: boolean }>();
    for (const row of world.query({ read: [Position] }).unwrap()) {
      oracle.set(entityIndex(row.entity), {
        entity: row.entity,
        x: row.get(Position).x,
        selected: world.hasComponent(row.entity, Selected),
      });
    }
    expect(accepted).toEqual(oracle);
  }
});

test('invalidating an outstanding candidate prevents acceptance and retains the baseline', () => {
  const world = new World();
  const entity = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  const projection = createStateProjection(world, [Position]);
  projection.read().accept();
  const stale = projection.read();
  projection.invalidate();
  expect(() => stale.accept()).toThrow();
  expect(projection.read().indices).toEqual([entityIndex(entity)]);
});

test('source writes during candidate construction cannot be accepted', () => {
  const world = new World();
  const entity = world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  const projection = createStateProjection(world, [Position]);
  const stale = projection.read();
  world.set(entity, Position, { x: 2 }).unwrap();
  expect(() => stale.validate()).toThrow();
  expect(() => stale.accept()).toThrow();
  const current = projection.read();
  expect(current.indices).toEqual([entityIndex(entity)]);
  current.accept();
  expect(projection.read().indices).toEqual([]);
});
