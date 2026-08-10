import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// hello-custom-shader vite config: compile the shader and serve the authored
// pack through the same catalog path used by a shipped app.
export default defineConfig({
  plugins: [
    forgeaxShader({ materialPackages: [resolve(here, 'src/pulse-material.shader.pack.json')] }) as never,
    pluginPack({
      runtimeBinding: createStandaloneRuntimeAssetBinding('hello-custom-shader'),
      roots: [resolve(here, 'assets')],
    }) as never,
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
