import { World } from '@forgeax/engine-ecs';
import { type ParticleRenderCamera, particleRenderFeature } from '@forgeax/engine-vfx-render';
import { describe, expect, it } from 'vitest';

function camera(x: number): ParticleRenderCamera {
  return {
    position: new Float32Array([x, 0, 2]),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: new Float32Array(16),
  };
}

describe('particle billboard camera expansion', () => {
  it('reads the active camera at each valid frame without mutating batch policy', () => {
    const world = new World();
    let active = camera(0);
    const feature = particleRenderFeature({
      observations: { read: () => [] },
      camera: { read: () => active },
    });

    const first = feature.extract({ worlds: [world], owner: 0, frameNumber: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.camera).toBe(active);
    expect(first.value.observations).toEqual([]);

    active = camera(5);
    const second = feature.extract({ worlds: [world], owner: 0, frameNumber: 2 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.camera).toBe(active);
    expect(second.value.camera).not.toBe(first.value.camera);
  });
});
