import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fbxImporter } from '@forgeax/engine-fbx';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

// hello-fbx-skin vite config (feat-20260615-fbx-importer-via-sdk M5 t51).
//
// pluginPack scans forgeax-engine-assets/vendor/fbx-test for humanoid.fbx +
// humanoid.fbx.meta.json, dispatching to fbxImporter at build time. The runtime
// resolves the GUIDs at registry time via configurePackIndex('/pack-index.json')
// + loadByGuid<SceneAsset>(sceneGuid) + sceneInstances.instantiate x 3 with
// per-instance AnimationPlayer for pose-distinct rendering.
//
// The .fbx fixture lives in the forgeax-engine-assets submodule per the
// engine repo's zero-binary invariant.

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      roots: [resolve(monorepoRoot, 'forgeax-engine-assets/vendor/fbx-test')],
      importers: [fbxImporter],
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
