import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { withRhiDebug } from '../../../shared/src/rhi-debug-vite-preset';
import { optionalAssetPack } from '../../../shared/src/optional-asset-pack.js';

// RHI-debug frame capture wired via the shared preset (forgeaxShader +
// vitePluginRhiDebug + fs.allow). The demo's textures/meshes are served via
// pluginPack, passed through extraPlugins so the preset still owns the shader +
// capture plugins. Capture stays gated behind FORGEAX_ENGINE_RHI_DEBUG=1.
const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
const assetRoots = [
  resolve(monorepoRoot, 'forgeax-engine-assets', 'learn-opengl', 'textures'),
  resolve(monorepoRoot, 'forgeax-engine-assets', 'learn-opengl', 'meshes'),
];
const runtimeBinding = createStandaloneRuntimeAssetBinding('learn-render-4-10-anti-aliasing-msaa');

export default withRhiDebug({
  here,
  rootDepth: 4,
  port: 5183,
  extraPlugins: [
    ...optionalAssetPack(assetRoots, () =>
      pluginPack({ runtimeBinding, refresh: reloadAssetHost(), importers: [imageImporter, gltfImporter], roots: assetRoots }),
    ),
  ],
});
