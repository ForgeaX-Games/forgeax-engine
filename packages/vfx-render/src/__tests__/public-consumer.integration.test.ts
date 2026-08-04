import { encodeEntity, FixedUpdate, World } from '@forgeax/engine-ecs';
import type { RendererOptions } from '@forgeax/engine-render';
import { createParticleRenderBatch, type ParticleSimulationObservation } from '@forgeax/engine-vfx';
import { particleRenderFeature } from '@forgeax/engine-vfx-render';
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

function observation(world: World): ParticleSimulationObservation {
  const batch = createParticleRenderBatch([]);
  if (!batch.ok) throw new Error(batch.error.code);
  return {
    player: encodeEntity(0, 0),
    effect: world.allocSharedRef('ParticleEffectAsset', {
      kind: 'particle-effect',
      schemaVersion: 1,
      emitters: [],
    }),
    seed: 17,
    playing: true,
    timeScale: 1,
    tick: 1,
    emitters: [],
    batches: batch.value,
    diagnostics: [],
    telemetry: {
      tick: 1,
      alive: 0,
      spawned: 0,
      dropped: 0,
      selectedBackend: 'cpu',
      cpuUpdateMs: 0,
      allocatedBytes: 0,
    },
  };
}

describe('vfx-render public consumer boundary', () => {
  it('keeps the production owner in vfx-render and consumes frozen observations', () => {
    const world = new World();
    const camera = {
      position: new Float32Array([0, 0, 2]),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array(16),
    };
    const feature = particleRenderFeature({
      observations: { read: () => [observation(world)] },
      camera: { read: () => camera },
    });
    const rendererOptions = { features: [feature] } satisfies RendererOptions;
    const extracted = feature.extract({ worlds: [world], owner: 0, frameNumber: 1 });

    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect(extracted.value.world).toBe(world);
    expect(extracted.value.camera).toBe(camera);
    expect(extracted.value.observations).toHaveLength(1);
    expect(extracted.value.observations[0]?.batches.batches).toHaveLength(0);
    expect(rendererOptions.features[0]).toBe(feature);
  });

  it('assembles through the public renderer and advances the World FixedUpdate path', async () => {
    const { createRenderer } = await import('@forgeax/engine-runtime');
    const { rhi } = await import('@forgeax/engine-rhi-null');
    const { Camera } = await import('@forgeax/engine-render');
    const { Transform } = await import('@forgeax/engine-scene');
    const world = new World();
    const camera = {
      position: new Float32Array([0, 0, 2]),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array(16),
    };
    const feature = particleRenderFeature({
      observations: { read: () => [observation(world)] },
      camera: { read: () => camera },
    });
    const renderer = await createRenderer(
      {
        width: 64,
        height: 64,
        getContext: () => null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as HTMLCanvasElement,
      { rhi, features: [feature] },
      { shaderManifestUrl: manifest },
    );
    expect((await renderer.ready).ok).toBe(true);

    expect(
      world.spawn(
        { component: Transform, data: { pos: [0, 0, 2] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      ).ok,
    ).toBe(true);

    let fixedUpdates = 0;
    world.addSystem(FixedUpdate, {
      name: 'public-consumer-fixed-update',
      queries: [],
      fn: () => {
        fixedUpdates += 1;
      },
    });
    expect(world.update(1 / 60).ok).toBe(true);
    expect(fixedUpdates).toBe(1);
    expect(renderer.draw([world], { owner: 0 }).ok).toBe(true);
    expect(renderer.renderFeatureDiagnostics()[0]?.latestError).toBeUndefined();
    renderer.dispose();
  });

  it('exposes all lifecycle callbacks through the public RenderFeature shape', () => {
    const feature = particleRenderFeature({
      observations: { read: () => [] },
      camera: { read: () => undefined },
    });
    const lifecycle: readonly [
      typeof feature.extract,
      typeof feature.prepare,
      typeof feature.contribute,
      NonNullable<typeof feature.recover>,
      NonNullable<typeof feature.dispose>,
    ] = [feature.extract, feature.prepare, feature.contribute, feature.recover, feature.dispose];
    void lifecycle;
    expect(feature.identity).toBe('forgeax.vfx-render.particles');
  });
});
