import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { createParticleCodeNativeCooker } from '@forgeax/engine-vfx-compiler';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { playwright } from '@vitest/browser-playwright';
import { websocketListenerCommands } from './packages/net-websocket/__tests__/support/ws-listener-commands';
import materialContractInventory from './scripts/material-contract-inventory.json' with {
  type: 'json',
};
import { targetProfileImporter } from './templates/game-default/assets/plugins/target-profile-importer';

// Keep the browser project independently loadable. The full workspace config
// discovers every unit and dawn project; browser CI only needs this project,
// and loading the rest makes Vite's dependency optimizer exceed the heavy
// runner heap before a browser test can start.
const rootDir = fileURLToPath(new URL('.', import.meta.url));
const materialPackages = [
  ...materialContractInventory.materialPackages,
  resolve(rootDir, 'templates/game-default/assets/animated-target-material.pack.json'),
  resolve(rootDir, 'templates/game-default/assets/hit-flash-material.pack.json'),
];
const vfxModules = Object.fromEntries(
  ['hit.vfx.wgsl', 'charge.vfx.wgsl'].map((name) => [
    name,
    {
      entry: readFileSync(resolve(rootDir, 'templates/game-default/assets', name), 'utf8'),
    },
  ]),
);
const templatePackRoots = [
  'animated-target-material.pack.json',
  'base-material.pack.json',
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
].map((relativePath) => resolve(rootDir, 'templates/game-default/assets', relativePath));
const submoduleJpegMetaPath = resolve(
  rootDir,
  'forgeax-engine-assets/demo-assets/hello-sprite/wood-container.jpg.meta.json',
);
const submoduleBgmMetaPath = resolve(
  rootDir,
  'forgeax-engine-assets/collectathon-audio/bgm-loop.wav.meta.json',
);
const submoduleFbxDir = resolve(rootDir, 'forgeax-engine-assets/vendor/fbx-test');
const submoduleGlbDir = resolve(rootDir, 'forgeax-engine-assets/khronos-gltf-samples/BoxTextured');
const submoduleDejavuFontMetaPath = resolve(
  rootDir,
  'forgeax-engine-assets/dejavu-fonts/DejaVuSansMono.ttf.meta.json',
);
const submoduleDejavuLegacyAtlasMetaPath = resolve(
  rootDir,
  'forgeax-engine-assets/dejavu-fonts/DejaVuSansMono.atlas.png.meta.json',
);
const submoduleDejavuLegacyPackPath = resolve(
  rootDir,
  'forgeax-engine-assets/dejavu-fonts/DejaVuSansMono.font.pack.json',
);
const submoduleSpriteAtlasDir = resolve(
  rootDir,
  'forgeax-engine-assets/demo-assets/hello-sprite-atlas',
);
const browserVendorMetaRoots = [
  'learn-opengl/textures/awesomeface.png.meta.json',
  'learn-opengl/textures/bricks2.jpg.meta.json',
  'learn-opengl/textures/bricks2_disp.jpg.meta.json',
  'learn-opengl/textures/bricks2_normal.jpg.meta.json',
  'learn-opengl/textures/brickwall.jpg.meta.json',
  'learn-opengl/textures/brickwall_normal.jpg.meta.json',
  'learn-opengl/textures/container.jpg.meta.json',
  'learn-opengl/textures/container2.png.meta.json',
  'learn-opengl/textures/container2_specular.png.meta.json',
  'learn-opengl/textures/grass.png.meta.json',
  'learn-opengl/textures/marble.jpg.meta.json',
  'learn-opengl/textures/metal.png.meta.json',
  'learn-opengl/textures/newport_loft.hdr.meta.json',
  'learn-opengl/textures/hdr/newport_loft.hdr.meta.json',
  'learn-opengl/textures/toy_box_diffuse.png.meta.json',
  'learn-opengl/textures/toy_box_disp.png.meta.json',
  'learn-opengl/textures/toy_box_normal.png.meta.json',
  'learn-opengl/textures/window.png.meta.json',
  'learn-opengl/textures/wood.png.meta.json',
  'learn-opengl/meshes/cube-mesh.stub.meta.json',
  'learn-opengl/objects/backpack/backpack.gltf.meta.json',
  'learn-opengl/objects/planet/mars.png.meta.json',
  'learn-opengl/objects/planet/planet.gltf.meta.json',
  'learn-opengl/objects/rock/rock.gltf.meta.json',
  'learn-opengl/objects/rock/rock.png.meta.json',
].map((relativePath) => resolve(rootDir, 'forgeax-engine-assets', relativePath));
const entityVisibilityBrowserTest =
  'apps/hello/entity-visibility/src/__tests__/visibility.browser.test.ts';
const producerReadiness =
  process.env.FORGEAX_BROWSER_PACK_READINESS === 'before-consume' ? 'before-consume' : 'on-demand';

export function createBrowserProject() {
  const runEntityVisibilityBrowserTest = process.env.FORGEAX_BROWSER_ENTITY_VISIBILITY === '1';
  const plugins = [
    forgeaxShader({ materialPackages }),
    pluginPack({
      runtimeBinding: createStandaloneRuntimeAssetBinding('browser-tests'),
      producerReadiness,
      roots: [
        resolve(rootDir, 'apps/learn-render/1.getting-started/4.textures/assets'),
        resolve(rootDir, 'apps/learn-render/1.getting-started/5.transformations/assets'),
        resolve(rootDir, 'apps/learn-render/1.getting-started/6.coordinate-systems/assets'),
        resolve(rootDir, 'apps/learn-render/1.getting-started/7.camera/assets'),
        ...browserVendorMetaRoots,
        resolve(rootDir, 'forgeax-engine-assets/khronos-gltf-samples/Sponza/Sponza.gltf.meta.json'),
        ...templatePackRoots,
        resolve(
          rootDir,
          'forgeax-engine-assets/demo-assets/template-game-default/sky.hdr.meta.json',
        ),
        resolve(rootDir, 'forgeax-engine-assets/sfx'),
        submoduleJpegMetaPath,
        submoduleBgmMetaPath,
        submoduleFbxDir,
        submoduleGlbDir,
        submoduleDejavuFontMetaPath,
        submoduleDejavuLegacyAtlasMetaPath,
        submoduleDejavuLegacyPackPath,
        submoduleSpriteAtlasDir,
      ],
      importers: [
        imageImporter,
        gltfImporter,
        audioImporter,
        fbxImporter,
        fontImporter,
        targetProfileImporter(),
      ],
      cookers: [createParticleCodeNativeCooker(vfxModules)],
    }),
  ];
  return {
    plugins,
    server: {
      fs: { allow: [rootDir] },
    },
    define: {
      'import.meta.env.FORGEAX_RUNTIME_SCOPE_ID': JSON.stringify('browser-tests'),
    },
    test: {
      name: 'browser',
      include: ['**/*.browser.test.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/artifacts/**',
        '**/.worktrees/**',
        '**/.claude/worktrees/**',
        ...(runEntityVisibilityBrowserTest ? [] : [entityVisibilityBrowserTest]),
      ],
      // Chromium's lavapipe WebGPU device is shared by browser workers. Keep
      // one Vitest worker as the lifecycle boundary for this real-WebGPU
      // project; the split runner adds a process boundary between groups.
      fileParallelism: false,
      maxWorkers: 1,
      deps: {
        optimizer: {
          client: { enabled: false },
        },
      },
      browser: {
        enabled: true,
        commands: websocketListenerCommands,
        provider: playwright({
          launchOptions: {
            channel: 'chrome-beta',
            args: [
              '--enable-unsafe-webgpu',
              '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
              '--use-vulkan=swiftshader',
              '--disable-vulkan-surface',
              '--ignore-gpu-blocklist',
              '--disable-gpu-driver-bug-workarounds',
              '--disable-dawn-features=disallow_unsafe_apis',
              '--autoplay-policy=no-user-gesture-required',
            ],
          },
        }),
        instances: [{ browser: 'chromium' }],
        headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0' && !!process.env.CI,
      },
    },
  };
}
