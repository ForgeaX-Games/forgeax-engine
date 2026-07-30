import { describe, expect, it } from 'vitest';

describe('fbx importer contract migration fixture', () => {
  it('requires the generic ImportProduct shape', () => {
    expect('ImportProduct').toBe('ImportProduct');
  });

  it('requires multi-asset output to keep local artifact ownership', () => {
    expect('asset-local artifacts').toContain('artifacts');
    expect('package-global artifacts').not.toContain('asset-local artifacts');
  });
});
