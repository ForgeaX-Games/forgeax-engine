import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../shared/src/optional-asset-pack.js';

// hello-skin vite config (tweak-20260611-skin-fox-3clip-and-kb-sample-assets M6).
//
// pluginPack scans forgeax-engine-assets/khronos-gltf-samples/Fox so the
// build-time gltfImporter emits all 8 sub-asset PODs (mesh + material +
// scene + texture + skeleton + skin + 3 animation-clip) declared in
// Fox.glb.meta.json. The runtime resolves them at registry time via
// configureRuntimeAssetCatalog(assets, runtimeBinding) + loadByGuid<SceneAsset>(sceneGuid).
//
// forgeaxShader emits manifest.json with default-standard-pbr +
// default-standard-pbr-skin entries; the engine registers the skin variant
// at boot so any node carrying Skin renders through the skinned PBR pipeline.

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const assetRoots = [resolve(monorepoRoot, 'forgeax-engine-assets/khronos-gltf-samples/Fox')];
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-skin');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({
        runtimeBinding,
        producerReadiness: 'on-demand',
        refresh: reloadAssetHost(),
        roots: assetRoots,
        importers: [imageImporter, gltfImporter],
      }),
    ),
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
