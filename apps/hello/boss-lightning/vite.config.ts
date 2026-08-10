import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { createParticleCodeNativeCooker } from '@forgeax/engine-vfx-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-boss-lightning');
const vfxModules = Object.fromEntries(
  ['mouth-charge.vfx.wgsl', 'impact-mesh.vfx.wgsl'].map(name => [
    name,
    { entry: readFileSync(resolve(here, 'assets', name), 'utf8') },
  ]),
);

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      roots: [resolve(here, 'assets')],
      cookers: [createParticleCodeNativeCooker(vfxModules)],
      refresh: reloadAssetHost(),
      runtimeBinding,
    }),
  ],
  server: {
    fs: { allow: [monorepoRoot] },
  },
  build: {
    target: 'esnext',
    rollupOptions: { input: { main: resolve(here, 'index.html') } },
  },
});
