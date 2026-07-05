import { describe, expect, it } from 'vitest';
import { fbxErr, FBX_ERROR_HINTS, type FbxErrorCode } from '../src/errors.js';

function exhaustiveSwitch(code: FbxErrorCode): string {
  switch (code) {
    case 'fbx-mesh-type-unsupported':
      return 'mesh-type';
  }
}

describe('FbxErrorCode', () => {
  it('closed union: exhaustive switch compiles without default', () => {
    // If the switch is non-exhaustive, tsc will fail (typecheck enabled).
    expect(exhaustiveSwitch('fbx-mesh-type-unsupported')).toBe('mesh-type');
  });

  it('hint contains actionable guidance', () => {
    const hint = FBX_ERROR_HINTS['fbx-mesh-type-unsupported'];
    expect(hint).toContain('NURBS');
    expect(hint).toContain('polygon mesh');
  });

  it('fbxErr mesh-type-unsupported roundtrip', () => {
    const err = fbxErr('fbx-mesh-type-unsupported', {
      meshType: 'nurbs',
      meshName: 'Sphere001',
    });
    expect(err.code).toBe('fbx-mesh-type-unsupported');
    expect(err.expected).toBeTypeOf('string');
    expect(err.hint).toBeTypeOf('string');
    expect(err.detail.meshType).toBe('nurbs');
    expect(err.detail.meshName).toBe('Sphere001');
  });

  it('FBX_ERROR_HINTS covers all FbxErrorCode members', () => {
    // TypeScript forces the Record key set to match FbxErrorCode.
    // This runtime check catches gaps at test time.
    const codes: FbxErrorCode[] = ['fbx-mesh-type-unsupported'];
    for (const code of codes) {
      expect(FBX_ERROR_HINTS[code]).toBeTypeOf('string');
      expect(FBX_ERROR_HINTS[code].length).toBeGreaterThan(0);
    }
  });
});
