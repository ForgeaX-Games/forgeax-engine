import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type CookedMaterialRecord,
  createMaterialArtifactDigest,
  projectCookedMaterialRecord,
  serializeCookedMaterialRecord,
  validateCookedMaterialRecord,
} from '../evidence/material-cook.js';

const record: CookedMaterialRecord = {
  schemaVersion: 'material-cook/3',
  guid: 'mat-root',
  authored: {
    kind: 'material',
    passes: [{ name: 'forward', program: { module: 'core/pbr' } }],
    parameters: [{ name: 'roughness', type: 'f32' }],
    values: { roughness: 0.5 },
  },
  resolved: {
    passes: [{ name: 'forward', program: { module: 'core/pbr' } }],
    parameters: [{ name: 'roughness', type: 'f32' }],
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
    schemaVersion: 'material-cook/3',
    sourceClosure: ['materials/mat-root.material.json'],
    profile: 'webgpu/v1',
    compilerVersion: 'compiler/1',
    identity: {
      materialContractDigest: 'sha256:material-contract',
      sourceRevision: 'sha256:source-revision',
      sourceClosureDigest: 'sha256:source-closure',
      layoutIdentity: 'sha256:layout',
      programIdentity: 'sha256:program',
      pipelineIdentity: 'sha256:pipeline',
      materialPublicationIdentity: 'sha256:publication',
      cookIdentity: 'sha256:input',
      compilerFingerprint: 'sha256:compiler',
      wasm: {
        sourceContentKey: 'sha256:wasm-source',
        artifactSha256: 'sha256:wasm-artifact',
        glueSha256: 'sha256:wasm-glue',
      },
      artifactDigest: 'sha256:artifact',
      valueGeneration: 1,
      dependencyGeneration: 1,
      cookGeneration: 1,
    },
    derivedInterface: { layoutIdentity: 'sha256:layout' },
  },
};

describe('cooked material schema', () => {
  it('requires material-cook/3 identity and derived interface association', () => {
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../schema/material-cook.schema.json', import.meta.url)),
        'utf8',
      ),
    ) as {
      properties: Record<
        string,
        { const?: string; required?: string[]; properties?: Record<string, unknown> }
      >;
      required: string[];
    };
    expect(schema.properties.schemaVersion?.const).toBe('material-cook/3');
    expect(schema.properties.receipt?.required).toEqual(
      expect.arrayContaining(['identity', 'derivedInterface']),
    );
    expect(schema.properties.receipt?.properties?.derivedInterface).toBeDefined();
  });

  it('defines the v3 identity, provenance, and generation contract', () => {
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../schema/material-cook.schema.json', import.meta.url)),
        'utf8',
      ),
    ) as {
      properties: Record<
        string,
        { const?: string; required?: string[]; properties?: Record<string, unknown> }
      >;
    };
    expect(schema.properties.schemaVersion?.const).toBe('material-cook/3');
    expect(schema.properties.receipt?.properties?.identity).toMatchObject({
      type: 'object',
      required: expect.arrayContaining([
        'materialContractDigest',
        'sourceRevision',
        'sourceClosureDigest',
        'layoutIdentity',
        'programIdentity',
        'pipelineIdentity',
        'materialPublicationIdentity',
        'cookIdentity',
        'compilerFingerprint',
        'wasm',
        'artifactDigest',
        'valueGeneration',
        'dependencyGeneration',
        'cookGeneration',
      ]),
    });
    expect(schema.properties.receipt?.required).toEqual(
      expect.arrayContaining(['identity', 'derivedInterface']),
    );
  });

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
      validateCookedMaterialRecord({ ...record, schemaVersion: 'material-cook/1' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'material-cook-record-invalid' },
    });
  });
});
