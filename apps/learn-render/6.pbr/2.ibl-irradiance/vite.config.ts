import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { withRhiDebug } from '../../../shared/src/rhi-debug-vite-preset';

// RHI-debug frame capture wired via the shared preset. The Skylight equirect HDR
// (vendor newport_loft.hdr, GUID 019e4a26-3c29-7420-af5d-20f2724a16b0) is served
// via pluginPack scanning the vendor textures dir, passed through extraPlugins so
// the shared preset still owns forgeaxShader + vitePluginRhiDebug + fs.allow.
const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');

export default withRhiDebug({
  here,
  rootDepth: 4,
  port: 5196,
  extraPlugins: [
    pluginPack({
      roots: [resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures')],
      importers: [imageImporter],
    }),
  ],
});
