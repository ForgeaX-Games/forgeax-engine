import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// parity-urp-vs-hdrp vite config (feat-20260608-cluster-lighting M7 / w26).
// Single page hosting two canvases: left URP (default), right HDRP (installPipeline).
// Preview port 4175 + strictPort=true: scripts/bench/pixel-parity.mjs spawns
// this preview alongside parity-forgeax (port 4174) for the urp-vs-hdrp target.
export default defineConfig({
  plugins: [forgeaxShader() as never],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  preview: {
    port: 4175,
    strictPort: true,
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
