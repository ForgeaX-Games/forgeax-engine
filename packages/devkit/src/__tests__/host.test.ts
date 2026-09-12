// @perf-budget-skip: intentional standalone Vite and ScriptablePack composition integration gate.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { BUILTIN_MESH_ASSETS } from '@forgeax/engine-pack/builtin';
import { describe, expect, it } from 'vitest';
import {
  createViteConfig,
  devKitDdcRoots,
  findInstalledEnginePackageRoot,
  ignoreDevKitCatalogPath,
} from '../host.js';
import { readProjectFacts } from '../project.js';

type PackContext = {
  readonly emitFile: (asset: {
    readonly fileName?: string;
    readonly name?: string;
    readonly source: string | Uint8Array;
  }) => string;
  readonly getFileName: (referenceId: string) => string;
};

type PackPlugin = {
  readonly name: 'forgeax:pack';
  readonly generateBundle: (this: PackContext, ...args: readonly unknown[]) => void | Promise<void>;
  readonly closeBundle: (...args: readonly unknown[]) => void | Promise<void>;
};

type EngineWorkspaceResolverPlugin = {
  readonly name: 'forgeax:devkit-engine-workspace-resolver';
  readonly resolveId: (
    this: { readonly resolve: (...args: readonly unknown[]) => Promise<unknown> },
    source: string,
    importer?: string,
  ) => Promise<unknown>;
};

describe('standalone host', () => {
  it('owns canonical project and build DDC roots', () => {
    expect(devKitDdcRoots('/workspace/game')).toEqual({
      buildCacheRoot: resolve('/workspace/game', '.forgeax/ddc/build-cache'),
      projectDdcRoot: resolve('/workspace/game', '.forgeax/ddc/v2'),
    });
  });

  it('finds the packaged desktop Engine dependency closure', () => {
    const packageRoot = resolve(
      tmpdir(),
      'forgeax-studio',
      'resources',
      'engine',
      'node_modules',
      '@forgeax',
    );
    expect(findInstalledEnginePackageRoot(resolve(packageRoot, 'engine-devkit', 'dist'))).toBe(packageRoot);
    expect(findInstalledEnginePackageRoot(resolve(tmpdir(), 'forgeax-studio', 'resources', 'engine'))).toBeUndefined();
  });

  it('resolves Engine workspace packages for external projects without installed links', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-external-resolution-'));
    try {
      await mkdir(resolve(root, 'assets'));
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'external-game',
            name: 'External Game',
            schemaVersion: '1.0.0',
            entry: 'main.ts',
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"external-game"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
      ]);
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      const config = await createViteConfig(facts.value, 'build');
      const resolver = (config.plugins ?? []).find(
        (plugin): plugin is EngineWorkspaceResolverPlugin => {
          if (typeof plugin !== 'object' || plugin === null || Array.isArray(plugin)) return false;
          const candidate = plugin as { readonly name?: unknown; readonly resolveId?: unknown };
          return (
            candidate.name === 'forgeax:devkit-engine-workspace-resolver' &&
            typeof candidate.resolveId === 'function'
          );
        },
      );
      expect(resolver).toBeDefined();
      if (resolver === undefined) return;
      const context = { resolve: async () => null };
      const importer = resolve(root, '.forgeax/generated/main.ts');
      const app = await resolver.resolveId.call(context, '@forgeax/engine-app', importer);
      const guid = await resolver.resolveId.call(context, '@forgeax/engine-pack/guid', importer);
      expect(String(app)).toMatch(/packages[\\/]app[\\/]dist[\\/]index\.mjs$/);
      expect(String(guid)).toMatch(/packages[\\/]pack[\\/]dist[\\/]guid\.mjs$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('materializes only missing Engine builtin mesh descriptors for standalone projects', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-builtins-'));
    try {
      await mkdir(resolve(root, 'assets'));
      const cube = BUILTIN_MESH_ASSETS.find((asset) => asset.geometry === 'procedural-cube');
      expect(cube).toBeDefined();
      if (cube === undefined) return;
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'builtin-game',
            name: 'Builtin Game',
            schemaVersion: '1.0.0',
            entry: 'main.ts',
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"builtin-game"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
        writeFile(
          resolve(root, 'assets/authored.pack.json'),
          `${JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: cube.guid,
                kind: 'mesh',
                payload: { geometry: 'procedural-cube' },
                refs: [],
                artifacts: {},
              },
            ],
          })}\n`,
        ),
      ]);
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      await createViteConfig(facts.value, 'build');
      const generated = JSON.parse(
        await readFile(resolve(root, '.forgeax/generated/engine-builtins.pack.json'), 'utf8'),
      ) as {
        readonly assets: readonly {
          readonly guid: string;
          readonly payload: { readonly geometry: string };
        }[];
      };
      const generatedGuids = generated.assets.map((asset) => asset.guid.toLowerCase());
      expect(generatedGuids).not.toContain(cube.guid.toLowerCase());
      expect(generatedGuids).toHaveLength(BUILTIN_MESH_ASSETS.length - 1);
      expect(generated.assets.map((asset) => asset.payload.geometry)).toContain(
        'procedural-sphere',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps shader inputs out while admitting project-owned importer assets', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-host-'));
    const shader = resolve(root, 'assets/shaders/custom.wgsl.meta.json');
    const targetProfile = resolve(root, 'assets/target-profile.json.meta.json');
    const image = resolve(root, 'assets/image.png.meta.json');
    await mkdir(resolve(root, 'assets/shaders'), { recursive: true });
    await Promise.all([
      writeFile(shader, '{"importer":"shader"}\n'),
      writeFile(targetProfile, '{"importer":"game-default-target-profile"}\n'),
      writeFile(image, '{"importer":"image"}\n'),
    ]);
    expect(ignoreDevKitCatalogPath(shader)).toBe(true);
    expect(ignoreDevKitCatalogPath(targetProfile)).toBe(false);
    expect(ignoreDevKitCatalogPath(image)).toBe(false);
  });

  it('instantiates forge.json defaultScene before game bootstrap', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-host-'));
    await mkdir(resolve(root, 'assets'));
    await Promise.all([
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'game',
          name: 'Game',
          schemaVersion: '1.0.0',
          entry: 'main.ts',
          plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }],
          defaultScene: 'c5def54a-ed2b-4fa1-9535-8e1b18cb9f5b',
        })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), '{"name":"game"}\n'),
      writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
    ]);
    const facts = await readProjectFacts(root);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    await createViteConfig(facts.value, 'build');
    const generated = await readFile(resolve(root, '.forgeax/generated/main.ts'), 'utf8');
    const html = await readFile(resolve(root, '.forgeax/generated/index.html'), 'utf8');
    expect(html).toContain('<link rel="icon" href="data:," />');
    expect(html).toContain('<title>Game</title>');
    expect(generated.indexOf('assets.instantiate<SceneAsset>(handle, app.world)')).toBeLessThan(
      generated.indexOf('await pluginLoader.root.update'),
    );
    expect(generated).toContain('loadByGuid<SceneAsset>');
    expect(generated).toContain('defaultSceneRoot');
    expect(generated).toContain('gameHostPlugin');
    expect(generated).toContain("query.has('forgeax-tool-replay')");
    expect(generated).toContain('replayToolPreviewCapture(capture)');
    expect(generated).toContain('host.value.capture()');
    expect(generated).toContain('navigator.webdriver === true');
    expect(generated).toContain('pointerLockAllowed');
    expect(generated).toContain('() => import("../../main.ts")');
    expect(generated).toContain('new ResizeObserver(resizeCanvas)');
    expect(generated).toContain('resizeObserver.disconnect()');
    expect(generated).toContain("from 'virtual:forgeax/pack-runtime'");
    expect(generated).toContain('const runtimeScopeBinding = runtimeBinding;');
    expect(generated).toContain('assets.configureRuntimeBinding(runtimeScopeBinding);');
    expect(generated).toContain(
      "assets.configurePackIndex(new URL('pack-index.json', document.baseURI).href);",
    );
    expect(generated).toContain(
      '...(import.meta.env.DEV ? { expectedScope: runtimeScopeBinding } : {}),',
    );
    expect(generated).not.toContain('createStandaloneRuntimeAssetBinding');
    expect(generated).not.toContain('createDevImportTransport');
    expect(generated).not.toContain('import { gameplay }');
  });

  it('projects the requested static base and output directory into Vite', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-host-'));
    const output = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-output-'));
    await mkdir(resolve(root, 'assets'));
    await Promise.all([
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'game',
          name: 'Game',
          schemaVersion: '1.0.0',
          entry: 'main.ts',
          plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }],
        })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), '{"name":"game"}\n'),
      writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
    ]);
    const facts = await readProjectFacts(root);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    const config = await createViteConfig(facts.value, 'build', '/games/game/', {
      outDir: output,
    });
    expect(config.base).toBe('/games/game/');
    expect(config.build?.outDir).toBe(output);
    const generatedHtml = await readFile(resolve(root, '.forgeax/generated/index.html'), 'utf8');
    expect(generatedHtml).toContain('formatStartupFailure');
    expect(generatedHtml).toContain('appendStructuredFailure');
    expect(generatedHtml).toContain("failed to start.\\n' + message");
    expect(generatedHtml).not.toContain("failed to start.\n' + message");
  });

  it('keeps structured startup causes instead of collapsing objects to [object Object]', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-host-'));
    await mkdir(resolve(root, 'assets'));
    await Promise.all([
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'game',
          name: 'Game',
          schemaVersion: '1.0.0',
          entry: 'main.ts',
        })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), '{"name":"game"}\n'),
      writeFile(resolve(root, 'main.ts'), 'export async function bootstrap() {}\n'),
    ]);
    const facts = await readProjectFacts(root);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    await createViteConfig(facts.value, 'build');
    const generatedHtml = await readFile(resolve(root, '.forgeax/generated/index.html'), 'utf8');
    const inlineScript = generatedHtml.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
    expect(inlineScript).toBeDefined();

    class HostElement {
      textContent = '';
      readonly style = { display: 'none' };
    }
    const notice = new HostElement();
    const listeners = new Map<string, (event: { readonly reason: unknown }) => void>();
    runInNewContext(inlineScript ?? '', {
      document: { querySelector: () => notice },
      HTMLElement: HostElement,
      window: {
        addEventListener: (type: string, listener: (event: { readonly reason: unknown }) => void) =>
          listeners.set(type, listener),
      },
    });
    listeners.get('unhandledrejection')?.({
      reason: {
        name: 'AssetError',
        message: 'pack-index.json could not be loaded',
        code: 'asset-not-imported',
        hint: 'rebuild the asset catalog',
      },
    });

    expect(notice.textContent).toContain('AssetError');
    expect(notice.textContent).toContain('asset-not-imported');
    expect(notice.textContent).toContain('pack-index.json could not be loaded');
    expect(notice.textContent).toContain('rebuild the asset catalog');
    expect(notice.textContent).not.toContain('[object Object]');

    listeners.get('unhandledrejection')?.({
      reason: {
        name: 'EngineEnvironmentError',
        message: 'forgeax-engine: no usable backend',
        detail: {
          webgpuError: {
            name: 'RhiError',
            code: 'adapter-unavailable',
            hint: 'browser-native WebGPU adapter was not available',
          },
          wgpuError: {
            name: 'RhiError',
            code: 'rhi-not-available',
            hint: 'wgpu/WebGL2 initialization failed',
          },
        },
      },
    });
    expect(notice.textContent).toContain('detail.webgpuError: RhiError adapter-unavailable');
    expect(notice.textContent).toContain('detail.wgpuError: RhiError rhi-not-available');
    expect(notice.textContent).toContain('supports browser WebGPU and a wgpu/WebGL2 fallback');
  });

  it('adapts a schema entry bootstrap into the native plugin lifecycle', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-host-'));
    await mkdir(resolve(root, 'assets'));
    await Promise.all([
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'game',
          name: 'Game',
          schemaVersion: '1.0.0',
          entry: 'main.ts',
        })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), '{"name":"game"}\n'),
      writeFile(resolve(root, 'main.ts'), 'export async function bootstrap() {}\n'),
    ]);
    const facts = await readProjectFacts(root);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    await createViteConfig(facts.value, 'build');
    const generated = await readFile(resolve(root, '.forgeax/generated/main.ts'), 'utf8');
    expect(generated).toContain('project-entry-bootstrap');
    expect(generated).toContain('bootstrapModule.bootstrap(ctx.gameHost.app.world, ctx.gameHost)');
  });

  it('resource host wires the package-owned equirect kit into the canonical scene', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-resource-host-'));
    try {
      await mkdir(resolve(root, 'assets'));
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'resource-game',
            name: 'Resource Game',
            schemaVersion: '1.0.0',
            entry: 'main.ts',
            plugins: [{ id: 'resource', name: './main.ts', realm: 'engine' }],
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"resource-game"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
      ]);
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      const config = await createViteConfig(facts.value, 'build', '/', {
        bootstrapRoot: 'resource-bootstrap',
      });
      const generated = await readFile(resolve(root, '.forgeax/generated/main.ts'), 'utf8');
      expect(generated).toContain("allocSharedRef('EquirectAsset', environment.value)");
      expect(generated).toContain('data: { equirect: canonicalEnvironment }');
      expect(generated).toContain('fitToolPreviewCameraToAabb');
      expect(generated).toContain('projection: CAMERA_PROJECTION_ORTHOGRAPHIC');
      expect(generated).toContain('tonemap: TONEMAP_NONE');
      expect(generated).toContain('clearColor: [0, 0, 0, 1]');
      expect(generated).toContain('createApp(');
      expect(generated).toContain('plugins: [],');
      expect(generated).toContain('assets.configureRuntimeBinding(runtimeScopeBinding)');
      expect(generated).toContain('assets.setCatalogSource(assetCatalog)');
      expect(generated).toContain('await assets.enumerateCatalog()');
      expect(generated).toContain(
        'assets.installDecoder(vfxGpuEffectContribution.kind, vfxGpuEffectContribution.decoder)',
      );
      expect(generated).not.toContain('assetDecoders:');
      expect(generated).not.toContain('component: Skylight, data: {}');
      expect(generated).not.toContain('component: SkyboxBackground, data: {}');
      expect(config.server?.fs?.allow).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/packages[\\/]preview[\\/]assets[\\/]canonical-kit$/),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads project-owned TypeScript importers through the standalone host boundary', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-project-importer-'));
    try {
      await mkdir(resolve(root, 'assets'), { recursive: true });
      await mkdir(resolve(root, 'assets', 'plugins'), { recursive: true });
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'importer-game',
            name: 'Importer Game',
            schemaVersion: '1.0.0',
            entry: 'main.ts',
            plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }],
          })}\n`,
        ),
        writeFile(
          resolve(root, 'package.json'),
          `${JSON.stringify({
            name: 'importer-game',
            forgeax: {
              assets: { roots: ['assets'], importers: ['./assets/plugins/importer.ts#factory'] },
            },
          })}\n`,
        ),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
        writeFile(
          resolve(root, 'assets', 'plugins', 'importer.ts'),
          `export function factory() { return { key: 'fixture-importer', import: async () => ({ ok: true, value: { assets: [], sourceDependencies: [] } }) }; }\n`,
        ),
      ]);
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      await expect(createViteConfig(facts.value, 'build')).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cooks a ScriptablePack source through the standalone build composition root', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-scriptable-pack-'));
    const sceneGuid = '019ffa97-0000-7000-8000-000000000001';
    try {
      await mkdir(resolve(root, 'assets'));
      await symlink(resolve(process.cwd(), 'node_modules'), resolve(root, 'node_modules'), 'dir');
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'scriptable-game',
            name: 'Scriptable Game',
            schemaVersion: '1.0.0',
            entry: 'main.ts',
            plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }],
            defaultScene: sceneGuid,
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"scriptable-game"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
        writeFile(
          resolve(root, 'assets', 'default-scene.pack.ts'),
          `const sceneGuid = new Uint8Array([1, 159, 250, 151, 0, 0, 112, 0, 128, 0, 0, 0, 0, 0, 0, 1]);
export default {
  schemaVersion: '1.0.0',
  packageId: new Uint8Array([1, 159, 250, 151, 0, 0, 112, 0, 128, 0, 0, 0, 0, 0, 0, 0]),
  name: 'Default Scene',
  assets: { scene: { guid: sceneGuid, kind: 'scene', name: 'Default Scene' } },
  externalAssets: {},
  build: () => ({ ok: true, value: { scene: { kind: 'scene', entities: [] } } }),
};
`,
        ),
      ]);

      const previous = process.cwd();
      process.chdir(root);
      try {
        const facts = await readProjectFacts(root);
        expect(facts.ok).toBe(true);
        if (!facts.ok) return;
        const config = await createViteConfig(facts.value, 'build');
        const pack = (config.plugins ?? []).find((plugin): plugin is PackPlugin => {
          if (typeof plugin !== 'object' || plugin === null || Array.isArray(plugin)) return false;
          const candidate = plugin as {
            readonly name?: unknown;
            readonly generateBundle?: unknown;
            readonly closeBundle?: unknown;
          };
          return (
            candidate.name === 'forgeax:pack' &&
            typeof candidate.generateBundle === 'function' &&
            typeof candidate.closeBundle === 'function'
          );
        });
        expect(pack).toBeDefined();
        if (pack === undefined || typeof pack.generateBundle !== 'function') return;
        const emitted = new Map<string, string | Uint8Array>();
        await pack.generateBundle.call({
          emitFile(asset) {
            const fileName = asset.fileName ?? asset.name ?? 'asset';
            emitted.set(fileName, asset.source);
            return fileName;
          },
          getFileName(referenceId) {
            return referenceId;
          },
        });
        await pack.closeBundle();
        const index = JSON.parse(String(emitted.get('pack-index.json'))) as readonly {
          readonly guid: string;
          readonly kind: string;
          readonly lifecycle?: string;
          readonly packageUrl: string;
        }[];
        const scene = index.find((entry) => entry.guid === sceneGuid);
        expect(scene).toMatchObject({ kind: 'scene', lifecycle: 'current' });
        if (scene === undefined) return;
        const packBody = JSON.parse(String(emitted.get(scene.packageUrl.slice(1)))) as {
          readonly assets: readonly { readonly guid: string; readonly kind: string }[];
        };
        expect(packBody.assets).toEqual(
          expect.arrayContaining([expect.objectContaining({ guid: sceneGuid, kind: 'scene' })]),
        );
      } finally {
        process.chdir(previous);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('escapes the project name used as the generated page title', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-title-'));
    await mkdir(resolve(root, 'assets'));
    await Promise.all([
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'game',
          name: 'Game <One> & "Two"',
          schemaVersion: '1.0.0',
          entry: 'main.ts',
          plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }],
        })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), '{"name":"game"}\n'),
      writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
    ]);
    const facts = await readProjectFacts(root);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    await createViteConfig(facts.value, 'build');
    const html = await readFile(resolve(root, '.forgeax/generated/index.html'), 'utf8');
    expect(html).toContain('<title>Game &lt;One&gt; &amp; &quot;Two&quot;</title>');
  });
});
