import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { withRhiDebug } from '../../../shared/src/rhi-debug-vite-preset';

// RHI-debug frame capture wired via the shared preset. Same vendor
// newport_loft.hdr Skylight input + pluginPack wiring as sibling 2.ibl-irradiance;
// pluginPack passed through extraPlugins so the preset owns forgeaxShader +
// vitePluginRhiDebug + fs.allow.
const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('learn-render-6-3-ibl-specular');

export default withRhiDebug({
  here,
  rootDepth: 4,
  port: 5197,
  extraPlugins: [
    pluginPack({
      runtimeBinding,
      refresh: reloadAssetHost(),
      importers: [imageImporter],
      roots: [resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures')],
    }),
  ],
});
