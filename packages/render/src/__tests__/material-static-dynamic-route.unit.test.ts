import type { CookedMaterialRecord } from '@forgeax/engine-pack';
import { describe, expect, it, vi } from 'vitest';
import { assembleMaterialProjection } from '../assembly/material/assembly.js';
import {
  routeMaterialPipeline,
  updateMaterialRuntimeValues,
} from '../assembly/material/pipeline-projection.js';

const record: CookedMaterialRecord = {
  schemaVersion: 'material-cook/3',
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
  artifact: {
    mediaType: 'text/wgsl',
    path: 'material-route.wgsl',
    digest: 'sha256:route',
    bytes: new Uint8Array([4]),
  },
  receipt: {
    schemaVersion: 'material-cook/3',
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

describe('cooked material static and dynamic routing', () => {
  it('updates runtime values without requesting a compile or changing the artifact key', () => {
    const projection = assembleMaterialProjection(record);
    const updated = updateMaterialRuntimeValues(projection, {
      baseColor: [0.25, 0.5, 0.75, 1],
    });

    expect(updated.runtimeValues.baseColor).toEqual([0.25, 0.5, 0.75, 1]);
    expect(updated.specializationKey).toBe(projection.specializationKey);
  });

  it('selects a cooked static specialization and returns a structured miss', () => {
    const projection = assembleMaterialProjection(record);
    const lookup = vi.fn((key: string) =>
      key === 'route-key' ? { key, bytes: new Uint8Array([4]), digest: 'sha256:route' } : undefined,
    );

    const ready = routeMaterialPipeline({ projection, lookupArtifact: lookup });
    expect(ready).toMatchObject({ kind: 'ready', specializationKey: 'route-key' });
    expect(lookup).toHaveBeenCalledWith('route-key');

    const missing = routeMaterialPipeline({
      projection: { ...projection, specializationKey: 'uncooked-static-selection' },
      lookupArtifact: lookup,
    });
    expect(missing).toMatchObject({
      kind: 'error',
      error: {
        code: 'material-specialization-not-cooked',
        detail: { specializationKey: 'uncooked-static-selection' },
      },
    });
  });
});
