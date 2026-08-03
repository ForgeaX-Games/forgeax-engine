import { encodeEntity, FixedUpdate, World } from '@forgeax/engine-ecs';
import { Camera, type RenderPipeline } from '@forgeax/engine-render';
import { RenderGraph } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { Transform } from '@forgeax/engine-scene';
import { toShared } from '@forgeax/engine-types';
import { createParticleRenderBatch, type ParticleOutputBatch } from '@forgeax/engine-vfx';
import { collectParticleRenderBuckets, particleRenderFeature } from '@forgeax/engine-vfx-render';
import { describe, expect, it } from 'vitest';

const PARTICLE_SHADER_SOURCE = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(f32(vertex_index), 0.0, 0.0, 1.0);
  output.color = vec4<f32>(1.0);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}`;

const manifest = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [
      { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
      { hash: 'tonemap0', wgsl: '/* tonemap stub */', glsl: '', bindings: '' },
    ],
    materialShaders: [
      {
        identifier: 'forgeax::vfx-render.particles.billboard',
        sourcePath: 'particles.billboard.wgsl',
        composedWgsl: PARTICLE_SHADER_SOURCE,
        paramSchema: '[]',
        variants: [],
      },
      {
        identifier: 'forgeax::vfx-render.particles.mesh',
        sourcePath: 'particles.mesh.wgsl',
        composedWgsl: PARTICLE_SHADER_SOURCE,
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

function pipeline(): RenderPipeline {
  return {
    buildGraph: (context) => {
      const graph = new RenderGraph<typeof context>();
      graph.addResource('color', { kind: 'texture', lifetime: 'transient' });
      graph.addPass('base', { reads: [], writes: ['color'], execute: () => undefined });
      return graph;
    },
    execute: () => undefined,
  };
}

function batch(kind: ParticleOutputBatch['kind'], count: number): ParticleOutputBatch {
  if (kind === 'billboard') {
    return {
      kind,
      material: toShared<'MaterialAsset'>(31),
      count,
      attributes: {
        position: new Float32Array(count * 3),
        size: new Float32Array(count * 2),
        color: new Float32Array(count * 4),
      },
    };
  }
  return {
    kind,
    material: toShared<'MaterialAsset'>(31),
    mesh: toShared<'MeshAsset'>(32),
    count,
    attributes: {
      transform: new Float32Array(count * 16),
      color: new Float32Array(count * 4),
    },
  };
}

function observation(world: World, batches: readonly ParticleOutputBatch[]) {
  const renderBatch = createParticleRenderBatch(batches);
  if (!renderBatch.ok) throw new Error(renderBatch.error.hint);
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
    batches: renderBatch.value,
    diagnostics: [],
    telemetry: {
      tick: 1,
      alive: batches.reduce((total, item) => total + item.count, 0),
      spawned: 0,
      dropped: 0,
      selectedBackend: 'cpu' as const,
      cpuUpdateMs: 0,
      allocatedBytes: 0,
    },
  };
}

function countDraws(device: RhiDevice): () => number {
  let count = 0;
  const original = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = (descriptor) => {
    const result = original(descriptor);
    if (!result.ok || !result.value) return result;
    const encoder = result.value;
    const begin = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = (passDescriptor) => {
      const pass = begin(passDescriptor);
      const draw = pass.draw.bind(pass);
      const drawIndexed = pass.drawIndexed.bind(pass);
      pass.draw = (...drawArgs) => {
        count += 1;
        draw(...drawArgs);
      };
      pass.drawIndexed = (...drawArgs) => {
        count += 1;
        drawIndexed(...drawArgs);
      };
      return pass;
    };
    return result;
  };
  return () => count;
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('particle prepared graphics public consumer', () => {
  it('observes FixedUpdate, buckets, and a submitted particle draw', async () => {
    const { createRenderer } = await import('@forgeax/engine-runtime');
    const { rhi } = await import('@forgeax/engine-rhi-null');
    const world = new World();
    let current = [observation(world, [batch('billboard', 2), batch('billboard', 3)])];
    const camera = {
      position: new Float32Array([0, 0, 2]),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array(16),
    };
    const feature = particleRenderFeature({
      observations: { read: () => current },
      camera: { read: () => camera },
    });
    const renderer = await createRenderer(
      canvas(),
      { rhi, features: [feature] },
      { shaderManifestUrl: manifest },
    );
    renderer.registerPipeline('particle::prepared', pipeline());
    expect(
      renderer.installPipeline({ kind: 'render-pipeline', pipelineId: 'particle::prepared' }).ok,
    ).toBe(true);
    expect((await renderer.ready).ok).toBe(true);
    expect(
      world.spawn(
        { component: Transform, data: { pos: [0, 0, 2] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      ).ok,
    ).toBe(true);
    const drawCount = countDraws(renderer.device);

    world.addSystem(FixedUpdate, {
      name: 'particle-fixed-update',
      queries: [],
      fn: () => undefined,
    });
    expect(world.update(1 / 60).ok).toBe(true);
    expect(collectParticleRenderBuckets(world, current[0]?.batches.batches ?? [])).toHaveLength(1);
    expect(renderer.draw([world], { owner: 0 }).ok).toBe(true);
    expect(['preparing', 'ready']).toContain(feature.diagnostics().readiness);
    // Custom material shader modules use the renderer's one-frame async cache;
    // the next frame is the contract boundary for prepared pipeline readiness.
    await nextFrame();
    expect(renderer.draw([world], { owner: 0 }).ok).toBe(true);
    expect(renderer.perFramePassNames).toContain('forgeax.vfx-render.particles::particles');
    expect(drawCount()).toBeGreaterThan(0);
    expect(feature.diagnostics().readiness).toBe('ready');
    expect(renderer.renderFeatureDiagnostics()[0]?.latestError).toBeUndefined();

    current = [observation(world, [batch('mesh', 1)])];
    expect(renderer.draw([world], { owner: 0 }).ok).toBe(true);
    await nextFrame();
    expect(renderer.draw([world], { owner: 0 }).ok).toBe(true);
    expect(drawCount()).toBeGreaterThan(1);
    expect(renderer.renderFeatureDiagnostics()[0]?.latestError).toBeUndefined();

    current = [observation(world, [batch('billboard', 1), batch('mesh', 1)])];
    expect(renderer.draw([world], { owner: 0 }).ok).toBe(true);
    await nextFrame();
    expect(renderer.draw([world], { owner: 0 }).ok).toBe(true);
    expect(drawCount()).toBeGreaterThan(2);
    expect(renderer.renderFeatureDiagnostics()[0]?.latestError).toBeUndefined();
    renderer.dispose();
  });
});
