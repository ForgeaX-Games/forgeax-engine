import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import type { PluginPack } from '@forgeax/engine-vite-plugin-pack';
import { build } from 'vite';
import { afterEach, expect, it } from 'vitest';
import { discoverPluginAssets } from '../plugin-assets.js';
import { pluginProgramsBuild } from '../plugin-programs.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function playerBuild(source: string) {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-player-boundary-'));
  roots.push(root);
  await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(
    resolve(import.meta.dirname, '../../../../engine'),
    resolve(root, 'node_modules/@forgeax/engine'),
    'dir',
  );
  await writeFile(resolve(root, 'entry.js'), source);
  const inventory = await discoverPluginAssets({ root, assetRoots: [] });
  return build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      pluginProgramsBuild({
        projectRoot: root,
        roots: {},
        inventory: async () => inventory,
        binding: createStandaloneRuntimeAssetBinding('test'),
        // No virtual program module is requested: the production bundle guard
        // must still validate the page and Worker graph it is attached to.
        pack: {} as PluginPack,
      }),
    ],
    build: { write: false, minify: false, target: 'esnext', rollupOptions: { input: 'entry.js' } },
  });
}

it('delivers the browser runtime producer through the existing player bundle guard', async () => {
  const output = await playerBuild(
    "import { RuntimePackProducer } from '@forgeax/engine/import'; globalThis.Producer = RuntimePackProducer;",
  );
  if (Array.isArray(output) || !('output' in output)) throw new Error('missing bundle');
  const chunks = output.output.flatMap((item) => (item.type === 'chunk' ? [item] : []));
  expect(chunks.some((chunk) => chunk.code.includes('RuntimePackProducer'))).toBe(true);
  expect(chunks.flatMap((chunk) => Object.keys(chunk.modules))).toContainEqual(
    expect.stringContaining('/import/dist/browser.mjs'),
  );
});

it('rejects a Node import even when Vite has replaced it with a browser stub', async () => {
  await expect(
    playerBuild("import fs from 'node:fs'; globalThis.read = () => fs.readFileSync('asset');"),
  ).rejects.toThrow(/Node dependency/);
});
