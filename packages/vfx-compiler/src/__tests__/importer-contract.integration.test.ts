import { ImporterRegistry, type RunImportMeta, runImport } from '@forgeax/engine-import';
import {
  type ImportResult,
  ok,
  type ParticleEffectAsset,
  type Result,
} from '@forgeax/engine-types';
import type { ParticleEffectSource } from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';
import {
  type ParticleOperatorDefinition,
  ParticleOperatorRegistry,
  particleEffectImporter,
} from '../index.js';

const EFFECT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const MATERIAL_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45d';

const source: ParticleEffectSource = {
  schemaVersion: 1,
  emitters: [
    {
      id: 'spark',
      capacity: 32,
      space: 'world',
      schedule: { rate: 4, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      operators: {
        spawn: [{ kind: 'spawn-rate', version: 1, params: { rate: 4 } }],
        initialize: [{ kind: 'set-life', version: 1, params: { seconds: 1 } }],
        update: [{ kind: 'gravity', version: 1, params: { y: -9.8 } }],
        output: [{ kind: 'billboard', version: 1, params: { size: 0.25 } }],
      },
      output: { kind: 'billboard', material: MATERIAL_GUID },
    },
  ],
};

function definition(
  stage: 'spawn' | 'initialize' | 'update' | 'output',
  kind: string,
): ParticleOperatorDefinition {
  return {
    stage,
    kind,
    version: 1,
    parameterSchema: {},
    validateParams: (): Result<void, never> => ok(undefined),
    compile: { cpu: (params) => ({ stage, kind, params }) },
  };
}

function registry(): ParticleOperatorRegistry {
  const result = new ParticleOperatorRegistry();
  for (const [stage, kind] of [
    ['spawn', 'spawn-rate'],
    ['initialize', 'set-life'],
    ['update', 'gravity'],
    ['output', 'billboard'],
  ] as const) {
    const registered = result.register(definition(stage, kind));
    if (!registered.ok) throw new Error(registered.error.code);
  }
  return result;
}

function meta(): RunImportMeta {
  return {
    importer: 'particle-effect',
    source: 'effects/spark.json',
    subAssets: [{ guid: EFFECT_GUID, sourceIndex: 0, kind: 'particle-effect' }],
  };
}

function readFs() {
  return {
    readSource: async () => ({
      ok: true as const,
      value: new TextEncoder().encode(JSON.stringify(source)),
    }),
  };
}

describe('particle-effect importer public asset-cook contract', () => {
  it('registers through the public importer API and returns a generic ImportProduct', async () => {
    const importers = new ImporterRegistry();
    importers.register(particleEffectImporter(registry()));

    const result = await runImport(meta(), importers, readFs());

    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value) throw new Error('particle effect import failed');

    const product = result.value.product;
    const asset = product.assets[0];
    expect(asset).toBeDefined();
    expect(asset?.guid).toBe(EFFECT_GUID);
    expect(asset?.kind).toBe('particle-effect');
    expect(asset?.payload).toMatchObject({
      kind: 'particle-effect',
      schemaVersion: 1,
      emitters: [{ id: 'spark', capacity: 32 }],
    } satisfies Partial<ParticleEffectAsset>);
    expect(asset?.refs).toEqual([{ guid: MATERIAL_GUID }]);
    expect(Object.keys(asset?.artifacts ?? {})).toEqual(['particle-effect/program.json']);
    expect(asset?.artifacts['particle-effect/program.json']).toMatchObject({
      mediaType: 'application/json',
    });
    expect(asset?.artifacts['particle-effect/program.json']?.bytes.byteLength).toBeGreaterThan(0);
    expect(product.sourceDependencies).toEqual(['effects/spark.json']);
    expect(result.value.pack.assets[0]?.artifacts).toHaveProperty('particle-effect/program.json');
    expect(result.value.pack).not.toHaveProperty('bins');
    expect(result.value.cookProducts[0]).toMatchObject({
      guid: EFFECT_GUID,
      payload: expect.objectContaining({ kind: 'particle-effect' }),
      refs: [MATERIAL_GUID],
      artifacts: {
        'particle-effect/program.json': expect.objectContaining({
          mediaType: 'application/json',
        }),
      },
      receipt: expect.objectContaining({
        guid: EFFECT_GUID,
        origin: 'sourceMeta',
        status: 'succeeded',
      }),
    });
  });

  it('uses the declared GUID and asset-local artifact key without package-global facts', async () => {
    const importer = particleEffectImporter(registry());
    const context = {
      source: 'effects/spark.json',
      readSource: async () => ({
        ok: true as const,
        value: new TextEncoder().encode(JSON.stringify(source)),
      }),
      readSibling: async () => ({ ok: true as const, value: new Uint8Array() }),
      decodeImage: async () => {
        throw new Error('not used');
      },
      subAssets: [{ guid: EFFECT_GUID, sourceIndex: 0, kind: 'particle-effect' }],
      importSettings: {},
    } satisfies Parameters<NonNullable<typeof importer.import>>[0];

    const imported = (await importer.import(context)) as ImportResult<ParticleEffectAsset>;

    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error(imported.error.code);
    expect(imported.value.assets[0]?.guid).toBe(EFFECT_GUID);
    expect(imported.value.assets[0]?.refs).toEqual([{ guid: MATERIAL_GUID }]);
    expect(imported.value.assets[0]?.artifacts).not.toHaveProperty('packageUrl');
    expect(imported.value.assets[0]?.artifacts).not.toHaveProperty('receipt');
    expect(imported.value).not.toHaveProperty('artifacts');
    expect(imported.value).not.toHaveProperty('packageUrl');
  });
});
