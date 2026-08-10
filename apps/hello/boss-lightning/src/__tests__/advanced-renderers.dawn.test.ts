import { describe, expect, it } from 'vitest';
import { createTopologyResourcePlan } from '@forgeax/engine-vfx-render';

describe('Boss Lightning Dawn advanced renderer contract', () => {
  it('keeps Dawn topology resources distinct', () => {
    const plans = [
      createTopologyResourcePlan({
        kind: 'ribbon',
        material: 'vfx',
        stripKey: 'alive-index',
        capacity: 8,
      }),
      createTopologyResourcePlan({ kind: 'trail', material: 'vfx', historyLength: 4, capacity: 8 }),
      createTopologyResourcePlan({
        kind: 'beam',
        material: 'vfx',
        endpointField: 'velocity',
        capacity: 8,
      }),
    ];

    expect(plans.every(result => result.ok)).toBe(true);
    const resources = plans.flatMap(result => (result.ok ? [result.value.resourceKey] : []));
    expect(new Set(resources).size).toBe(3);
  });
});
