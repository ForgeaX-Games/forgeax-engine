import { describe, expect, it } from 'vitest';
import { createUiLoader } from '../loader.js';

describe('ui loader errors', () => {
  it('rejects malformed payload with a closed, recoverable error', () => {
    const result = createUiLoader().load({ guid: '', html: 1, css: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-asset');
      expect(result.error.expected).toBeTruthy();
      expect(result.error.hint).toBeTruthy();
      expect(result.error.detail).toBeTruthy();
    }
  });
  it('loads a valid payload without requiring a DOM', () => {
    const result = createUiLoader().load({ guid: 'a', html: '<div/>', css: '' });
    expect(result.ok).toBe(true);
  });
});
