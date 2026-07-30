import type { CookedMaterialRecord } from '@forgeax/engine-pack';
import { describe, expect, it } from 'vitest';
import { assembleMaterialProjection } from '../renderer/material/assembly.js';
import { projectMaterialPipeline } from '../renderer/material/pipeline-projection.js';

function cookedRecord(): CookedMaterialRecord {
  return {
    schemaVersion: 'material-cook/1',
    guid: 'material-leaf' as never,
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
      sourceClosure: ['project::standard'],
      profile: 'forgeax-material-wgsl-v1',
      compilerVersion: 'compiler/1',
      inputDigest: 'specialization-key',
      outputDigest: 'sha256:artifact',
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
});
