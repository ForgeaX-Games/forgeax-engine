import { encodeEntity, World } from '@forgeax/engine-ecs';
import type { RenderFeaturePrepareContext, RenderFeaturePreparedRef } from '@forgeax/engine-render';
import { err, ok, toShared } from '@forgeax/engine-types';
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

describe('particle render readiness retry', () => {
  it('reports unavailable without drawing, then accepts the next valid frame', () => {
    const world = new World();
    let active: ParticleRenderCamera | undefined;
    const feature = particleRenderFeature({
      observations: { read: () => [] },
      camera: { read: () => active },
    });

    const unavailable = feature.extract({ worlds: [world], owner: 0, frameNumber: 1 });
    expect(unavailable.ok).toBe(false);
    expect(feature.diagnostics().readiness).toBe('unavailable');
    expect(feature.diagnostics().error?.code).toBe('particle-render-camera-unavailable');

    active = camera();
    const ready = feature.extract({ worlds: [world], owner: 0, frameNumber: 2 });
    expect(ready.ok).toBe(true);
    expect(feature.diagnostics().error).toBeUndefined();
    expect(feature.diagnostics().readiness).toBe('empty');
  });

  it('retains the material identity during preparation and clears it after retry', () => {
    const world = new World();
    const batches = createParticleRenderBatch([
      {
        kind: 'billboard',
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
    const feature = particleRenderFeature({
      observations: {
        read: () => [
          {
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
          },
        ],
      },
      camera: { read: () => camera() },
    });
    const extracted = feature.extract({ worlds: [world], owner: 0, frameNumber: 1 });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;

    const ref = <Kind extends RenderFeaturePreparedRef['kind']>(kind: Kind) =>
      ({ kind, generation: 0 }) as RenderFeaturePreparedRef<Kind>;
    const prepareContext = (ready: boolean) =>
      ({
        graphics: {
          prepareIndexData: () => ok(ref('index-data')),
          preparePipeline: () => ok(ref('pipeline')),
          prepareBindings: () => (ready ? ok(ref('bindings')) : err(new Error('material warming'))),
          prepareVertexData: () => ok(ref('vertex-data')),
        },
      }) as unknown as RenderFeaturePrepareContext;

    expect(feature.prepare(extracted.value, prepareContext(false)).ok).toBe(false);
    expect(feature.diagnostics()).toMatchObject({
      readiness: 'preparing',
      error: {
        code: 'particle-render-material-not-ready',
        detail: { assetGuid: '31', code: 'particle-render-material-not-ready' },
      },
    });

    expect(feature.prepare(extracted.value, prepareContext(true)).ok).toBe(true);
    expect(feature.diagnostics().error).toBeUndefined();
  });
});
