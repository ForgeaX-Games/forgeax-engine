import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import {
  createParticleEffectNativeCooker,
  createStockParticleOperatorRegistry,
} from '@forgeax/engine-vfx-compiler';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      roots: [resolve(here, 'assets')],
      cookers: [createParticleEffectNativeCooker(createStockParticleOperatorRegistry())],
      refresh: reloadAssetHost(),
    }),
  ],
  server: {
    fs: { allow: [monorepoRoot] },
  },
  build: {
    target: 'esnext',
    rollupOptions: { input: { main: resolve(here, 'index.html') } },
  },
});
