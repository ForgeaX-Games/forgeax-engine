import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import type { RenderFeature } from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok, toShared } from '@forgeax/engine-types';
import {
  createParticleRenderBatch,
  type ParticleBillboardBatch,
  type ParticleMeshBatch,
  type ParticleRenderBatch,
  validateParticleRenderBatch,
} from '@forgeax/engine-vfx';
import { describe, expect, expectTypeOf, it } from 'vitest';

function canvas(): HTMLCanvasElement {
  return {
    width: 64,
    height: 64,
    getContext: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
}

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

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => resolve(directory, name));
}

function expectInvalidBatch(input: unknown, path: string): void {
  const result = validateParticleRenderBatch(input);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  switch (result.error.code) {
    case 'vfx-batch-invalid':
      expect(result.error.detail.path).toBe(path);
      break;
    default:
      throw new Error(`unexpected error: ${result.error.code}`);
  }
}

function batchValue(): ParticleRenderBatch {
  const result = createParticleRenderBatch([]);
  if (!result.ok) throw new Error(result.error.hint);
  return result.value;
}

const material = toShared<'MaterialAsset'>(31);
const mesh = toShared<'MeshAsset'>(32);

function billboardBatch(): ParticleBillboardBatch {
  return {
    kind: 'billboard',
    material,
    count: 2,
    attributes: {
      position: new Float32Array(6),
      size: new Float32Array(4),
      color: new Float32Array(8),
    },
  };
}

function meshBatch(): ParticleMeshBatch {
  return {
    kind: 'mesh',
    material,
    mesh,
    count: 1,
    attributes: {
      transform: new Float32Array(16),
      color: new Float32Array(4),
    },
  };
}

function syntheticBatches(): readonly ParticleRenderBatch[] {
  const inputs: readonly unknown[] = [
    { batches: [] },
    { batches: [billboardBatch()] },
    { batches: [meshBatch()] },
  ];
  return inputs.map((input) => {
    const validated = validateParticleRenderBatch(input);
    if (!validated.ok) throw new Error(validated.error.hint);
    const created = createParticleRenderBatch(validated.value.batches);
    if (!created.ok) throw new Error(created.error.hint);
    return created.value;
  });
}

function readBatchData(data: ParticleRenderBatch): number {
  let value = data.batches.length;
  for (const batch of data.batches) {
    value += batch.count + batch.material;
    if (batch.kind === 'billboard') {
      value +=
        batch.attributes.position.length +
        batch.attributes.size.length +
        batch.attributes.color.length;
    } else {
      value += batch.mesh + batch.attributes.transform.length + batch.attributes.color.length;
    }
  }
  return value;
}

function compatibilityFeature(
  getBatch: () => ParticleRenderBatch,
  observations: string[] = [],
): RenderFeature<ParticleRenderBatch> {
  return {
    identity: 'runtime.test.particle-render-batch',
    extract: () => {
      const data = getBatch();
      observations.push(`extract:${data.batches.map((batch) => batch.kind).join(',') || 'empty'}`);
      return ok(data);
    },
    prepare: (data) => {
      expectTypeOf(data).toEqualTypeOf<ParticleRenderBatch>();
      readBatchData(data);
      observations.push(`prepare:${data.batches.map((batch) => batch.kind).join(',') || 'empty'}`);
      return ok(undefined);
    },
    contribute: (data) => {
      expectTypeOf(data).toEqualTypeOf<ParticleRenderBatch>();
      readBatchData(data);
      observations.push(
        `contribute:${data.batches.map((batch) => batch.kind).join(',') || 'empty'}`,
      );
      return ok(undefined);
    },
  };
}

describe('ParticleRenderBatch public RenderFeature compatibility', () => {
  it('keeps the public batch as the actual feature callback data', () => {
    const feature = compatibilityFeature(batchValue);

    expectTypeOf(feature).toMatchTypeOf<RenderFeature<ParticleRenderBatch>>();
    expect(feature.identity).toBe('runtime.test.particle-render-batch');
  });

  it('keeps the public renderer assembly entry available to the consumer', async () => {
    const { createRenderer } = await import('@forgeax/engine-runtime');
    const renderer = await createRenderer(
      canvas(),
      {
        rhi,
        features: [compatibilityFeature(batchValue)],
      },
      { shaderManifestUrl: manifest },
    );

    expect((await renderer.ready).ok).toBe(true);
    renderer.dispose();
  });

  it('runs empty, billboard, and mesh batches through one feature and frame loop', async () => {
    const scenarios = syntheticBatches();
    let current = scenarios[0];
    const observations: string[] = [];
    const { createRenderer } = await import('@forgeax/engine-runtime');
    const renderer = await createRenderer(
      canvas(),
      {
        rhi,
        features: [compatibilityFeature(() => current ?? batchValue(), observations)],
      },
      { shaderManifestUrl: manifest },
    );

    expect((await renderer.ready).ok).toBe(true);
    const world = new World();
    for (const scenario of scenarios) {
      current = scenario;
      expect(renderer.draw([world], { owner: 0 }).ok).toBe(true);
    }

    expect(observations).toEqual([
      'extract:empty',
      'prepare:empty',
      'contribute:empty',
      'extract:billboard',
      'prepare:billboard',
      'contribute:billboard',
      'extract:mesh',
      'prepare:mesh',
      'contribute:mesh',
    ]);
    expect(renderer.renderFeatureDiagnostics()[0]?.status).toBe('active');
    renderer.dispose();
  });

  it('keeps the consumer out of VFX and runtime production boundaries', () => {
    const vfxSources = productionSourceFiles(resolve(repositoryRoot, 'packages/vfx/src')).map(
      (path) => readFileSync(path, 'utf8'),
    );
    const vfxPackage = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'packages/vfx/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const runtimePackage = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'packages/runtime/package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const runtimeAssembly = readFileSync(
      resolve(repositoryRoot, 'packages/runtime/src/createRenderer.ts'),
      'utf8',
    );
    const runtimeBundle = readFileSync(
      resolve(repositoryRoot, 'packages/runtime/dist/index.mjs'),
      'utf8',
    );

    expect(vfxSources.some((source) => source.includes('@forgeax/engine-render'))).toBe(false);
    expect(vfxSources.some((source) => source.includes('RenderFeature'))).toBe(false);
    expect(vfxPackage.dependencies?.['@forgeax/engine-render']).toBeUndefined();
    expect(runtimePackage.dependencies?.['@forgeax/engine-vfx']).toBeUndefined();
    expect(runtimePackage.devDependencies?.['@forgeax/engine-vfx']).toBe('workspace:*');
    for (const productionText of [runtimeAssembly, runtimeBundle]) {
      expect(productionText).not.toContain('@forgeax/engine-vfx');
      expect(productionText).not.toContain('ParticleRenderBatch');
      expect(productionText).not.toMatch(/kind\s*===\s*['"](?:billboard|mesh)['"]/);
    }
  });

  it('keeps public batch validation valid for three shapes and closed for invalid input', () => {
    for (const batch of syntheticBatches()) {
      expect(validateParticleRenderBatch(batch).ok).toBe(true);
    }

    const billboard = billboardBatch();
    const meshOutput = meshBatch();
    const invalidPositionAttributes = {
      ...billboard.attributes,
      position: new Float32Array(5),
    };
    expectInvalidBatch({ batches: [{ ...billboard, kind: 'ribbon' }] }, 'batches[0].kind');
    expectInvalidBatch(
      { batches: [{ ...billboard, attributes: invalidPositionAttributes }] },
      'batches[0].attributes.position',
    );
    expectInvalidBatch({ batches: [{ ...meshOutput, count: -1 }] }, 'batches[0].count');
    expectInvalidBatch({ batches: [{ ...meshOutput, mesh: -1 }] }, 'batches[0].mesh');
  });
});
