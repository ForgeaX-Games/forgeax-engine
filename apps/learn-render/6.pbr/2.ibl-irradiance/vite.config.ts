import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

// learn-render section-6.pbr 2.ibl-irradiance vite config.
// 6.2 ibl-irradiance covers the diffuse split-sum half of LearnOpenGL
// section-6 PBR IBL chapter. The Skylight equirect HDR input is the
// vendor newport_loft.hdr (CC-BY-NC carve-out in the forgeax-engine-assets
// submodule, GUID 019e4a26-3c29-7420-af5d-20f2724a16b0). pluginPack scans
// the vendor textures dir so /pack-index.json includes the .hdr GUID
// row in both dev (configureServer middleware) and build (generateBundle
// emit) -- charter P4 consistent abstraction.

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      roots: [resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures')],
      importers: [imageImporter],
    }),
  ],
  server: {
    port: 5196,
    strictPort: true,
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
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.browser.test.ts',
      '**/*.dawn.test.ts',
    ],
  },
});
