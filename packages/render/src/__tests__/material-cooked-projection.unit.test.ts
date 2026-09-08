import type { CookedMaterialRecord } from '@forgeax/engine-pack';
import { describe, expect, it } from 'vitest';
import { assembleMaterialProjection } from '../assembly/material/assembly.js';
import { projectMaterialPipeline } from '../assembly/material/pipeline-projection.js';

function cookedRecord(): CookedMaterialRecord {
  return {
    schemaVersion: 'material-cook/3',
    guid: 'material-leaf' as never,
    specializationKey: 'specialization-key',
    authored: {
      kind: 'material',
      parent: 'material-parent' as never,
      values: { baseColor: [1, 0, 0, 1] },
    },
    resolved: {
      passes: [
        {
          name: 'forward',
          program: {
            module: 'project::standard',
            vertexEntry: 'vs_main',
            fragmentEntry: 'fs_main',
          },
          renderState: { blend: 'opaque' },
        },
      ],
      parameters: [{ name: 'baseColor', type: 'color' }],
      values: { baseColor: [0.2, 0.3, 0.4, 1] },
    },
    refs: {
      parent: ['material-parent'],
      textures: [],
      samplers: [],
      modules: ['project::standard'],
    },
    artifact: {
      mediaType: 'text/wgsl',
      path: 'material-leaf.wgsl',
      digest: 'sha256:artifact',
      bytes: new Uint8Array([1, 2, 3]),
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
        artifactDigest: 'sha256:artifact',
        valueGeneration: 1,
        dependencyGeneration: 1,
        cookGeneration: 1,
      },
      derivedInterface: { layoutIdentity: 'sha256:layout' },
    },
  };
}

describe('cooked material render projection', () => {
  it('projects cooked passes and artifact identity without exposing authored inheritance', () => {
    const projection = assembleMaterialProjection(cookedRecord());

    expect(projection).toMatchObject({
      materialGuid: 'material-leaf',
      specializationKey: 'specialization-key',
      artifactHash: 'sha256:artifact',
      passes: [
        {
          name: 'forward',
          module: 'project::standard',
          vertexEntry: 'vs_main',
          fragmentEntry: 'fs_main',
        },
      ],
    });
    expect('authored' in projection).toBe(false);
    expect(projection.passes[0]?.artifactHash).toBe('sha256:artifact');
  });

  it('builds a pipeline projection from the cooked artifact, not the parent chain', () => {
    const projection = assembleMaterialProjection(cookedRecord());
    const pipeline = projectMaterialPipeline(projection);

    expect(pipeline).toEqual({
      specializationKey: 'specialization-key',
      artifactHash: 'sha256:artifact',
      passes: projection.passes,
    });
  });

  it('keeps projections isolated when adjacent slots use different cooked identities', () => {
    const firstRecord = cookedRecord();
    const secondRecord: CookedMaterialRecord = {
      ...firstRecord,
      guid: 'material-slot-2' as never,
      authored: {
        kind: 'material',
        ...firstRecord.authored,
        parent: 'material-parent-2' as never,
        values: { baseColor: [0, 1, 0, 1] },
      },
      resolved: {
        ...firstRecord.resolved,
        values: { baseColor: [0.8, 0.1, 0.2, 1] },
      },
      artifact: {
        ...firstRecord.artifact,
        path: 'material-slot-2.wgsl',
        digest: 'sha256:artifact-2',
        bytes: new Uint8Array([4, 5, 6]),
      },
      receipt: {
        ...firstRecord.receipt,
        identity: {
          ...firstRecord.receipt.identity,
          cookIdentity: 'sha256:input-2',
          artifactDigest: 'sha256:artifact-2',
        },
      },
      specializationKey: 'specialization-key-2',
    };

    const first = assembleMaterialProjection(firstRecord);
    const second = assembleMaterialProjection(secondRecord);

    expect(second).not.toBe(first);
    expect(first.materialGuid).toBe('material-leaf');
    expect(first.specializationKey).toBe('specialization-key');
    expect(first.artifactHash).toBe('sha256:artifact');
    expect(second.materialGuid).toBe('material-slot-2');
    expect(second.specializationKey).toBe('specialization-key-2');
    expect(second.artifactHash).toBe('sha256:artifact-2');
    expect(second.runtimeValues).not.toBe(first.runtimeValues);
    expect('authored' in second).toBe(false);
  });
});
