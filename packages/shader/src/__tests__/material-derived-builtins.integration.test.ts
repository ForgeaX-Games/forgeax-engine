import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STANDARD_PBR_PARAM_SCHEMA } from '../material-schemas.js';

describe('material derived built-in integration contract', () => {
  it('uses the same derived identity for standard and skinned standard schemas', () => {
    const standard = derive(DEFAULT_STANDARD_PBR_PARAM_SCHEMA);
    const skinned = derive(DEFAULT_STANDARD_PBR_PARAM_SCHEMA);
    expect(skinned.layoutIdentity).toBe(standard.layoutIdentity);
    expect(skinned.totalBytes).toBe(standard.totalBytes);
  });

  it('includes a coordinate member pair for every built-in texture binding', () => {
    const derived = derive(DEFAULT_STANDARD_PBR_PARAM_SCHEMA);
    const textureNames = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter(
      (entry) => entry.type === 'texture2d',
    ).map((entry) => entry.name);
    expect(derived.coordinateRecords.map((record) => record.parameter)).toEqual(textureNames);
    expect(
      derived.coordinateRecords.every((record) =>
        record.transformMember.endsWith('CoordinatesTransform'),
      ),
    ).toBe(true);
    expect(
      derived.coordinateRecords.every((record) =>
        record.metadataMember.endsWith('CoordinatesMetadata'),
      ),
    ).toBe(true);
  });
});
