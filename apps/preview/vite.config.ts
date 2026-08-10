import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { gltfImporter } from '@forgeax/engine-gltf';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { defineConfig } from 'vite';
import { targetProfileImporter } from '../../templates/game-default/assets/plugins/target-profile-importer';
import { createParticleCodeNativeCooker } from '@forgeax/engine-vfx-compiler';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..');
const templatesDir = resolve(monorepoRoot, 'templates');
const templateAssetRoot = resolve(templatesDir, 'game-default', 'assets');
const vfxModules = Object.fromEntries(
  ['hit.vfx.wgsl', 'charge.vfx.wgsl'].map((name) => [
    name,
    { entry: readFileSync(resolve(templateAssetRoot, name), 'utf8') },
  ]),
);
// Keep the authored WGSL tree under assets/ so the template has one visible
// content root, but do not hand build-only shader sidecars to vite-plugin-pack.
// Pack is a runtime catalog; forgeaxShader owns WGSL compilation and manifest
// publication. Explicit file roots make that boundary executable instead of
// relying on a directory-name convention.
const templatePackRoots = [
  'animated-target-material.pack.json',
  'base-material.pack.json',
  'charge-vfx-effect.pack.json',
  'hit-flash-material.pack.json',
  'hit-vfx-effect.pack.json',
  'hit-vfx-materials.pack.json',
  'multi-material-target.pack.json',
  'scene.pack.json',
  'target-profile.json.meta.json',
  'ui/hud.pack.json',
  'ui/settings.pack.json',
].map((relativePath) => resolve(templateAssetRoot, relativePath));
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
const submoduleJpegMetaPath = resolve(
  monorepoRoot,
  'forgeax-engine-assets',
  'demo-assets',
  'hello-sprite',
  'wood-container.jpg.meta.json',
);
const submoduleSfxDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'sfx');
const submoduleBgmMetaPath = resolve(monorepoRoot, 'forgeax-engine-assets', 'collectathon-audio', 'bgm-loop.wav.meta.json');
const submoduleFbxDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'vendor', 'fbx-test');
const submoduleGlbDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'khronos-gltf-samples', 'BoxTextured');
const submoduleDejavuFontMetaPath = resolve(
  monorepoRoot,
  'forgeax-engine-assets',
  'dejavu-fonts',
  'DejaVuSansMono.ttf.meta.json',
);
const submoduleDejavuLegacyAtlasMetaPath = resolve(
  monorepoRoot,
  'forgeax-engine-assets',
  'dejavu-fonts',
  'DejaVuSansMono.atlas.png.meta.json',
);
const submoduleDejavuLegacyPackPath = resolve(
  monorepoRoot,
  'forgeax-engine-assets',
  'dejavu-fonts',
  'DejaVuSansMono.font.pack.json',
);
const submoduleVideoDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'demo-assets', 'hello-video-cutscene');
const submoduleSpriteAtlasDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'demo-assets', 'hello-sprite-atlas');

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
      runtimeBinding: createStandaloneRuntimeAssetBinding('preview'),
      refresh: reloadAssetHost(),
      roots: [
        // game-default/assets/ holds the entry SceneAsset, material/VFX packs,
        // and target-profile sidecar. WGSL stays beside them in
        // game-default/assets/shaders but is intentionally build-only.
        ...templatePackRoots,
        submoduleSkyMetaPath,
        submoduleJpegMetaPath,
        submoduleSfxDir,
        submoduleBgmMetaPath,
        submoduleFbxDir,
        submoduleGlbDir,
        submoduleDejavuFontMetaPath,
        submoduleDejavuLegacyAtlasMetaPath,
        submoduleDejavuLegacyPackPath,
        submoduleSpriteAtlasDir,
      ],
      importers: [audioImporter, imageImporter, fbxImporter, gltfImporter, fontImporter, targetProfileImporter()],
      cookers: [createParticleCodeNativeCooker(vfxModules)],
    }) as never,
  ],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  // VideoAsset is intentionally a runtime-only URL descriptor. Serve the
  // licensed WebM from the asset submodule without inventing a Pack importer.
  publicDir: submoduleVideoDir,
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
}));
