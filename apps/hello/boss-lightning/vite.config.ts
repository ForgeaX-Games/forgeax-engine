import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-boss-lightning');
export default defineConfig({
  plugins: [
    forgeaxShader({
      materialPackages: [
        resolve(here, 'assets/arc-nova-sigil.shader.pack.json'),
        resolve(here, 'assets/arc-nova-violet-sigil.shader.pack.json'),
        resolve(here, 'assets/arc-nova-shard.shader.pack.json'),
        resolve(here, 'assets/arc-nova-ember-shard.shader.pack.json'),
      ],
    }) as never,
    pluginPack({
      roots: [resolve(here, 'assets')],
      cookers: [createParticleCodeNativeCookerFromRoots([resolve(here, 'assets')])],
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
