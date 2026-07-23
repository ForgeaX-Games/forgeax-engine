import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fbxImporter } from '@forgeax/engine-fbx';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

// collectathon vite config: 3D third-person collectathon showcase.
//
// pluginPack roots: M2 adds the humanoid.fbx fixture directory (the player
// skinned mesh, reused from apps/hello/fbx-skin per D-3). M5 adds the sky.hdr
// directory (IBL, demo-assets/template-game-default) + the collectathon-audio
// directory (footstep/pickup/guardian/BGM cues). monorepoRoot is 2 levels up
// (apps/collectathon -> monorepo root), same depth as apps/tetris, NOT the
// 3-level hello path.

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      refresh: reloadAssetHost(),
      roots: [
        resolve(monorepoRoot, 'forgeax-engine-assets/vendor/fbx-test'),
        resolve(monorepoRoot, 'forgeax-engine-assets/demo-assets/template-game-default'),
        resolve(monorepoRoot, 'forgeax-engine-assets/collectathon-audio'),
        resolve(monorepoRoot, 'forgeax-engine-assets/dejavu-fonts'),
      ],
      importers: [imageImporter, gltfImporter, fbxImporter],
    }),
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
