import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { encodeEntity, World } from '@forgeax/engine-ecs';
import type { RenderFeaturePrepareContext, RenderFeaturePreparedRef } from '@forgeax/engine-render';
import { ok, toShared } from '@forgeax/engine-types';
import {
  createParticleRenderBatch,
  type ParticleOutputBatch,
  type ParticleSimulationObservation,
} from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';
import { PARTICLE_SHADER_IDENTIFIERS, particleRenderFeature } from '../index.js';

function batch(kind: ParticleOutputBatch['kind']): ParticleOutputBatch {
  if (kind === 'billboard') {
    return {
      kind,
      material: toShared<'MaterialAsset'>(31),
      count: 1,
      attributes: {
        position: new Float32Array(3),
        size: new Float32Array(2),
        color: new Float32Array(4),
      },
    };
  }
  return {
    kind,
    material: toShared<'MaterialAsset'>(31),
    mesh: toShared<'MeshAsset'>(32),
    count: 1,
    attributes: {
      transform: new Float32Array(16),
      color: new Float32Array(4),
    },
  };
}

function observation(world: World): ParticleSimulationObservation {
  const batches = createParticleRenderBatch([batch('billboard'), batch('mesh')]);
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
      alive: 2,
      spawned: 2,
      dropped: 0,
      selectedBackend: 'cpu',
      cpuUpdateMs: 0,
      allocatedBytes: 0,
    },
  };
}

function ref<Kind extends RenderFeaturePreparedRef['kind']>(
  kind: Kind,
): RenderFeaturePreparedRef<Kind> {
  return { kind, generation: 0 };
}

describe('particle shader manifest and prepared pipeline contract', () => {
  it('declares the manifest identifiers and standard pipeline entry points', () => {
    const shaderRoot = resolve(dirname(import.meta.dirname), 'shaders');
    for (const [kind, identifier] of Object.entries(PARTICLE_SHADER_IDENTIFIERS)) {
      const source = readFileSync(resolve(shaderRoot, `${kind}.wgsl`), 'utf8');
      expect(source).toContain(`#define_import_path ${identifier}`);
      expect(source).toContain('fn vs_main(');
      expect(source).toContain('fn fs_main(');
    }
  });

  it('turns billboard quads into premultiplied soft discs', () => {
    const shaderRoot = resolve(dirname(import.meta.dirname), 'shaders');
    const source = readFileSync(resolve(shaderRoot, 'billboard.wgsl'), 'utf8');
    expect(source).toContain('@location(1) local: vec2<f32>');
    expect(source).toContain('smoothstep(0.55, 1.0, length(input.local))');
    expect(source).toContain('input.color.rgb * alpha');
  });

  it('requests the shader matching each output kind instead of default-unlit fallback', () => {
    const world = new World();
    const feature = particleRenderFeature({
      observations: { read: () => [observation(world)] },
      camera: {
        read: () => ({
          position: new Float32Array(3),
          right: new Float32Array([1, 0, 0]),
          up: new Float32Array([0, 1, 0]),
          viewProjection: new Float32Array(16),
        }),
      },
    });
    const extracted = feature.extract({ worlds: [world], owner: 0, frameNumber: 1 });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;

    const pipelineDescriptors: { shader: string; renderState?: Record<string, unknown> }[] = [];
    const context = {
      graphics: {
        prepareIndexData: () => ok(ref('index-data')),
        preparePipeline: (
          _name: string,
          descriptor: { shader: string; renderState?: Record<string, unknown> },
        ) => {
          pipelineDescriptors.push(descriptor);
          return ok(ref('pipeline'));
        },
        prepareBindings: () => ok(ref('bindings')),
        prepareVertexData: () => ok(ref('vertex-data')),
      },
    } as unknown as RenderFeaturePrepareContext;

    expect(feature.prepare(extracted.value, context).ok).toBe(true);
    expect(pipelineDescriptors.map((descriptor) => descriptor.shader)).toEqual([
      PARTICLE_SHADER_IDENTIFIERS.billboard,
      PARTICLE_SHADER_IDENTIFIERS.mesh,
    ]);
    expect(pipelineDescriptors[0]?.renderState).toMatchObject({
      cullMode: 'none',
      depthCompare: 'less-equal',
      depthWriteEnabled: false,
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
    });
    expect(pipelineDescriptors[1]?.renderState).toBeUndefined();
  });
});
