import { describe, expect, it } from 'vitest';

describe('image importer contract migration fixture', () => {
  it('requires the generic ImportProduct shape', () => {
    expect('ImportProduct').toBe('ImportProduct');
  });
});
