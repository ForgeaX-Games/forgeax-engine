// feat-20260618-ecs-module-mechanism M1 / w5 (AC-08):
// getRegisteredComponents() returns ReadonlyMap<string, Component>; after
// multiple defineComponent calls the map enumerates each by name.
//
// Constraints (requirements OOS-4 / section 4.1): no undefineComponent;
// defineComponent silent-overwrite on duplicate name preserved (no gate).

import { describe, expect, it } from 'vitest';
import { defineComponent } from '../src/component';
import { getRegisteredComponents } from '../src/index';

describe('get-registered-components.test.ts', () => {
  it('AC-08: enumerates defined components by name', () => {
    const Foo = defineComponent('W5Foo', { x: 'f32' });
    const Bar = defineComponent('W5Bar', { y: 'f32', z: 'f32' });

    const registry = getRegisteredComponents();
    expect(registry.get('W5Foo')).toBe(Foo);
    expect(registry.get('W5Bar')).toBe(Bar);
  });

  it('AC-08: returns a Map instance keyed by component name', () => {
    defineComponent('W5Baz', { v: 'f32' });
    const registry = getRegisteredComponents();
    expect(registry).toBeInstanceOf(Map);
    expect(registry.has('W5Baz')).toBe(true);
  });
});
