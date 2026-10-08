import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publishShaderManifest } from '../manifest-publication.js';
import { loadSharedEngineShaderManifest } from '../shared-engine-inputs.js';

let root: string;
let manifestPath: string;
const wgsl = '// source \u00e9\r\nfn main() {}\n// final bytes  ';
const entries = [{ hash: 'primary', wgsl, bindings: '[]' }];
const materialShaders = [{ identifier: 'material', composedWgsl: wgsl, variants: [] }];

function writePayload(value: unknown): void {
  writeFileSync(join(root, 'shared/shaders.json'), JSON.stringify(value));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shared-publication-loader-'));
  mkdirSync(join(root, 'shared'));
  manifestPath = join(root, 'shared/manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      producer: 'repo-build-inputs',
      inputFingerprint: 'test-source',
      inventory: ['shared/shaders.json'],
      payload: { engineShaderManifest: 'shared/shaders.json' },
    }),
  );
  writePayload(publishShaderManifest(entries, materialShaders));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

it('loads exact shared shader bytes in Node without a browser Crypto global', async () => {
  vi.stubGlobal('crypto', undefined);
  const loaded = await loadSharedEngineShaderManifest(manifestPath);
  expect({ entries: loaded.entries, materialShaders: loaded.materialShaders }).toEqual({
    entries,
    materialShaders,
  });
  expect(loaded.sourceFragments.get(wgsl)?.join('')).toBe(wgsl);
  expect(
    publishShaderManifest(loaded.entries, loaded.materialShaders, loaded.sourceFragments),
  ).toEqual(publishShaderManifest(entries, materialShaders));
});

it('rejects changed source bytes under an unchanged source digest', async () => {
  const publication = publishShaderManifest(entries, materialShaders);
  publication.fragments[0] += ' ';
  writePayload(publication);
  await expect(loadSharedEngineShaderManifest(manifestPath)).rejects.toThrow('digest mismatch');
});

it('rejects unused source digests before accepting the shared publication', async () => {
  const publication = publishShaderManifest(entries, materialShaders);
  publication.sources['0'.repeat(64)] = [0];
  writePayload(publication);
  await expect(loadSharedEngineShaderManifest(manifestPath)).rejects.toThrow('missing or unused');
});

it('retains the producer inventory gate before loading shader rows', async () => {
  rmSync(join(root, 'shared/shaders.json'));
  await expect(loadSharedEngineShaderManifest(manifestPath)).rejects.toThrow(
    'inventory is missing',
  );
});
