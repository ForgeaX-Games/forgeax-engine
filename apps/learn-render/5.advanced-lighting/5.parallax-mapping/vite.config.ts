import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { withRhiDebug } from '../../../shared/src/rhi-debug-vite-preset';

// RHI-debug frame capture wired via the shared preset (forgeaxShader +
// vitePluginRhiDebug + fs.allow). The demo's LearnOpenGL textures are served via
// pluginPack, passed through extraPlugins so the preset still owns the shader +
// capture plugins. Capture stays gated behind FORGEAX_ENGINE_RHI_DEBUG=1.
const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');

export default withRhiDebug({
  here,
  rootDepth: 4,
  port: 5189,
  keepBinExternal: true,
  extraPlugins: [
    pluginPack({
      roots: [resolve(monorepoRoot, 'forgeax-engine-assets', 'learn-opengl', 'textures')],
    }),
  ],
});
