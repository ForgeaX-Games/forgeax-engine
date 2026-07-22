import { describe, expect, it } from 'vitest';
import { rewriteUiSourceTokens } from '../ui-artifact-finalizer.js';

describe('UI token source ranges', () => {
  it('rewrites repeated, escaped, and fragment-bearing references independently', () => {
    const result = rewriteUiSourceTokens(
      'a ui-token:hero.png#top b ui-token:hero.png#top c',
      new Map([['hero.png#top', '/assets/hero-hash.png']]),
    );
    expect(result).toEqual({
      ok: true,
      value: 'a /assets/hero-hash.png b /assets/hero-hash.png c',
    });
  });

  it('accepts empty CSS without serializing the source document', () => {
    expect(rewriteUiSourceTokens('', new Map())).toEqual({ ok: true, value: '' });
  });
});
