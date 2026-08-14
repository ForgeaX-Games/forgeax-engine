import { mkdir, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import type { InlineConfig, Plugin } from 'vite';
import type { ProjectFacts } from './types.js';

function moduleSpecifier(from: string, to: string): string {
  const value = relative(from, to).split(sep).join('/');
  return value.startsWith('.') ? value : `./${value}`;
}

function hostSource(facts: ProjectFacts): string {
  const generated = resolve(facts.root, '.forgeax', 'generated');
  const entry = moduleSpecifier(generated, resolve(facts.root, facts.entry));
  const plugins = [
    `audioPlugin()`,
    ...(facts.physics === undefined
      ? []
      : [`physicsPlugin('${facts.physics === '2d' ? 'rapier-2d' : 'rapier-3d'}')`]),
  ];
  return `import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createApp } from '@forgeax/engine-app';
import { audioPlugin } from '@forgeax/engine-audio';
import { physicsPlugin } from '@forgeax/engine-physics';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { bootstrap } from ${JSON.stringify(entry)};

const canvas = document.querySelector('#app');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('forgeax: missing canvas');
const binding = import.meta.env.DEV
  ? createStandaloneRuntimeAssetBinding(${JSON.stringify(facts.id)})
  : undefined;
const result = await createApp(canvas, { plugins: [${plugins.join(', ')}] }, {
  ...forgeaxBundlerAdapter(),
  ...(binding === undefined ? {} : { importTransport: createDevImportTransport(binding) }),
});
if (!result.ok) throw result.error;
const app = result.value;
const assets = app.renderer.assets;
if (binding === undefined) assets.configurePackIndex(new URL('pack-index.json', document.baseURI).toString());
else assets.configureRuntimeBinding(binding);
await assets.refreshCatalog();
let defaultScene;
let defaultSceneRoot;
const defaultSceneGuid = ${JSON.stringify(facts.defaultScene)};
if (defaultSceneGuid !== undefined) {
  const loaded = await assets.loadByGuid(assets.parseGuid(defaultSceneGuid));
  if (!loaded.ok) throw loaded.error;
  defaultScene = loaded.value;
  const handle = app.world.allocSharedRef('SceneAsset', loaded.value);
  const instantiated = assets.instantiate(handle, app.world);
  if (!instantiated.ok) throw instantiated.error;
  defaultSceneRoot = instantiated.value;
}
const uiRoot = document.querySelector('#game-ui');
const cleanups = [];
await bootstrap(app.world, {
  app,
  assets,
  renderer: app.renderer,
  ...(defaultScene === undefined ? {} : { defaultScene }),
  ...(defaultSceneRoot === undefined ? {} : { defaultSceneRoot }),
  uiRoot: uiRoot instanceof HTMLElement ? uiRoot : document.body,
  registerCleanup: (cleanup) => cleanups.push(cleanup),
  setPointerLockAllowed: (allowed) => app.input?.setPointerLockAllowed?.(allowed),
});
app.start().unwrap();
let disposed = false;
const dispose = () => {
  if (disposed) return;
  disposed = true;
  app.stop();
  for (const cleanup of cleanups.reverse()) cleanup();
  app.renderer.dispose();
};
window.addEventListener('pagehide', dispose);
`;
}

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ForgeaX Game</title>
    <style>
      html, body, #app-shell, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body { background: #05070b; }
      #app { display: block; }
      #app-shell { position: relative; }
      #game-ui { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
      #game-ui > * { pointer-events: auto; }
    </style>
  </head>
  <body>
    <div id="app-shell"><canvas id="app"></canvas><div id="game-ui"></div></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
`;

export async function createViteConfig(
  facts: ProjectFacts,
  command: 'serve' | 'build',
  base = '/',
): Promise<InlineConfig> {
  const generated = resolve(facts.root, '.forgeax', 'generated');
  await mkdir(generated, { recursive: true });
  await Promise.all([
    writeFile(resolve(generated, 'index.html'), HTML),
    writeFile(resolve(generated, 'main.ts'), hostSource(facts)),
  ]);
  const roots = facts.assetRoots.map((root) => resolve(facts.root, root));
  const runtimeBinding = createStandaloneRuntimeAssetBinding(facts.id);
  const plugins: Plugin[] = [
    forgeaxShader() as Plugin,
    pluginPack({
      roots,
      base,
      runtimeBinding,
      refresh: command === 'serve' ? reloadAssetHost() : undefined,
      importers: [audioImporter, imageImporter, fbxImporter, gltfImporter, fontImporter],
      cookers: [createParticleCodeNativeCookerFromRoots(roots)],
    }) as Plugin,
  ];
  return {
    root: generated,
    base,
    configFile: false,
    publicDir: false,
    plugins,
    resolve: { dedupe: ['@forgeax/engine-app', '@forgeax/engine-ecs', '@forgeax/engine-runtime'] },
    server: { fs: { allow: [facts.root] } },
    build: {
      target: 'esnext',
      outDir: resolve(facts.root, 'dist'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(generated, 'index.html') },
    },
  };
}
