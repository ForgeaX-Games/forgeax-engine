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

  it('returns undefined for missing headers', () => {
    expect(readRequestHeader({}, 'x-forgeax-import-mode')).toBeUndefined();
    expect(readRequestHeader(undefined, 'x-forgeax-import-mode')).toBeUndefined();
  });
});
