import { readFileSync } from 'node:fs';

import { SIMULATION_COMPARISON_DOMAINS } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';

import {
  SIMULATION_INSPECTION_ERROR_FIELDS,
  SIMULATION_INSPECTION_MANIFEST_VERSION,
  SIMULATION_INSPECTION_RECORD_OWNER,
  SIMULATION_INSPECTION_SCHEMA_OWNER,
  type SimulationInspectionManifest,
  validateSimulationInspectionManifest,
} from '../simulation-manifest';

const validManifest: SimulationInspectionManifest = {
  formatVersion: 1,
  recordOwner: SIMULATION_INSPECTION_RECORD_OWNER,
  schemaOwner: SIMULATION_INSPECTION_SCHEMA_OWNER,
  baselineFingerprint: 'simulation-v1:manifest',
  participants: [
    {
      id: 'forgeax.physics.rapier-3d',
      version: '1',
      schemaFingerprint: 'rapier-3d-simulation-v1',
      ready: true,
    },
  ],
  errors: {
    codes: ['simulation-participant-missing'],
    fields: SIMULATION_INSPECTION_ERROR_FIELDS,
  },
  trace: { recordTick: 0, sampleCount: 0 },
  report: {
    verdict: 'match',
    domains: SIMULATION_COMPARISON_DOMAINS,
    tolerance: { required: true, fields: {} },
    entries: [],
  },
};

describe('simulation inspection manifest contract', () => {
  it('accepts the versioned participant/error/report/tolerance shape', () => {
    expect(SIMULATION_INSPECTION_MANIFEST_VERSION).toBe(1);
    expect(validateSimulationInspectionManifest(validManifest)).toMatchObject({ ok: true });
  });

  it('rejects missing required paths with machine-readable detail', () => {
    for (const path of ['formatVersion', 'participants', 'errors', 'trace', 'report']) {
      const candidate = { ...validManifest } as Record<string, unknown>;
      delete candidate[path];
      const result = validateSimulationInspectionManifest(candidate);
      expect(result).toMatchObject({ ok: false, error: { code: 'simulation-manifest-invalid' } });
      if (!result.ok) expect(result.error.detail.path).toBe(path);
    }
  });

  it('rejects incompatible versions and invalid tolerance declarations', () => {
    const wrongVersion = validateSimulationInspectionManifest({
      ...validManifest,
      formatVersion: 2,
    });
    expect(wrongVersion).toMatchObject({
      ok: false,
      error: { code: 'simulation-manifest-invalid', detail: { path: 'formatVersion' } },
    });

    const invalidTolerance = validateSimulationInspectionManifest({
      ...validManifest,
      report: { ...validManifest.report, tolerance: { required: true, fields: { speed: -1 } } },
    });
    expect(invalidTolerance).toMatchObject({
      ok: false,
      error: {
        code: 'simulation-manifest-invalid',
        detail: { path: 'report.tolerance.fields.speed' },
      },
    });
  });

  it('keeps the machine schema aligned with the public contract constants', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../../schema/simulation-inspection.schema.json', import.meta.url),
        'utf8',
      ),
    ) as {
      required: readonly string[];
      properties: {
        formatVersion: { const: number };
        errors: { properties: { fields: { const: readonly string[] } } };
        report: { properties: { domains: { items: { enum: readonly string[] } } } };
      };
    };
    expect(schema.properties.formatVersion.const).toBe(SIMULATION_INSPECTION_MANIFEST_VERSION);
    expect(schema.properties.errors.properties.fields.const).toEqual(
      SIMULATION_INSPECTION_ERROR_FIELDS,
    );
    expect(schema.properties.report.properties.domains.items.enum).toEqual(
      SIMULATION_COMPARISON_DOMAINS,
    );
    expect(schema.required).toContain('baselineFingerprint');
  });
});
