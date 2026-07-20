import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

// learn-render section-3.1 model-loading vite config.
// Sponza atrium demo with 4 PointLight + DirectionalLight +
// Skylight IBL. pluginPack scans two roots: khronos-gltf-samples for
// the Sponza glTF + 69 textures, and learn-opengl/textures for the
// newport_loft.hdr Skylight equirect input (CC BY-NC 4.0 carve-out).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      roots: [
        resolve(monorepoRoot, 'forgeax-engine-assets/khronos-gltf-samples/Sponza'),
        resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures'),
      ],
      importers: [imageImporter, gltfImporter],
    }),
  ],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    // The pack plugin emits decoded RGBA .bin assets (~787MB across 200 textures);
    // computing their gzip sizes for the build report is meaningless (binary GPU
    // payloads are never gzip-served) and adds wall time. Skip it.
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
});