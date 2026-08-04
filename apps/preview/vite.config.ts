import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { gltfImporter } from '@forgeax/engine-gltf';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { defineConfig } from 'vite';
import { generateTemplateAssets } from '../../templates/game-default/assets/generate-assets.mjs';

// The template keeps generated, license-safe PNG sources out of git. Generate
// them before pluginPack scans roots so dev, build, and browser tests share one
// authored sidecar -> importer contract.
generateTemplateAssets();

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..');
const templatesDir = resolve(monorepoRoot, 'templates');
// Binary demo-assets (sky.hdr, ...) live in the forgeax-engine-assets submodule
// so the engine repo stays binary-free. Select the sky sidecar explicitly;
// the submodule also mirrors the template UI sidecars, which must not be
// scanned twice because GUIDs are globally unique.
const submoduleSkyMetaPath = resolve(
  monorepoRoot,
  'forgeax-engine-assets',
  'demo-assets',
  'template-game-default',
  'sky.hdr.meta.json',
);
const submoduleSfxDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'sfx');
const submoduleBgmMetaPath = resolve(monorepoRoot, 'forgeax-engine-assets', 'collectathon-audio', 'bgm-loop.wav.meta.json');
const submoduleFbxDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'vendor', 'fbx-test');
const submoduleGlbDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'khronos-gltf-samples', 'BoxTextured');
const submoduleDejavuFontsDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'dejavu-fonts');

export default defineConfig(({ command }) => ({
  define: command === 'build' ? { 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': JSON.stringify('0') } : undefined,
  plugins: [
    forgeaxShader({
      // game-default custom materials are authored packs: the pack owns the
      // parameter contract, while the WGSL module remains the build-time
      // source. This keeps manifest paramSchema and runtime MaterialAsset in
      // lockstep on WebGPU and the WebGL2 fallback.
      materialPackages: [
        resolve(templatesDir, 'game-default/assets/animated-target-material.pack.json'),
        resolve(templatesDir, 'game-default/assets/hit-flash-material.pack.json'),
      ],
    }) as never,
    // RHI capture is a dev-only inspection front door. Keeping the plugin out
    // of `vite build` makes the production Preview graph free of the recorder,
    // upload route, and debug-only browser chunk.
    ...(command === 'serve' ? [vitePluginRhiDebug()] : []),
    pluginPack({
      refresh: reloadAssetHost(),
      roots: [
        // game-default/assets/ holds the entry SceneAsset (scene.pack.json,
        // GUID-discoverable via forge.json.defaultScene) + material packs;
        // submodule holds binary demo assets.
        resolve(templatesDir, 'game-default/assets'),
        submoduleSkyMetaPath,
        submoduleSfxDir,
        submoduleBgmMetaPath,
        submoduleFbxDir,
        submoduleGlbDir,
        submoduleDejavuFontsDir,
      ],
      importers: [audioImporter, imageImporter, fbxImporter, gltfImporter],
    }) as never,
  ],
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
}));
