import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    vitePluginRhiDebug(),
    pluginPack({
      refresh: reloadAssetHost(),
      roots: [resolve(monorepoRoot, 'forgeax-engine-assets', 'learn-opengl', 'textures')],
    }),
  ],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext', rollupOptions: { input: { main: resolve(here, 'index.html') } } },
});
