import { World } from '@forgeax/engine-ecs';
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
});
