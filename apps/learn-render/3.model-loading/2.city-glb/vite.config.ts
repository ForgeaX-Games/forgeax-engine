import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

// learn-render city-glb: loads the UE5 city_Sample_512.glb through the
// build-time gltfImporter + vite-plugin-pack pipeline. The glb + its generated
// <source>.meta.json sidecar live in local-assets/ (gitignored) because the
// binary is ~62 MB and decodes to multiple GB of RGBA textures -- worktree-local,
// never committed. Dev on-demand import (POST /__import) avoids up-front decode
// of all 321 textures.

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      refresh: reloadAssetHost(),
      roots: [resolve(here, 'local-assets')],
      importers: [imageImporter, gltfImporter],
    }),
  ],
  server: {
    fs: {
      allow: [monorepoRoot, here],
    },
  },
  build: {
    target: 'esnext',
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
});
