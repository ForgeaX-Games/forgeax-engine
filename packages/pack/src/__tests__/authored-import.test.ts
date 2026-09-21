import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateAuthoredImport } from '../authored-import.js';

const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../templates/game-default/assets/multi-material-target.pack.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
describe('authored Pack import contract', () => {
  it('accepts the complete official authored package and preserves identities', () => {
    const pack = fixture();
    const result = validateAuthoredImport(pack);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.assets.map((a) => a.guid)).toEqual(
        pack.assets.map((a: { guid: string }) => a.guid),
      );
  });
  it('rejects missing references and permits a real catalog dependency', () => {
    const pack = fixture();
    const removed = pack.assets.pop();
    expect(validateAuthoredImport(pack).ok).toBe(false);
    expect(validateAuthoredImport(pack, new Set([removed.guid])).ok).toBe(true);
  });
  it('rejects collisions, runtime publications and malformed JSON shapes', () => {
    const pack = fixture();
    pack.assets.push(pack.assets[0]);
    expect(validateAuthoredImport(pack).ok).toBe(false);
    expect(validateAuthoredImport({ ...fixture(), scopeId: 'runtime' }).ok).toBe(false);
    expect(validateAuthoredImport({ assets: [] }).ok).toBe(false);
  });
  it.each([
    '../secret',
    '/tmp/secret',
    'https://host/model',
    '%2e%2e/secret',
    'C:/secret',
  ])('rejects unsafe artifact %s', (path) => {
    const pack = fixture();
    pack.assets[0].artifacts = { geometry: { path, mediaType: 'application/octet-stream' } };
    expect(validateAuthoredImport(pack).ok).toBe(false);
  });
});
