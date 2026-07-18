import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

// hello-audio vite config (feat-20260529-hello-audio-demo-with-spacebar-one-shot-sfx-playba).
//
// Two-plugin stack mirrors the hello-sprite shape:
//   - forgeaxShader -- compile the engine shader manifest (build-time naga_oil
//     composer; same registration path as every other demo).
//   - pluginPack    -- emit /pack-index.json (dev configureServer +
//     build generateBundle) so the sfx GUID resolves via the pack pipeline.
//
// D-7: pluginPack roots points at the forgeax-engine-assets/sfx/ submodule
// directory (single source of truth; no audio copy inside the demo). Users
// that clone without --recurse-submodules will see a silent demo -- the
// README documents this explicitly (charter P3 explicit failure).
//
// Dev port 5195 is reserved for this app (5193 = hello-sprite, 5194 =
// hello-physics, 5199 = hello-picking).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const sfxDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'sfx');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({ roots: [sfxDir] }),
  ],
  server: {
    port: 5195,
    strictPort: true,
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: (filePath: string): boolean | undefined =>
      filePath.endsWith('.bin') ? false : undefined,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
    ],
  },
});
