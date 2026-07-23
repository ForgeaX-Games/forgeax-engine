import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..');
const templatesDir = resolve(monorepoRoot, 'templates');
// Binary demo-assets (sky.hdr, ...) live in the forgeax-engine-assets submodule
// so the engine repo stays binary-free. pluginPack scans both roots and folds
// them into a single pack-index served at /pack-index.json.
const submoduleDemoAssetsDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'demo-assets');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      refresh: reloadAssetHost(),
      roots: [
        // game-default/assets/ holds the entry SceneAsset (scene.pack.json,
        // GUID-discoverable via forge.json.defaultScene) + material packs;
        // submodule holds binary demo assets.
        resolve(templatesDir, 'game-default'),
        resolve(submoduleDemoAssetsDir, 'template-game-default'),
      ],
    }) as never,
  ],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
});
