import { describe, expect, it } from 'vitest';
import { createMaterialLoader } from '../material/loader.js';

describe('material runtime readiness', () => {
  it('loads only a cooked record with its artifact and complete references', async () => {
    const loader = createMaterialLoader({
      loadRecord: async () => ({
        schemaVersion: 'material-cook/1',
        guid: 'mat-ready',
        resolved: { passes: [], parameters: [], values: {} },
        refs: { parent: [], textures: [], samplers: [], modules: [] },
        artifact: {
          mediaType: 'text/wgsl',
          path: 'mat.wgsl',
          digest: 'sha256:a',
          bytes: new Uint8Array([1]),
        },
        receipt: {
          sourceClosure: [],
          profile: 'webgpu/v1',
          compilerVersion: 'compiler/1',
          inputDigest: 'i',
          outputDigest: 'sha256:a',
        },
      }),
      loadReference: async () => true,
    });

    const result = await loader.load({ guid: 'mat-ready', specializationKey: 'key-a' });

    expect(result.status).toBe('Ready');
    if (result.status !== 'Ready') return;
    expect(result.artifact.digest).toBe('sha256:a');
  });

  it('returns a structured missing-cook failure without compiling at runtime', async () => {
    const loader = createMaterialLoader({ loadRecord: async () => undefined });
    const result = await loader.load({ guid: 'mat-missing', specializationKey: 'key-a' });

    expect(result).toMatchObject({
      status: 'Error',
      error: { code: 'material-specialization-not-cooked' },
    });
  });
});
