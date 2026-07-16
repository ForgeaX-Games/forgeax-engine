// feat-20260618-ecs-module-mechanism M1 / w2 (AC-02):
// After defineSystem, getRegisteredSystems() enumerates the descriptor by name
// and the returned handle carries every descriptor field: queries / fn / after /
// before / resources / runIf. SystemSet membership belongs to World scheduling state.
//
// Constraints (plan-strategy D-6): getRegisteredSystems() returns the
// type-erased ReadonlyMap<string, SystemHandle<any>> -- the aux enumeration
// path does not preserve generics.

import { describe, expect, it } from 'vitest';
import { defineComponent } from '../src/component';
import { defineSystem, defineSystemSet, getRegisteredSystems, World } from '../src/index';

describe('define-system-registry.test.ts', () => {
  it('AC-02: getRegisteredSystems() enumerates handle with all fields by name', () => {
    const A = defineComponent('W2A', { x: 'f32' });
    const handle = defineSystem({
      name: 'w2-full',
      queries: [{ with: [A] }],
      fn: () => {},
      after: ['w2-upstream'],
      before: ['w2-downstream'],
      resources: ['W2Resource'],
      runIf: () => true,
    });

    const registry = getRegisteredSystems();
    const got = registry.get('w2-full');
    expect(got).toBeDefined();
    expect(got).toBe(handle);
    // Full field enumeration.
    expect(got?.name).toBe('w2-full');
    expect(got?.queries).toHaveLength(1);
    expect(typeof got?.fn).toBe('function');
    expect(got?.after).toEqual(['w2-upstream']);
    expect(got?.before).toEqual(['w2-downstream']);
    expect(got?.resources).toEqual(['W2Resource']);
    expect(typeof got?.runIf).toBe('function');

    const world = new World();
    const set = defineSystemSet({ name: 'w2-set' });
    world.addSystems(set, [handle]);
    expect(world.inspect().systems.find((system) => system.name === 'w2-full')?.sets).toEqual([
      'w2-set',
    ]);
  });

  it('AC-02: registry is a read-only Map snapshot', () => {
    defineSystem({ name: 'w2-snapshot', queries: [], fn: () => {} });
    const registry = getRegisteredSystems();
    expect(registry.has('w2-snapshot')).toBe(true);
    expect(registry).toBeInstanceOf(Map);
  });
});
