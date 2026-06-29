import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

// video-texture vite config — mirror of hello-room vite.config.ts shape.
// The forgeaxShader plugin injects the build-time shader pipeline so the
// demo exercises the same WGSL path as other hello apps; the engine
// `ShaderRegistry` consumes the manifest entries via Renderer.ready ->
// shader.loadManifest. Single-entry build (index.html) keeps parity with
// hello-room / hello-cube.
//
// The cutscene.webm is host-side DOM (the demo's VideoElementProvider creates
// a <video src="/cutscene.webm">), NOT an engine pack asset. The engine repo
// tracks zero binaries (CI grep:no-binary-assets), so the webm lives in the
// forgeax-engine-assets submodule (demo-assets/hello-video-cutscene/, shared
// with hello-video-cutscene). Pointing vite's static publicDir at that dir
// serves the file at `/cutscene.webm`. Cloning without --recurse-submodules
// leaves the dir absent -> the <video> 404s and no frame decodes (charter P3
// explicit failure, surfaced as VideoUploadUnsupportedError).
const demoAssets = resolve(monorepoRoot, 'forgeax-engine-assets', 'demo-assets', 'hello-video-cutscene');

export default defineConfig({
  publicDir: demoAssets,
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
