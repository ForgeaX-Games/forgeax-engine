import { FixedUpdate, World } from '@forgeax/engine-ecs';
import {
  PARTICLE_SIMULATION_RESOURCE_KEY,
  ParticleEffectPlayer,
  type ParticleSimulation,
} from '@forgeax/engine-vfx';
import { createParticleRuntimeHost, type ParticleRenderCamera } from '@forgeax/engine-vfx-render';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

const manifest = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [
      { hash: 'pbr00000', wgsl: '/* pbr stub */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
      { hash: 'tonemap0', wgsl: '/* tonemap stub */', glsl: '', bindings: '' },
    ],
  }),
)}`;

function canvas(): HTMLCanvasElement {
  return {
    width: 64,
    height: 64,
    getContext: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
}

function camera(): ParticleRenderCamera {
  return {
    position: new Float32Array([0, 0, 2]),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: new Float32Array(16),
  };
}

function worldWithPlayer(): World {
  const world = new World({ time: { fixedDeltaSeconds: 1 / 60, maxDeltaSeconds: 1 } });
  const effect = world.allocSharedRef('ParticleEffectAsset', {
    kind: 'particle-effect',
    schemaVersion: 1,
    emitters: [],
    program: { format: 'forgeax-vfx-program-1', emitters: [] },
  });
  world
    .spawn({
      component: ParticleEffectPlayer,
      data: { effect, playing: true, seed: 7, timeScale: 1 },
    })
    .unwrap();
  return world;
}

describe('ParticleRuntimeHost public lifecycle', () => {
  it('attaches one feature across independent worlds and keeps registry setup idempotent', async () => {
    const { createRenderer } = await import('@forgeax/engine-runtime');
    const { rhi } = await import('@forgeax/engine-rhi-null');
    const renderer = await createRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    expect((await renderer.ready).ok).toBe(true);

    const registerPackLoader = vi.spyOn(renderer.assets.loaders, 'registerPackLoader');
    const host = createParticleRuntimeHost({ camera: { read: () => camera() } });
    const editWorld = worldWithPlayer();
    const playWorld = worldWithPlayer();

    const editAttached = await host.attachWorld({ world: editWorld, assets: renderer.assets });
    expect(editAttached.ok).toBe(true);
    expect(editWorld.inspect().scheduleSystemCount(FixedUpdate)).toBe(1);

    const duplicate = await host.attachWorld({ world: editWorld, assets: renderer.assets });
    expect(duplicate.ok).toBe(true);
    if (duplicate.ok) expect(duplicate.value.state).toBe('already-attached');
    expect(editWorld.inspect().scheduleSystemCount(FixedUpdate)).toBe(1);

    const playAttached = await host.attachWorld({ world: playWorld, assets: renderer.assets });
    expect(playAttached.ok).toBe(true);
    expect(playWorld.inspect().scheduleSystemCount(FixedUpdate)).toBe(1);
    expect(registerPackLoader).toHaveBeenCalledTimes(1);

    expect(editWorld.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY)).not.toBe(
      playWorld.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY),
    );
    expect(host.feature).toBe(host.feature);

    expect(editWorld.update(1 / 60).ok).toBe(true);
    expect(playWorld.update(1 / 60).ok).toBe(true);
    const editFrame = host.feature.extract({ worlds: [editWorld], owner: 0, frameNumber: 1 });
    const playFrame = host.feature.extract({ worlds: [playWorld], owner: 0, frameNumber: 2 });
    expect(editFrame.ok).toBe(true);
    expect(playFrame.ok).toBe(true);
    if (editFrame.ok && playFrame.ok) {
      expect(editFrame.value.observations).toHaveLength(1);
      expect(playFrame.value.observations).toHaveLength(1);
      expect(editFrame.value.observations).not.toBe(playFrame.value.observations);
    }

    const detached = host.detachWorld({ world: playWorld });
    expect(detached.ok).toBe(true);
    expect(playWorld.hasResource(PARTICLE_SIMULATION_RESOURCE_KEY)).toBe(false);
    expect(playWorld.inspect().scheduleSystemCount(FixedUpdate)).toBe(0);
    expect(editWorld.hasResource(PARTICLE_SIMULATION_RESOURCE_KEY)).toBe(true);

    const reattached = await host.attachWorld({ world: playWorld, assets: renderer.assets });
    expect(reattached.ok).toBe(true);
    expect(registerPackLoader).toHaveBeenCalledTimes(1);
    host.detachWorld({ world: editWorld });
    host.detachWorld({ world: playWorld });
    renderer.dispose();
  });

  it('keeps renderer failures structured for machine recovery', () => {
    const host = createParticleRuntimeHost({ camera: { read: () => undefined } });
    const result = host.feature.extract({ worlds: [new World()], owner: 0, frameNumber: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: 'render-feature-stage-failed',
        expected: expect.any(String),
        hint: expect.any(String),
        detail: { stage: 'extract' },
      });
    }
  });

  it('makes an incomplete stop observable as a remaining play binding', async () => {
    const { createRenderer } = await import('@forgeax/engine-runtime');
    const { rhi } = await import('@forgeax/engine-rhi-null');
    const renderer = await createRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    expect((await renderer.ready).ok).toBe(true);
    const host = createParticleRuntimeHost({ camera: { read: () => camera() } });
    const editWorld = worldWithPlayer();
    const playWorld = worldWithPlayer();

    expect((await host.attachWorld({ world: editWorld, assets: renderer.assets })).ok).toBe(true);
    expect((await host.attachWorld({ world: playWorld, assets: renderer.assets })).ok).toBe(true);

    // Counterfactual teardown: stopping only the edit binding must leave the
    // play binding observable instead of silently claiming a clean stop.
    expect(host.detachWorld({ world: editWorld }).ok).toBe(true);
    expect(playWorld.hasResource(PARTICLE_SIMULATION_RESOURCE_KEY)).toBe(true);
    expect(playWorld.inspect().scheduleSystemCount(FixedUpdate)).toBe(1);

    expect(host.detachWorld({ world: playWorld }).ok).toBe(true);
    renderer.dispose();
  });

  it('publishes structured attach and detach result types', () => {
    const host = createParticleRuntimeHost({ camera: { read: () => camera() } });
    expectTypeOf(host.attachWorld).toBeFunction();
    expectTypeOf(host.detachWorld).toBeFunction();
    expectTypeOf(host.feature).toMatchTypeOf<{ readonly identity: string }>();
  });
});
