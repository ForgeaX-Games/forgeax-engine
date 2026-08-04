import { encodeEntity, World } from '@forgeax/engine-ecs';
import { resolveVisibility, Visibility, VisibilityStateValue } from '@forgeax/engine-render';
import { toShared } from '@forgeax/engine-types';
import { createParticleRenderBatch } from '@forgeax/engine-vfx';
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

function observation(world: World) {
  const batches = createParticleRenderBatch([
    {
      kind: 'billboard' as const,
      material: toShared<'MaterialAsset'>(31),
      count: 1,
      attributes: {
        position: new Float32Array(3),
        size: new Float32Array(2),
        color: new Float32Array(4),
      },
    },
  ]);
  if (!batches.ok) throw new Error(batches.error.hint);
  return {
    player: encodeEntity(0, 0),
    effect: world.allocSharedRef('ParticleEffectAsset', {
      kind: 'particle-effect' as const,
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
      selectedBackend: 'cpu' as const,
      cpuUpdateMs: 0,
      allocatedBytes: 0,
    },
  };
}

describe('particle render multi-world lifecycle', () => {
  it('does not let one unavailable world suppress the next repaired world', () => {
    const firstWorld = new World();
    const secondWorld = new World();
    let activeWorld = firstWorld;
    let activeCamera: ParticleRenderCamera | undefined = camera();
    const feature = particleRenderFeature({
      observations: { read: (world) => (world === activeWorld ? [] : []) },
      camera: { read: () => activeCamera },
    });
    expect(feature.extract({ worlds: [firstWorld], owner: 0, frameNumber: 1 }).ok).toBe(true);

    activeWorld = secondWorld;
    activeCamera = undefined;
    const unavailable = feature.extract({ worlds: [secondWorld], owner: 0, frameNumber: 2 });
    expect(unavailable.ok).toBe(false);

    activeCamera = camera();
    const repaired = feature.extract({ worlds: [secondWorld], owner: 0, frameNumber: 3 });
    expect(repaired.ok).toBe(true);
  });

  it('keeps repeated recovery and disposal idempotent after world teardown', () => {
    const world = new World();
    const feature = particleRenderFeature({
      observations: { read: () => [] },
      camera: { read: () => camera() },
    });
    const extracted = feature.extract({ worlds: [world], owner: 0, frameNumber: 1 });
    expect(extracted.ok).toBe(true);
    expect(
      feature.recover({
        caps: {} as never,
        frame: { frameNumber: 2 },
        resources: [],
        targets: [],
        reportError: { report: () => undefined },
        graphics: {} as never,
      }).ok,
    ).toBe(true);
    expect(
      feature.recover({
        caps: {} as never,
        frame: { frameNumber: 2 },
        resources: [],
        targets: [],
        reportError: { report: () => undefined },
        graphics: {} as never,
      }).ok,
    ).toBe(true);
    expect(
      feature.dispose({
        caps: {} as never,
        frame: { frameNumber: 2 },
        resources: [],
        targets: [],
        reportError: { report: () => undefined },
        graphics: {} as never,
      }).ok,
    ).toBe(true);
    expect(
      feature.dispose({
        caps: {} as never,
        frame: { frameNumber: 2 },
        resources: [],
        targets: [],
        reportError: { report: () => undefined },
        graphics: {} as never,
      }).ok,
    ).toBe(true);
    expect(feature.diagnostics().readiness).toBe('disabled');
  });

  it('keeps equal player handles isolated when the batch changes World owner', () => {
    const firstWorld = new World();
    const secondWorld = new World();
    firstWorld.spawn({ component: Visibility, data: { state: VisibilityStateValue.hidden } });
    secondWorld.spawn({ component: Visibility, data: { state: VisibilityStateValue.hidden } });
    const reports: World[] = [];
    const feature = particleRenderFeature({
      observations: { read: (world) => [observation(world)] },
      camera: { read: () => camera() },
    });
    const snapshots = [
      { world: firstWorld, snapshot: resolveVisibility(firstWorld) },
      { world: secondWorld, snapshot: resolveVisibility(secondWorld) },
    ];

    const first = feature.extract({
      worlds: [firstWorld, secondWorld],
      owner: 0,
      frameNumber: 1,
      visibilitySnapshots: snapshots,
      reportHiddenEntity: ({ world }) => reports.push(world),
    });
    const second = feature.extract({
      worlds: [firstWorld, secondWorld],
      owner: 1,
      frameNumber: 2,
      visibilitySnapshots: snapshots,
      reportHiddenEntity: ({ world }) => reports.push(world),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(reports).toEqual([firstWorld, secondWorld]);
  });
});
