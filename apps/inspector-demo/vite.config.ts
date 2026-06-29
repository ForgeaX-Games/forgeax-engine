import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..');

// inspector-demo vite config — mirror of hello-cube vite.config.ts shape
// (feat-20260511-inspector-p0-spike T-14 + charter proposition 5 consistent
// abstraction). The forgeaxShader plugin is injected so the production app
// exercises the same shader-pipeline path as hello-triangle / hello-cube.
//
// build.rollupOptions.input is single-entry (main: index.html); the engine
// internally consumes the manifest produced by the plugin via
// Renderer.ready -> shader.loadManifest. inspector-demo does not own a
// separate .wgsl source — the forgeaxShader plugin auto-emits a
// manifest.json with pbr/unlit entries via @forgeax/engine-vite-plugin-shader
// (feat-20260518-pbr-direct-lighting-mvp M5 / w22.8). The inspector entry
// point is `engine.startConsole({ port: 5732 })` invoked from src/main.ts
// (charter proposition 4 explicit opt-in).
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
