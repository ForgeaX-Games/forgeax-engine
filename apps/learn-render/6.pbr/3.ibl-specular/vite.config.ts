import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

// learn-render section-6.pbr 3.ibl-specular vite config.
// 6.3 ibl-specular covers the split-sum (diffuse + specular prefilter +
// BRDF LUT) full chain of LearnOpenGL section-6 PBR IBL chapter. Same
// vendor newport_loft.hdr Skylight input + pluginPack wiring as the
// sibling 2.ibl-irradiance config; see that file's header for the
// rationale (charter P5 consistent abstraction).

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..', '..');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      roots: [resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures')],
    }),
  ],
  server: {
    port: 5197,
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
