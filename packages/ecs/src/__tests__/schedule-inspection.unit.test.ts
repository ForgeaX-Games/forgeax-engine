import { describe, expect, it } from 'vitest';
import { FixedUpdate, Update } from '../schedule-token';
import { World } from '../world';

describe('schedule-scoped inspection', () => {
  it('groups systems by their owning schedule', () => {
    const world = new World();
    world.addSystem(Update, { name: 'update-system', queries: [], fn: () => {} });
    world.addSystem(FixedUpdate, { name: 'fixed-system', queries: [], fn: () => {} });

    const inspection = world.inspect();

    expect(inspection.scheduleSystemCount(Update)).toBe(1);
    expect(inspection.scheduleSystemCount(FixedUpdate)).toBe(1);
    expect(inspection.schedules).toEqual([
      { schedule: Update, systems: [{ name: 'update-system', sets: [] }] },
      { schedule: FixedUpdate, systems: [{ name: 'fixed-system', sets: [] }] },
    ]);
  });
});
