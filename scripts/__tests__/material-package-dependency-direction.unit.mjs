import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifestUrl = new URL('../../packages/vite-plugin-pack/package.json', import.meta.url);
const tsconfigUrl = new URL('../../packages/vite-plugin-pack/tsconfig.json', import.meta.url);

test('material package dependency direction', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const tsconfig = JSON.parse(await readFile(tsconfigUrl, 'utf8'));
  const source = await readFile(
    new URL('../../packages/vite-plugin-pack/src/index.ts', import.meta.url),
    'utf8',
  );

  assert.ok(manifest.dependencies['@forgeax/engine-shader-compiler']);
  assert.ok(tsconfig.references.some((reference) => reference.path === '../shader-compiler'));
  assert.doesNotMatch(source, /@forgeax\/engine-(assets-runtime|render)/);
});
