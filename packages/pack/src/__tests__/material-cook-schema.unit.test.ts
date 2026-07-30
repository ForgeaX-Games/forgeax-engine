import { describe, expect, it } from 'vitest';
import {
  type CookedMaterialRecord,
  createMaterialArtifactDigest,
  projectCookedMaterialRecord,
  serializeCookedMaterialRecord,
  validateCookedMaterialRecord,
} from '../evidence/material-cook.js';

const record: CookedMaterialRecord = {
  schemaVersion: 'material-cook/1',
  guid: 'mat-root',
  authored: {
    kind: 'material',
    passes: [{ name: 'forward', program: { module: 'core/pbr' } }],
    parameters: [{ name: 'roughness', type: 'f32', static: true }],
    values: { roughness: 0.5 },
  },
  resolved: {
    passes: [{ name: 'forward', program: { module: 'core/pbr' } }],
    parameters: [{ name: 'roughness', type: 'f32', static: true }],
    values: { roughness: 0.5 },
  },
  refs: { parent: [], textures: [], samplers: [], modules: ['core/pbr'] },
  artifact: {
    mediaType: 'text/wgsl',
    path: 'materials/mat-root/forward.wgsl',
    digest: 'sha256:artifact',
    bytes: new TextEncoder().encode('shader'),
  },
  receipt: {
    sourceClosure: ['materials/mat-root.material.json'],
    profile: 'webgpu/v1',
    compilerVersion: 'compiler/1',
    inputDigest: 'sha256:input',
    outputDigest: 'sha256:artifact',
  },
};

describe('cooked material schema', () => {
  it('serializes a stable cooked DTO and derives an artifact digest', () => {
    const first = serializeCookedMaterialRecord(record);
    const second = serializeCookedMaterialRecord({ ...record });

    expect(first).toBe(second);
    expect(createMaterialArtifactDigest(record.artifact.bytes)).toBe(
      'sha256:e137e75a5e0e7a623ca39de480667a55b43e0eedec58767634ebaef07c33383a',
    );
    expect(validateCookedMaterialRecord(JSON.parse(first))).toEqual({ ok: true, value: record });
  });

  it('projects cooked data without exposing an authored GUID entry', () => {
    const projection = projectCookedMaterialRecord(record);

    expect(projection.resolved.values).toEqual({ roughness: 0.5 });
    expect(projection.artifact.digest).toBe('sha256:artifact');
    expect(projection).not.toHaveProperty('guid');
    expect(projection).not.toHaveProperty('authored');
  });

  it('rejects missing fields and unsupported schema versions', () => {
    expect(validateCookedMaterialRecord({ ...record, refs: undefined })).toMatchObject({
      ok: false,
      error: { code: 'material-cook-record-invalid' },
    });
    expect(
      validateCookedMaterialRecord({ ...record, schemaVersion: 'material-cook/2' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'material-cook-record-invalid' },
    });
  });
});
