import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// hello-custom-shader vite config.
//
// The forgeaxShader plugin compiles the user-side pulse-material.wgsl
// at transform time (sidecar pulse-material.wgsl.meta.json with
// subAssets[].kind='material-shader' routes the file through the
// material-shader compose path, AC-09 + plan-strategy D-ImportsMap; M3
// already wired the transform hook to read the sidecar). The composed
// WGSL + paramSchema land in the shader manifest's materialShaders[]
// section, ready for ShaderRegistry.registerMaterialShader at engine
// boot.
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
