import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
// 3.3.csm sits 4 levels below the repo root
// (apps / learn-render / 5.advanced-lighting / 3.3.csm); D3 (3.1.shadow-mapping/
// 3.full) is one deeper, hence its config uses 5x '..'. Scaffolding this demo
// from D3 copied the 5x depth and overshot to .worktrees/, yielding an empty
// pack-index (assets 404). Browser smoke caught it; dawn smoke catalogs the
// texture directly and never hit the pack path.
const monorepoRoot = resolve(here, '..', '..', '..', '..');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      roots: [
        resolve(monorepoRoot, 'forgeax-engine-assets', 'learn-opengl', 'textures'),
      ],
    }),
  ],
  server: {
    port: 5201,
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
