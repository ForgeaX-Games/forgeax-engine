import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { capstoneContentImporter } from './src/reimport';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const sfxRoot = resolve(repoRoot, 'forgeax-engine-assets', 'sfx');
const localAssets = resolve(here, 'assets');

export default defineConfig({
  plugins: [
    vitePluginRhiDebug(),
    forgeaxShader({ materialPackages: [resolve(here, 'src/pulse-material.pack.json')] }) as never,
    pluginPack({ roots: [sfxRoot, localAssets], importers: [audioImporter, capstoneContentImporter()], refresh: reloadAssetHost() }),
  ],
  server: {
    port: 5208,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: (filePath: string): boolean | undefined => filePath.endsWith('.bin') ? false : undefined,
    rollupOptions: { input: { main: resolve(here, 'index.html') } },
  },
});
