import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

const Marker = defineComponent('ChangeDetectionMarker', { value: 'f32' });

describe('mutation epoch evidence', () => {
  it('advances once per successful mutation and not for failures or no-ops', () => {
    const Other = defineComponent('MutationEpochOther', { value: 'f32' });
    const world = new World();
    const entity = world.spawn({ component: Marker, data: { value: 1 } }).unwrap();
    expect(world._getMutationEpoch()).toBe(1);
    expect(world._getComponentChange(entity, Marker.id)).toEqual({ added: 1, changed: 1 });

    expect(world.set(entity, Other, { value: 2 }).ok).toBe(false);
    world.removeResource('missing');
    expect(world._getMutationEpoch()).toBe(1);

    world.set(entity, Marker, { value: 2 }).unwrap();
    expect(world._getMutationEpoch()).toBe(2);
    expect(world._getComponentChange(entity, Marker.id)).toEqual({ added: 1, changed: 2 });
  });

  it('keeps resource evidence on its ResourceStore entry', () => {
    const world = new World();
    world.insertResource('ChangeDetectionResource', { value: 1 });
    expect(world.getResourceChange('ChangeDetectionResource')).toEqual({ added: 1, changed: 1 });
    world.update(1 / 60).unwrap();
    world.insertResource('ChangeDetectionResource', { value: 2 });
    expect(world.getResourceChange('ChangeDetectionResource')).toEqual({ added: 1, changed: 2 });
  });

  it('keeps independent query cursors and retries after consumer throws', () => {
    const world = new World();
    const entity = world.spawn({ component: Marker, data: { value: 1 } }).unwrap();
    const first = world.query({ read: [Marker], changed: [Marker] }).unwrap();
    const second = world.query({ read: [Marker], changed: [Marker] }).unwrap();

    expect(() => {
      for (const _row of first) throw new Error('consumer failure');
    }).toThrow('consumer failure');
    expect([...first].map((row) => row.entity)).toEqual([entity]);
    expect([...second].map((row) => row.entity)).toEqual([entity]);
  });

  it('does not inherit evidence when a slot generation is reused', () => {
    const world = new World();
    const retired = world.spawn({ component: Marker, data: { value: 1 } }).unwrap();
    const added = world.query({ read: [Marker], added: [Marker] }).unwrap();
    expect([...added].map((row) => row.entity)).toEqual([retired]);

    world.despawn(retired).unwrap();
    const reused = world.spawn({ component: Marker, data: { value: 2 } }).unwrap();
    expect((reused as number) & 0xffffff).toBe((retired as number) & 0xffffff);
    expect(reused).not.toBe(retired);
    expect([...added].map((row) => row.entity)).toEqual([reused]);
  });

  it('carries evidence through grow, migration, and swap-pop', () => {
    const Attached = defineComponent('MutationEpochAttached', { flag: 'u8' });
    const world = new World();
    const entities = Array.from({ length: 65 }, (_, value) =>
      world.spawn({ component: Marker, data: { value } }).unwrap(),
    );
    const changed = world.query({ read: [Marker], changed: [Marker] }).unwrap();
    expect([...changed].length).toBe(65);

    const survivor = entities[0];
    const removed = entities[1];
    if (survivor === undefined || removed === undefined) throw new Error('fixture');
    world.addComponent(survivor, { component: Attached, data: { flag: 1 } }).unwrap();
    world.despawn(removed).unwrap();
    expect([...changed]).toEqual([]);

    world.set(survivor, Marker, { value: 99 }).unwrap();
    expect([...changed].map((row) => row.entity)).toEqual([survivor]);
  });
});
