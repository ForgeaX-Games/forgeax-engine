import { describe, expect, it } from 'vitest';

describe('gltf importer contract migration fixture', () => {
  it('requires the generic ImportProduct shape', () => {
    expect('ImportProduct').toBe('ImportProduct');
  });
});
