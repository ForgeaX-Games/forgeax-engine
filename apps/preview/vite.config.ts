import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { gltfImporter } from '@forgeax/engine-gltf';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { defineConfig } from 'vite';
import { targetProfileImporter } from '../../templates/game-default/assets/plugins/target-profile-importer';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { resolveProjectPort } from '@forgeax/engine-devkit';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..');
const previewPort = resolveProjectPort(undefined);
const templatesDir = resolve(monorepoRoot, 'templates');
const templateAssetRoot = resolve(templatesDir, 'game-default', 'assets');
const isPublicDistribution = existsSync(resolve(monorepoRoot, '.forgeax-public-distribution'));
const publicTemplateResourceRoot = resolve(templateAssetRoot, 'sdk-resources');
const brotatoAssetRoot = resolve(templatesDir, 'game-brotato-3d', 'assets');
const previewUiAuthoringMetaPath = resolve(
  here,
  'assets',
  'ui-authoring',
  'preview-hud.ui.html.meta.json',
);
// Keep the authored WGSL tree under assets/ so the template has one visible
// content root, but do not hand build-only shader sidecars to vite-plugin-pack.
// Pack is a runtime catalog; forgeaxShader owns WGSL compilation and manifest
// publication. Explicit file roots make that boundary executable instead of
// relying on a directory-name convention.
const templatePackRoots = [
  'animated-target-material.pack.json',
  'arc-nova-ember-shard.shader.pack.json',
  'arc-nova-geometry.pack.json',
  'arc-nova-shard.shader.pack.json',
  'arc-nova-sigil.shader.pack.json',
  'arc-nova-violet-sigil.shader.pack.json',
  'base-material.pack.json',
  'boss-lightning-contact.pack.json',
  'boss-lightning-flight.pack.json',
  'boss-lightning-materials.pack.json',
  'boss-lightning-suite.pack.json',
  'boss-lightning-telegraph.pack.json',
  'charge-vfx-effect.pack.json',
  'hit-flash-material.pack.json',
  'hit-vfx-effect.pack.json',
  'hit-vfx-materials.pack.json',
  'multi-material-target.pack.json',
  'resonance-forge.pack.ts',
  'scene.pack.json',
  'target-profile.json.meta.json',
  'ui/hud.pack.json',
  'ui/settings.pack.json',
].map((relativePath) => resolve(templateAssetRoot, relativePath));
const sdkTemplatePackRoots = ['game-empty', 'game-3d'].flatMap((template) => {
  const assetRoot = resolve(templatesDir, template, 'assets');
  return readdirSync(assetRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.pack.ts'))
    .map((entry) => resolve(assetRoot, entry.name))
    .sort();
});
templatePackRoots.push(
  ...sdkTemplatePackRoots,
  resolve(brotatoAssetRoot, 'brotato-3d.pack.ts'),
  resolve(brotatoAssetRoot, 'brotato-impact-vfx.pack.json'),
  resolve(brotatoAssetRoot, 'ui/hud.pack.json'),
);
// Contributor builds read the private asset checkout. Public SDK source builds
// use the exact allowlisted files materialized below templates/game-default.
const skyMetaPath = resolve(
  monorepoRoot,
  ...(isPublicDistribution
    ? ['packages', 'preview', 'assets', 'canonical-kit', 'sky.hdr.meta.json']
    : ['forgeax-engine-assets', 'demo-assets', 'template-game-default', 'sky.hdr.meta.json']),
);
const submoduleJpegMetaPath = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution
    ? ['demo-assets', 'hello-sprite', 'wood-container.jpg.meta.json']
    : ['forgeax-engine-assets', 'demo-assets', 'hello-sprite', 'wood-container.jpg.meta.json']),
);
const submoduleSfxDir = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution ? ['sfx'] : ['forgeax-engine-assets', 'sfx']),
);
const submoduleBgmMetaPath = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution
    ? ['collectathon-audio', 'bgm-loop.wav.meta.json']
    : ['forgeax-engine-assets', 'collectathon-audio', 'bgm-loop.wav.meta.json']),
);
const submoduleFbxDir = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution ? ['vendor', 'fbx-test'] : ['forgeax-engine-assets', 'vendor', 'fbx-test']),
);
const submoduleGlbDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'khronos-gltf-samples', 'BoxTextured');
const submoduleDejavuFontMetaPath = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution
    ? ['dejavu-fonts', 'DejaVuSansMono.ttf.meta.json']
    : ['forgeax-engine-assets', 'dejavu-fonts', 'DejaVuSansMono.ttf.meta.json']),
);
const submoduleDejavuLegacyAtlasMetaPath = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution
    ? ['dejavu-fonts', 'DejaVuSansMono.atlas.png.meta.json']
    : ['forgeax-engine-assets', 'dejavu-fonts', 'DejaVuSansMono.atlas.png.meta.json']),
);
const submoduleDejavuLegacyPackPath = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution
    ? ['dejavu-fonts', 'DejaVuSansMono.font.pack.json']
    : ['forgeax-engine-assets', 'dejavu-fonts', 'DejaVuSansMono.font.pack.json']),
);
const submoduleVideoDir = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution
    ? ['demo-assets', 'hello-video-cutscene']
    : ['forgeax-engine-assets', 'demo-assets', 'hello-video-cutscene']),
);
const submoduleSpriteAtlasDir = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution
    ? ['demo-assets', 'hello-sprite-atlas']
    : ['forgeax-engine-assets', 'demo-assets', 'hello-sprite-atlas']),
);
const externalAssetRoots = isPublicDistribution
  ? [
      skyMetaPath,
      submoduleJpegMetaPath,
      submoduleSfxDir,
      submoduleBgmMetaPath,
      submoduleFbxDir,
      submoduleDejavuFontMetaPath,
      submoduleDejavuLegacyAtlasMetaPath,
      submoduleDejavuLegacyPackPath,
      submoduleSpriteAtlasDir,
    ]
  : [
      skyMetaPath,
      submoduleJpegMetaPath,
      submoduleSfxDir,
      submoduleBgmMetaPath,
      submoduleFbxDir,
      submoduleGlbDir,
      submoduleDejavuFontMetaPath,
      submoduleDejavuLegacyAtlasMetaPath,
      submoduleDejavuLegacyPackPath,
      submoduleSpriteAtlasDir,
    ];
// The tracked template packs are the Preview's required catalog. Public SDK
// source snapshots intentionally omit contributor-only binary fixtures, so
// exclude only those missing optional roots instead of disabling Pack (and
// therefore every tracked game-3d pack) as a unit.
const packRoots = [
  ...templatePackRoots,
  previewUiAuthoringMetaPath,
  ...externalAssetRoots.filter((root) => existsSync(root)),
];
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
        resolve(templatesDir, 'game-default/assets/arc-nova-sigil.shader.pack.json'),
        resolve(templatesDir, 'game-default/assets/arc-nova-violet-sigil.shader.pack.json'),
        resolve(templatesDir, 'game-default/assets/arc-nova-shard.shader.pack.json'),
        resolve(templatesDir, 'game-default/assets/arc-nova-ember-shard.shader.pack.json'),
      ],
    }) as never,
    // RHI capture is a dev-only inspection front door. Keeping the plugin out
    // of `vite build` makes the production Preview graph free of the recorder,
    // upload route, and debug-only browser chunk.
    ...(command === 'serve' ? [vitePluginRhiDebug()] : []),
    pluginPack({
      runtimeBinding: createStandaloneRuntimeAssetBinding('preview'),
      refresh: reloadAssetHost(),
      ddc: {
        buildCacheRoot: resolve(monorepoRoot, 'shared-build-inputs', 'ddc'),
        projectDdcRoot: resolve(here, '.forgeax', 'ddc', 'v2'),
      },
      roots: packRoots,
      importers: [
        audioImporter,
        imageImporter,
        fbxImporter,
        gltfImporter,
        fontImporter,
        { key: 'ui', ...createUiImporter() },
        targetProfileImporter(),
      ],
      cookers: [createParticleCodeNativeCookerFromRoots([templateAssetRoot, brotatoAssetRoot])],
    }),
  ],
  server: {
    ...previewPort,
    fs: {
      allow: [monorepoRoot],
    },
  },
  preview: previewPort,
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
