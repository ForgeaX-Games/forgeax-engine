import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Component, defineComponent } from '../component';
import {
  createEntityRemap,
  projectComponentData,
  validateProfileComponents,
} from '../externalization';
import { FixedUpdate } from '../schedule-token';
import { FixedTime, Time } from '../time';
import { World } from '../world';

const SimulationPose = defineComponent('SimulationFactsPose', {
  position: {
    type: 'array<f32, 3>',
    // biome-ignore lint/suspicious/noExplicitAny: fixed array defaults are branded at runtime
    default: [0, 0, 0] as any,
  },
  target: { type: 'entity' },
  transientVelocity: {
    type: 'array<f32, 3>',
    // biome-ignore lint/suspicious/noExplicitAny: fixed array defaults are branded at runtime
    default: [0, 0, 0] as any,
    transient: true,
  },
});

const SimulationRefs = defineComponent('SimulationFactsRefs', {
  // biome-ignore lint/suspicious/noExplicitAny: entity arrays are branded at runtime
  targets: { type: 'array<entity>', default: [] as any },
});

const SimulationTransient = defineComponent(
  'SimulationFactsTransient',
  { value: { type: 'f32', default: 0 } },
  { transient: true },
);

const SimulationNonPortable = defineComponent('SimulationFactsNonPortable', {
  resource: { type: 'ref' },
});

function timeFacts(world: World): Record<string, number> {
  const time = world.getResource(Time);
  const fixed = world.getResource(FixedTime);
  return {
    delta: time.delta,
    elapsed: time.elapsed,
    fixedDelta: fixed.delta,
    tick: fixed.tick,
    overstep: fixed.overstep,
    droppedSeconds: fixed.droppedSeconds,
    droppedUpdates: fixed.droppedUpdates,
  };
}

describe('M1 ECS simulation facts characterization', () => {
  it('keeps fixed clock fields observable at each completed fixed step', () => {
    const world = new World();
    const ticks: number[] = [];
    world.addSystem(FixedUpdate, {
      name: 'simulation-facts-fixed-clock',
      queries: [],
      fn: (_world) => ticks.push(_world.getResource(FixedTime).tick),
    });

    expect(world.update(1 / 30).ok).toBe(true);
    expect(ticks).toEqual([1, 2]);
    expect(timeFacts(world)).toEqual({
      delta: 1 / 30,
      elapsed: 1 / 30,
      fixedDelta: 1 / 60,
      tick: 2,
      overstep: 0,
      droppedSeconds: 0,
      droppedUpdates: 0,
    });
  });

  it('records clamp and dropped-step metrics without hiding them in the clock', () => {
    const world = new World({
      time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 1, maxDeltaSeconds: 0.1 },
    });
    world.addSystem(FixedUpdate, {
      name: 'simulation-facts-dropped-steps',
      queries: [],
      fn: () => undefined,
    });

    expect(world.update(0.1).ok).toBe(true);
    expect(timeFacts(world)).toEqual({
      delta: 0.1,
      elapsed: 0.1,
      fixedDelta: 1 / 60,
      tick: 1,
      overstep: 0.016666666666333332,
      droppedSeconds: 0.06666666666666667,
      droppedUpdates: 1,
    });
  });

  it('projects owned component facts while excluding transient fields', () => {
    const source = projectComponentData(SimulationPose as Component, {
      position: [1, 2, 3],
      target: 17,
      transientVelocity: [9, 8, 7],
    });
    const changedTransient = projectComponentData(SimulationPose as Component, {
      position: [1, 2, 3],
      target: 17,
      transientVelocity: [100, 200, 300],
    });

    expect(source).toEqual({ position: [1, 2, 3], target: 17 });
    expect(changedTransient).toEqual(source);
    expect(projectComponentData(SimulationTransient as Component, { value: 9 })).toEqual({});
  });

  it('remaps scalar and array entity references through an injected mapping', () => {
    const scalar = projectComponentData(
      SimulationPose as Component,
      { position: [0, 0, 0], target: 4 },
      createEntityRemap([0, 100, 200, 300, 400]),
    );
    const array = projectComponentData(
      SimulationRefs as Component,
      { targets: [1, 3, 4] },
      (entity) => entity + 1000,
    );

    expect(scalar.target).toBe(400);
    expect(array.targets).toEqual([1001, 1003, 1004]);
  });

  it('records the remap owner behavior for an unmapped entity reference', () => {
    const remap = createEntityRemap([0, 100]);

    expect(remap(1)).toBe(100);
    expect(remap(7)).toBe(7);
  });

  it('enumerates the live resource roster and portable component boundary', () => {
    const world = new World();
    world.insertResource('simulation-facts-resource', { seed: 7 });
    world.spawn({ component: SimulationPose, data: { target: 0 } as never }).unwrap();

    const inspection = world.inspect();
    expect(inspection.resourceKeys.sort()).toEqual(
      ['FixedTime', 'Time', 'simulation-facts-resource'].sort(),
    );
    expect(inspection.activeComponents).toContain('SimulationFactsPose');

    const result = validateProfileComponents([
      SimulationPose as Component,
      SimulationTransient as Component,
      SimulationNonPortable as Component,
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => [error.component, error.code])).toEqual([
      ['SimulationFactsTransient', 'component-fully-transient'],
      ['SimulationFactsNonPortable', 'field-not-portable'],
    ]);
    expect(result.errors[1]?.field).toBe('resource');
    expect(result.errors[1]?.fieldType).toBe('ref');
  });

  it('keeps a stable local fingerprint shape and explicit finite tolerance facts', () => {
    const world = new World();
    const entity = world
      .spawn({ component: SimulationPose, data: { target: 0 } as never })
      .unwrap();
    const projected = projectComponentData(
      SimulationPose as Component,
      world.get(entity, SimulationPose).unwrap(),
    );
    const fingerprint = {
      time: timeFacts(world),
      entity: projected,
    };
    const tolerances = { 'entity.position[0]': 0, 'time.overstep': 1e-12 };

    expect(Object.keys(fingerprint).sort()).toEqual(['entity', 'time']);
    expect(Object.values(tolerances).every((value) => Number.isFinite(value) && value >= 0)).toBe(
      true,
    );
    expect(fingerprint.entity).not.toHaveProperty('transientVelocity');
  });

  it('keeps the World boundary within the cohesion limits', () => {
    const worldSource = readFileSync(
      fileURLToPath(new URL('../world.ts', import.meta.url)),
      'utf8',
    );
    const errorsSource = readFileSync(
      fileURLToPath(new URL('../errors.ts', import.meta.url)),
      'utf8',
    );
    const importedModules = new Set(
      [...worldSource.matchAll(/from ['"](\.\/[^'"]+)['"]/g)].map((match) => match[1]),
    );

    expect(importedModules.size).toBeLessThanOrEqual(20);
    expect(errorsSource.split('\n').length).toBeLessThanOrEqual(1500);
  });
});
