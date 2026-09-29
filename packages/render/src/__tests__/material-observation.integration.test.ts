import { describe, expect, it } from 'vitest';
import {
  projectMeshMaterialBindingObservation,
  summarizeMeshMaterialBindings,
} from '../mesh-material-bindings';

const bindings = [
  { handle: 11, source: 'renderer-override' as const },
  { handle: 12, source: 'mesh-default' as const },
  { handle: 0, source: 'engine-default' as const },
];

const failure = {
  code: 'material-specialization-stale-generation',
  expected: 'a stable material publication generation',
  hint: 'retry the producer-owned material rebuild',
  detail: { material: 'mat-a', dependencies: ['texture/a'] },
};

describe('resident MeshMaterialBindingObservation', () => {
  it('projects sampler, readiness, mip, and nearest preparation failure without producer fields', () => {
    const observation = projectMeshMaterialBindingObservation({
      worldId: 2,
      entityKey: 9,
      bindings,
      diagnostics: [],
      residency: [
        {
          readiness: 'ready',
          samplers: [{ handle: 101, resident: true }],
          textures: [{ handle: 201, mipLevelCount: 4 }],
        },
        {
          readiness: 'pending',
          samplers: [{ handle: 102, resident: false }],
          textures: [{ handle: 202, mipLevelCount: 1 }],
        },
        {
          readiness: 'last-known-good',
          samplers: [{ handle: 103, resident: true }],
          textures: [{ handle: 203, mipLevelCount: 2 }],
          preparationFailure: failure,
        },
      ],
    });

    expect(observation).toMatchObject({
      worldId: 2,
      entityKey: 9,
      bindings,
      residency: [
        { readiness: 'ready', textures: [{ mipLevelCount: 4 }] },
        { readiness: 'pending' },
        { readiness: 'last-known-good', preparationFailure: failure },
      ],
    });
    expect(observation).not.toHaveProperty('materialAsset');
    expect(observation).not.toHaveProperty('producerReadiness');
  });

  it('recomputes aggregate counts from the retained observations', () => {
    const first = projectMeshMaterialBindingObservation({
      worldId: 0,
      entityKey: 1,
      bindings,
      diagnostics: [],
      residency: [
        { readiness: 'ready', samplers: [], textures: [] },
        { readiness: 'failed', samplers: [], textures: [], preparationFailure: failure },
        { readiness: 'pending', samplers: [], textures: [] },
      ],
    });
    expect(summarizeMeshMaterialBindings([first])).toEqual({
      total: 3,
      ready: 1,
      pending: 1,
      failed: 1,
      lastKnownGood: 0,
      textureCount: 0,
      samplerCount: 0,
    });

    const rebuilt = projectMeshMaterialBindingObservation({
      ...first,
      residency: [
        { readiness: 'ready', samplers: [], textures: [] },
        { readiness: 'last-known-good', samplers: [], textures: [], preparationFailure: failure },
        { readiness: 'ready', samplers: [], textures: [] },
      ],
    });
    expect(summarizeMeshMaterialBindings([rebuilt])).toEqual({
      total: 3,
      ready: 2,
      pending: 0,
      failed: 0,
      lastKnownGood: 1,
      textureCount: 0,
      samplerCount: 0,
    });
  });
});
