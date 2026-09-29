import type { CookedMaterialRecord } from '@forgeax/engine-pack';
import { deriveStandardLayerPlan } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { assembleMaterialProjection } from '../assembly/material/assembly.js';

const record: CookedMaterialRecord = {
  schemaVersion: 'material-cook/4',
  guid: 'material-route',
  specializationKey: 'route-key',
  authored: {
    kind: 'material',
    values: { useNormalMap: false },
  },
  resolved: {
    passes: [{ name: 'forward', program: { module: 'project::standard' } }],
    parameters: [
      { name: 'baseColor', type: 'color' },
      { name: 'useNormalMap', type: 'bool' },
    ],
    values: { baseColor: [1, 1, 1, 1], useNormalMap: false },
  },
  refs: { parent: [], textures: [], samplers: [], modules: ['project::standard'] },
  programs: [
    {
      specializationKey: 'route-program',
      artifact: {
        mediaType: 'text/wgsl',
        path: 'material-route.wgsl',
        digest: 'sha256:route',
        bytes: new Uint8Array([4]),
      },
      selections: [
        {
          pass: 'forward',
          context: {
            backend: 'webgpu',
            capability: 'storage-buffer',
            pipeline: 'forward',
            geometry: 'mesh',
            pass: 'forward',
            profile: 'forgeax-material-wgsl-v1',
            toolchain: 'naga-oil',
            instrumentation: 'none',
          },
        },
      ],
    },
  ],
  receipt: {
    schemaVersion: 'material-cook/4',
    sourceClosure: ['project::standard'],
    profile: 'forgeax-material-wgsl-v1',
    compilerVersion: 'compiler/1',
    identity: {
      materialContractDigest: 'sha256:contract',
      sourceRevision: 'sha256:source',
      sourceClosureDigest: 'sha256:closure',
      layoutIdentity: 'sha256:layout',
      programIdentity: 'sha256:program',
      pipelineIdentity: 'sha256:pipeline',
      materialPublicationIdentity: 'sha256:publication',
      cookIdentity: 'sha256:input',
      compilerFingerprint: 'sha256:compiler',
      wasm: {
        sourceContentKey: 'unavailable',
        artifactSha256: 'unavailable',
        glueSha256: 'unavailable',
      },
      artifactDigest: 'sha256:route',
      valueGeneration: 1,
      dependencyGeneration: 1,
      cookGeneration: 1,
    },
    derivedInterface: { layoutIdentity: 'sha256:layout' },
  },
};

describe('cooked material layer projection', () => {
  it('rejects a stale Standard layer plan before render projection', () => {
    const standardPass = { name: 'forward', program: { module: 'forgeax::default-standard-pbr' } };
    const standardResolved = { ...record.resolved, passes: [standardPass] };
    const expected = deriveStandardLayerPlan(
      standardResolved.parameters,
      standardResolved.passes,
    ).identity;
    const standardRecord = {
      ...record,
      resolved: standardResolved,
      receipt: {
        ...record.receipt,
        derivedInterface: { layoutIdentity: 'sha256:layout', layerPlanIdentity: expected },
      },
    } as CookedMaterialRecord;

    expect(assembleMaterialProjection(standardRecord).layerPlan.identity).toBe(expected);
    expect(() =>
      assembleMaterialProjection({
        ...standardRecord,
        receipt: {
          ...standardRecord.receipt,
          derivedInterface: { layoutIdentity: 'sha256:layout', layerPlanIdentity: 'stale' },
        },
      }),
    ).toThrow('Standard material layer-plan identity mismatch');
  });
});
