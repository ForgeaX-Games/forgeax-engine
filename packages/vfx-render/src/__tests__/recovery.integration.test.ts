import { encodeEntity, World } from '@forgeax/engine-ecs';
import type {
  RenderFeatureGraphicsPrepare,
  RenderFeaturePrepareContext,
} from '@forgeax/engine-render';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { createParticleRenderBatch, type ParticleOutputBatch } from '@forgeax/engine-vfx';
import { particleRenderFeature } from '@forgeax/engine-vfx-render';
import { describe, expect, it } from 'vitest';

const caps = { backendKind: 'null' } as unknown as Readonly<RhiCaps>;

function camera() {
  return {
    position: new Float32Array([0, 0, 2]),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: new Float32Array(16),
  };
}

function batch(world: World): ParticleOutputBatch {
  const material = world.allocSharedRef('MaterialAsset', { kind: 'material', guid: 'particle' });
  return {
    kind: 'billboard',
    material,
    count: 1,
    attributes: {
      position: new Float32Array(3),
      size: new Float32Array(2),
      color: new Float32Array(4),
    },
  };
}

function observation(world: World) {
  const batches = createParticleRenderBatch([batch(world)]);
  if (!batches.ok) throw new Error(batches.error.hint);
  return {
    player: encodeEntity(0, 0),
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
      selectedBackend: 'cpu' as const,
      cpuUpdateMs: 0,
      allocatedBytes: 0,
    },
  };
}

function prepareContext(
  generation: number,
  requests: Array<{ readonly kind: string; readonly name: string }>,
): RenderFeaturePrepareContext {
  const ref = <Kind extends 'pipeline' | 'bindings' | 'vertex-data' | 'index-data'>(
    kind: Kind,
  ) => ({
    kind,
    generation,
  });
  const graphics: RenderFeatureGraphicsPrepare = {
    preparePipeline: (name) => {
      requests.push({ kind: 'pipeline', name });
      return ok(ref('pipeline'));
    },
    prepareBindings: (name) => {
      requests.push({ kind: 'bindings', name });
      return ok(ref('bindings'));
    },
    prepareVertexData: (name) => {
      requests.push({ kind: 'vertex-data', name });
      return ok(ref('vertex-data'));
    },
    prepareIndexData: (name) => {
      requests.push({ kind: 'index-data', name });
      return ok(ref('index-data'));
    },
  };
  return {
    caps,
    frame: { frameNumber: generation },
    resources: [],
    targets: [],
    reportError: { report: () => undefined },
    graphics,
  };
}

describe('particle render prepared recovery', () => {
  it('caches bucket pipeline refs per device generation and rebuilds after recovery', () => {
    const world = new World();
    const feature = particleRenderFeature({
      observations: { read: () => [observation(world)] },
      camera: { read: () => camera() },
    });
    const first = feature.extract({ worlds: [world], owner: 0, frameNumber: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const requests: Array<{ readonly kind: string; readonly name: string }> = [];
    expect(feature.prepare(first.value, prepareContext(1, requests)).ok).toBe(true);
    expect(feature.prepare(first.value, prepareContext(1, requests)).ok).toBe(true);
    expect(
      new Set(
        requests.filter((request) => request.kind === 'pipeline').map((request) => request.name),
      ).size,
    ).toBe(1);
    expect(
      new Set(
        requests.filter((request) => request.kind === 'index-data').map((request) => request.name),
      ).size,
    ).toBe(1);
    expect(
      new Set(
        requests.filter((request) => request.kind === 'bindings').map((request) => request.name),
      ).size,
    ).toBe(1);
    expect(
      new Set(
        requests.filter((request) => request.kind === 'vertex-data').map((request) => request.name),
      ).size,
    ).toBe(1);

    expect(feature.recover(prepareContext(2, requests)).ok).toBe(true);
    expect(feature.recover(prepareContext(2, requests)).ok).toBe(true);
    expect(feature.prepare(first.value, prepareContext(2, requests)).ok).toBe(true);
    expect(feature.diagnostics().generation).toBe(2);
  });

  it('keeps world input replacement and feature disposal isolated and idempotent', () => {
    const firstWorld = new World();
    const secondWorld = new World();
    let active = firstWorld;
    const feature = particleRenderFeature({
      observations: { read: (world) => (world === active ? [observation(world)] : []) },
      camera: { read: () => camera() },
    });
    const first = feature.extract({ worlds: [firstWorld], owner: 0, frameNumber: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(feature.prepare(first.value, prepareContext(1, [])).ok).toBe(true);
    expect(feature.diagnostics().bucketCount).toBe(1);

    active = secondWorld;
    const replacement = feature.extract({ worlds: [secondWorld], owner: 0, frameNumber: 2 });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    expect(feature.prepare(replacement.value, prepareContext(1, [])).ok).toBe(true);
    expect(feature.diagnostics().bucketCount).toBe(1);

    active = firstWorld;
    expect(feature.extract({ worlds: [firstWorld], owner: 0, frameNumber: 3 }).ok).toBe(true);
    expect(feature.dispose(prepareContext(3, [])).ok).toBe(true);
    expect(feature.dispose(prepareContext(3, [])).ok).toBe(true);
    expect(feature.diagnostics().readiness).toBe('disabled');
  });
});
