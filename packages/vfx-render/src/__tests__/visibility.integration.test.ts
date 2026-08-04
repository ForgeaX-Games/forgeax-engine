import { type EntityHandle, World } from '@forgeax/engine-ecs';
import {
  type RenderFeaturePrepareContext,
  resolveVisibility,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine-render';
import { ok, toShared } from '@forgeax/engine-types';
import { createParticleRenderBatch, type ParticleSimulationObservation } from '@forgeax/engine-vfx';
import { type ParticleRenderCamera, particleRenderFeature } from '@forgeax/engine-vfx-render';
import { describe, expect, it } from 'vitest';

function camera(): ParticleRenderCamera {
  return {
    position: new Float32Array([0, 0, 2]),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: new Float32Array(16),
  };
}

function observation(world: World, player: EntityHandle): ParticleSimulationObservation {
  const batches = createParticleRenderBatch([
    {
      kind: 'billboard',
      material: toShared<'MaterialAsset'>(31),
      count: 1,
      attributes: {
        position: new Float32Array(3),
        size: new Float32Array(2),
        color: new Float32Array([1, 0, 0, 1]),
      },
    },
  ]);
  if (!batches.ok) throw new Error(batches.error.hint);
  return {
    player,
    effect: world.allocSharedRef('ParticleEffectAsset', {
      kind: 'particle-effect',
      schemaVersion: 1,
      emitters: [],
    }),
    seed: 1,
    playing: true,
    timeScale: 1,
    tick: 1,
    emitters: [],
    batches: batches.value,
    diagnostics: [],
    telemetry: {
      tick: 1,
      alive: 1,
      spawned: 1,
      dropped: 0,
      selectedBackend: 'cpu',
      cpuUpdateMs: 0,
      allocatedBytes: 0,
    },
  };
}

function prepareContext(): RenderFeaturePrepareContext {
  const ref = <Kind extends 'pipeline' | 'bindings' | 'vertex-data' | 'index-data'>(
    kind: Kind,
  ) => ({ kind, generation: 1 });
  return {
    caps: {} as never,
    frame: { frameNumber: 1 },
    resources: [],
    targets: [],
    reportError: { report: () => undefined },
    graphics: {
      preparePipeline: () => ok(ref('pipeline')),
      prepareBindings: () => ok(ref('bindings')),
      prepareVertexData: () => ok(ref('vertex-data')),
      prepareIndexData: () => ok(ref('index-data')),
    },
  };
}

describe('particle visibility gate', () => {
  it('filters before prepare and restores the same player entity', () => {
    const world = new World();
    const player = world
      .spawn({ component: Visibility, data: { state: VisibilityStateValue.visible } })
      .unwrap();
    const reports: EntityHandle[] = [];
    const feature = particleRenderFeature({
      observations: { read: () => [observation(world, player)] },
      camera: { read: () => camera() },
    });
    const extract = (frameNumber: number) =>
      feature.extract({
        worlds: [world],
        owner: 0,
        frameNumber,
        visibilitySnapshots: [{ world, snapshot: resolveVisibility(world) }],
        reportHiddenEntity: ({ entity }) => reports.push(entity),
      });

    const visible = extract(1);
    expect(visible.ok).toBe(true);
    if (!visible.ok) return;
    expect(visible.value.observations).toHaveLength(1);
    expect(feature.prepare(visible.value, prepareContext()).ok).toBe(true);

    world.set(player, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
    const hidden = extract(2);
    expect(hidden.ok).toBe(true);
    if (!hidden.ok) return;
    expect(hidden.value.observations).toHaveLength(0);
    expect(feature.prepare(hidden.value, prepareContext()).ok).toBe(true);
    expect(reports).toEqual([player]);

    world.set(player, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    const restored = extract(3);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.observations[0]?.player).toBe(player);
  });
});
