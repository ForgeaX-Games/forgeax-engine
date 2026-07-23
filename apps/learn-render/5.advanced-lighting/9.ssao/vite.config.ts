import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { withRhiDebug } from '../../../shared/src/rhi-debug-vite-preset';

// RHI-debug frame capture wired via the shared preset (forgeaxShader +
// vitePluginRhiDebug + fs.allow). The demo's LearnOpenGL objects (backpack.gltf
// + textures) are served via pluginPack with its gltf/image importers, passed
// through extraPlugins so the preset still owns the shader + capture plugins.
// Capture stays gated behind FORGEAX_ENGINE_RHI_DEBUG=1.
const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');

export default withRhiDebug({
  here,
  rootDepth: 4,
  port: 5180,
  keepBinExternal: true,
  extraPlugins: [
    pluginPack({
      refresh: reloadAssetHost(),
      roots: [resolve(monorepoRoot, 'forgeax-engine-assets', 'learn-opengl', 'objects')],
      importers: [imageImporter, gltfImporter],
    }),
  ],
});
