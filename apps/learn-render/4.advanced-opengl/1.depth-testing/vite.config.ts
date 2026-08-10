import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { withRhiDebug } from '../../../shared/src/rhi-debug-vite-preset';

// RHI-debug frame capture wired via the shared preset (forgeaxShader +
// vitePluginRhiDebug + fs.allow). The demo's textures/meshes are served via
// pluginPack, passed through extraPlugins so the preset still owns the shader +
// capture plugins. Capture stays gated behind FORGEAX_ENGINE_RHI_DEBUG=1.
const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('learn-render-4-1-depth-testing');

export default withRhiDebug({
  here,
  rootDepth: 4,
  port: 5174,
  materialPackages: [resolve(here, 'src/depth-viz.pack.json')],
  extraPlugins: [
    pluginPack({
      runtimeBinding,
      refresh: reloadAssetHost(),
      importers: [imageImporter],
      roots: [
        resolve(monorepoRoot, 'forgeax-engine-assets', 'learn-opengl', 'textures'),
        resolve(monorepoRoot, 'forgeax-engine-assets', 'learn-opengl', 'meshes'),
      ],
    }),
  ],
});
