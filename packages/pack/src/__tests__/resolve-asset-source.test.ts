// @ts-nocheck — PackErrorDetail is a discriminated union narrowed by runtime .code
// checks; TS cannot follow the narrowing through PackError.detail.
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAssetSource } from '../resolve-asset-source.js';

describe('resolveAssetSource — omit derivation (w4)', () => {
  const metaDir = '/project/assets';

  it('omitted source derives companion file from meta filename (AC-2)', () => {
    const metaPath = resolve(metaDir, 'foo.png.meta.json');
    const result = resolveAssetSource(metaPath, undefined, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(resolve(metaDir, 'foo.png'));
    }
  });

  it('renamed audio meta derives correct companion (AC-3)', () => {
    const metaPath = resolve(metaDir, 'bleep.wav.meta.json');
    const result = resolveAssetSource(metaPath, undefined, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(resolve(metaDir, 'bleep.wav'));
    }
  });

  it('derivation is a single rule: strip .meta.json suffix only', () => {
    const cases = [
      { meta: 'model.glb.meta.json', expected: 'model.glb' },
      { meta: 'sprite.png.meta.json', expected: 'sprite.png' },
      { meta: 'font.ttf.meta.json', expected: 'font.ttf' },
      { meta: 'bgm.mp3.meta.json', expected: 'bgm.mp3' },
    ];
    for (const { meta, expected } of cases) {
      const metaPath = resolve(metaDir, meta);
      const result = resolveAssetSource(metaPath, undefined, {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(resolve(metaDir, expected));
      }
    }
  });
});

describe('resolveAssetSource — @name/ path + boundary + legacy (w5)', () => {
  const metaDir = '/project/assets';
  const metaPath = resolve(metaDir, 'foo.png.meta.json');

  it('resolves @name/rest to absolute path via paths table (AC-5)', () => {
    const paths = { shared: '/lib/assets' };
    const result = resolveAssetSource(metaPath, '@shared/foo.png', paths);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(resolve('/lib/assets', 'foo.png'));
    }
  });

  it('returns pack-unknown-path for undeclared @name (AC-8)', () => {
    const paths = { shared: '/lib/assets' };
    const result = resolveAssetSource(metaPath, '@nope/x.png', paths);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('pack-unknown-path');
      expect(result.error.detail.pathName).toBe('nope');
      expect(result.error.detail.knownNames).toEqual(['shared']);
    }
  });

  it('returns pack-malformed-path-ref for bare @ with no name or rest (AC-9)', () => {
    const result = resolveAssetSource(metaPath, '@', { shared: '/lib/assets' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('pack-malformed-path-ref');
      expect(result.error.detail.rawSource).toBe('@');
      if (result.error.detail.code === 'pack-malformed-path-ref') {
        expect(result.error.detail.reason).toBe('format');
      }
    }
  });

  it('returns pack-malformed-path-ref for @onlyname with no /rest (AC-9)', () => {
    const result = resolveAssetSource(metaPath, '@onlyname', { shared: '/lib/assets' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('pack-malformed-path-ref');
      expect(result.error.detail.rawSource).toBe('@onlyname');
    }
  });

  it('returns pack-malformed-path-ref for ../ escape (AC-11)', () => {
    const paths = { shared: '/data/shared' };
    const result = resolveAssetSource(metaPath, '@shared/../escape.png', paths);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('pack-malformed-path-ref');
      expect(result.error.detail.rawSource).toBe('@shared/../escape.png');
      if (result.error.detail.code === 'pack-malformed-path-ref') {
        expect(result.error.detail.reason).toBe('escape');
      }
    }
  });

  it('resolves legacy relative path unchanged', () => {
    const result = resolveAssetSource(metaPath, 'sub/foo.png', {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(resolve(metaDir, 'sub/foo.png'));
    }
  });

  it('returns pack-unknown-path for @name/ when paths is empty', () => {
    const result = resolveAssetSource(metaPath, '@any/x.png', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('pack-unknown-path');
      expect(result.error.detail.pathName).toBe('any');
      expect(result.error.detail.knownNames).toEqual([]);
    }
  });
});
