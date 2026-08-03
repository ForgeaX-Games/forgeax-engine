import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..');
const templatesDir = resolve(monorepoRoot, 'templates');
// Binary demo-assets (sky.hdr, ...) live in the forgeax-engine-assets submodule
// so the engine repo stays binary-free. Select the sky sidecar explicitly;
// the submodule also mirrors the template UI sidecars, which must not be
// scanned twice because GUIDs are globally unique.
const submoduleSkyMetaPath = resolve(
  monorepoRoot,
  'forgeax-engine-assets',
  'demo-assets',
  'template-game-default',
  'sky.hdr.meta.json',
);
const submoduleSfxDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'sfx');
const submoduleBgmMetaPath = resolve(monorepoRoot, 'forgeax-engine-assets', 'collectathon-audio', 'bgm-loop.wav.meta.json');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      refresh: reloadAssetHost(),
      roots: [
        // game-default/assets/ holds the entry SceneAsset (scene.pack.json,
        // GUID-discoverable via forge.json.defaultScene) + material packs;
        // submodule holds binary demo assets.
        resolve(templatesDir, 'game-default/assets'),
        submoduleSkyMetaPath,
        submoduleSfxDir,
        submoduleBgmMetaPath,
      ],
      importers: [audioImporter, imageImporter],
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
