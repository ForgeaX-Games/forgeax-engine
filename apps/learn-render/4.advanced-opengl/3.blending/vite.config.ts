import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('learn-render-4-3-blending');
const learnOpenGlTexturesRoot = resolve(monorepoRoot, 'forgeax-engine-assets', 'learn-opengl', 'textures');
const learnOpenGlTextureRoots = [
  resolve(learnOpenGlTexturesRoot, 'metal.png.meta.json'),
  resolve(learnOpenGlTexturesRoot, 'marble.jpg.meta.json'),
  resolve(learnOpenGlTexturesRoot, 'grass.png.meta.json'),
  resolve(learnOpenGlTexturesRoot, 'window.png.meta.json'),
];

export default defineConfig({
  plugins: [
    forgeaxShader({ materialPackages: [resolve(here, 'src/alpha-test.pack.json')] }) as never,
    pluginPack({
      runtimeBinding,
      refresh: reloadAssetHost(),
      importers: [imageImporter],
      roots: learnOpenGlTextureRoots,
    }),
  ],
  server: {
    port: 5176,
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
