import { describe, expect, it } from 'vitest';
import { reflectVfxRenderer } from '../reflection.js';

describe('Batch B renderer reflection', () => {
  it('derives topology and independent bounded output metadata', () => {
    const reflected = reflectVfxRenderer([
      { kind: 'billboard', material: 'vfx', sorting: 'back-to-front' },
      { kind: 'ribbon', material: 'vfx', stripKey: 'alive-index', capacity: 32 },
      { kind: 'trail', material: 'vfx', historyLength: 8, capacity: 32 },
      { kind: 'beam', material: 'vfx', endpointField: 'velocity', capacity: 16 },
    ]);

    expect(reflected.ok).toBe(true);
    if (reflected.ok) {
      expect(reflected.value.map((entry) => entry.topology)).toEqual([
        'billboard',
        'ribbon',
        'trail',
        'beam',
      ]);
      expect(reflected.value.map((entry) => entry.capacity)).toEqual([64, 32, 32, 16]);
      expect(new Set(reflected.value.map((entry) => entry.resource)).size).toBe(4);
    }
  });
});
