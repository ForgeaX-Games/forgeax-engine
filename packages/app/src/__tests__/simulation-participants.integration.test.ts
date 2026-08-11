import { createSimulationError, type SimulationParticipant, World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { createApp } from '../create-app';
import {
  createSimulationInspection,
  registerSimulationParticipants,
} from '../internal/simulation-participants';

function participant(id: string, ready = true): SimulationParticipant {
  return {
    id,
    version: '1',
    schemaFingerprint: `${id}-v1`,
    isReady: () => ready,
    recordState: () => ok({ id }),
    prepareRestore: () => ok({ state: null }),
    commitRestore: () => undefined,
    disposeRestore: () => undefined,
  };
}

function rendererStub(): Renderer {
  return {
    backend: 'webgpu' as const,
    ready: Promise.resolve({ ok: true, value: undefined }),
    draw: () => ({ ok: true, value: undefined }),
    onError: () => () => undefined,
    onLost: () => () => undefined,
    dispose: () => undefined,
  } as unknown as Renderer;
}

describe('App simulation participant assembly', () => {
  it('registers ready participants and exposes a read-only inspection projection', () => {
    const world = new World();
    const physics = participant('forgeax.physics.test');
    const audio = participant('forgeax.audio.test');

    const registered = registerSimulationParticipants(world, [physics, audio]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const inspection = createSimulationInspection(world, registered.value);
    expect(inspection()).toMatchObject({
      formatVersion: 1,
      recordOwner: '@forgeax/engine-ecs',
      schemaOwner: '@forgeax/engine-ecs',
      participants: [
        { id: physics.id, version: '1', schemaFingerprint: 'forgeax.physics.test-v1', ready: true },
        { id: audio.id, version: '1', schemaFingerprint: 'forgeax.audio.test-v1', ready: true },
      ],
      trace: { sampleCount: 0 },
    });
    expect(inspection().baselineFingerprint).toBe(world.simulationFingerprint());
    expect('record' in inspection()).toBe(false);
  });

  it('reports a structured not-ready error and leaves the World unregistered', () => {
    const world = new World();
    const result = registerSimulationParticipants(world, [participant('missing', false)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'simulation-participant-not-ready',
      expected: expect.any(String),
      hint: expect.stringContaining('fresh target'),
      detail: { id: 'missing' },
    });
    expect(world.simulationRecord().ok).toBe(true);
  });

  it('does not create a second record/schema owner in the App projection', () => {
    const world = new World();
    const registered = registerSimulationParticipants(world, [participant('owner')]);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const summary = createSimulationInspection(world, registered.value)();
    expect(summary).not.toHaveProperty('record');
    expect(summary).not.toHaveProperty('schema');
    expect(summary.baselineFingerprint).toBe(world.simulationFingerprint());
    expect(createSimulationError('simulation-participant-not-ready', { id: 'owner' }).code).toBe(
      'simulation-participant-not-ready',
    );
  });

  it('wires the same inspection through the assemble App entry', async () => {
    const world = new World();
    const registered = await createApp({
      renderer: rendererStub(),
      world,
      simulationParticipants: [participant('forgeax.app.assembled')],
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.value.simulationInspection()).toMatchObject({
      recordOwner: '@forgeax/engine-ecs',
      participants: [{ id: 'forgeax.app.assembled', ready: true }],
    });
  });
});
