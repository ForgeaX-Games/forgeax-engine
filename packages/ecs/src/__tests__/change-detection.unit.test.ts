import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { Entity } from '../entity';
import { createQueryState, queryRun } from '../query';
import { World } from '../world';

const Marker = defineComponent('ChangeDetectionMarker', { value: 'f32' });
const AddedMarker = defineComponent('ChangeDetectionAddedMarker', { value: 'f32' });

describe('change detection', () => {
  it('tracks Changed rows and keeps filtered bundles live and contiguous', () => {
    const world = new World();
    const first = world.spawn({ component: Marker, data: { value: 1 } }).unwrap();
    const second = world.spawn({ component: Marker, data: { value: 2 } }).unwrap();
    const changed = createQueryState<readonly [typeof Marker, typeof Entity]>({
      with: [Marker, Entity],
      changed: [Marker],
    });
    const values: number[] = [];

    queryRun(changed, world, (bundle) => {
      values.push(bundle.Entity.self.length);
    });
    expect(values).toEqual([2]);
    values.length = 0;
    queryRun(changed, world, (bundle) => values.push(bundle.Entity.self.length));
    expect(values).toEqual([]);

    world.update(1 / 60).unwrap();
    world.set(second, Marker, { value: 20 }).unwrap();
    values.length = 0;
    queryRun(changed, world, (bundle) => values.push(bundle.Entity.self.length));
    expect(values).toEqual([1]);
    expect(world.get(second, Marker).unwrap().value).toBe(20);
    expect(world.get(first, Marker).unwrap().value).toBe(1);
  });

  it('distinguishes Added from later Changed writes', () => {
    const world = new World();
    const added = createQueryState<readonly [typeof AddedMarker, typeof Entity]>({
      with: [AddedMarker, Entity],
      added: [AddedMarker],
    });
    const entity = world.spawn({ component: AddedMarker, data: { value: 3 } }).unwrap();
    const seen: number[] = [];

    queryRun(added, world, (bundle) => seen.push(bundle.Entity.self.length));
    expect(seen).toEqual([1]);
    seen.length = 0;
    world.update(1 / 60).unwrap();
    world.set(entity, AddedMarker, { value: 4 }).unwrap();
    queryRun(added, world, (bundle) => seen.push(bundle.Entity.self.length));
    expect(seen).toEqual([]);
  });

  it('records resource insertion and overwrite ticks', () => {
    const world = new World();
    world.insertResource('ChangeDetectionResource', { value: 1 });
    const added = world.getResourceChange('ChangeDetectionResource');
    expect(added?.added).toBe(0);
    expect(added?.changed).toBe(0);
    world.update(1 / 60).unwrap();
    world.insertResource('ChangeDetectionResource', { value: 2 });
    expect(world.getResourceChange('ChangeDetectionResource')?.changed).toBe(1);
  });
});
