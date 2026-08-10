import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STANDARD_PBR_PARAM_SCHEMA } from '../material-schemas.js';

const alphaSchema = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../apps/parity/color-lighting/schemas/material-alpha.schema.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as object;
const validateAlpha = new Ajv2020({ allErrors: true, strict: false }).compile(alphaSchema);

describe('standard PBR material alpha contract', () => {
  it('owns RGBA and factor-times-texture alpha in the baseColor schema', () => {
    const baseColor = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.find((entry) => entry.name === 'baseColor');
    const alphaCutoff = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.find(
      (entry) => entry.name === 'alphaCutoff',
    );

    expect(baseColor).toMatchObject({
      name: 'baseColor',
      type: 'color',
      default: [1, 1, 1, 1],
    });
    expect(alphaCutoff).toMatchObject({ name: 'alphaCutoff', type: 'f32' });
    expect(DEFAULT_STANDARD_PBR_PARAM_SCHEMA.map((entry) => entry.name)).not.toContain(
      'baseColorAlpha',
    );
    expect(DEFAULT_STANDARD_PBR_PARAM_SCHEMA.map((entry) => entry.name)).not.toContain(
      'textureAlphaFactor',
    );
  });

  it.each([
    ['short RGBA', { baseColor: [1, 1, 1], alphaMode: 'MASK' }],
    ['unknown alpha mode', { baseColor: [1, 1, 1, 1], alphaMode: 'DITHER' }],
    ['negative cutoff', { baseColor: [1, 1, 1, 1], alphaMode: 'MASK', alphaCutoff: -0.1 }],
  ])('rejects %s before GPU execution', (_name, value) => {
    expect(validateAlpha(value)).toBe(false);
  });

  it('keeps the glTF MASK default cutoff explicit in the schema', () => {
    const properties = alphaSchema as {
      readonly properties?: {
        readonly alphaCutoff?: { readonly default?: number };
      };
    };
    expect(properties.properties?.alphaCutoff?.default).toBe(0.5);
    expect(validateAlpha({ baseColor: [1, 1, 1, 0.5], alphaMode: 'MASK' })).toBe(true);
  });
});
