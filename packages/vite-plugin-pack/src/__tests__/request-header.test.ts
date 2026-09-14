import { describe, expect, it } from 'vitest';
import { readRequestHeader } from '../dev/request-header.js';

describe('readRequestHeader', () => {
  it('reads a string header value', () => {
    expect(readRequestHeader({ 'x-forgeax-import-mode': 'rebuild' }, 'x-forgeax-import-mode')).toBe('rebuild');
  });

  it('reads the first value when the header is an array', () => {
    expect(readRequestHeader({ 'x-forgeax-import-mode': ['rebuild', 'cold-cook'] }, 'X-Forgeax-Import-Mode')).toBe(
      'rebuild',
    );
  });

  it('accepts immutable and empty header arrays', () => {
    const values: readonly string[] = Object.freeze(['rebuild', 'cold-cook']);
    expect(readRequestHeader({ 'x-mode': values }, 'x-mode')).toBe('rebuild');
    expect(readRequestHeader({ 'x-mode': [] as readonly string[] }, 'x-mode')).toBeUndefined();
  });

  it('returns undefined for missing headers', () => {
    expect(readRequestHeader({}, 'x-forgeax-import-mode')).toBeUndefined();
    expect(readRequestHeader(undefined, 'x-forgeax-import-mode')).toBeUndefined();
  });
});
