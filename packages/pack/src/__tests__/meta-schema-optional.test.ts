import { describe, expect, it } from 'vitest';
import { validateMeta } from '../schema-compiled.js';

describe('meta.schema.json source optional (w8 / AC-4)', () => {
  const minimalMeta = {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    importSettings: {},
    subAssets: [{ guid: '00000000-0000-4000-8000-000000000001', sourceIndex: 0, kind: 'image' }],
  };

  it('meta without source key passes ajv validation (AC-4)', () => {
    const valid = validateMeta(minimalMeta);
    expect(valid).toBe(true);
  });

  it('meta with explicit source passes ajv validation (AC-1 back-compat)', () => {
    const metaWithSource = { ...minimalMeta, source: 'foo.png' };
    const valid = validateMeta(metaWithSource);
    expect(valid).toBe(true);
  });

  it('meta missing required field importer fails validation', () => {
    const { importer: _, ...withoutImporter } = minimalMeta;
    const valid = validateMeta(withoutImporter);
    expect(valid).toBe(false);
  });

  it('ajv reinstantiation idempotent — same validator returns same result', () => {
    const valid1 = validateMeta(minimalMeta);
    const valid2 = validateMeta(minimalMeta);
    expect(valid1).toBe(valid2);
  });
});
