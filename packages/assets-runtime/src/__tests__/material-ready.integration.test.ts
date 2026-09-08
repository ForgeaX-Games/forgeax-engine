import {
  type CookedMaterialRecord,
  createMaterialArtifactDigest,
  serializeCookedMaterialRecord,
} from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { MaterialGenerationCache } from '../material/generation-cache';
import { inspectMaterialRuntime } from '../material/inspection.js';
import { createMaterialLoader, type MaterialPublication } from '../material/loader.js';
import { materialParametersToParamSchema } from '../material/runtime-shader.js';

const MATERIAL_GUID = 'mat-ready';
const ARTIFACT_BYTES = new TextEncoder().encode('published material artifact');
const PRODUCTION_GUID = '019f0000-0000-7000-8000-000000000701';

function cookedRecord(guid = MATERIAL_GUID): CookedMaterialRecord {
  const artifactDigest = createMaterialArtifactDigest(ARTIFACT_BYTES);
  return {
    schemaVersion: 'material-cook/3',
    guid,
    materialGuid: guid,
    publicationGeneration: 7,
    specializationKey: 'material-specialization/7/ready',
    artifactDigest,
    sourceClosure: ['materials/ready.material.json', 'shaders/ready.wgsl'],
    parameterContract: { parameters: [], values: {} },
    resolved: { passes: [], parameters: [], values: {} },
    refs: { parent: [], textures: [], samplers: [], modules: [] },
    artifact: {
      mediaType: 'text/wgsl',
      path: `materials/${guid}/shader.wgsl`,
      digest: artifactDigest,
      bytes: ARTIFACT_BYTES,
    },
    receipt: {
      schemaVersion: 'material-cook/3',
      sourceClosure: ['materials/ready.material.json', 'shaders/ready.wgsl'],
      profile: 'webgpu/v1',
      compilerVersion: 'compiler/1',
      identity: {
        materialContractDigest: 'sha256:ready-contract',
        sourceRevision: 'sha256:ready-source',
        sourceClosureDigest: 'sha256:ready-closure',
        layoutIdentity: 'sha256:ready-layout',
        programIdentity: 'sha256:ready-program',
        pipelineIdentity: 'sha256:ready-pipeline',
        materialPublicationIdentity: 'sha256:ready-publication',
        cookIdentity: 'sha256:ready-cook',
        compilerFingerprint: 'sha256:ready-compiler',
        wasm: {
          sourceContentKey: 'unavailable',
          artifactSha256: 'unavailable',
          glueSha256: 'unavailable',
        },
        artifactDigest,
        valueGeneration: 7,
        dependencyGeneration: 7,
        cookGeneration: 7,
      },
      derivedInterface: { layoutIdentity: 'sha256:ready-layout' },
    },
  };
}

function publication(
  overrides: {
    readonly record?: unknown;
    readonly artifact?: MaterialPublication['artifact'] | null;
  } = {},
): MaterialPublication {
  const record = cookedRecord();
  return {
    guid: MATERIAL_GUID,
    record: overrides.record ?? record,
    ...(overrides.artifact === null
      ? {}
      : { artifact: overrides.artifact ?? { bytes: ARTIFACT_BYTES } }),
  };
}

function createLoader(loadPublication: () => Promise<MaterialPublication | undefined>) {
  return createMaterialLoader({ loadPublication, loadReference: async () => true });
}

describe('material runtime readiness', () => {
  it('preserves authored numeric defaults in the runtime parameter contract', () => {
    expect(
      materialParametersToParamSchema(
        [
          { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
          { name: 'roughness', type: 'f32', default: 0.5 },
          { name: 'baseColorTexture', type: 'texture' },
        ],
        'published::custom',
      ),
    ).toEqual([
      { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
      { name: 'roughness', type: 'f32', default: 0.5 },
      { name: 'baseColorTexture', type: 'texture2d' },
    ]);
  });

  it('loads only a cooked record with its artifact and complete references', async () => {
    const loader = createLoader(async () => publication());

    const result = await loader.load({
      guid: MATERIAL_GUID,
      specializationKey: 'material-specialization/7/ready',
    });

    expect(result.status).toBe('Ready');
    if (result.status !== 'Ready') return;
    expect(result).toMatchObject({
      materialGuid: MATERIAL_GUID,
      publicationGeneration: 7,
      specializationKey: 'material-specialization/7/ready',
      artifactDigest: expect.stringMatching(/^sha256:/),
      sourceClosure: ['materials/ready.material.json', 'shaders/ready.wgsl'],
      parameterContract: { parameters: [], values: {} },
    });
    expect(inspectMaterialRuntime(result)).toMatchObject({
      materialGuid: MATERIAL_GUID,
      readiness: 'ready',
      publicationGeneration: 7,
      specializationKey: 'material-specialization/7/ready',
      artifactDigest: expect.stringMatching(/^sha256:/),
      sourceClosure: ['materials/ready.material.json', 'shaders/ready.wgsl'],
      parameterContract: { parameters: [], values: {} },
      status: 'Ready',
    });
  });

  it('returns a structured missing-cook failure without compiling at runtime', async () => {
    const loader = createLoader(async () => undefined);
    const result = await loader.load({ guid: 'mat-missing', specializationKey: 'key-a' });

    expect(result).toMatchObject({
      status: 'Error',
      error: { code: 'material-specialization-not-cooked' },
    });
  });

  it.each([
    ['artifact missing', () => ({ artifact: null }), 'asset-artifact-missing'],
    [
      'artifact bytes tampered',
      () => ({ artifact: { bytes: new TextEncoder().encode('tampered artifact') } }),
      'asset-artifact-integrity-mismatch',
    ],
    [
      'record field tampered',
      () => ({ record: { ...cookedRecord(), publicationGeneration: undefined } }),
      'material-cook-record-invalid',
    ],
  ] as const)('rejects %s on the published tuple', async (_label, mutate, code) => {
    const loader = createLoader(async () => publication(mutate()));
    const result = await loader.load({
      guid: MATERIAL_GUID,
      specializationKey: 'material-specialization/7/ready',
    });

    expect(result).toMatchObject({ status: 'Error', error: { code } });
  });

  it('keeps publication generations distinct in the material cache', async () => {
    const cache = new MaterialGenerationCache();
    let calls = 0;
    const load = async () => {
      calls += 1;
      return calls;
    };

    const first = await cache.resolve(MATERIAL_GUID, 'material-specialization/7/ready', load, 7);
    const second = await cache.resolve(MATERIAL_GUID, 'material-specialization/7/ready', load, 8);

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(calls).toBe(2);
  });

  it('loads the published record sidecar through the production GUID route', async () => {
    const record = cookedRecord(PRODUCTION_GUID);
    const packageUrl = `/materials/${PRODUCTION_GUID}.pack.json`;
    const descriptor = {
      path: record.artifact.path,
      mediaType: record.artifact.mediaType,
      byteLength: ARTIFACT_BYTES.byteLength,
      integrity: { algorithm: 'sha256' as const, digest: record.artifactDigest },
    };
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: PRODUCTION_GUID,
          kind: 'material',
          payload: {
            kind: 'material',
            passes: [{ name: 'Forward', program: { module: 'core/pbr' } }],
            parameters: [],
            values: {},
          },
          refs: [],
          artifacts: { [record.artifact.path]: descriptor },
        },
      ],
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/pack-index.json')) {
        return new Response(
          JSON.stringify([{ guid: PRODUCTION_GUID, packageUrl, kind: 'material' }]),
        );
      }
      if (url.endsWith('.record.json')) {
        return new Response(serializeCookedMaterialRecord(record), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('.pack.json')) return new Response(JSON.stringify(pack));
      if (url.endsWith('.wgsl')) return new Response(ARTIFACT_BYTES);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const registry = new AssetRegistry({} as never);
      registry.configurePackIndex('/pack-index.json');
      const parsedGuid = AssetGuid.parse(PRODUCTION_GUID);
      expect(parsedGuid.ok).toBe(true);
      if (!parsedGuid.ok) return;
      const payloadResult = await registry.loadByGuid(parsedGuid.value);

      expect(payloadResult).toMatchObject({ ok: true });
      expect(registry.getMaterialReadiness(PRODUCTION_GUID)).toMatchObject({
        status: 'Ready',
        materialGuid: PRODUCTION_GUID,
        publicationGeneration: 7,
        artifactDigest: record.artifactDigest,
      });
      expect(fetcher).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not require a cooked artifact for an Engine-owned material module', async () => {
    const packageUrl = `/materials/${PRODUCTION_GUID}.pack.json`;
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: PRODUCTION_GUID,
          kind: 'material',
          payload: {
            kind: 'material',
            passes: [{ name: 'Forward', program: { module: 'forgeax::default-standard-pbr' } }],
            values: { baseColor: [1, 0.2, 0.05, 1] },
          },
          refs: [],
          artifacts: {},
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/pack-index.json')) {
          return new Response(
            JSON.stringify([{ guid: PRODUCTION_GUID, packageUrl, kind: 'material' }]),
          );
        }
        return new Response(JSON.stringify(pack));
      }),
    );

    try {
      const registry = new AssetRegistry({} as never);
      registry.configurePackIndex('/pack-index.json');
      const parsedGuid = AssetGuid.parse(PRODUCTION_GUID);
      expect(parsedGuid.ok).toBe(true);
      if (!parsedGuid.ok) return;

      const result = await registry.loadByGuid(parsedGuid.value);

      expect(result).toMatchObject({ ok: true, value: { kind: 'material' } });
      expect(registry.getMaterialReadiness(PRODUCTION_GUID)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('installs authored pass modules from MaterialReady without a host registration step', async () => {
    const customShaderId = 'published::custom';
    const baseRecord = cookedRecord(PRODUCTION_GUID);
    const record: CookedMaterialRecord = {
      ...baseRecord,
      resolved: {
        ...baseRecord.resolved,
        passes: [{ name: 'Forward', program: { module: customShaderId } }],
      },
      refs: { ...baseRecord.refs, modules: [customShaderId] },
    };
    const packageUrl = `/materials/${PRODUCTION_GUID}.pack.json`;
    const descriptor = {
      path: record.artifact.path,
      mediaType: record.artifact.mediaType,
      byteLength: ARTIFACT_BYTES.byteLength,
      integrity: { algorithm: 'sha256' as const, digest: record.artifactDigest },
    };
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: PRODUCTION_GUID,
          kind: 'material',
          payload: {
            kind: 'material',
            passes: [{ name: 'Forward', program: { module: customShaderId } }],
            parameters: [],
            values: {},
          },
          refs: [],
          artifacts: { [record.artifact.path]: descriptor },
        },
      ],
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/pack-index.json')) {
        return new Response(
          JSON.stringify([{ guid: PRODUCTION_GUID, packageUrl, kind: 'material' }]),
        );
      }
      if (url.endsWith('.record.json')) {
        return new Response(serializeCookedMaterialRecord(record), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('.pack.json')) return new Response(JSON.stringify(pack));
      if (url.endsWith('.wgsl')) return new Response(ARTIFACT_BYTES);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);

    const shaderRegistry = new ShaderRegistry({
      device: {
        createShaderModule: () => {
          throw new Error('not used');
        },
      } as never,
      manifestUrl: undefined,
    });
    try {
      const registry = new AssetRegistry(shaderRegistry);
      registry.configurePackIndex('/pack-index.json');
      const parsedGuid = AssetGuid.parse(PRODUCTION_GUID);
      expect(parsedGuid.ok).toBe(true);
      if (!parsedGuid.ok) return;

      const result = await registry.loadByGuid(parsedGuid.value);

      expect(result).toMatchObject({ ok: true });
      const lookup = shaderRegistry.findMaterialArtifact(customShaderId);
      expect(lookup).toMatchObject({
        ok: true,
        value: { source: new TextDecoder().decode(ARTIFACT_BYTES), paramSchema: [] },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('installs authored pass modules from an inline cooked artifact', async () => {
    const customShaderId = 'published::inline-custom';
    const baseRecord = cookedRecord(PRODUCTION_GUID);
    const record: CookedMaterialRecord = {
      ...baseRecord,
      resolved: {
        ...baseRecord.resolved,
        passes: [{ name: 'Forward', program: { module: customShaderId } }],
      },
      refs: { ...baseRecord.refs, modules: [customShaderId] },
    };
    const packageUrl = `/materials/${PRODUCTION_GUID}.inline.pack.json`;
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: PRODUCTION_GUID,
          kind: 'material',
          payload: {
            kind: 'material',
            passes: [{ name: 'Forward', program: { module: customShaderId } }],
            parameters: [],
            values: {},
            cooked: JSON.parse(serializeCookedMaterialRecord(record)),
          },
          refs: [],
          artifacts: {},
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/pack-index.json')) {
          return new Response(
            JSON.stringify([{ guid: PRODUCTION_GUID, packageUrl, kind: 'material' }]),
          );
        }
        if (url.endsWith('.inline.pack.json')) return new Response(JSON.stringify(pack));
        return new Response('not found', { status: 404 });
      }),
    );

    const shaderRegistry = new ShaderRegistry({
      device: {
        createShaderModule: () => {
          throw new Error('not used');
        },
      } as never,
      manifestUrl: undefined,
    });
    try {
      const registry = new AssetRegistry(shaderRegistry);
      registry.configurePackIndex('/pack-index.json');
      const parsedGuid = AssetGuid.parse(PRODUCTION_GUID);
      expect(parsedGuid.ok).toBe(true);
      if (!parsedGuid.ok) return;

      const result = await registry.loadByGuid(parsedGuid.value);

      expect(result).toMatchObject({ ok: true });
      expect(shaderRegistry.findMaterialArtifact(customShaderId)).toMatchObject({
        ok: true,
        value: { source: new TextDecoder().decode(ARTIFACT_BYTES), paramSchema: [] },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not reinterpret the Pack descriptor base64 digest as a material digest', async () => {
    const record = cookedRecord(PRODUCTION_GUID);
    const packageUrl = `/materials/${PRODUCTION_GUID}.pack.json`;
    const descriptor = {
      path: record.artifact.path,
      mediaType: record.artifact.mediaType,
      byteLength: ARTIFACT_BYTES.byteLength,
      integrity: {
        algorithm: 'sha256' as const,
        digest: 'xEjSZ79vI9pvhM0qf+ot+tnK32nBxZHXVAn4OYdaJ3M=',
      },
    };
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: PRODUCTION_GUID,
          kind: 'material',
          payload: {
            kind: 'material',
            passes: [{ name: 'Forward', program: { module: 'core/pbr' } }],
            parameters: [],
            values: {},
          },
          refs: [],
          artifacts: { [record.artifact.path]: descriptor },
        },
      ],
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/pack-index.json')) {
        return new Response(
          JSON.stringify([{ guid: PRODUCTION_GUID, packageUrl, kind: 'material' }]),
        );
      }
      if (url.endsWith('.record.json')) return new Response(serializeCookedMaterialRecord(record));
      if (url.endsWith('.pack.json')) return new Response(JSON.stringify(pack));
      if (url.endsWith('.wgsl')) return new Response(ARTIFACT_BYTES);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const registry = new AssetRegistry({} as never);
      registry.configurePackIndex('/pack-index.json');
      const parsedGuid = AssetGuid.parse(PRODUCTION_GUID);
      expect(parsedGuid.ok).toBe(true);
      if (!parsedGuid.ok) return;
      const result = await registry.loadByGuid(parsedGuid.value);
      expect(result).toMatchObject({ ok: true });
      expect(registry.getMaterialReadiness(PRODUCTION_GUID)).toMatchObject({ status: 'Ready' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
