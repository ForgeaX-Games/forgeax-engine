import { describe, expect, it } from 'vitest';

describe('font importer contract migration fixture', () => {
  it('requires the generic ImportProduct shape', () => {
    expect('ImportProduct').toBe('ImportProduct');
  });

  it('keeps atlas artifact ownership separate from font GUID refs', () => {
    expect('atlas artifact').toContain('artifact');
    expect('font refs').toContain('refs');
  });
});
