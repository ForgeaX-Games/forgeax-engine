import {
  type CookedMaterialRecord,
  createMaterialArtifactDigest,
  createMaterialProgramSetDigest,
  type MaterialCookProgram,
  type MaterialCookProgramContext,
} from '@forgeax/engine-pack/material-cook';
import { MaterialArtifactRegistry, ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialProgramAbi } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { inspectMaterialRuntime } from '../material/inspection.js';
import { createMaterialLoader, type MaterialPublication } from '../material/loader.js';
import {
  installMaterialReadyShaders,
  projectMaterialRecord,
  selectMaterialPassProgram,
} from '../material/runtime-shader.js';

const context: MaterialCookProgramContext = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
};

const submissionAbi: MaterialProgramAbi = {
  directEntry: 'vs_main',
  sceneIndexEntry: 'vs_scene_index',
  materialRow: { byteLength: 16, fields: [] },
  resourceSlots: [],
  uvSets: [],
  vertexInputs: [],
  alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' },
  reflection: { layoutIdentity: 'layout', resourceSlots: [], vertexInputs: [] },
  receiptIdentity: 'custom-layout',
  generation: 1,
};
function fixture() {
  const passes = ['Forward', 'Overlay'].map((name) => ({ name, program: { module: name } }));
  const programs = passes.map(({ name }) => {
    const bytes = new TextEncoder().encode(`program ${name}`);
    return {
      specializationKey: name,
      artifact: {
        mediaType: 'text/wgsl',
        path: `${name}.wgsl`,
        digest: createMaterialArtifactDigest(bytes),
        bytes,
      },
      selections: [{ pass: name, context }],
    };
  });
  const artifactDigest = createMaterialProgramSetDigest(programs, passes);
  const record: CookedMaterialRecord = {
    schemaVersion: 'material-cook/4',
    guid: 'material',
    materialGuid: 'material',
    publicationGeneration: 1,
    specializationKey: 'publication',
    artifactDigest,
    sourceClosure: ['material.json'],
    parameterContract: { parameters: [], values: {} },
    resolved: { passes, parameters: [], values: {} },
    refs: { parent: [], textures: [], samplers: [], modules: [] },
    programs,
    receipt: {
      schemaVersion: 'material-cook/4',
      sourceClosure: ['material.json'],
      profile: 'webgpu/v1',
      compilerVersion: 'test',
      identity: {
        materialContractDigest: 'contract',
        sourceRevision: 'source',
        sourceClosureDigest: 'closure',
        layoutIdentity: 'layout',
        programIdentity: 'program',
        pipelineIdentity: 'pipeline',
        materialPublicationIdentity: 'publication',
        cookIdentity: 'cook',
        compilerFingerprint: 'compiler',
        wasm: { sourceContentKey: 'source', artifactSha256: 'artifact', glueSha256: 'glue' },
        artifactDigest,
        valueGeneration: 1,
        dependencyGeneration: 1,
        cookGeneration: 1,
      },
      derivedInterface: { layoutIdentity: 'layout' },
    },
  };
  const artifacts = Object.fromEntries(
    programs.map(({ artifact }) => [
      artifact.path,
      { bytes: new Uint8Array(artifact.bytes), digest: artifact.digest },
    ]),
  );
  const publication: MaterialPublication = { guid: 'material', record, artifacts };
  return { record, artifacts, publication };
}
const request = { guid: 'material', specializationKey: 'publication' };
const load = (publication: MaterialPublication) =>
  createMaterialLoader({ loadPublication: async () => publication }).load(request);

it('publishes Ready only after every program has verified immutable bytes', async () => {
  const { publication, artifacts } = fixture();
  const result = await load(publication);
  expect(result.status).toBe('Ready');
  if (result.status !== 'Ready') throw new Error('Expected Ready');
  expect(result.programs).toHaveLength(2);
  const before = result.programs[1]?.artifact.bytes.slice();
  artifacts['Overlay.wgsl']?.bytes.fill(0);
  expect(result.programs[1]?.artifact.bytes).toEqual(before);
  expect(result.record.programs).toBe(result.programs);
});

it('rejects a missing or corrupted second program instead of publishing a partial generation', async () => {
  const { publication, artifacts } = fixture();
  delete artifacts['Overlay.wgsl'];
  expect(await load(publication)).toMatchObject({
    status: 'Error',
    error: { code: 'asset-artifact-missing', detail: { field: 'Overlay.wgsl' } },
  });
  artifacts['Overlay.wgsl'] = { bytes: new TextEncoder().encode('old generation'), digest: 'old' };
  expect(await load(publication)).toMatchObject({
    status: 'Error',
    error: { code: 'asset-artifact-integrity-mismatch', detail: { field: 'Overlay.wgsl' } },
  });
});

it('rejects a stale selection manifest before publishing Ready', async () => {
  const { publication, record } = fixture();
  expect(
    await load({
      ...publication,
      record: {
        ...record,
        resolved: {
          ...record.resolved,
          passes: record.resolved.passes.map((pass) => ({
            ...pass,
            program: { ...pass.program, fragmentEntry: 'changed' },
          })),
        },
      },
    }),
  ).toMatchObject({ status: 'Error', error: { code: 'material-cook-record-invalid' } });
});

it('installs programs under their own keys and preserves each Pass selection', async () => {
  const { publication } = fixture();
  const ready = await load(publication);
  if (ready.status !== 'Ready') throw new Error('Expected Ready');
  const shaders = new ShaderRegistry({
    device: {
      createShaderModule: () => {
        throw new Error('Program installation must not compile GPU modules');
      },
    } as never,
    manifestUrl: undefined,
  });
  const artifacts = new MaterialArtifactRegistry();
  const projection = installMaterialReadyShaders(shaders, ready, artifacts);
  expect(
    projection.passes.map((pass) => pass.programs.map((program) => program.specializationKey)),
  ).toEqual([['Forward'], ['Overlay']]);
  expect(shaders.findMaterialArtifact('Forward').ok).toBe(true);
  expect(shaders.findMaterialArtifact('Overlay').ok).toBe(true);
  expect(shaders.findMaterialArtifact('publication').ok).toBe(false);
});

it('leaves both registries unchanged when a later program conflicts', async () => {
  const { publication } = fixture();
  const ready = await load(publication);
  if (ready.status !== 'Ready') throw new Error('Expected Ready');
  const shaders = new ShaderRegistry({
    device: {
      createShaderModule: () => {
        throw new Error('Program installation must not compile GPU modules');
      },
    } as never,
    manifestUrl: undefined,
  });
  const artifacts = new MaterialArtifactRegistry();
  artifacts
    .register({
      key: 'Overlay',
      bytes: new TextEncoder().encode('conflicting prior program'),
      metadata: { paramSchema: [] },
    })
    .unwrap();
  expect(() => installMaterialReadyShaders(shaders, ready, artifacts)).toThrow(
    'material-artifact-conflict',
  );
  expect(artifacts.get('Forward')).toBeUndefined();
  expect(shaders.findMaterialArtifact('Forward').ok).toBe(false);
  expect(shaders.findMaterialArtifact('Overlay').ok).toBe(false);
});

it('selects the exact Pass and context and refuses unsupported or ambiguous selections', () => {
  const { record } = fixture();
  const projection = projectMaterialRecord(record);
  expect(selectMaterialPassProgram(projection, 'Overlay', context).specializationKey).toBe(
    'Overlay',
  );
  expect(() =>
    selectMaterialPassProgram(projection, 'Overlay', { ...context, geometry: 'skinned' }),
  ).toThrow('no unique published program');
  expect(() => selectMaterialPassProgram(projection, 'Missing', context)).toThrow(
    'no unique published program',
  );
  expect(() =>
    selectMaterialPassProgram(
      { ...projection, passes: [...projection.passes, ...projection.passes] },
      'Forward',
      context,
    ),
  ).toThrow('no unique published program');
});

it('selects direct and scene-index entries from one projected publication', () => {
  const { record } = fixture();
  const forward = record.programs[0];
  if (forward === undefined) throw new Error('Forward fixture program is missing');
  const modernRecord: CookedMaterialRecord = {
    ...record,
    programs: record.programs.map((program, index) =>
      index === 0
        ? {
            ...program,
            selections: program.selections.flatMap((selection) => [
              {
                ...selection,
                address: 'direct' as const,
                entry: submissionAbi.directEntry,
                abi: submissionAbi,
              },
              {
                ...selection,
                address: 'scene-index' as const,
                entry: submissionAbi.sceneIndexEntry,
                abi: submissionAbi,
              },
            ]),
          }
        : program,
    ),
  };
  const projection = projectMaterialRecord(modernRecord);
  expect(selectMaterialPassProgram(projection, 'Forward', context, 'direct')).toMatchObject({
    address: 'direct',
    entry: 'vs_main',
    abi: submissionAbi,
  });
  expect(selectMaterialPassProgram(projection, 'Forward', context, 'scene-index')).toMatchObject({
    address: 'scene-index',
    entry: 'vs_scene_index',
    abi: submissionAbi,
  });
  expect(forward.selections).toHaveLength(1);
});

it('loads and selects a ray derivative through the same complete material publication', async () => {
  const { record } = fixture();
  const bytes = new TextEncoder().encode('@compute @workgroup_size(64) fn cs_surface() {}');
  const rayContext = {
    backend: 'webgpu',
    capability: 'storage-buffer',
    pipeline: 'ray',
    geometry: 'mesh',
    pass: 'ray-hit',
    profile: 'forgeax-material-ray-v1',
    toolchain: 'naga-oil',
    instrumentation: 'none',
  } as const;
  const ray: MaterialCookProgram = {
    specializationKey: 'ray-surface',
    artifact: {
      mediaType: 'text/wgsl',
      path: 'ray.wgsl',
      bytes,
      digest: createMaterialArtifactDigest(bytes),
    },
    selections: [{ pass: 'Forward', context: rayContext, entry: 'cs_surface' }],
  };
  const programs: MaterialCookProgram[] = [
    ...record.programs.map((program) => ({
      ...program,
      selections: program.selections.flatMap((selection) => [
        {
          ...selection,
          address: 'direct' as const,
          entry: submissionAbi.directEntry,
          abi: submissionAbi,
        },
        {
          ...selection,
          address: 'scene-index' as const,
          entry: submissionAbi.sceneIndexEntry,
          abi: submissionAbi,
        },
      ]),
    })),
    ray,
  ];
  const artifactDigest = createMaterialProgramSetDigest(programs, record.resolved.passes);
  const complete = {
    ...record,
    programs,
    artifactDigest,
    receipt: { ...record.receipt, identity: { ...record.receipt.identity, artifactDigest } },
  };
  const artifacts = Object.fromEntries(
    programs.map(({ artifact }) => [
      artifact.path,
      {
        bytes: artifact.bytes.slice(),
        digest: artifact.digest,
      },
    ]),
  );
  const publication: MaterialPublication = { guid: 'material', record: complete, artifacts };
  const ready = await load(publication);
  expect(ready.status).toBe('Ready');
  if (ready.status !== 'Ready') throw new Error('shared publication did not load');
  const inspected = inspectMaterialRuntime(ready);
  const rayInfo = inspected.programs.find((program) => program.specializationKey === 'ray-surface');
  expect(rayInfo).toEqual({
    specializationKey: 'ray-surface',
    artifactDigest: ray.artifact.digest,
    byteLength: bytes.byteLength,
    selections: [{ pass: 'Forward', context: rayContext, entry: 'cs_surface' }],
  });
  expect(JSON.parse(JSON.stringify(inspected)).programs).toEqual(inspected.programs);
  expect(rayInfo?.selections).not.toBe(ready.programs.at(-1)?.selections);
  expect(rayInfo?.selections[0]?.context).not.toBe(ready.programs.at(-1)?.selections[0]?.context);
  const shaders = new ShaderRegistry({
    device: {
      createShaderModule: () => {
        throw new Error('Installation must not compile GPU modules');
      },
    } as never,
    manifestUrl: undefined,
  });
  const projection = installMaterialReadyShaders(shaders, ready, new MaterialArtifactRegistry());
  expect(selectMaterialPassProgram(projection, 'Forward', rayContext)).toMatchObject({
    specializationKey: 'ray-surface',
    entry: 'cs_surface',
    artifactHash: ray.artifact.digest,
  });
  expect(shaders.findMaterialArtifact('ray-surface').unwrap().source).toBe(
    new TextDecoder().decode(bytes),
  );
  expect(selectMaterialPassProgram(projection, 'Forward', context, 'scene-index').entry).toBe(
    submissionAbi.sceneIndexEntry,
  );
  expect(() => selectMaterialPassProgram(projection, 'Forward', rayContext, 'scene-index')).toThrow(
    /no unique published program/,
  );
  expect(() =>
    selectMaterialPassProgram(projectMaterialRecord(record), 'Forward', rayContext),
  ).toThrow(/no unique published program/);

  delete artifacts['ray.wgsl'];
  expect(await load(publication)).toMatchObject({
    status: 'Error',
    error: {
      code: 'asset-artifact-missing',
      detail: { field: 'ray.wgsl' },
    },
  });
  const failed = await load(publication);
  if (failed.status !== 'Error') throw new Error('missing artifact must fail');
  const retained = inspectMaterialRuntime({ status: 'LastKnownGood', ready, failure: failed });
  expect(retained).toMatchObject({
    readiness: 'last-known-good',
    preparationFailure: { code: 'asset-artifact-missing', detail: { field: 'ray.wgsl' } },
    lastKnownGood: {
      publicationGeneration: ready.publicationGeneration,
      programs: inspected.programs,
    },
  });
  artifacts['ray.wgsl'] = {
    bytes: new TextEncoder().encode('stale ray source'),
    digest: ray.artifact.digest,
  };
  expect(await load(publication)).toMatchObject({
    status: 'Error',
    error: {
      code: 'asset-artifact-integrity-mismatch',
      detail: { field: 'ray.wgsl' },
    },
  });
});
