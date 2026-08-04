import { FixedTime, World } from '@forgeax/engine-ecs';
import { runPlugins } from '@forgeax/engine-plugin';
import { Camera } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import {
  PARTICLE_SIMULATION_RESOURCE_KEY,
  ParticleCpuExecutorRegistry,
  ParticleEffectPlayer,
  type ParticleSimulation,
  particleSimulationPlugin,
} from '@forgeax/engine-vfx';
import { particleRenderFeature, particleSceneSpaceResolver } from '@forgeax/engine-vfx-render';
import { describe, expect, it } from 'vitest';

const manifest = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [
      { hash: 'pbr00000', wgsl: '/* pbr stub */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
      { hash: 'tonemap0', wgsl: '/* tonemap stub */', glsl: '', bindings: '' },
    ],
    materialShaders: [
      {
        identifier: 'forgeax::vfx-render.particles.billboard',
        sourcePath: 'particles.billboard.wgsl',
        composedWgsl: '/* particle billboard stub */',
        paramSchema: '[]',
        variants: [],
      },
      {
        identifier: 'forgeax::vfx-render.particles.mesh',
        sourcePath: 'particles.mesh.wgsl',
        composedWgsl: '/* particle mesh stub */',
        paramSchema: '[]',
        variants: [],
      },
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

function camera() {
  return {
    position: new Float32Array([0, 0, 2]),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: new Float32Array(16),
  };
}

describe('public VFX two-stage assembly', () => {
  it('installs simulation and renderer roots independently on one World', async () => {
    const { rhi } = await import('@forgeax/engine-rhi-null');
    const world = new World();
    const root = world
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    const effect = world.allocSharedRef('ParticleEffectAsset', {
      kind: 'particle-effect',
      schemaVersion: 1,
      emitters: [],
      program: { format: 'forgeax-vfx-program-1', emitters: [] },
    });
    const player = world
      .spawn(
        { component: Transform, data: {} },
        { component: ParticleEffectPlayer, data: { effect, seed: 7, playing: true, timeScale: 1 } },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    const sceneResolver = particleSceneSpaceResolver({ world });
    const plugins = await runPlugins(
      world,
      [],
      [
        particleSimulationPlugin({
          assets: { lookup: () => undefined },
          cpuExecutors: new ParticleCpuExecutorRegistry(),
          spaceResolver: sceneResolver,
        }),
      ],
    );
    expect(plugins.ok).toBe(true);

    const feature = particleRenderFeature({
      observations: {
        read: (currentWorld) => {
          const simulation = currentWorld.getResource<ParticleSimulation>(
            PARTICLE_SIMULATION_RESOURCE_KEY,
          );
          const observation = simulation.read(player);
          return observation === undefined ? [] : [observation];
        },
      },
      camera: { read: () => camera() },
    });
    const renderer = await createRenderer(
      canvas(),
      { rhi, features: [feature] },
      { shaderManifestUrl: manifest },
    );
    expect((await renderer.ready).ok).toBe(true);
    expect(world.update(1 / 60).ok).toBe(true);
    expect(world.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY)).toBeDefined();
    expect(renderer.draw([world], { owner: 0 }).ok).toBe(true);

    const attached = sceneResolver.resolve({
      player,
      space: 'local',
      phase: 'extract',
      tick: world.getResource(FixedTime).tick,
    });
    expect(attached.ok).toBe(true);
    if (attached.ok) expect(attached.value.parent).toBe(root);
    renderer.dispose();
    world.sharedRefs.release(effect);
  });
});
