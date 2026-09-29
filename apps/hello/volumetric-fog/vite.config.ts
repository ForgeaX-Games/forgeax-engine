import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { volumetricDensityImporter } from './src/volumetric-density-importer';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-volumetric-fog');

export default defineConfig({
  plugins: [
    forgeaxShader({ engineEntries: { pointShadows: true } }) as never,
    pluginPack({
      runtimeBinding,
      roots: [
        resolve(here, 'assets'),
        resolve(monorepoRoot, 'forgeax-engine-assets/threejs/webgpu-volume-lighting'),
      ],
      importers: [volumetricDensityImporter(), imageImporter],
      refresh: reloadAssetHost(),
    }),
  ],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext' },
});
