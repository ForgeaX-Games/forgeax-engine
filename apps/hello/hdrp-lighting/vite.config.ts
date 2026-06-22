import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// hello-hdrp-lighting vite config (feat-20260608-cluster-lighting M7 / w25).
// Mirrors apps/hello/bloom/vite.config.ts shape — the forgeaxShader plugin
// emits the engine shader manifest containing pbr/unlit/skybox + the M4 HDRP
// cluster-forward shader (forgeax::hdrp-cluster-forward) so installPipeline
// resolves a real RenderPipelineAsset on first ready().
export default defineConfig({
  plugins: [forgeaxShader() as never],
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
