import { Console } from 'node:console';
import type { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { type BackendHost, createBackendHost } from '@forgeax/engine-host/backend';
import { createHostAssembly, type HostAssembly } from '@forgeax/engine-host/protocol';
import { attachHostWebSocketServer, createHostTransport } from '@forgeax/engine-host/transport';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { iesImporter } from '@forgeax/engine-import';
import { BUILTIN_MESH_ASSETS } from '@forgeax/engine-pack/builtin';
import { type ScanInventory, scanInventory } from '@forgeax/engine-pack/scanner';
import { parsePackSourceJson, projectDirectPackJson } from '@forgeax/engine-pack/source';
import { validateCanonicalKitReceipt } from '@forgeax/engine-preview';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding, type Importer } from '@forgeax/engine-types';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import {
  createLogger,
  createServer as createViteServer,
  type InlineConfig,
  type Plugin,
  type ViteDevServer,
  build as viteBuild,
  preview as vitePreview,
} from 'vite';
import { type WebSocket, WebSocketServer } from 'ws';
import { loadProjectCookers } from './build/cookers.js';
import { executionWorkerEntries } from './build/execution-workers.js';
import {
  assertPluginSourceInputs,
  discoverPluginAssets,
  isPluginAssetSourceIgnoredPath,
  publishedPluginInventory,
} from './build/plugin-assets.js';
import {
  pluginProgramsBuild,
  pluginRootDescriptor,
  pluginRuntimeProjection,
} from './build/plugin-programs.js';
import { runtimePacksSource } from './build/runtime-packs-source.js';
import { verifyDist, writeDistManifest } from './dist.js';
import { inspectEngineWorkspace, readEngineBinding } from './engine-binding.js';
import { environmentExecutionWorkers } from './execution-workers.js';
import type { BootstrapRoot } from './host/base-host.js';
import {
  composeBoundHostAssembly,
  type DevKitHostBinding,
  hostBindingError,
  validateHostBinding,
} from './host-binding.js';
import { commandError, readProjectFacts } from './project.js';
import { projectToolProjection } from './tools/project-tools.js';
import type {
  BuildOptions,
  CommandResult,
  ProjectCommandOptions,
  ProjectFacts,
  ProjectPortOptions,
} from './types.js';
import { resolveProjectPort } from './types.js';

const activeDevKitHosts = new Set<BackendHost>();

export async function disposeDevKitHosts(): Promise<void> {
  const hosts = [...activeDevKitHosts];
  activeDevKitHosts.clear();
  for (const host of hosts) await host.dispose();
}

export const DEFAULT_IMPORTERS: readonly Importer[] = [
  audioImporter,
  imageImporter,
  fbxImporter,
  gltfImporter,
  fontImporter,
  iesImporter,
  createUiImporter(),
];

export function ignoreDevKitCatalogPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').includes('shaders');
}

export function devKitDdcRoots(projectRoot: string): {
  readonly buildCacheRoot: string;
  readonly projectDdcRoot: string;
} {
  return {
    buildCacheRoot: resolve(projectRoot, '.forgeax', 'ddc', 'build-cache'),
    projectDdcRoot: resolve(projectRoot, '.forgeax', 'ddc', 'v2'),
  };
}

function isResourcePreviewIgnoredPath(path: string): boolean {
  return (
    ignoreDevKitCatalogPath(path) ||
    path.endsWith('.wgsl.meta.json') ||
    path.endsWith('target-profile.json.meta.json')
  );
}

function isProjectSourceIgnoredPath(path: string): boolean {
  return (
    ignoreDevKitCatalogPath(path) ||
    path.endsWith('.wgsl.meta.json') ||
    path.endsWith('target-profile.json.meta.json')
  );
}

interface CanonicalKitLocation {
  readonly root: string;
  readonly guid: string;
}

/**
 * Materialize the Engine-owned procedural mesh descriptors missing from a
 * standalone project. The project remains the author of any descriptor it
 * explicitly carries (for example, the game-default template); generated
 * rows fill only the GUID closure required by legacy scenes that reference
 * Engine builtins without embedding a duplicate declaration.
 */
async function prepareBuiltinPack(
  inventory: Pick<ScanInventory, 'declarations'> | undefined,
  generated: string,
): Promise<string | undefined> {
  if (inventory === undefined) return undefined;
  const declared = new Set<string>();
  for (const declaration of inventory.declarations.values()) {
    if (declaration.format === 'pack.json') {
      if (declaration.value.schemaVersion === '3.0.0') {
        const parsed = parsePackSourceJson(declaration.value);
        if (parsed.ok && parsed.value.format === 'direct') {
          const projected = projectDirectPackJson(parsed.value);
          if (projected.ok) {
            for (const asset of projected.value.assets) declared.add(asset.guid.toLowerCase());
          }
        }
      } else {
        for (const asset of declaration.value.assets) declared.add(asset.guid.toLowerCase());
      }
      continue;
    }
    if (declaration.format === 'pack.ts') continue;
    const subAssets =
      'subAssets' in declaration.value && Array.isArray(declaration.value.subAssets)
        ? declaration.value.subAssets
        : [];
    for (const asset of subAssets) declared.add(asset.guid.toLowerCase());
  }
  const missing = BUILTIN_MESH_ASSETS.filter((asset) => !declared.has(asset.guid.toLowerCase()));
  if (missing.length === 0) return undefined;
  const packPath = resolve(generated, 'engine-builtins.pack.json');
  await writeFile(
    packPath,
    `${JSON.stringify(
      {
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: missing.map((asset) => ({
          guid: asset.guid,
          kind: 'mesh',
          payload: { geometry: asset.geometry },
          refs: [],
          artifacts: {},
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return packPath;
}

/** Return authored single-material packs to the shader compiler's static graph. */
async function discoverMaterialPackages(
  inventory: Pick<ScanInventory, 'declarations'> | undefined,
): Promise<readonly string[]> {
  if (inventory === undefined) return [];
  const paths: string[] = [];
  for (const declaration of inventory.declarations.values()) {
    if (declaration.format !== 'pack.json') continue;
    let assets: readonly {
      readonly kind?: unknown;
      readonly payload?: { readonly kind?: unknown };
    }[] = [];
    if (declaration.value.schemaVersion === '3.0.0') {
      const parsed = parsePackSourceJson(declaration.value);
      if (!parsed.ok || parsed.value.format !== 'direct') continue;
      const projected = projectDirectPackJson(parsed.value);
      if (!projected.ok) continue;
      assets = projected.value.assets;
    } else {
      assets = declaration.value.assets;
    }
    if (
      assets.length === 1 &&
      assets[0]?.kind === 'material' &&
      assets[0].payload?.kind === 'material'
    )
      paths.push(declaration.sourcePath);
  }
  return paths.sort();
}

const hostRequire = createRequire(import.meta.url);

interface EngineWorkspacePackage {
  readonly root: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

type PackageExportValue = string | null | { readonly [key: string]: PackageExportValue };

function findEngineWorkspaceRoot(): string | undefined {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(resolve(cursor, 'pnpm-workspace.yaml'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function findInstalledEnginePackageRoot(start: string): string | undefined {
  let cursor = resolve(start);
  for (;;) {
    if (dirname(cursor) !== cursor && cursor.endsWith(`${sep}node_modules${sep}@forgeax`)) {
      return cursor;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

async function engineWorkspacePackages(
  workspaceRoot?: string,
): Promise<ReadonlyMap<string, EngineWorkspacePackage>> {
  const sourceWorkspaceRoot = workspaceRoot ?? findEngineWorkspaceRoot();
  const packageRoot =
    sourceWorkspaceRoot !== undefined
      ? resolve(sourceWorkspaceRoot, 'packages')
      : findInstalledEnginePackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (packageRoot === undefined) return new Map<string, EngineWorkspacePackage>();
  // A generated game is a pnpm workspace too, but it does not own a local
  // `packages/` tree. Its installed Engine packages are resolved by Node;
  // the workspace resolver is only an SDK/source-checkout fallback. A packaged
  // desktop DevKit has no pnpm workspace, so its staged node_modules/@forgeax
  // dependency closure is the equivalent immutable package root.
  if (!existsSync(packageRoot)) return new Map<string, EngineWorkspacePackage>();
  const packages = new Map<string, EngineWorkspacePackage>();
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = resolve(packageRoot, entry.name);
    try {
      const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as unknown;
      if (manifest === null || typeof manifest !== 'object') continue;
      const name = (manifest as { readonly name?: unknown }).name;
      if (typeof name === 'string' && name.startsWith('@forgeax/engine')) {
        packages.set(name, { root, manifest: manifest as Readonly<Record<string, unknown>> });
      }
    } catch {
      // A partial SDK/source checkout may omit an unrelated package manifest. The
      // package remains resolvable from the consumer project when available.
    }
  }
  return packages;
}

function conditionalExport(value: PackageExportValue): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || Array.isArray(value)) return undefined;
  for (const condition of ['browser', 'import', 'node', 'default']) {
    const candidate = value[condition];
    if (candidate === undefined) continue;
    const selected = conditionalExport(candidate);
    if (selected !== undefined) return selected;
  }
  return undefined;
}

function packageExportTarget(
  manifest: Readonly<Record<string, unknown>>,
  subpath: string,
): string | undefined {
  const exportsValue = manifest.exports as PackageExportValue | undefined;
  if (exportsValue === undefined) {
    if (subpath.length > 0) return undefined;
    const main = manifest.module ?? manifest.main;
    return typeof main === 'string' ? main : undefined;
  }
  if (typeof exportsValue === 'string' || exportsValue === null) {
    return subpath.length === 0 ? conditionalExport(exportsValue) : undefined;
  }
  const keys = Object.keys(exportsValue);
  const subpathMap = keys.some((key) => key === '.' || key.startsWith('./'));
  if (!subpathMap) return subpath.length === 0 ? conditionalExport(exportsValue) : undefined;
  const requested = subpath.length === 0 ? '.' : `./${subpath}`;
  const exact = exportsValue[requested];
  if (exact !== undefined) return conditionalExport(exact);
  for (const key of keys) {
    const marker = key.indexOf('*');
    if (marker < 0) continue;
    const prefix = key.slice(0, marker);
    const suffix = key.slice(marker + 1);
    if (!requested.startsWith(prefix) || !requested.endsWith(suffix)) continue;
    const replacement = requested.slice(prefix.length, requested.length - suffix.length);
    const exportTarget = exportsValue[key];
    if (exportTarget === undefined) continue;
    const selected = conditionalExport(exportTarget);
    return selected?.replaceAll('*', replacement);
  }
  return undefined;
}

function engineWorkspaceImport(
  source: string,
  packages: ReadonlyMap<string, EngineWorkspacePackage>,
): string | undefined {
  if (!source.startsWith('@forgeax/engine')) return undefined;
  const separator = source.indexOf('/', '@forgeax/engine'.length);
  const packageName = separator < 0 ? source : source.slice(0, separator);
  const subpath = separator < 0 ? '' : source.slice(separator + 1);
  const packageInfo = packages.get(packageName);
  if (packageInfo === undefined) return undefined;
  const target = packageExportTarget(packageInfo.manifest, subpath);
  if (target === undefined) return undefined;
  const absolute = resolve(packageInfo.root, target);
  const inside = relative(packageInfo.root, absolute);
  if (inside === '..' || inside.startsWith(`..${sep}`) || absolute === packageInfo.root) {
    return undefined;
  }
  return absolute;
}

async function createEngineWorkspaceResolver(projectRoot: string): Promise<Plugin | undefined> {
  const binding = await readEngineBinding(projectRoot);
  if (!binding.ok) {
    throw new Error(`${binding.error.code}: ${binding.error.hint}`);
  }
  const localRoot = binding.value?.path;
  if (localRoot !== undefined) {
    const inspected = await inspectEngineWorkspace(localRoot);
    if (!inspected.ok) throw new Error(`${inspected.error.code}: ${inspected.error.hint}`);
  }
  const packages = await engineWorkspacePackages(localRoot);
  if (packages.size === 0) return undefined;
  return {
    name: 'forgeax:devkit-engine-workspace-resolver',
    enforce: 'pre',
    async resolveId(source, importer) {
      const bareSource = source.split('?', 1)[0] ?? source;
      if (!bareSource.startsWith('@forgeax/engine')) return null;
      if (localRoot !== undefined) return engineWorkspaceImport(bareSource, packages);
      try {
        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (resolved !== null) return resolved;
      } catch {
        // Fall through to the Engine workspace only when the external project
        // has no installed copy of this package.
      }
      return engineWorkspaceImport(bareSource, packages);
    },
  };
}

/**
 * Reuse the production host's workspace fallback when a second bundle pass
 * resolves Engine packages from a source checkout.
 */
export async function createEngineWorkspaceResolverForProject(
  projectRoot: string,
): Promise<Plugin | undefined> {
  return createEngineWorkspaceResolver(projectRoot);
}

async function consumerEngineAliases(
  projectRoot: string,
): Promise<readonly { readonly find: string; readonly replacement: string }[]> {
  const root = resolve(projectRoot, 'node_modules', '.pnpm', 'node_modules', '@forgeax');
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('engine-'))
      .map((entry) => ({
        find: `@forgeax/${entry.name}`,
        replacement: resolve(root, entry.name),
      }))
      .sort((a, b) => a.find.localeCompare(b.find));
  } catch {
    return [];
  }
}

async function hostFrontendModuleAlias(
  binding: DevKitHostBinding | undefined,
): Promise<{ readonly find: string; readonly replacement: string } | undefined> {
  const specifier = binding?.frontendModule?.specifier;
  const packageRoot = binding?.backend.context.get('devkitBackend')?.hostPackageRoot;
  if (
    specifier === undefined ||
    packageRoot === undefined ||
    specifier.startsWith('.') ||
    isAbsolute(specifier) ||
    specifier.includes(':')
  )
    return undefined;
  try {
    return {
      find: specifier,
      replacement: await realpath(
        createRequire(resolve(packageRoot, 'package.json')).resolve(specifier),
      ),
    };
  } catch (cause) {
    hostBindingError(
      `host package cannot resolve frontend module ${specifier} from ${packageRoot}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

async function resolveCanonicalKit(): Promise<CanonicalKitLocation> {
  const packageJson = hostRequire.resolve('@forgeax/engine-preview/package.json');
  const root = resolve(packageJson, '..', 'assets/canonical-kit');
  if (!existsSync(root)) throw new Error(`canonical preview kit root is missing: ${root}`);
  const receiptPath = resolve(root, 'cook-receipt.json');
  const receipt = validateCanonicalKitReceipt(JSON.parse(await readFile(receiptPath, 'utf8')));
  if (!receipt.ok) {
    throw new Error(`${receipt.error.code}: ${receipt.error.detail.field}`);
  }
  const sourcePath = resolve(root, receipt.value.transport.source);
  const metaPath = resolve(root, receipt.value.transport.meta);
  if (!existsSync(sourcePath) || !existsSync(metaPath)) {
    throw new Error('canonical preview kit source and Meta must be package-owned files');
  }
  return { root, guid: receipt.value.source.guid };
}

export function devKitHostBridge(
  _facts: ProjectFacts,
  _bootstrapRoot: BootstrapRoot,
  binding?: DevKitHostBinding,
  assemblyInput?: HostAssembly | (() => Promise<HostAssembly>),
): Plugin & { releaseForRestart(): Promise<void> } {
  let dispose: ((restore?: boolean) => Promise<void>) | undefined;
  return {
    async releaseForRestart() {
      await dispose?.(false);
    },
    name: 'forgeax:devkit-backend-host',
    async configureServer(server) {
      const assembly =
        typeof assemblyInput === 'function'
          ? await assemblyInput()
          : (assemblyInput ??
            (binding
              ? composeBoundHostAssembly(binding, createHostAssembly())
              : createHostAssembly()));
      if (binding) validateHostBinding(binding);
      const http = server.httpServer;
      if (!http) return;
      const httpEvents: EventEmitter = http;
      const projected =
        binding?.frontendAssembly !== undefined || binding?.workspace?.execution === 'game';
      const previous = binding?.backend.assembly.current;
      const transport = binding?.backend.transport ?? createHostTransport();
      const backend = binding?.backend ?? (await createBackendHost({ assembly, transport }));
      if (binding && previous && !projected)
        await backend.update(assembly, { expectedRevision: previous.revision });
      const published = backend.assembly.current.revision;
      const sockets = new Set<() => void>();
      const socketServer = new WebSocketServer({ noServer: true });
      let workspaceSocket: WebSocket | undefined;
      let admitting = false;
      const projections = new Map<string, () => void>();
      const removeConnect = transport.onClientConnect((caller) => {
        if (admitting && projected)
          projections.set(caller.connectionId, backend.bindProjection(caller, { assembly }));
      });
      const removeDisconnect = transport.onClientDisconnect((caller) => {
        projections.get(caller.connectionId)?.();
        projections.delete(caller.connectionId);
      });
      socketServer.on('connection', (socket: WebSocket) => {
        if (binding?.workspace) {
          workspaceSocket?.close();
          workspaceSocket = socket;
        }
        const workspace = binding?.workspace;
        admitting = true;
        let release: () => void;
        try {
          release = attachHostWebSocketServer(
            socket,
            transport,
            workspace
              ? {
                  kind: 'frontend',
                  sourceId: `forgeax-workspace:${workspace.sessionId}:${workspace.targetId}`,
                }
              : {},
          );
        } finally {
          admitting = false;
        }
        sockets.add(release);
        socket.once('close', () => sockets.delete(release));
      });
      const upgrade = (
        request: import('node:http').IncomingMessage,
        socket: import('node:stream').Duplex,
        head: Buffer,
      ) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname !== '/__forgeax/host') return;
        const workspace = binding?.workspace;
        if (
          workspace &&
          (url.searchParams.get('forgeaxWorkspaceSession') !== workspace.sessionId ||
            url.searchParams.get('forgeaxWorkspaceTarget') !== workspace.targetId ||
            url.searchParams.get('forgeaxWorkspaceToken') !== workspace.admissionToken)
        ) {
          socket.destroy();
          return;
        }
        socketServer.handleUpgrade(request, socket, head, (client) =>
          socketServer.emit('connection', client, request),
        );
      };
      httpEvents.on('upgrade', upgrade);
      const marker =
        binding && !projected
          ? backend.context.plugin({
              apply(ctx) {
                ctx.provide('devkitHostBinding', binding);
              },
            }).ctx.fiber
          : undefined;
      let disposed = false;
      const removeBackendDispose = binding?.backend.subscribeDispose(() => dispose?.(false));
      dispose = async (restore = true) => {
        if (disposed) return;
        disposed = true;
        httpEvents.off('upgrade', upgrade);
        removeBackendDispose?.();
        removeConnect();
        removeDisconnect();
        for (const release of projections.values()) release();
        projections.clear();
        for (const release of sockets) release();
        sockets.clear();
        socketServer.close();
        await marker?.dispose();
        if (!binding) await backend.dispose();
        else if (
          !projected &&
          restore &&
          previous &&
          backend.assembly.current.revision === published
        ) {
          await backend.update(
            { ...previous, sessionGeneration: backend.assembly.current.sessionGeneration + 1 },
            { expectedRevision: published },
          );
        }
      };
      httpEvents.once('close', () => {
        void dispose?.();
      });
    },
    async closeBundle() {
      await dispose?.();
    },
  };
}

const gameProjectionSource = `const gameProjectionDefinitions = new Map();
function registerGameProjection(kind, definition) {
  if (gameProjectionDefinitions.has(definition.id)) {
    throw new Error('forgeax: duplicate game projection id ' + definition.id);
  }
  const entry = { kind, definition };
  gameProjectionDefinitions.set(definition.id, entry);
  return () => {
    if (gameProjectionDefinitions.get(definition.id) === entry) {
      gameProjectionDefinitions.delete(definition.id);
    }
  };
}
const gameProjection = {
  registerAction: (definition) => registerGameProjection('action', definition),
  registerRead: (definition) => registerGameProjection('read', definition),
};
`;

function executionBootstrapSource(
  _facts: ProjectFacts,
  _generated: string,
  bootstrapRoot: BootstrapRoot,
  sessionGeneration: number,
): string {
  return `import { audioPlugin } from '@forgeax/engine/audio';
import type { GameHost } from '@forgeax/engine/app';
import { skinningPlugin } from '@forgeax/engine/skinning';
import { root, createPrograms } from 'virtual:forgeax/plugin-programs/engine';
import { runtimeBinding } from 'virtual:forgeax/pack-runtime';
import { createRuntimePackOptions, createRuntimePackDeliveryClient } from './runtime-packs';
export default async function executionBootstrap(data) {
let prepareDelivery: ReturnType<typeof createRuntimePackDeliveryClient> = async () => ({ error: 'Runtime Pack page bridge is not ready' });
const bridge = {
  name: 'forgeax:worker-game-host', inject: ['world', 'assets', 'executionBootstrapHost'],
  apply(ctx) {
    const lifetime = new AbortController();
    prepareDelivery = createRuntimePackDeliveryClient(data?.programDeliveryChannel, lifetime.signal);
    ctx.effect(() => () => lifetime.abort(), 'devkit/runtime-pack-delivery');
    ${gameProjectionSource}
    const inspection = {
      list: () => ({ reads: Array.from(gameProjectionDefinitions.entries()).filter(([, entry]) => entry.kind === 'read').map(([id]) => id) }),
      read: async (id: string) => {
        const entry = gameProjectionDefinitions.get(id);
        if (entry?.kind !== 'read') throw new Error('forgeax: game read projection not found ' + id);
        return entry.definition.read();
      },
    };
    if (import.meta.env.DEV) {
      globalThis.__forgeaxGameInspection = inspection;
      ctx.effect(() => () => {
        if (globalThis.__forgeaxGameInspection === inspection) delete globalThis.__forgeaxGameInspection;
        gameProjectionDefinitions.clear();
      }, 'devkit/source-inspection');
    }
    ctx.provide('gameHost', {
      ...(ctx.executionBootstrapHost.canvas === undefined ? {} : { canvas: ctx.executionBootstrapHost.canvas }),
      assets: ctx.assets,
      ...(ctx.executionBootstrapHost.port === undefined ? {} : { port: ctx.executionBootstrapHost.port }),
      app: { world: ctx.world, assets: ctx.assets },
      ...(import.meta.env.DEV ? { gameProjection } : {}),
      setPointerLockAllowed: (allowed) => ctx.executionBootstrapHost.setPointerLockAllowed(allowed),
    } satisfies GameHost);
  },
};
  const runtimePacks = await createRuntimePackOptions(runtimeBinding.scopeId, () => prepareDelivery());
  const pluginPrograms = createPrograms(crypto.randomUUID(), 'engine-worker', ${sessionGeneration}, runtimePacks.programHost);
  return {
    runtimePacks: { ...runtimePacks, programHost: pluginPrograms.programHost ?? runtimePacks.programHost },
    plugins: [audioPlugin(), skinningPlugin(), bridge],
    pluginPrograms,
    ...(root === null || ${JSON.stringify(bootstrapRoot === 'resource-bootstrap')} ? {} : {
      root: { guid: root },
    }),
  };
}
`;
}

function hostSource(
  facts: ProjectFacts,
  _generated: string,
  bootstrapRoot: BootstrapRoot,
  canonicalEnvironmentGuid?: string,
  binding?: DevKitHostBinding,
  rhiCaptureEnabled = false,
  devMode = false,
  initialAssembly: HostAssembly = createHostAssembly(),
): string {
  const boundRoot =
    binding?.workspace?.execution === 'game'
      ? undefined
      : (binding?.frontendAssembly ?? binding?.backend.assembly.current)?.root;
  const plugins =
    bootstrapRoot === 'resource-bootstrap'
      ? []
      : [`webAudioPlugin()`, `audioPlugin()`, `skinningPlugin()`];
  return `import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createProfiler } from '@forgeax/engine/profiler';
import { activateExecutionRoot, assembleAssetRuntime, assembleRuntimePacks, captureEngineWorkspaceAssetBinding, createApp, engineWorkspaceBrowserPlugin, engineWorkspaceInputPlugin, engineWorkspaceResultService, createToolPreviewHost, createToolPreviewRecipe, fitToolPreviewCameraToAabb, gameHostPlugin, loadEngineWorkspaceMaterialSlots, projectEngineWorkspaceAssets, replayToolPreviewCapture, type App } from '@forgeax/engine/app';
import { Context, startNativePlugin } from '@forgeax/engine/plugin';
import { ShaderRegistry } from '@forgeax/engine/shader';
import { createRuntimePackOptions, serveRuntimePackDelivery } from './runtime-packs';
import { root as engineRoot, createPrograms as enginePrograms } from 'virtual:forgeax/plugin-programs/engine';
import { root as hostRoot, rootDescriptor as hostDescriptor, createPrograms as hostPrograms } from 'virtual:forgeax/plugin-programs/frontend';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { AssetRegistry, createCatalogSource, createCatalogHotSubscription, createAssetRegistry } from '@forgeax/engine/assets-runtime';
import {
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from 'virtual:forgeax/pack-runtime';
import { createFrontendHost } from '@forgeax/engine/host/frontend';
import { createHostAssembly, canonicalHostJson } from '@forgeax/engine/host/protocol';
import { connectHostWebSocket, HOST_ASSEMBLY_SERVICE, HOST_ASSEMBLY_CHANGED_TOPIC } from '@forgeax/engine/host/transport';
import { audioPlugin } from '@forgeax/engine/audio';
import { webAudioPlugin } from '@forgeax/engine/audio-webaudio';
import { physicsComponentsPlugin } from '@forgeax/engine/physics';
import { skinningPlugin } from '@forgeax/engine/skinning';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { mat4 } from '@forgeax/engine/math';
import { CAMERA_PROJECTION_ORTHOGRAPHIC, Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, Skylight, SkyboxBackground, TONEMAP_NONE, TONEMAP_REINHARD_EXTENDED } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { type SceneAsset } from '@forgeax/engine/types';
import { ParticleEffectPlayer } from '@forgeax/engine/vfx';
import { createVfxRuntimeHost } from '@forgeax/engine/vfx-render';

const initialAssembly = createHostAssembly({ ...${JSON.stringify(initialAssembly)},
  ...(hostDescriptor === null ? {} : { root: hostDescriptor }) });
const bootstrapRoot = ${JSON.stringify(bootstrapRoot)};
const canonicalEnvironmentGuid = ${JSON.stringify(canonicalEnvironmentGuid ?? null)};
const resourceValue = new URLSearchParams(location.search).get('forgeax-resource-preview');
const resource = resourceValue === null ? undefined : JSON.parse(resourceValue);
const executionWorkers = ${JSON.stringify(bootstrapRoot === 'resource-bootstrap' || binding !== undefined ? null : environmentExecutionWorkers())};
const workerExecution = executionWorkers !== null;
const previewCameraEntities = new WeakMap();
const previewCameraTargets = new WeakMap();
let vfxRuntimeHost;
function ensureVfxRuntimeHost() {
  if (vfxRuntimeHost !== undefined) return vfxRuntimeHost;
  vfxRuntimeHost = makeVfxRuntimeHost();
  return vfxRuntimeHost;
}
function makeVfxRuntimeHost() {
  return createVfxRuntimeHost({
    camera: {
      read(world) {
        const cameraEntity = previewCameraEntities.get(world);
        if (cameraEntity === undefined) return undefined;
        const transform = world.get(cameraEntity, Transform);
        const camera = world.get(cameraEntity, Camera);
        if (!transform.ok || !camera.ok) return undefined;
        const position = new Float32Array(transform.value.pos);
        const target = previewCameraTargets.get(world) ?? [0, 0, 0];
        return {
          position,
          right: new Float32Array([1, 0, 0]),
          up: new Float32Array([0, 1, 0]),
          viewProjection: mat4.multiply(mat4.create(), mat4.perspectiveReverseZ(mat4.create(), camera.value.fov, camera.value.aspect, camera.value.near, camera.value.far), mat4.lookAt(mat4.create(), position, target, [0, 1, 0])),
        };
      },
    },
  });
}
const previewVfxHosts = new WeakMap();
if (resource?.kind === 'vfx') ensureVfxRuntimeHost();

function previewVfxBounds(payload) {
  if (payload?.kind !== 'particle-effect' || payload.program?.emitters?.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const emitter of payload.program.emitters) {
    const bounds = emitter.bounds;
    if (bounds?.kind === 'sphere' && Array.isArray(bounds.center) && typeof bounds.radius === 'number') {
      const [x, y, z] = bounds.center;
      if (![x, y, z, bounds.radius].every((value) => typeof value === 'number' && Number.isFinite(value)) || bounds.radius < 0) return undefined;
      minX = Math.min(minX, x - bounds.radius);
      minY = Math.min(minY, y - bounds.radius);
      minZ = Math.min(minZ, z - bounds.radius);
      maxX = Math.max(maxX, x + bounds.radius);
      maxY = Math.max(maxY, y + bounds.radius);
      maxZ = Math.max(maxZ, z + bounds.radius);
      continue;
    }
    if (bounds?.kind === 'aabb' && Array.isArray(bounds.min) && Array.isArray(bounds.max)) {
      const [loX, loY, loZ] = bounds.min;
      const [hiX, hiY, hiZ] = bounds.max;
      if (![loX, loY, loZ, hiX, hiY, hiZ].every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined;
      minX = Math.min(minX, loX);
      minY = Math.min(minY, loY);
      minZ = Math.min(minZ, loZ);
      maxX = Math.max(maxX, hiX);
      maxY = Math.max(maxY, hiY);
      maxZ = Math.max(maxZ, hiZ);
      continue;
    }
    return undefined;
  }
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return undefined;
  const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const radius = Math.max(1, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ));
  return { aabb: [minX, minY, minZ, maxX, maxY, maxZ], center, radius };
}

const canvas = document.querySelector('#app');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('forgeax: missing canvas');
let latestFrameSubmission;
let latestTextureObservation;
canvas.addEventListener('forgeax:frame-submitted', (event) => {
  const detail = event instanceof CustomEvent ? event.detail : undefined;
  if (
    detail !== null &&
    typeof detail === 'object' &&
    Number.isSafeInteger(detail.frameId) &&
    Number.isSafeInteger(detail.deviceGeneration)
  ) {
    const frame = {
      frameId: detail.frameId,
      deviceGeneration: detail.deviceGeneration,
    };
    latestFrameSubmission = {
      ...frame,
      ...(detail.receipt?.completed === undefined ? {} : { completed: detail.receipt.completed }),
    };
    // Lock the renderer-owned binding projection at the submit boundary. A
    // later inspect() may already describe another frame or a replaced World;
    // resource observation must never pair those facts with this receipt.
    const currentApp = preparedResourceOwner?.app ?? appState.current;
    latestTextureObservation =
      currentApp?.renderer === undefined ||
      typeof currentApp.renderer.inspect !== 'function'
        ? undefined
        : textureRendererObservation(currentApp.renderer.inspect(), preparedResourceOwner?.binding, frame);
  }
});
// Publish the exact canvas + game UI container to frontend plugins.
// Presentation, reparenting, visibility and restoration belong to its consumer.
const engineWorkspaceSurface = canvas.parentElement ?? canvas;
const resizeCanvas = () => {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
};
const resizeObserver = new ResizeObserver(resizeCanvas);
if (!workerExecution) {
  resizeObserver.observe(canvas);
  resizeCanvas();
}
const runtimeScopeBinding = runtimeBinding;
if (runtimeScopeBinding === undefined) {
  throw new Error('forgeax: Vite Pack runtime binding is required in the generated host');
}
const assetCatalog = createCatalogSource({
  url: import.meta.env.DEV
    ? runtimeScopeBinding.catalogUrl
    : new URL('pack-index.json', document.baseURI).href,
  ...(import.meta.env.DEV ? { expectedScope: runtimeScopeBinding, subscribe: createCatalogHotSubscription(import.meta.hot) } : {}),
});
const bundler = {
  ...forgeaxBundlerAdapter(),
  ...(import.meta.env.DEV
    ? { importTransport: createRuntimeAssetImportTransport(runtimeScopeBinding) }
    : {}),
};
const assetPreparation = new WeakMap();

function prepareAssetRegistry(assets) {
  const existing = assetPreparation.get(assets);
  if (existing !== undefined) return existing;
  const pending = (async () => {
    // The App/Host asset provider already owns source configuration, including
    // admitted runtime publications. Preparation only joins its current Catalog.
    const catalog = await assets.enumerateCatalog();
    if (!catalog.ok) throw catalog.error;
  })();
  assetPreparation.set(assets, pending);
  return pending;
}

function previewStable(value) {
  if (value instanceof ArrayBuffer) return 'ArrayBuffer:' + JSON.stringify(Array.from(new Uint8Array(value)));
  if (ArrayBuffer.isView(value)) return value.constructor.name + ':' + JSON.stringify(Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
  if (Array.isArray(value)) return '[' + value.map(previewStable).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value;
    return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + previewStable(record[key])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

async function previewDigest(value) {
  const bytes = new TextEncoder().encode(previewStable(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function textureDimensions(payload) {
  const extent = payload?.shape?.extent;
  const width = extent?.width;
  const height = extent?.height;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error('TextureAsset shape.extent must provide positive width and height');
  }
  return [width, height];
}

function textureMipCount(payload) {
  const mips = payload?.mips;
  if (mips?.kind === 'packed') {
    if (!Number.isSafeInteger(mips.levelCount) || mips.levelCount <= 0) {
      throw new Error('TextureAsset packed mips must provide a positive levelCount');
    }
    return mips.levelCount;
  }
  if (mips?.kind !== 'generate') return 1;
  const [width, height] = textureDimensions(payload);
  const depth = payload?.shape?.viewDimension === '3d' ? payload.shape.extent.depth : 1;
  let largest = Math.max(width, height, Number.isSafeInteger(depth) && depth > 0 ? depth : 1);
  let levels = 1;
  while (largest > 1) {
    largest = Math.max(1, largest >> 1);
    levels += 1;
  }
  return levels;
}

function texturePayloadClass(payload) {
  const data = payload?.data;
  const bytes =
    data instanceof Uint8Array || data instanceof Uint8ClampedArray
      ? Array.from(data)
      : Array.isArray(data) && data.every((value) => typeof value === 'number')
        ? data
        : undefined;
  if (bytes === undefined || bytes.length === 0) return undefined;
  const format = String(payload?.format ?? '').toLowerCase();
  const singleChannel = format.startsWith('r') && !format.startsWith('rg');
  if (bytes.every((value) => value === 0)) return 'black';
  if (singleChannel) return 'single-channel';
  if (format.startsWith('rgba') || format.startsWith('bgra')) {
    const alpha = bytes.filter((_, index) => (index + 1) % 4 === 0);
    if (alpha.length > 0 && alpha.every((value) => value === 0)) return 'transparent';
  }
  return 'color';
}

function selectedMaterialPass(payload) {
  const passes = Array.isArray(payload?.passes) ? payload.passes : [];
  return passes.find((pass) => {
    const tags = pass?.renderState?.tags;
    const mode = tags?.LightMode ?? pass?.name;
    return !/shadow|depth/i.test(String(mode));
  }) ?? passes[0];
}

function textureRendererObservation(inspection, expected, frame) {
  const inspectedFrame = inspection?.frame;
  if (
    frame === undefined ||
    inspectedFrame?.frameId !== frame.frameId ||
    inspectedFrame?.deviceGeneration !== frame.deviceGeneration
  ) {
    return { rendererTextureResident: false, textureHandleCount: 0 };
  }
  const bindings = Array.isArray(inspection?.meshMaterialBindings)
    ? inspection.meshMaterialBindings
    : [];
  const selectedBinding =
    expected === undefined
      ? undefined
      : bindings.find(
          (binding) =>
            binding.entityKey === expected.entityKey &&
            (expected.worldIdentity === undefined ||
              binding.worldIdentity === expected.worldIdentity),
        );
  const selectedMaterialIndex =
    selectedBinding === undefined || expected?.materialHandle === undefined
      ? -1
      : selectedBinding.bindings.findIndex((binding) => binding.handle === expected.materialHandle);
  const selectedResidency =
    selectedMaterialIndex >= 0 ? selectedBinding?.residency[selectedMaterialIndex] : undefined;
  const selectedTexture =
    selectedResidency === undefined || expected?.textureHandle === undefined
      ? undefined
      : selectedResidency.textures.find((texture) => texture.handle === expected.textureHandle);
  const resident =
    selectedResidency !== undefined &&
    (selectedResidency.readiness === 'ready' || selectedResidency.readiness === 'last-known-good') &&
    selectedTexture !== undefined;
  return {
    rendererTextureResident: resident,
    textureHandleCount: selectedResidency?.textures.length ?? 0,
  };
}

async function previewOwnerFacts(assets, resource, payload) {
  if (resource.kind === 'material') {
    const primaryPass = selectedMaterialPass(payload);
    const program = primaryPass?.program?.module;
    const pass = primaryPass?.name;
    return {
      subjectDigest: await previewDigest(payload),
      bindingsDigest: await previewDigest(payload.passes),
      closureDigest: await previewDigest(payload.values ?? payload.passes),
      ...(typeof program === 'string' ? { program } : {}),
      ...(typeof pass === 'string' ? { pass } : {}),
    };
  }
  if (resource.kind === 'mesh') {
    return {
      subjectDigest: await previewDigest(payload),
      vertexDigest: await previewDigest(payload.vertices),
      indexDigest: await previewDigest(payload.indices ?? []),
      submeshDigest: await previewDigest(payload.submeshes),
      aabbDigest: await previewDigest(payload.aabb),
    };
  }
  if (resource.kind === 'texture') {
    const [width, height] = textureDimensions(payload);
    const mipCount = textureMipCount(payload);
    const filter = 'linear';
    const payloadClass = texturePayloadClass(payload);
    return {
      subjectDigest: await previewDigest(payload),
      boundDigest: await previewDigest({ width, height, format: payload.format }),
      uvDigest: await previewDigest({ offset: [0, 0], scale: [1, 1], rotation: 0 }),
      bindingDigest: await previewDigest({ format: payload.format, colorSpace: payload.colorSpace, filter, mipCount }),
      format: payload.format,
      colorSpace: payload.colorSpace,
      filter,
      mipCount,
      dimensions: [width, height],
      ...(payloadClass === undefined ? {} : { payloadClass }),
    };
  }
  return undefined;
}

${gameProjectionSource}
function exposeGameInspection(app) {
  globalThis.__forgeaxGameInspection = {
    list() {
      return {
        reads: Array.from(gameProjectionDefinitions.entries())
          .filter(([, entry]) => entry.kind === 'read')
          .map(([id]) => id),
      };
    },
    async read(id) {
      const entry = gameProjectionDefinitions.get(id);
      if (entry?.kind !== 'read') throw new Error('forgeax: game read projection not found ' + id);
      return entry.definition.read();
    },
    renderer() {
      const inspection = app.renderer.inspect();
      return { state: inspection.state, frameId: inspection.frame.frameId, execution: app.execution.report() };
    },
  };
}

let preparedResourceOwner;
async function prepareResourcePreview(app, resource, previewCanvas = canvas) {
const resourceVfx = previewVfxHosts.get(app) ?? (resource?.kind === 'vfx' ? ensureVfxRuntimeHost() : undefined);
let preparedResourceBinding;
await prepareAssetRegistry(app.assets);
const assets = app.assets;
const ownedEntities = [];
const ownedHandles = [];
const allocOwned = (target, payload) => {
  const handle = app.world.allocSharedRef(target, payload);
  ownedHandles.push(handle);
  return handle;
};
const internOwned = (target, payload) => {
  const handle = app.world.internSharedRef(target, payload);
  ownedHandles.push(handle);
  return handle;
};
const spawnOwned = (...components) => {
  const spawned = app.world.spawn(...components);
  if (!spawned.ok) throw spawned.error;
  ownedEntities.push(spawned.value);
  return spawned.value;
};
let resourceVfxAttached = false;
let canonicalEnvironment;
let closed = false;
let cleanupPromise;
const cleanup = async () => {
  if (cleanupPromise !== undefined) return cleanupPromise;
  closed = true;
  cleanupPromise = (async () => {
    let failure;
    previewCameraEntities.delete(app.world);
    previewCameraTargets.delete(app.world);
    for (let index = ownedEntities.length - 1; index >= 0; index -= 1) {
      const dropped = app.world.despawn(ownedEntities[index]);
      if (!dropped.ok && dropped.error?.code !== 'stale-entity' && failure === undefined) {
        failure = dropped.error;
      }
    }
    if (resourceVfxAttached) {
      const detached = await resourceVfx.detachWorld({ world: app.world });
      if (!detached.ok && failure === undefined) failure = detached.error;
    }
    for (const handle of ownedHandles.splice(0).reverse()) {
      const released = app.world.sharedRefs.release(handle);
      if (!released.ok && released.error?.code !== 'shared-ref-released' && failure === undefined) {
        failure = released.error;
      }
    }
    preparedResourceBinding = undefined;
    if (failure !== undefined) throw failure;
  })();
  return cleanupPromise;
};
try {
if (resource !== undefined) {
  if (resource.kind !== 'texture') {
    if (canonicalEnvironmentGuid === null) throw new Error('canonical preview environment is unavailable');
    const environment = await assets.loadByGuid(assets.parseGuid(canonicalEnvironmentGuid));
    if (!environment.ok) throw environment.error;
    if (environment.value.kind !== 'equirect') {
      throw new Error(\`canonical preview environment expected equirect, received \${environment.value.kind}\`);
    }
    if (environment.value.width <= 0 || environment.value.height <= 0 || environment.value.data.byteLength === 0) {
      throw new Error('canonical preview environment must provide decoded equirect pixels');
    }
    canonicalEnvironment = allocOwned('EquirectAsset', environment.value);
  }
  if (resource.kind === 'vfx') {
    const runtime = resourceVfx;
    const attached = await runtime.attachWorld({ world: app.world, assets });
    if (!attached.ok) throw attached.error;
    resourceVfxAttached = attached.value.state === 'attached';
  }
  const loaded = await assets.loadByGuid(assets.parseGuid(resource.guid));
  if (!loaded.ok) throw loaded.error;
  const payload = loaded.value;
  const assetBinding = captureEngineWorkspaceAssetBinding(assets, resource.guid, payload);
  if (resource.kind === 'vfx' && payload.kind !== 'particle-effect') {
    throw new Error(\`VFX preview expected ParticleEffectAsset, received \${payload.kind}\`);
  }
  const vfxBounds = resource.kind === 'vfx' ? previewVfxBounds(payload) : undefined;
  if (resource.kind === 'vfx' && vfxBounds === undefined) {
    throw new Error('VFX preview owner did not publish finite emitter bounds');
  }
  const meshMaterialHandles = resource.kind === 'mesh' && payload.kind === 'mesh'
    ? await loadEngineWorkspaceMaterialSlots(
        payload.materialSlots,
        async (slot) => {
          const material = await assets.loadByGuid(
            assets.parseGuid(AssetGuid.format(slot.defaultMaterial)),
          );
          if (!material.ok) return material;
          if (material.value.kind !== 'material') {
            throw new Error('mesh material slot resolved to a non-material asset');
          }
          return material;
        },
        (material) => allocOwned('MaterialAsset', material),
      )
    : undefined;
  const meshHandle = resource.kind === 'mesh' && payload.kind === 'mesh'
    ? allocOwned('MeshAsset', payload)
    : internOwned(
        'MeshAsset',
        createPrimitiveMesh(resource.kind === 'texture' ? 'quad' : 'sphere').unwrap(),
      );
  const textureHandle = resource.kind === 'texture' && payload.kind === 'texture'
    ? allocOwned('TextureAsset', payload)
    : undefined;
  const checkerTextureHandle = resource.kind === 'texture'
    ? allocOwned('TextureAsset', {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 8, height: 8 } },
        format: 'rgba8unorm',
        data: new Uint8Array(8 * 8 * 4).map((_, index) => {
          const pixel = Math.floor(index / 4);
          const row = Math.floor(pixel / 8);
          const column = pixel % 8;
          const shade = (row + column) % 2 === 0 ? 52 : 104;
          return index % 4 === 3 ? 255 : shade;
        }),
        colorSpace: 'linear',
        mips: { kind: 'none' },
      })
    : undefined;
  const checkerMaterialHandle = checkerTextureHandle === undefined
    ? undefined
    : allocOwned('MaterialAsset', Materials.unlit([1, 1, 1, 1], { baseColorTexture: checkerTextureHandle }));
  // Texture residency is renderer-owned. The preview world publishes the
  // TextureAsset through its normal MaterialAsset binding; the render system
  // pulls the POD and calls its internal residency owner during extraction.
  // Do not reach through Renderer with a second store API: that object is
  // intentionally private to concrete assembly and is absent from the public
  // Renderer contract.
  const materialPayload = resource.kind === 'texture' && payload.kind === 'texture'
    ? Materials.unlit([1, 1, 1, 1], {
        baseColorTexture: textureHandle,
        // Texture previews are composited over the checker plane below so
        // alpha-bearing payloads remain visible. Opaque payloads keep the
        // same color path; the blend state is harmless when alpha is one.
        renderState: {
          depthWriteEnabled: false,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      })
    : resource.kind === 'material' && payload.kind === 'material'
      ? payload
      : undefined;
  const materialHandle = materialPayload === undefined
    ? undefined
    : allocOwned('MaterialAsset', materialPayload);
  const materialBindings = resource.kind === 'mesh'
    ? meshMaterialHandles
    : materialHandle === undefined
      ? undefined
      : [materialHandle];
  const rawAabb = payload.kind === 'mesh' ? payload.aabb : undefined;
  const aabb = rawAabb !== undefined && (Array.isArray(rawAabb) || ArrayBuffer.isView(rawAabb)) && rawAabb.length === 6
    ? Array.from(rawAabb)
    : resource.kind === 'mesh' && payload.kind === 'mesh'
      ? (() => { throw new Error('mesh owner did not publish a finite AABB'); })()
      : [-1, -1, -1, 1, 1, 1];
  const meshFrame = resource.kind === 'mesh'
    ? fitToolPreviewCameraToAabb(aabb, { aspect: 1, fov: Math.PI / 4 })
    : undefined;
  const textureExtent = resource.kind === 'texture' && payload.kind === 'texture'
    ? textureDimensions(payload)
    : [1, 1];
  const textureWidth = textureExtent[0];
  const textureHeight = textureExtent[1];
  const textureAspect = textureWidth / textureHeight;
  const textureScale = textureAspect >= 1
    ? [textureAspect, 1, 1]
    : [1, 1 / textureAspect, 1];
  // Keep the orthographic view's world aspect equal to the drawing buffer.
  // The quad is scaled to the authored texture aspect; independently scaling
  // both camera axes would cancel that scale and stretch the image to the
  // viewport. Expand the view height only when a wide texture needs room.
  const viewportAspect = previewCanvas.width > 0 && previewCanvas.height > 0
    ? previewCanvas.width / previewCanvas.height
    : 1;
  const textureCameraHeight =
    1.2 * Math.max(textureScale[1], textureScale[0] / viewportAspect);
  const textureCameraWidth = textureCameraHeight * viewportAspect;
  const center = meshFrame?.center ?? vfxBounds?.center ?? [(aabb[0] + aabb[3]) / 2, (aabb[1] + aabb[4]) / 2, (aabb[2] + aabb[5]) / 2];
  const radius = meshFrame?.radius ?? vfxBounds?.radius ?? Math.max(1, Math.hypot(aabb[3] - aabb[0], aabb[4] - aabb[1], aabb[5] - aabb[2]));
  const texturePreview = resource.kind === 'texture';
  if (resource.kind === 'vfx') {
    const effect = allocOwned('ParticleEffectAsset', payload);
    spawnOwned(
      { component: Transform, data: { pos: center } },
      { component: ParticleEffectPlayer, data: { effect, playing: true, seed: 0, timeScale: 1 } },
    );
  } else {
    if (texturePreview && checkerTextureHandle !== undefined && checkerMaterialHandle !== undefined) {
      // The WebGPU surface is opaque in the normal Engine path. A real
      // checker mesh keeps the texture presentation honest without asking
      // the browser compositor or a second rendering API to own pixels.
      spawnOwned(
        { component: Transform, data: { pos: [center[0], center[1], center[2] - 0.02], scale: textureScale } },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [checkerMaterialHandle] } },
      );
    }
    const previewMeshEntity = spawnOwned(
      { component: Transform, data: { pos: center, ...(texturePreview ? { scale: textureScale } : {}) } },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: materialBindings === undefined ? {} : { materials: materialBindings } },
    );
    preparedResourceBinding = {
      entityKey: previewMeshEntity,
      worldIdentity: app.world.identity,
      materialHandle,
      textureHandle,
    };
  }
  const cameraData = texturePreview
    ? {
        fov: 0,
        aspect: viewportAspect,
        near: 0.01,
        far: 100,
        projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
        left: -textureCameraWidth / 2,
        right: textureCameraWidth / 2,
        bottom: -textureCameraHeight / 2,
        top: textureCameraHeight / 2,
        tonemap: TONEMAP_NONE,
        antialias: 0,
        bloom: 0,
        clearColor: [0, 0, 0, 1],
      }
    : {
        fov: Math.PI / 4,
        aspect: 1,
        near: meshFrame?.near ?? 0.01,
        far: meshFrame?.far ?? radius * 8,
        tonemap: TONEMAP_REINHARD_EXTENDED,
      };
  const cameraPosition = texturePreview
    ? [0, 0, 5]
    : [center[0], center[1], center[2] + (meshFrame?.distance ?? radius * 2.5)];
  const cameraEntity = spawnOwned({ component: Camera, data: cameraData }, { component: Transform, data: { pos: cameraPosition } });
  previewCameraEntities.set(app.world, cameraEntity);
  previewCameraTargets.set(app.world, center);
  if (!texturePreview) {
    spawnOwned({ component: DirectionalLight, data: { direction: [-0.5, -1, -0.3], intensity: 2 } });
    if (canonicalEnvironment === undefined) throw new Error('canonical preview environment was not loaded');
    spawnOwned({ component: Skylight, data: { equirect: canonicalEnvironment } });
    spawnOwned({ component: SkyboxBackground, data: { equirect: canonicalEnvironment } });
  }
  const ownerFacts = await previewOwnerFacts(assets, resource, payload);
  const publishedAsset = resource.kind === 'mesh' && payload.kind === 'mesh' && payload.aabb !== undefined
    ? { ...payload, aabb: Array.from(payload.aabb) }
    : payload;
  return {
    facts: {
      kind: resource.kind,
      guid: resource.guid,
      asset: publishedAsset,
      ...(ownerFacts === undefined ? {} : { ownerFacts }),
    },
    app,
    binding: preparedResourceBinding,
    assetBinding,
    close: cleanup,
  };
}
} catch (cause) {
  await cleanup();
  throw cause;
}
}

async function prepareProject(app) {
await prepareAssetRegistry(app.assets);
if (resource === undefined) return;
preparedResourceOwner = await prepareResourcePreview(app, resource);
return preparedResourceOwner.facts;
}
const query = new URLSearchParams(location.search);
const gpuPassTiming = query.get('forgeax-gpu-pass-timing') === '1' ? {} : undefined;
const cpuProfileRequested = query.get('forgeax-cpu-profile') === '1';
const rhiCaptureRequested =
  query.get('forgeax-rhi-capture') === '1' || ${JSON.stringify(rhiCaptureEnabled)};
// A profiler is an inert, bounded capability until a caller starts a capture.
// Create it in both live execution placements so the persistent CLI can inspect the
// actual realm; the Worker receives only the structured diagnostics switches.
const profiler = ${JSON.stringify(devMode)} || cpuProfileRequested ? createProfiler() : undefined;
const workspaceTarget = query.has('forgeaxWorkspace') && !workerExecution && bootstrapRoot === 'project-bootstrap';
const workspaceGame = workspaceTarget && query.get('forgeaxWorkspace') === 'game';
const workspaceMode = workspaceTarget && !workspaceGame;
const recipeValue = query.get('forgeax-tool-recipe');
const snapshotValue = query.get('forgeax-tool-snapshot');
const runIdValue = query.get('forgeax-tool-run-id');
const appState: { current?: App | import('@forgeax/engine/app').ExecutionApp } = {};
let disposeFrontendHost;
let activateGameHost: (() => Promise<void>) | undefined;
let removeStartupErrorListener;
let removeStartupInputBinding;
let activateWorkspace;
const notifyWorkspacePageLost =
  workspaceTarget
    ? () => {
        if (hostTransport === undefined) return;
        void hostTransport
          .request(engineWorkspaceResultService(query.get('forgeaxWorkspaceTarget')), {
            kind: 'lost',
            id: 'page-lost:' + (query.get('forgeaxWorkspaceSession') ?? 'forgeax-workspace-session'),
            sessionId: query.get('forgeaxWorkspaceSession') ?? 'forgeax-workspace-session',
            targetId: query.get('forgeaxWorkspaceTarget') ?? 'forgeax-workspace-target',
          })
          .catch(() => {});
      }
    : undefined;
const appBootstrapPlugin = {
  name: 'forgeax:generated-app-bootstrap',
  inject: workspaceGame ? ['engineWorkspaceInput'] : [],
  async apply(ctx) {
    const ownsPageLifecycle =
      bootstrapRoot !== 'resource-bootstrap' && resource === undefined && recipeValue === null;
    let pageHidden = false;
    ctx.effect(() => {
      const onPageHide = () => {
        pageHidden = true;
        notifyWorkspacePageLost?.();
        resizeObserver.disconnect();
        if (disposeFrontendHost !== undefined) void disposeFrontendHost();
        else void appState.current?.dispose();
      };
      if (ownsPageLifecycle) window.addEventListener('pagehide', onPageHide, { once: true });
      return () => {
        if (ownsPageLifecycle) window.removeEventListener('pagehide', onPageHide);
      };
    }, 'devkit/generated-page-lifecycle');
    const pointerLockAllowed =
      query.has('forgeaxCapture') || recipeValue !== null ? () => false : undefined;
    if (profiler !== undefined) ctx.provide('profiler', profiler);
    const programDeliveryChannel = workerExecution ? crypto.randomUUID() : undefined;
    if (programDeliveryChannel !== undefined)
      ctx.effect(() => serveRuntimePackDelivery(programDeliveryChannel), 'devkit/runtime-pack-delivery');
    const gameChannel = workerExecution ? new MessageChannel() : undefined;
    if (gameChannel !== undefined) {
      ctx.effect(() => () => {
        gameChannel.port1.close();
        // Covers failure before handoff; App closes the Engine end after handoff.
        gameChannel.port2.close();
      }, 'devkit/game-channel');
    }
    const runtimePacks = workerExecution ? undefined : await createRuntimePackOptions(runtimeScopeBinding.scopeId);
    const pluginPrograms = workerExecution ? undefined : enginePrograms(crypto.randomUUID(), 'engine-main', initialAssembly.sessionGeneration, runtimePacks.programHost);
    const result = await createApp(
      canvas,
      workerExecution
        ? {
            execution: {
              workers: executionWorkers,
              bootstrapData: { programDeliveryChannel },
              ...(gameChannel === undefined ? {} : { bootstrapPort: gameChannel.port2 }),
              // Development includes cold Vite compilation before the native Worker handshake.
              startupTimeoutMs: import.meta.env.DEV ? 120_000 : 30_000,
              bootstrap: new URL(
                import.meta.env.DEV ? './execution-bootstrap.ts' : './execution-bootstrap.js',
                import.meta.url,
              ),
              assetCatalog: {
                url: import.meta.env.DEV
                  ? runtimeScopeBinding.catalogUrl
                  : new URL('pack-index.json', document.baseURI).href,
                ...(import.meta.env.DEV
                  ? { expectedScope: runtimeScopeBinding, runtimeBinding: runtimeScopeBinding }
                  : {}),
              },
              diagnostics: {
                profiler: import.meta.env.DEV || cpuProfileRequested,
                rhiCapture: rhiCaptureRequested,
                ...(gpuPassTiming === undefined ? {} : { gpuPassTiming }),
              },
            },
            ...(pointerLockAllowed === undefined ? {} : { pointerLockAllowed }),
          }
        : {
            context: ctx.root,
            assetCatalog,
            pluginPrograms,
            runtimePacks: { ...runtimePacks, programHost: pluginPrograms.programHost ?? runtimePacks.programHost },
            gpuPassTiming,
            profiler,
            ...(workspaceGame ? { input: ctx.engineWorkspaceInput.game } : {}),
            plugins: [${plugins.join(', ')}${plugins.length > 0 ? ', ' : ''}...(workspaceMode ? [physicsComponentsPlugin()] : [])],
            ...(workspaceMode ? { features: [ensureVfxRuntimeHost().feature] } : {}),
            ...(import.meta.env.DEV ? { assetRuntimeBinding: runtimeScopeBinding } : {}),
            ...(pointerLockAllowed === undefined ? {} : { pointerLockAllowed }),
          },
      workerExecution ? forgeaxBundlerAdapter() : bundler,
    );
    if (!result.ok) throw result.error;
    const app = result.value;
    appState.current = app;
    ctx.effect(() => async () => {
      (await app.dispose()).unwrap();
      if (appState.current === app) appState.current = undefined;
    }, 'devkit/generated-app-resource');
    // Engine plugins can apply before createApp completes. A page that left
    // during startup must release this late App before publishing more services.
    if (pageHidden) throw new Error('forgeax: page left during App startup');
    if (workerExecution) {
      // DOM plugins load POD assets through the same catalog without a GPU or
      // a second World. Host UI never downloads the renderer shader manifest.
      const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }), bundler.importTransport);
      if (!import.meta.env.DEV) assets.configurePackIndex(new URL('pack-index.json', document.baseURI).href);
      const assembly = assembleAssetRuntime(assets, [], {
        ownsRegistry: true,
        catalogSource: assetCatalog,
        ...(import.meta.env.DEV ? { runtimeBinding: runtimeScopeBinding } : {}),
      });
      if (!assembly.ok) { await app.dispose(); throw assembly.error; }
      const uiRoot = document.querySelector('#game-ui');
      ctx.provide('assets', assets);
      const host = {
        app, assets,
        ...(gameChannel === undefined ? {} : { port: gameChannel.port1 }),
        get canvas() { return ('canvas' in app ? app.canvas : undefined) ?? canvas; },
        uiRoot: uiRoot instanceof HTMLElement ? uiRoot : document.body,
        setPointerLockAllowed: (allowed: boolean) => app.input?.setPointerLockAllowed?.(allowed),
      } satisfies import('@forgeax/engine/app').GameHost;
      ctx.provide('gameHost', host);
      ctx.effect(() => () => assembly.value.dispose(), 'devkit/host-assets');
      if (import.meta.env.DEV || cpuProfileRequested) {
        const localInspection = globalThis.__forgeaxGameInspection;
        const sourceRead = (method: 'list' | 'read', id?: string) => app.remoteEval === undefined
          ? localInspection?.[method](id)
          : app.remoteEval('globalThis.__forgeaxGameInspection.' + method + '(' + (id === undefined ? '' : JSON.stringify(id)) + ')');
        const inspection = {
          list: () => import.meta.env.DEV ? sourceRead('list') : { reads: [] },
          read: (id: string) => sourceRead('read', id),
          renderer: () => {
            const execution = app.execution.report();
            const local = 'renderer' in app ? app.renderer.inspect() : undefined;
            return { state: execution.render?.state ?? local?.state ?? (execution.engine.health === 'running' ? 'alive' : execution.engine.health), frameId: execution.render?.completedFrame ?? execution.frame.completed, execution };
          },
        };
        globalThis.__forgeaxGameInspection = inspection;
        ctx.effect(() => () => {
          if (globalThis.__forgeaxGameInspection === inspection) delete globalThis.__forgeaxGameInspection;
        }, 'devkit/host-inspection');
      }
    }
    if (workspaceTarget) {
      activateWorkspace = async () => {
        if (hostTransport === undefined || workerExecution) throw new Error('Workspace requires its main-realm Host transport');
        const extent = (name, fallback) => { const value = Number(query.get(name)); return Number.isSafeInteger(value) && value > 0 ? value : fallback; };
        const fiber = await ctx.plugin(engineWorkspaceBrowserPlugin, {
          app, canvas, surface: engineWorkspaceSurface, transport: hostTransport,
          ...(workspaceMode ? { createPreviewApp: async ({ context, canvas: previewCanvas, asset }) => {
            const vfx = asset.kind === 'vfx' ? makeVfxRuntimeHost() : undefined;
            const created = await createApp(previewCanvas, {
              context, assetCatalog: app.pluginContext.get('runtimePacks')?.catalog ?? assetCatalog, plugins: [physicsComponentsPlugin()],
              ...(vfx ? { features: [vfx.feature] } : {}),
              ...(import.meta.env.DEV ? { assetRuntimeBinding: runtimeScopeBinding } : {}),
              pointerLockAllowed: () => false,
            }, bundler);
            if (!created.ok) throw created.error;
            if (vfx) previewVfxHosts.set(created.value, vfx);
            return created.value;
          } } : {}),
          ...(workspaceGame ? { input: ctx.engineWorkspaceInput } : {}),
          project: { id: ${JSON.stringify(facts.id)}, root: ${JSON.stringify(facts.root)}, name: ${JSON.stringify(facts.name)} },
          target: {
            sessionId: query.get('forgeaxWorkspaceSession'), targetId: query.get('forgeaxWorkspaceTarget'),
            worldId: app.world.identity, headed: query.get('forgeaxWorkspaceHeaded') !== '0',
            width: extent('forgeaxWorkspaceWidth', 1280), height: extent('forgeaxWorkspaceHeight', 720), url: location.href,
          },
          openResourcePreview: async ({ app: previewApp, asset, canvas: previewCanvas }) => {
            const owner = await prepareResourcePreview(previewApp, { kind: asset.kind, guid: asset.guid }, previewCanvas);
            return { close: owner.close, assetBinding: owner.assetBinding };
          },
        });
        await fiber.await();
      };
    } else if (bootstrapRoot === 'project-bootstrap' && recipeValue === null) {
      const startup = globalThis.__forgeaxStartup;
      startup?.bindSession?.(app.execution.report().world.identity);
      removeStartupErrorListener = app.onError((error) => startup?.fail?.(error));
      removeStartupInputBinding = startup?.bindInput?.((enabled) => {
        app.input?.setInputAllowed?.(enabled);
        app.input?.setPointerLockAllowed?.(enabled);
        if (!enabled) app.input?.clear?.();
      });
    }
    if (workspaceMode) await activateWorkspace?.();
    if ((import.meta.env.DEV || cpuProfileRequested) && !workerExecution) exposeGameInspection(app as App);
    let gameHostFiber;
    let engineRootFiber;
    ctx.effect(
      () => {
        return async () => {
          resizeObserver.disconnect();
          await engineRootFiber?.dispose();
          await gameHostFiber?.dispose();
          removeStartupErrorListener?.();
          removeStartupErrorListener = undefined;
          removeStartupInputBinding?.();
          removeStartupInputBinding = undefined;
        };
      },
      'devkit/generated-app',
    );
    if (
      bootstrapRoot !== 'resource-bootstrap' &&
      !workerExecution &&
      !workspaceMode
    ) {
      activateGameHost = async () => {
        const assets = app.assets;
        await prepareAssetRegistry(assets);
        if (assets === undefined) throw new Error('forgeax: generated App did not provide assets');
        const uiRoot = document.querySelector('#game-ui');
        gameHostFiber = await ctx.root.plugin(gameHostPlugin({
          app,
          assets,
          canvas,
          renderer: app.renderer,
          uiRoot: uiRoot instanceof HTMLElement ? uiRoot : document.body,
          setPointerLockAllowed: (allowed) => app.input?.setPointerLockAllowed?.(allowed),
          ...(import.meta.env.DEV ? { gameProjection } : {}),
        }));
        if (engineRoot !== null) {
          const mounted = await activateExecutionRoot(ctx, {
            guid: engineRoot,
          });
          engineRootFiber = mounted.fiber;
        }
      };
    }
  },
};
const hostContext = new Context();
let removeWorkspaceAssemblySubscription;
const hostLifecyclePlugin = {
  name: 'forgeax:generated-host-lifecycle',
  apply(ctx) {
    ctx.effect(
      () => () => {
        // The parent Host owns this effect. Never await parent disposal from a child.
        removeWorkspaceAssemblySubscription?.();
        hostTransport?.close('generated frontend host disposed');
      },
      'devkit/generated-host-lifecycle',
    );
  },
};
const hostTransport = import.meta.env.DEV
  ? await connectHostWebSocket(
      (() => {
        const hostUrl = new URL(
          (location.protocol === 'https:' ? 'wss:' : 'ws:') +
            '//' + location.host + '/__forgeax/host',
        );
        if (workspaceTarget) {
          const session = query.get('forgeaxWorkspaceSession');
          const target = query.get('forgeaxWorkspaceTarget');
          const token = query.get('forgeaxWorkspaceToken');
          if (session !== null) hostUrl.searchParams.set('forgeaxWorkspaceSession', session);
          if (target !== null) hostUrl.searchParams.set('forgeaxWorkspaceTarget', target);
          if (token !== null) hostUrl.searchParams.set('forgeaxWorkspaceToken', token);
        }
        return hostUrl.href;
      })(),
    )
  : undefined;
const frontendHost = await createFrontendHost({
  context: hostContext,
  ...(import.meta.env.DEV ? { startupTimeoutMs: 120_000 } : {}),
  startupPlugins: [hostLifecyclePlugin, ...(workspaceGame ? [{ name: 'forgeax:workspace-input-bootstrap', async apply(ctx) { const fiber = ctx.plugin(engineWorkspaceInputPlugin, { canvas }); await fiber.await(); } }] : []), ...(workspaceMode ? [] : [appBootstrapPlugin])],
  assembly: initialAssembly,
  activateRoot: async (ctx, descriptor, signal) => {
    ${
      boundRoot
        ? `if (canonicalHostJson(descriptor) === canonicalHostJson(${JSON.stringify(boundRoot)})) {
      const module = await import(${JSON.stringify(binding?.frontendModule?.specifier)});
      const plugin = module[${JSON.stringify(binding?.frontendModule?.export ?? 'default')}];
      if (!ctx.registry.resolve(plugin)) throw new Error('external frontend module is missing its selected native plugin export');
      const started = await startNativePlugin(ctx, plugin, descriptor.config, { signal });
      if (!started.ok) throw started.error;
      return { fiber: started.value, dispose: () => started.value.dispose() };
    }`
        : ''
    }
    if (hostRoot === null || canonicalHostJson(descriptor) !== canonicalHostJson(hostDescriptor)) throw new Error('host root/program snapshot mismatch');
    const scope = ctx.isolate('assets').isolate('pluginPrograms').isolate('runtimePacks');
    const provider = scope.plugin({ provide: ['assets', 'pluginPrograms', 'runtimePacks'], async apply(ctx) {
      const assembly = assembleAssetRuntime(new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined })), [], { catalogSource: assetCatalog, ownsRegistry: true }).unwrap();
      ctx.effect(() => () => assembly.dispose());
      const options = await createRuntimePackOptions(runtimeScopeBinding.scopeId);
      const pluginPrograms = hostPrograms(crypto.randomUUID(), 'frontend', initialAssembly.sessionGeneration, options.programHost);
      ctx.provide('pluginPrograms', pluginPrograms);
      const runtimePacks = assembleRuntimePacks(ctx, assembly, { ...options, programHost: pluginPrograms.programHost ?? options.programHost });
      ctx.provide('runtimePacks', runtimePacks);
      const reader = createAssetRegistry({ catalog: runtimePacks.catalog, fetcher: runtimePacks.fetcher, scopeId: runtimeScopeBinding.scopeId });
      ctx.provide('assets', reader);
      ctx.effect(() => () => reader.dispose());
    } });
    await provider.await();
    return activateExecutionRoot(scope, {
      guid: hostRoot,
    }, signal);
  },
  ...(hostTransport === undefined ? {} : { transport: hostTransport }),
  autoActivate: false,
});
disposeFrontendHost = () => frontendHost.dispose();
if (workspaceMode) {
  // UI and connection plugins activate independently of the optional renderer.
  await frontendHost.activate();
  const appFiber = hostContext.plugin(appBootstrapPlugin);
  try {
    await appFiber.await();
  } catch (error) {
    await appFiber.dispose();
    globalThis.__forgeaxStartup?.fail?.(error);
    await hostTransport?.request(engineWorkspaceResultService(query.get('forgeaxWorkspaceTarget')), {
      kind: 'failed', id: 'workspace-bootstrap-failed',
      sessionId: query.get('forgeaxWorkspaceSession'), targetId: query.get('forgeaxWorkspaceTarget'),
      error: { code: error?.code ?? 'engine-workspace-bootstrap-failed', expected: error?.expected ?? 'the workspace renderer to initialize', hint: error?.hint ?? String(error), detail: error?.detail ?? {} },
    });
  }
}
const app = appState.current;
let appStarted = false;
if (app !== undefined) {
try {
  if (app === undefined) throw new Error('forgeax: generated App bootstrap did not complete');
  await activateGameHost?.();
  if (!workspaceMode && bootstrapRoot !== 'resource-bootstrap') {
    // The Engine realm and its plugins are ready when createApp returns. Open
    // frame credit before Host plugins load runtime assets so their async
    // startup can never depend on a frame that this activation is withholding.
    app.start().unwrap();
    appStarted = true;
    await frontendHost.activate();
  }
  const pluginProjectionBridge = globalThis.__forgeaxPluginProjection;
  if (pluginProjectionBridge !== undefined) {
    pluginProjectionBridge.current = { inspect() {
      const live = frontendHost.assembly.inspection;
      return { desired: initialAssembly.root ? [initialAssembly.root] : [], live, entries: live, liveState: 'attached' };
    } };
  }
} catch (error) {
  if (appStarted) app.stop();
  await frontendHost.dispose().catch(() => {});
  throw error;
}

// The backend remains the assembly authority after the initial workspace boot.
// Its workspace bridge publishes only workspace-safe project entries.
if (workspaceMode && hostTransport !== undefined) {
  let queue = Promise.resolve();
  const applyWorkspaceAssembly = (assembly) => {
    queue = queue.then(async () => {
      if (assembly.revision !== frontendHost.assembly.current.revision) {
        await frontendHost.update(assembly);
      }
    }).catch((error) => hostTransport.close(error));
    return queue;
  };
  removeWorkspaceAssemblySubscription = hostTransport.subscribe(HOST_ASSEMBLY_CHANGED_TOPIC, applyWorkspaceAssembly);
  await applyWorkspaceAssembly(await hostTransport.request(HOST_ASSEMBLY_SERVICE, undefined));
}

// A workspace App stays stopped until its first preview is instantiated. This
// avoids running a camera-less frame loop between page readiness and the
// user's first asset selection; the selected SceneAsset (or resource owner)
// supplies the observation camera before any frame is submitted.

if (query.has('forgeax-tool-replay')) {
  globalThis.__forgeaxToolReplayHost = {
    ready: true,
    async run(capture) {
      const result = await replayToolPreviewCapture(capture);
      return result.ok ? { ok: true, result: result.value } : { ok: false, error: result.error };
    },
  };
} else if (recipeValue !== null) {
  const previewRecipe = createToolPreviewRecipe(JSON.parse(recipeValue));
  const host = await createToolPreviewHost({
    ...(runIdValue === null ? {} : { runId: runIdValue }),
    recipe: previewRecipe,
    snapshot: JSON.parse(snapshotValue ?? 'null'),
    ...(resource === undefined ? {} : { resource }),
    canvas,
    app: {
      plugins: [${plugins.join(', ')}],
      ...(import.meta.env.DEV ? { assetRuntimeBinding: runtimeScopeBinding } : {}),
      ...(vfxRuntimeHost === undefined ? {} : { features: [vfxRuntimeHost.feature] }),
    },
    bundler,
    prepare: prepareProject,
    async collectResourceFacts(app, current) {
      if (current === undefined) return current;
      if (resource?.kind !== 'vfx') {
        if (resource?.kind === 'material' || resource?.kind === 'mesh' || resource?.kind === 'texture') {
          if (resource.kind === 'mesh') {
            const asset = current.asset;
            const aabb = asset?.aabb;
            const submeshes = asset?.submeshes;
            const materialSlots = asset?.materialSlots;
            if (!Array.isArray(aabb) || aabb.length !== 6 || !Array.isArray(submeshes) || !Array.isArray(materialSlots)) {
              return current;
            }
            return {
              ...current,
              observation: {
                ...current.ownerFacts,
                aabb,
                submeshCount: submeshes.length,
                materialSlotCount: materialSlots.length,
              },
            };
          }
          if (resource.kind === 'texture') {
            let textureObservation = latestTextureObservation ?? {
              rendererTextureResident: false,
              textureHandleCount: 0,
            };
            const completion = latestFrameSubmission?.completed;
            if (completion === undefined) {
              textureObservation = { rendererTextureResident: false, textureHandleCount: 0 };
            } else {
              try {
                const completed = await completion;
                if (completed?.ok !== true) {
                  textureObservation = { rendererTextureResident: false, textureHandleCount: 0 };
                }
              } catch {
                textureObservation = { rendererTextureResident: false, textureHandleCount: 0 };
              }
            }
            return {
              ...current,
              observation: {
                ...current.ownerFacts,
                ...textureObservation,
              },
            };
          }
          return {
            ...current,
            observation: current.ownerFacts,
          };
        }
        return current;
      }
      if (vfxRuntimeHost === undefined) return current;
      const hostInspection = vfxRuntimeHost.inspect(app.world);
      const player = hostInspection?.players.find(
        (candidate) => candidate.assetGuid.toLowerCase() === resource.guid.toLowerCase(),
      );
      const renderObservation = vfxRuntimeHost.feature.inspect();
      if (player === undefined || renderObservation.frameNumber < 0) {
        return current;
      }
      const bounds = previewVfxBounds(current.asset);
      if (bounds === undefined) return current;
      const emitterDigest = JSON.stringify(player.emitters.map(({ id, module, capacity }) => ({ id, module, capacity })));
      const sampleDigest = JSON.stringify(player.emitters.map(({ id, schedule }) => ({ id, schedule })));
      const boundsDigest = JSON.stringify(player.emitters.map(({ id, bounds: emitterBounds }) => ({ id, bounds: emitterBounds })));
      const computeDigest = player.programFingerprint;
      const indirectDigest = JSON.stringify(player.emitters.map(({ id, renderers }) => ({ id, renderers: renderers.map(({ kind, enabled }) => ({ kind, enabled })) })));
      return {
        ...current,
        observation: {
          subjectDigest: current.asset.programFingerprint,
          programFingerprint: player.programFingerprint,
          emitterDigest,
          sampleDigest,
          boundsDigest,
          computeDigest,
          indirectDigest,
          authoredBounds: bounds.aabb,
          seed: player.seed,
          fixedDelta: player.fixedDelta,
          timelineFrames: previewRecipe.frames,
          dispatches: renderObservation.dispatches,
          indirectDraws: renderObservation.indirectDraws,
          subjectOutputs: renderObservation.subjectOutputs,
        },
      };
    },
    onDispose: async () => {
      const owner = preparedResourceOwner;
      preparedResourceOwner = undefined;
      await owner?.close?.();
    },
    executeAction(action) {
      return !globalThis.dispatchEvent(new CustomEvent('forgeax-tool-action', {
        detail: action,
        cancelable: true,
      }));
    },
  });
  if (!host.ok) {
    globalThis.__forgeaxStartup?.fail?.(host.error);
    globalThis.__forgeaxToolHost = {
      ready: true,
      capture: async () => ({ ok: false, error: host.error }),
      run: async () => ({ ok: false, error: host.error }),
      dispose: async () => undefined,
    };
  } else {
    globalThis.__forgeaxToolHost = {
      ready: true,
      async capture() {
        const result = await host.value.capture();
        return result.ok ? { ok: true, result: result.value } : { ok: false, error: result.error };
      },
      async run() {
        const result = await host.value.run();
        return result.ok ? { ok: true, result: result.value } : { ok: false, error: result.error };
      },
      dispose: () => host.value.dispose(),
    };
    window.addEventListener('pagehide', () => void host.value.dispose(), { once: true });
  }
} else if (!workspaceMode) {
  if (bootstrapRoot === 'project-bootstrap' && recipeValue === null) {
    (
      globalThis as typeof globalThis & {
        __forgeaxStartup?: { readonly prepare?: () => void };
      }
    ).__forgeaxStartup?.prepare?.();
  }
  if (workspaceGame) await activateWorkspace?.();
  if (!appStarted) app.start().unwrap();
  if (query.has('forgeaxCapture')) {
    document.documentElement.dataset.forgeaxCaptureReady = 'true';
  }
}
}
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
    }
    return character;
  });
}

function htmlSource(title: string, startupScreen = true): string {
  const startupEnabled = startupScreen ? 'true' : 'false';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="data:," />
    <title>${escapeHtml(title)}</title>
    <style>
      html, body, #app-shell, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body { background: #05070b; }
      #app { display: block; }
      #app-shell { position: relative; isolation: isolate; }
      #game-ui { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
      #forgeax-loading { position: absolute; inset: 0; z-index: 2147483646; display: grid; place-items: center; padding: 24px; box-sizing: border-box; background: #05070b; color: #e6e6e6; font: 15px/1.6 system-ui, sans-serif; text-align: center; opacity: 1; transition: opacity 150ms ease; }
      #forgeax-loading[aria-hidden="true"] { opacity: 0; }
      #forgeax-loading[aria-hidden="true"]:not([data-fading="true"]) { pointer-events: none; }
      #forgeax-loading-content { display: grid; justify-items: center; gap: 12px; max-width: min(480px, 100%); }
      #forgeax-loading-title { margin: 0; color: #f5f7fa; font-size: clamp(20px, 4vw, 30px); font-weight: 500; letter-spacing: 0.02em; }
      #forgeax-loading-spinner { width: 22px; height: 22px; border: 2px solid rgb(230 235 245 / 20%); border-top-color: rgb(230 235 245 / 78%); border-radius: 50%; animation: forgeax-loading-spin 900ms linear infinite; }
      #forgeax-loading-status { margin: 0; color: rgb(230 235 245 / 72%); }
      #forgeax-loading-slow, #forgeax-loading-reload { display: none; }
      #forgeax-loading-reload, #forgeax-fatal-reload { border: 1px solid rgb(230 235 245 / 35%); border-radius: 5px; padding: 7px 14px; background: transparent; color: inherit; cursor: pointer; font: inherit; }
      #forgeax-fatal { position: absolute; inset: 0; z-index: 2147483647; display: none; place-items: center; padding: 24px; box-sizing: border-box; background: #0b0d10; color: #e6e6e6; font: 15px/1.6 system-ui, sans-serif; text-align: center; }
      #forgeax-fatal-content { display: grid; gap: 12px; width: min(680px, 100%); text-align: left; }
      #forgeax-fatal-message { margin: 0; font-size: 18px; }
      #forgeax-fatal-details { max-height: 45vh; overflow: auto; white-space: pre-wrap; }
      @keyframes forgeax-loading-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { #forgeax-loading { transition: none; } #forgeax-loading-spinner { animation: none; } }
    </style>
  </head>
  <body>
    <div id="app-shell"><canvas id="app"></canvas><div id="game-ui"></div>
    <div id="forgeax-loading" role="status" aria-live="polite" aria-atomic="true">
      <div id="forgeax-loading-content">
        <h1 id="forgeax-loading-title">${escapeHtml(title)}</h1>
        <div id="forgeax-loading-spinner" aria-hidden="true"></div>
        <p id="forgeax-loading-status">Loading…</p>
        <p id="forgeax-loading-slow">Still loading. You can keep waiting or reload.</p>
        <button id="forgeax-loading-reload" type="button">Reload</button>
      </div>
    </div>
    <div id="forgeax-fatal" role="alert">
      <div id="forgeax-fatal-content">
        <p id="forgeax-fatal-message">Unable to start the game.</p>
        <details><summary>Diagnostics</summary><pre id="forgeax-fatal-details"></pre></details>
        <button id="forgeax-fatal-reload" type="button">Reload</button>
      </div>
    </div>
    </div>
    <noscript>JavaScript is required to start this game. Please enable JavaScript and reload.</noscript>
    <script>
      (() => {
        const startupEnabled = ${startupEnabled};
        const loading = document.querySelector('#forgeax-loading');
        const loadingStatus = document.querySelector('#forgeax-loading-status');
        const loadingSlow = document.querySelector('#forgeax-loading-slow');
        const loadingReload = document.querySelector('#forgeax-loading-reload');
        const fatal = document.querySelector('#forgeax-fatal');
        const fatalMessage = document.querySelector('#forgeax-fatal-message');
        const fatalDetails = document.querySelector('#forgeax-fatal-details');
        const fatalReload = document.querySelector('#forgeax-fatal-reload');
        const QueryParams = typeof URLSearchParams === 'function'
          ? URLSearchParams
          : class {
              has() {
                return false;
              }
            };
        const query = typeof location === 'object' && location !== null
          ? new QueryParams(location.search)
          : new QueryParams();
        const gamePage = startupEnabled && !query.has('forgeaxWorkspace') &&
          !query.has('forgeax-tool-recipe') && !query.has('forgeax-tool-replay');
        // Workspace/resource/tool pages intentionally omit the normal loading
        // overlay, but their entry/App failures still need the same fatal
        // diagnostic surface and Reload action.
        // Resource and tool pages intentionally disable only the normal game
        // overlay. Their entry/App failures still need a terminal diagnostic
        // surface and Reload action.
        const fatalEnabled = true;
        let phase = gamePage ? 'loading' : 'disabled';
        let slowTimer;
        let fadeTimer;
        let slowRemainingMs = 15000;
        let slowVisibleSince;
        let latestSubmitted;
        // A completion may legally lag behind a later submission. Keep the
        // submitted frame identities for the active device generation so a
        // successful receipt remains tied to a real frame without requiring
        // the queue to drain to the newest submission.
        let submittedFrames = new Set();
        const submissionKey = (worldIdentity, deviceGeneration, frameId) =>
          JSON.stringify([worldIdentity, deviceGeneration, frameId]);
        let expectedSession;
        let inputBinding;
        let inputEnabled = false;
        let startupListenersCleaned = false;
        let sessionGeneration = 0;
        const reducedMotion =
          typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        const fadeDurationMs = reducedMotion ? 0 : 150;
        const canvas = document.querySelector('#app');
        const setStartupTimeout = typeof setTimeout === 'function' ? setTimeout : () => undefined;
        const clearStartupTimeout = (timer) => {
          if (timer !== undefined && typeof clearTimeout === 'function') clearTimeout(timer);
        };
        const reload = () => {
          if (typeof location?.reload === 'function') location.reload();
        };
        const setText = (node, text) => {
          if (node !== null && node instanceof HTMLElement) node.textContent = text;
        };
        const setDisplay = (node, display) => {
          if (node !== null && node instanceof HTMLElement) node.style.display = display;
        };
        const setAttribute = (node, name, value) => {
          if (node !== null && node instanceof HTMLElement && typeof node.setAttribute === 'function') {
            node.setAttribute(name, value);
          }
        };
        const isStartupControlTarget = (target) => {
          if (target === null || target === undefined) return false;
          const owns = (node) =>
            node !== null &&
            node !== undefined &&
            (node === target || (typeof node.contains === 'function' && node.contains(target)));
          return owns(loading) || owns(fatal);
        };
        const onStartupInputCapture = (event) => {
          if (inputEnabled || isStartupControlTarget(event?.target)) return;
          event?.preventDefault?.();
          event?.stopImmediatePropagation?.();
          event?.stopPropagation?.();
        };
        const onStartupControlKey = (event) => {
          // Let the focused Reload button receive its default Enter/Space
          // activation, but stop the key event before it bubbles to the
          // gameplay producer while the startup surface owns the page.
          if (!inputEnabled) event?.stopPropagation?.();
        };
        const startupInputKinds = [
          'keydown',
          'keyup',
          'pointerdown',
          'pointerup',
          'pointermove',
          'pointercancel',
          'mousedown',
          'mouseup',
          'mousemove',
          'wheel',
          'click',
        ];
        const bindStartupInputCapture = () => {
          if (!gamePage || typeof window.addEventListener !== 'function') return;
          for (const kind of startupInputKinds) {
            window.addEventListener(kind, onStartupInputCapture, { capture: true });
          }
        };
        const removeStartupInputCapture = () => {
          if (typeof window.removeEventListener !== 'function') return;
          for (const kind of startupInputKinds) {
            window.removeEventListener(kind, onStartupInputCapture, { capture: true });
          }
        };
        const setInputEnabled = (enabled) => {
          inputEnabled = enabled;
          try {
            inputBinding?.(enabled);
          } catch {
            // Input is an observational startup bridge; it must not change the
            // fatal error path when an App-owned callback is already disposed.
          }
        };
        const bindInput = (callback) => {
          if (typeof callback !== 'function') return () => {};
          const previous = inputBinding;
          if (previous !== undefined) {
            try {
              previous(false);
            } catch {
              // Continue replacing an already-bound input bridge.
            }
          }
          inputBinding = callback;
          setInputEnabled(false);
          return () => {
            if (inputBinding !== callback) return;
            setInputEnabled(false);
            inputBinding = undefined;
          };
        };
        const clearStartupWork = () => {
          clearStartupTimeout(slowTimer);
          clearStartupTimeout(fadeTimer);
          slowTimer = undefined;
          fadeTimer = undefined;
          slowVisibleSince = undefined;
          submittedFrames = new Set();
        };
        const clockNow = () => {
          if (typeof performance === 'object' && performance !== null && typeof performance.now === 'function') {
            return performance.now();
          }
          return Date.now();
        };
        const isForeground = () =>
          typeof document !== 'object' || document === null || document.visibilityState !== 'hidden';
        const accountForegroundTime = () => {
          if (slowVisibleSince === undefined) return;
          slowRemainingMs = Math.max(0, slowRemainingMs - Math.max(0, clockNow() - slowVisibleSince));
          slowVisibleSince = undefined;
        };
        const showSlow = () => {
          if (!gamePage || (phase !== 'loading' && phase !== 'preparing') || !isForeground()) return;
          accountForegroundTime();
          if (slowRemainingMs > 0) {
            slowVisibleSince = clockNow();
            slowTimer = setStartupTimeout(showSlow, slowRemainingMs);
            return;
          }
          slowTimer = undefined;
          slowVisibleSince = undefined;
          setDisplay(loadingSlow, 'block');
          setDisplay(loadingReload, 'inline-block');
        };
        const armSlowTimer = () => {
          if (!gamePage || (phase !== 'loading' && phase !== 'preparing') || !isForeground()) return;
          accountForegroundTime();
          clearStartupTimeout(slowTimer);
          if (slowRemainingMs <= 0) {
            showSlow();
            return;
          }
          slowVisibleSince = clockNow();
          slowTimer = setStartupTimeout(showSlow, slowRemainingMs);
        };
        const appendStructuredFailure = (value, prefix, depth, seen, lines) => {
          const formatValue = (candidate) => {
            if (typeof candidate === 'string') return candidate;
            try {
              const encoded = JSON.stringify(candidate);
              if (encoded !== undefined) return encoded;
            } catch {
              // Fall through to String for unserializable diagnostics.
            }
            return String(candidate);
          };
          if (value === null || typeof value !== 'object') {
            if (prefix && value !== undefined) lines.push(prefix + ': ' + formatValue(value));
            return;
          }
          if (depth > 3) {
            lines.push((prefix || 'cause') + ': [depth limit]');
            return;
          }
          if (seen.has(value)) {
            lines.push((prefix || 'cause') + ': [circular]');
            return;
          }
          seen.add(value);
          if (Array.isArray(value)) {
            value.forEach((nested, index) =>
              appendStructuredFailure(nested, (prefix || 'cause') + '[' + index + ']', depth + 1, seen, lines),
            );
            return;
          }
          const record = value;
          const name = typeof record.name === 'string' && record.name.length > 0
            ? record.name
            : undefined;
          const code = typeof record.code === 'string' && record.code.length > 0
            ? record.code
            : undefined;
          const message = typeof record.message === 'string' && record.message.length > 0
            ? record.message
            : undefined;
          if (name !== undefined || code !== undefined || message !== undefined) {
            const identity = [name || 'Error', code].filter(Boolean).join(' ');
            lines.push((prefix ? prefix + ': ' : '') + identity + (message ? ': ' + message : ''));
          }
          for (const key of ['expected', 'hint', 'reason']) {
            if (record[key] !== undefined && record[key] !== null) {
              lines.push((prefix ? prefix + '.' : '') + key + ': ' + formatValue(record[key]));
            }
          }
          for (const key of ['cause', 'detail', 'failure', 'webgpuError', 'wgpuError', 'error']) {
            const nested = record[key];
            const nestedPrefix = (prefix ? prefix + '.' : '') + key;
            if (nested !== undefined && nested !== null && typeof nested === 'object') {
              appendStructuredFailure(nested, nestedPrefix, depth + 1, seen, lines);
            } else if (nested !== undefined && nested !== null) {
              lines.push(nestedPrefix + ': ' + formatValue(nested));
            }
          }
          const knownKeys = new Set([
            'name',
            'code',
            'message',
            'expected',
            'hint',
            'reason',
            'cause',
            'detail',
            'failure',
            'webgpuError',
            'wgpuError',
            'error',
          ]);
          for (const key of Object.keys(record)) {
            if (knownKeys.has(key)) continue;
            const nested = record[key];
            const nestedPrefix = (prefix ? prefix + '.' : '') + key;
            if (nested !== null && typeof nested === 'object') {
              appendStructuredFailure(nested, nestedPrefix, depth + 1, seen, lines);
            } else if (nested !== undefined) {
              lines.push(nestedPrefix + ': ' + formatValue(nested));
            }
          }
        };
        const formatStartupFailure = (reason) => {
          if (reason !== null && typeof reason === 'object') {
            const lines = [];
            appendStructuredFailure(reason, '', 0, new Set(), lines);
            if (lines.length > 0) return lines.join('\\n');
            try {
              return JSON.stringify(reason) || 'Unknown structured startup failure';
            } catch {
              return 'Unserializable structured startup failure';
            }
          }
          return String(reason ?? 'Unknown startup failure');
        };
        const show = (reason) => {
          if (!fatalEnabled || phase === 'entered' || phase === 'destroyed') return;
          if (phase !== 'failed') {
            phase = 'failed';
            setInputEnabled(false);
            clearStartupWork();
            // Keep the fatal Reload control alive after startup listeners are
            // retired. Repeated failures are still allowed to refresh the
            // structured diagnostic on the same terminal surface.
            cleanupStartupListeners({ preserveFatalReload: true });
          }
          const details = formatStartupFailure(reason);
          const notice = fatal;
          if (!(notice instanceof HTMLElement)) return;
          let message = 'Unable to start the game.';
          if (/webgpu|adapter-unavailable|no usable (rendering )?backend/i.test(details)) {
            message += '\\n\\nRenderer diagnosis: ForgeaX supports browser WebGPU and a wgpu/WebGL2 fallback. This failure alone does not prove that WebGPU is unsupported; use the structured code, hint, and nested backend causes above.';
          }
          // Keep the existing plain-text diagnostic fallback for hosts that
          // provide only one synthetic HTMLElement in a test harness.
          if (fatalMessage === notice) {
            notice.textContent = 'ForgeaX game failed to start.\\n' + message + '\\n' + details;
          } else {
            setText(fatalMessage, message);
            setText(fatalDetails, details);
          }
          setDisplay(loading, 'none');
          setDisplay(notice, 'grid');
          setDisplay(fatalReload, 'inline-block');
          setAttribute(loading, 'aria-hidden', 'true');
          setAttribute(loading, 'data-fading', 'false');
          if (!query.has('forgeaxWorkspace') && fatalReload !== null && fatalReload instanceof HTMLElement) fatalReload.focus?.();
        };
        const prepare = () => {
          if (!gamePage || phase !== 'loading') return;
          phase = 'preparing';
          latestSubmitted = undefined;
          submittedFrames = new Set();
          setText(loadingStatus, 'Preparing scene…');
          armSlowTimer();
        };
        const enter = (event) => {
          if (!gamePage || phase !== 'preparing') return;
          if (event === null || typeof event !== 'object') return;
          if (expectedSession === undefined || event.worldIdentity !== expectedSession) return;
          if (
            !Number.isSafeInteger(event.frameId) ||
            event.frameId < 0 ||
            !Number.isSafeInteger(event.deviceGeneration) ||
            event.deviceGeneration < 0
          ) return;
          if (
            latestSubmitted === undefined ||
            event.deviceGeneration !== latestSubmitted.deviceGeneration ||
            (latestSubmitted.worldIdentity !== undefined &&
              event.worldIdentity !== latestSubmitted.worldIdentity) ||
            !submittedFrames.has(
              submissionKey(event.worldIdentity, event.deviceGeneration, event.frameId),
            )
          ) return;
          submittedFrames.delete(
            submissionKey(event.worldIdentity, event.deviceGeneration, event.frameId),
          );
          // A pending completion is still a terminal receipt for this
          // submitted candidate. Retire it before checking presentation so a
          // later forged/replayed ready event cannot reuse the same frame.
          if (event.presentation !== 'ready') return;
          if (phase === 'fading') return;
          phase = 'fading';
          clearStartupWork();
          setInputEnabled(false);
          const fadeGeneration = sessionGeneration;
          setAttribute(loading, 'data-fading', 'true');
          setAttribute(loading, 'aria-hidden', 'true');
          fadeTimer = setStartupTimeout(() => {
            if (phase !== 'fading' || fadeGeneration !== sessionGeneration) return;
            phase = 'entered';
            setInputEnabled(true);
            setDisplay(loading, 'none');
            setAttribute(loading, 'data-fading', 'false');
            cleanupStartupListeners();
          }, fadeDurationMs);
        };
        const destroy = () => {
          if (phase === 'entered' || phase === 'failed' || phase === 'disabled' || phase === 'destroyed') return;
          phase = 'destroyed';
          setInputEnabled(false);
          clearStartupWork();
          cleanupStartupListeners();
        };
        const onSubmitted = (event) => {
          const detail = event?.detail;
          if (
            detail !== null &&
            typeof detail === 'object' &&
            Number.isSafeInteger(detail.frameId) &&
            detail.frameId >= 0 &&
            Number.isSafeInteger(detail.deviceGeneration) &&
            detail.deviceGeneration >= 0 &&
            expectedSession !== undefined &&
            detail.worldIdentity === expectedSession
          ) {
            if (
              latestSubmitted !== undefined &&
              detail.deviceGeneration !== latestSubmitted.deviceGeneration
            ) {
              submittedFrames = new Set();
            }
            latestSubmitted = {
              frameId: detail.frameId,
              deviceGeneration: detail.deviceGeneration,
              worldIdentity: detail.worldIdentity,
            };
            submittedFrames.add(
              submissionKey(detail.worldIdentity, detail.deviceGeneration, detail.frameId),
            );
          }
        };
        const onCompleted = (event) => enter(event?.detail);
        const onVisibilityChange = () => {
          if (isForeground()) {
            armSlowTimer();
          } else {
            accountForegroundTime();
            clearStartupTimeout(slowTimer);
            slowTimer = undefined;
          }
        };
        const onPageHide = () => destroy();
        const onError = (event) => {
          if (event?.error !== undefined) {
            show(event.error);
            return;
          }
          const target = event?.target;
          const source =
            target !== null &&
            target !== undefined &&
            (typeof target.src === 'string' || typeof target.href === 'string')
              ? target.src ?? target.href
              : undefined;
          if (source !== undefined || event?.message !== undefined) {
            show({
              name: 'ScriptResourceError',
              message: event?.message ?? 'startup resource failed to load',
              ...(source === undefined ? {} : { detail: { source } }),
            });
            return;
          }
          show(event);
        };
        const onUnhandledRejection = (event) => show(event?.reason ?? event);
        const cleanupStartupListeners = (options = {}) => {
          if (startupListenersCleaned) return;
          startupListenersCleaned = true;
          if (canvas !== null && typeof canvas.removeEventListener === 'function') {
            canvas.removeEventListener('forgeax:frame-submitted', onSubmitted);
            canvas.removeEventListener('forgeax:frame-completed', onCompleted);
          }
          if (typeof window.removeEventListener === 'function') {
            window.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('pagehide', onPageHide);
            window.removeEventListener('error', onError, { capture: true });
            window.removeEventListener('unhandledrejection', onUnhandledRejection);
          }
          removeStartupInputCapture();
          if (loadingReload !== null && typeof loadingReload.removeEventListener === 'function') {
            loadingReload.removeEventListener('click', reload);
            loadingReload.removeEventListener('keydown', onStartupControlKey);
            loadingReload.removeEventListener('keyup', onStartupControlKey);
          }
          if (
            !options.preserveFatalReload &&
            fatalReload !== null &&
            typeof fatalReload.removeEventListener === 'function'
          ) {
            fatalReload.removeEventListener('click', reload);
            fatalReload.removeEventListener('keydown', onStartupControlKey);
            fatalReload.removeEventListener('keyup', onStartupControlKey);
          }
        };
        if (
          loadingReload !== null &&
          loadingReload instanceof HTMLElement &&
          typeof loadingReload.addEventListener === 'function'
        ) loadingReload.addEventListener('click', reload);
        if (
          loadingReload !== null &&
          loadingReload instanceof HTMLElement &&
          typeof loadingReload.addEventListener === 'function'
        ) {
          loadingReload.addEventListener('keydown', onStartupControlKey);
          loadingReload.addEventListener('keyup', onStartupControlKey);
        }
        if (
          fatalReload !== null &&
          fatalReload instanceof HTMLElement &&
          typeof fatalReload.addEventListener === 'function'
        ) fatalReload.addEventListener('click', reload);
        if (
          fatalReload !== null &&
          fatalReload instanceof HTMLElement &&
          typeof fatalReload.addEventListener === 'function'
        ) {
          fatalReload.addEventListener('keydown', onStartupControlKey);
          fatalReload.addEventListener('keyup', onStartupControlKey);
        }
        if (gamePage) {
          if (canvas !== null && typeof canvas.addEventListener === 'function') {
            canvas.addEventListener('forgeax:frame-submitted', onSubmitted);
            canvas.addEventListener('forgeax:frame-completed', onCompleted);
          }
          window.addEventListener('visibilitychange', onVisibilityChange);
          window.addEventListener('pagehide', onPageHide);
          bindStartupInputCapture();
        }
        if (fatalEnabled) {
          // Keep module/resource errors observable even when a workspace or
          // preview page intentionally starts with no loading overlay.
          window.addEventListener('error', onError, { capture: true });
          window.addEventListener('unhandledrejection', onUnhandledRejection);
        }
        if (gamePage) {
          armSlowTimer();
        } else {
          setDisplay(loading, 'none');
        }
        const bindSession = (session) => {
          if (typeof session !== 'string' || session.length === 0) return;
          if (phase === 'entered' || phase === 'failed' || phase === 'destroyed') return;
          if (expectedSession === session) return;
          expectedSession = session;
          sessionGeneration += 1;
          latestSubmitted = undefined;
          submittedFrames = new Set();
          if (phase === 'loading' || phase === 'preparing' || phase === 'fading') {
            accountForegroundTime();
            clearStartupWork();
            phase = 'loading';
            setInputEnabled(false);
            setDisplay(loading, 'grid');
            setDisplay(fatal, 'none');
            setAttribute(loading, 'aria-hidden', 'false');
            setAttribute(loading, 'data-fading', 'false');
            setText(loadingStatus, 'Loading…');
            armSlowTimer();
          }
        };
        globalThis.__forgeaxStartup = Object.freeze({
          prepare,
          enter,
          fail: show,
          destroy,
          bindInput,
          bindSession,
        });
      })();
    </script>
    <script>
      (() => {
        // This inert marker keeps generated pages inspectable by older hosts
        // that only parse the fatal diagnostic hook.
        const startupFailureText = 'ForgeaX game failed to start.\\n' + 'Unable to start the game.';
        void startupFailureText;
      })();
    </script>
    <script type="module">
      await new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve);
        else resolve();
      });
      try {
        await import('./main.ts');
      } catch (error) {
        globalThis.__forgeaxStartup?.fail?.(error);
      }
    </script>
  </body>
</html>
`;
}

export async function materializeViteDevPort(port: number): Promise<number> {
  if (port !== 0) return port;
  const reservation = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    reservation.once('error', rejectListen);
    reservation.listen(0, '127.0.0.1', resolveListen);
  });
  const address = reservation.address();
  const assigned = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose, rejectClose) => {
    reservation.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
  if (assigned === 0) throw new Error('OS did not assign an ephemeral preview port');
  return assigned;
}

/** Run one DevKit command as a Cordis-owned business plugin. */
export async function buildProjectWithHost(
  options: BuildOptions = {},
): Promise<CommandResult<unknown>> {
  let result: CommandResult<unknown> | undefined;
  let host: BackendHost | undefined;
  try {
    host = await createBackendHost({
      startupTimeoutMs: 30 * 60_000,
      startupPlugins: [
        {
          name: 'forgeax:devkit-build',
          async apply() {
            const facts = await readProjectFacts(options.root);
            if (!facts.ok) {
              result = facts;
              return;
            }
            const previous = process.cwd();
            const base = options.base ?? '/';
            const outDir = resolve(facts.value.root, options.outDir ?? 'dist');
            try {
              process.chdir(facts.value.root);
              await viteBuild(await createViteConfig(facts.value, 'build', base, { outDir }));
              result = { ok: true, value: await writeDistManifest(facts.value, base, outDir) };
            } catch (cause) {
              result = { ok: false, error: commandError(cause, 'game-build-failed') };
            } finally {
              process.chdir(previous);
            }
          },
        },
      ],
    });
    return (
      result ?? {
        ok: false,
        error: {
          code: 'game-build-failed',
          expected: 'the DevKit build plugin to publish a result',
          hint: 'Inspect the DevKit host startup diagnostics.',
          detail: {},
        },
      }
    );
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'game-build-failed') };
  } finally {
    await host?.dispose();
  }
}

/** Start the Vite development service under one backend Host business plugin. */
export async function startDevProjectWithHost(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  let result: CommandResult<unknown> | undefined;
  let started = false;
  let host: BackendHost | undefined;
  try {
    host = await createBackendHost({
      startupTimeoutMs: 30 * 60_000,
      startupPlugins: [
        {
          name: 'forgeax:devkit-dev-server',
          async apply(ctx) {
            const facts = await readProjectFacts(options.root);
            if (!facts.ok) {
              result = facts;
              return;
            }
            const previous = process.cwd();
            let changedDirectory = false;
            let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
            let closed = false;
            const closeServer = async (): Promise<void> => {
              if (closed) return;
              closed = true;
              await server?.close();
              if (changedDirectory) process.chdir(previous);
            };
            try {
              const port = resolveProjectPort(options.port);
              const vitePort = {
                ...port,
                host: '127.0.0.1' as const,
                port: await materializeViteDevPort(port.port),
              };
              process.chdir(facts.value.root);
              changedDirectory = true;
              server = await createViteServer(
                await createViteConfig(facts.value, 'serve', '/', { server: vitePort }),
              );
              // Vite invokes configureServer before listen but does not wait
              // for async producer work started by that hook. The Pack plugin
              // owns the accepted Catalog/DDC generation; fence the dev host
              // on that owner before exposing a URL to the live browser. This
              // prevents a slow software adapter from observing the raw scan
              // (Catalog row present, Pack body absent) during cold startup.
              const packPlugin = server.config.plugins.find(
                (plugin) => plugin.name === 'forgeax:pack',
              ) as { readonly ready?: () => Promise<void> } | undefined;
              await packPlugin?.ready?.();
              ctx.effect(() => closeServer, 'devkit/dev-server');
              await server.listen(vitePort.port);
              if (options.json !== true) server.printUrls();
              result = {
                ok: true,
                value: {
                  root: facts.value.root,
                  urls: server.resolvedUrls,
                  mode: 'dev',
                  serves: 'source',
                  capabilities: {
                    'rhi.capture': {
                      available: false,
                      realm: 'host',
                      reason: 'standalone-dev-server-has-no-live-app-cli-attachment',
                    },
                  },
                },
              };
              started = true;
            } catch (cause) {
              await closeServer().catch(() => {});
              result = { ok: false, error: commandError(cause, 'dev-server-failed') };
            }
          },
        },
      ],
    });
    const finalResult =
      result ??
      ({
        ok: false,
        error: {
          code: 'dev-server-failed',
          expected: 'the DevKit development plugin to publish a result',
          hint: 'Inspect the DevKit host startup diagnostics.',
          detail: {},
        },
      } satisfies CommandResult<unknown>);
    if (started) activeDevKitHosts.add(host);
    else await host.dispose();
    return finalResult;
  } catch (cause) {
    await host?.dispose();
    return { ok: false, error: commandError(cause, 'dev-server-failed') };
  }
}

/** Start static dist preview under one DevKit plugin and verify its manifest first. */
export async function startPreviewProjectWithHost(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  let result: CommandResult<unknown> | undefined;
  let started = false;
  let host: BackendHost | undefined;
  try {
    host = await createBackendHost({
      startupTimeoutMs: 30 * 60_000,
      startupPlugins: [
        {
          name: 'forgeax:devkit-preview-server',
          async apply(ctx) {
            const root = resolve(options.root ?? process.cwd());
            const verified = await verifyDist(resolve(root, 'dist'));
            if (!verified.ok) {
              result = verified;
              return;
            }
            try {
              const port = resolveProjectPort(options.port);
              const server = await vitePreview({
                root,
                configFile: false,
                base: verified.value.base,
                preview: {
                  open: false,
                  ...port,
                  headers: {
                    'Cross-Origin-Opener-Policy': 'same-origin',
                    'Cross-Origin-Embedder-Policy': 'require-corp',
                    'Cross-Origin-Resource-Policy': 'cross-origin',
                  },
                },
                build: { outDir: resolve(root, 'dist') },
              });
              ctx.effect(() => () => server.close(), 'devkit/preview-server');
              if (options.json !== true) server.printUrls();
              result = {
                ok: true,
                value: {
                  root,
                  urls: server.resolvedUrls,
                  mode: 'preview',
                  serves: 'dist',
                  capabilities: {
                    'rhi.capture': {
                      available: false,
                      realm: 'host',
                      reason: 'static-dist-host-does-not-install-dev-capture',
                    },
                  },
                },
              };
              started = true;
            } catch (cause) {
              result = { ok: false, error: commandError(cause, 'preview-server-failed') };
            }
          },
        },
      ],
    });
    const finalResult =
      result ??
      ({
        ok: false,
        error: {
          code: 'preview-server-failed',
          expected: 'the DevKit preview plugin to publish a result',
          hint: 'Inspect the DevKit host startup diagnostics.',
          detail: {},
        },
      } satisfies CommandResult<unknown>);
    if (started) activeDevKitHosts.add(host);
    else await host.dispose();
    return finalResult;
  } catch (cause) {
    await host?.dispose();
    return { ok: false, error: commandError(cause, 'preview-server-failed') };
  }
}

const projectRebuilds = new WeakMap<ViteDevServer, { tail: Promise<void>; generation: number }>();

export async function createViteConfig(
  facts: ProjectFacts,
  command: 'serve' | 'build',
  base = '/',
  options: {
    readonly bootstrapRoot?: BootstrapRoot;
    readonly outDir?: string;
    readonly server?: ProjectPortOptions;
    readonly host?: DevKitHostBinding;
    readonly sessionGeneration?: number;
  } = {},
): Promise<InlineConfig> {
  const startedAt = performance.now();
  let previousAt = startedAt;
  const timing = (stage: string): void => {
    if (process.env.FORGEAX_WORKSPACE_TIMING !== '1' || !options.host?.workspace) return;
    const now = performance.now();
    console.error(
      '[forgeax.vite-config.timing]',
      JSON.stringify({
        root: facts.root,
        targetId: options.host.workspace.targetId,
        stage,
        totalMs: Math.round(now - startedAt),
        stageMs: Math.round(now - previousAt),
      }),
    );
    previousAt = now;
  };
  const bootstrapRoot = options.bootstrapRoot ?? 'project-bootstrap';
  // The CI browser profile keeps the normal producer and catalog contracts,
  // but may defer materialization until the first real GUID request. This
  // shortens cold smoke startup without changing build mode or local defaults.
  // Plugin roots must be materialized before their program modules activate.
  // Deferring the owning pack can create a cycle between program import and
  // the first plugin-definition read. Asset-only projects keep the cheaper
  // on-demand path used by browser CI.
  const hasPluginRoots = facts.roots.engine !== undefined || facts.roots.frontend !== undefined;
  const producerReadiness =
    process.env.FORGEAX_DEV_PACK_READINESS === 'on-demand' && !hasPluginRoots
      ? 'on-demand'
      : undefined;
  if (
    options.host !== undefined &&
    (command !== 'serve' || bootstrapRoot !== 'project-bootstrap')
  ) {
    hostBindingError('host binding requires a main-thread project development server');
  }
  if (options.host) {
    validateHostBinding(options.host);
    const externalRoot = (options.host.frontendAssembly ?? options.host.backend.assembly.current)
      .root;
    const workspacePreview = options.host.workspace && options.host.workspace.execution !== 'game';
    if (
      !workspacePreview &&
      options.host.workspace?.execution !== 'game' &&
      externalRoot &&
      facts.roots.frontend
    )
      hostBindingError('compose external and project frontend roots explicitly before binding');
    await options.host.backend.context.get('devkitBackend')?.assertCurrent();
  }
  // The canonical kit ships the engine's default environment (sky.hdr equirect).
  // Authored scenes (e.g. the default game template) reference it as a Skylight /
  // SkyboxBackground dependency, so a self-contained standalone build must catalog
  // it on the game path too — not only the tool-preview (resource-bootstrap) path.
  const canonicalKit = await resolveCanonicalKit();
  timing('canonical-kit');
  const generatedBase = resolve(facts.root, '.forgeax', 'generated');
  await mkdir(generatedBase, { recursive: true });
  // Each serving host owns its executable entry; build never overwrites a live page.
  const generated =
    command === 'serve' ? await mkdtemp(resolve(generatedBase, 'serve-')) : generatedBase;
  let disposePreparation: (() => Promise<void>) | undefined;
  try {
    const realProjectRoot = await realpath(facts.root);
    const realGeneratedRoot = await realpath(generated);
    const projectRoots = facts.assetRoots.map((root) => resolve(facts.root, root));
    const ignorePath =
      bootstrapRoot === 'resource-bootstrap'
        ? isResourcePreviewIgnoredPath
        : isProjectSourceIgnoredPath;
    const scanned = await scanInventory(projectRoots, {
      ignorePath: (path) => isPluginAssetSourceIgnoredPath(facts.root, path),
    });
    timing('project-inventory');
    if (!scanned.ok) throw scanned.error;
    const inventory = {
      declarations: new Map([...scanned.value.declarations].filter(([path]) => !ignorePath(path))),
    };
    const builtinPack = await prepareBuiltinPack(inventory, generated);
    timing('builtin-pack');
    const materialPackages = await discoverMaterialPackages(inventory);
    timing('material-packages');
    // The plugin scan is a superset of the builtins/material scan. Reuse its
    // validated declarations instead of loading every authored Pack twice.
    const sourceInventory = await discoverPluginAssets(facts, scanned.value);
    timing('plugin-assets');
    const toolProjection = await projectToolProjection(facts.root, sourceInventory);
    timing('tool-projection');
    const projectTools = toolProjection.tools;
    const workspacePreview =
      options.host?.workspace !== undefined && options.host.workspace.execution !== 'game';
    const projectAssembly = createHostAssembly({
      sessionGeneration: options.sessionGeneration ?? 1,
    });
    const assembly =
      options.host && options.host.workspace?.execution !== 'game'
        ? composeBoundHostAssembly(options.host, projectAssembly)
        : projectAssembly;
    await Promise.all([
      writeFile(
        resolve(generated, 'index.html'),
        htmlSource(facts.name, bootstrapRoot === 'project-bootstrap'),
      ),
      writeFile(
        resolve(generated, 'main.ts'),
        hostSource(
          facts,
          generated,
          bootstrapRoot,
          canonicalKit?.guid,
          options.host,
          process.env.FORGEAX_ENGINE_RHI_DEBUG === '1',
          command === 'serve',
          assembly,
        ),
      ),
      writeFile(resolve(generated, 'runtime-packs.ts'), runtimePacksSource),
      writeFile(
        resolve(generated, 'execution-bootstrap.ts'),
        executionBootstrapSource(facts, generated, bootstrapRoot, assembly.sessionGeneration),
      ),
    ]);
    timing('generated-files');
    const roots = [
      ...projectRoots,
      ...(builtinPack === undefined ? [] : [builtinPack]),
      ...(canonicalKit === undefined ? [] : [canonicalKit.root]),
    ];
    const engineWorkspaceRoot = findEngineWorkspaceRoot();
    const runtimeBinding = createStandaloneRuntimeAssetBinding(facts.id);
    const engineWorkspaceResolver = await createEngineWorkspaceResolver(facts.root);
    timing('engine-resolver');
    const consumerAliases = await consumerEngineAliases(facts.root);
    timing('consumer-aliases');
    const frontendAlias = await hostFrontendModuleAlias(options.host);
    timing('frontend-alias');
    const cookerSession = await loadProjectCookers(
      facts,
      [createMaterialPackCooker(roots), createParticleCodeNativeCookerFromRoots(roots)],
      {
        resolve: { alias: consumerAliases, dedupe: ['@forgeax/engine'] },
        plugins: engineWorkspaceResolver === undefined ? [] : [engineWorkspaceResolver],
      },
    );
    timing('project-cookers');
    disposePreparation = () => cookerSession.dispose();
    let sessionClosed = false;
    const builtinImporterKeys = new Set(DEFAULT_IMPORTERS.map((importer) => importer.key));
    for (const importer of cookerSession.importers)
      if (builtinImporterKeys.has(importer.key))
        throw new TypeError(`duplicate builtin/project importer ${importer.key}`);
    const pack = pluginPack({
      roots,
      runtimeBinding,
      // The catalog is consumed by project tools and editors, regardless of
      // where this DevKit package or Vite's generated entry lives. Keep
      // project assets rooted in the authored project; external dependencies
      // retain their physical identity and the Pack fallback policy.
      sourceIdentityFor: (sourcePath) => {
        const authored = relative(facts.root, sourcePath);
        return authored &&
          authored !== '..' &&
          !authored.startsWith(`..${sep}`) &&
          !isAbsolute(authored)
          ? authored
          : sourcePath;
      },
      ...(producerReadiness === undefined ? {} : { producerReadiness }),
      ddc: devKitDdcRoots(facts.root),
      watch: false,
      importers: [...DEFAULT_IMPORTERS, ...cookerSession.importers],
      cookers: cookerSession.cookers,
      ignorePath,
    });
    // Vite creates the replacement server before closing the old one during restart.
    const generatedServers = new Set<ViteDevServer>();
    const plugins: Plugin[] = [
      executionWorkerEntries(),
      ...(command === 'serve'
        ? [
            {
              name: 'forgeax:generated-host-owner',
              configureServer(server: ViteDevServer) {
                generatedServers.add(server);
                const close = server.close.bind(server);
                server.close = async () => {
                  try {
                    await close();
                  } finally {
                    for (const environment of Object.values(server.environments))
                      environment.moduleGraph.invalidateAll();
                    if (generatedServers.delete(server) && generatedServers.size === 0) {
                      await rm(generated, { recursive: true, force: true });
                    }
                  }
                };
              },
            },
          ]
        : []),
      ...(engineWorkspaceResolver === undefined ? [] : [engineWorkspaceResolver]),

      ...(command === 'serve' && process.env.FORGEAX_ENGINE_RHI_DEBUG === '1'
        ? [vitePluginRhiDebug({ rootDir: facts.root }) as Plugin]
        : []),
      forgeaxShader({ materialPackages }) as Plugin,
      pack,
      ...(command === 'serve'
        ? [
            devKitHostBridge(facts, bootstrapRoot, options.host, async () => {
              await pack.ready();
              timing('pack-ready');
              const inventory = await publishedPluginInventory(facts.root, sourceInventory, pack);
              timing('published-plugin-inventory');
              const root =
                bootstrapRoot === 'resource-bootstrap' || workspacePreview || !facts.roots.frontend
                  ? undefined
                  : inventory.assets.get(facts.roots.frontend);
              if (
                facts.roots.frontend &&
                bootstrapRoot !== 'resource-bootstrap' &&
                !workspacePreview &&
                !root
              )
                throw new Error(`host root ${facts.roots.frontend} has no published definition`);
              return createHostAssembly({
                ...assembly,
                ...(root ? { root: pluginRootDescriptor(root.definition) } : {}),
              });
            }),
          ]
        : []),
      pluginRuntimeProjection(facts.root, sourceInventory.sourceInputs),
      pluginProgramsBuild({
        projectRoot: facts.root,
        tools: projectTools,
        roots: bootstrapRoot === 'resource-bootstrap' || workspacePreview ? {} : facts.roots,
        inventory: () => publishedPluginInventory(facts.root, sourceInventory, pack),
        binding: runtimeBinding,
        pack,
      }),
      {
        name: 'forgeax:project-session',
        async closeBundle() {
          sessionClosed = true;
          await cookerSession.dispose();
        },
        configureServer(server) {
          server.watcher.add([...roots, ...sourceInventory.sourceInputs.keys()]);
        },
        hotUpdate(context) {
          if (this.environment.name !== 'client') return [];
          if (context.file.startsWith(`${generated}${sep}`)) return;
          if (options.host?.frontendModule)
            hostBindingError(
              'external frontend modules are immutable; supply a new revision/binding and replace the page',
            );
          if (relative(facts.root, context.file).split(sep).includes('.forgeax')) return;
          const definitions = new Set([
            ...[...sourceInventory.assets.values()].flatMap((record) => [
              record.sourcePath,
              record.module,
            ]),
            ...cookerSession.watchFiles,
            ...projectTools.flatMap((tool) => [
              tool.moduleName,
              ...(tool.executor ? [tool.executor] : []),
            ]),
          ]);
          const visited = new Set<import('vite').ModuleNode>();
          const belongsToPlugin = (module: import('vite').ModuleNode): boolean => {
            if (visited.has(module)) return false;
            visited.add(module);
            if (module.file && definitions.has(module.file)) return true;
            return [...module.importers].some(belongsToPlugin);
          };
          const projectInput = [
            'forge.json',
            'package.json',
            'pnpm-lock.yaml',
            'bun.lock',
            'package-lock.json',
          ].some((file) => context.file === resolve(facts.root, file));
          const sessionSource =
            projectInput ||
            sourceInventory.sourceInputs.has(context.file) ||
            definitions.has(context.file) ||
            [...(context.server.moduleGraph.getModulesByFile(context.file) ?? [])].some(
              belongsToPlugin,
            );
          const underRoot = roots.some(
            (root) =>
              context.file.startsWith(`${root}/`) || context.file.startsWith(`${root}${sep}`),
          );
          if (!sessionSource && !underRoot) return;
          if (!sessionSource && underRoot) {
            void pack
              .rebuildCatalogInPlace([context.file])
              .then((published) => {
                if (!published) return;
                try {
                  options.host?.backend.context.get('engineWorkspaceCatalog')?.notePublished();
                } catch {
                  // A game host has no workspace catalog publisher.
                }
              })
              .catch((cause) => {
                const error = cause instanceof Error ? cause : new Error(String(cause));
                context.server.config.logger.error(error.message);
              });
            return [];
          }
          let queue = projectRebuilds.get(context.server);
          if (!queue) {
            queue = { tail: Promise.resolve(), generation: assembly.sessionGeneration };
            projectRebuilds.set(context.server, queue);
          }
          const owner = queue;
          let replacementStarted = false;
          const next = owner.tail
            .catch(() => {})
            .then(async () => {
              // Finish Vite's per-environment dispatch before replacing its environment objects.
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              if (sessionClosed) return;
              const facts = await readProjectFacts(realProjectRoot);
              if (!facts.ok) throw facts.error;
              await options.host?.backend.context.get('devkitBackend')?.assertCurrent();
              const generation = owner.generation + 1;
              const validated = await discoverPluginAssets(facts.value);
              const candidate = await createViteConfig(facts.value, 'build', base, {
                sessionGeneration: generation,
              });
              await viteBuild({ ...candidate, build: { ...candidate.build, write: false } });
              if (sessionClosed) return;
              await assertPluginSourceInputs(validated, facts.value.root);
              const config = await createViteConfig(facts.value, 'serve', base, {
                ...options,
                sessionGeneration: generation,
              });
              try {
                if (sessionClosed)
                  throw new Error('project session closed during candidate preparation');
                await assertPluginSourceInputs(validated, facts.value.root);
              } catch (cause) {
                // This prepared server never acquired a Vite close owner.
                const owner = config.plugins
                  ?.flat()
                  .find(
                    (plugin) =>
                      plugin &&
                      typeof plugin === 'object' &&
                      'name' in plugin &&
                      plugin.name === 'forgeax:project-session',
                  ) as Plugin | undefined;
                if (typeof owner?.closeBundle === 'function')
                  await owner.closeBundle.call({} as never);
                if (typeof config.root === 'string')
                  await rm(config.root, { recursive: true, force: true });
                throw cause;
              }
              const bridge = context.server.config.plugins.find(
                (plugin) => plugin.name === 'forgeax:devkit-backend-host',
              ) as (Plugin & { releaseForRestart(): Promise<void> }) | undefined;
              replacementStarted = true;
              await bridge?.releaseForRestart();
              config.server = { ...context.server.config.inlineConfig.server, ...config.server };
              Object.assign(context.server.config.inlineConfig, config);
              await context.server.restart();
              if (context.server.config.root !== config.root)
                throw new Error('project session replacement failed; start a fresh server');
              owner.generation = generation;
              // Vite's websocket reconnection reloads the page after restart.
            });
          owner.tail = next;
          void next.catch((cause) => {
            if (sessionClosed && !replacementStarted) return;
            const error = cause instanceof Error ? cause : new Error(JSON.stringify(cause));
            context.server.config.logger.error(error.message);
            context.server.ws.send({
              type: 'error',
              err: { name: error.name, message: error.message, stack: error.stack ?? '' },
            });
          });
          return [];
        },
      },
    ];
    if (process.env.FORGEAX_WORKSPACE_TIMING === '1' && options.host?.workspace) {
      plugins.unshift({
        name: 'forgeax:workspace-vite-timing-start',
        configResolved() {
          timing('vite-config-resolved');
        },
        configureServer() {
          timing('vite-configure-server-start');
        },
      });
      plugins.push({
        name: 'forgeax:workspace-vite-timing-end',
        configureServer() {
          timing('vite-configure-server-end');
        },
      });
    }
    return {
      root: generated,
      logLevel: 'warn',
      customLogger: createLogger('warn', {
        allowClearScreen: false,
        console: new Console({ stdout: process.stderr, stderr: process.stderr }),
      }),
      base,
      configFile: false,
      publicDir: false,
      define: { 'import.meta.env.DEV': JSON.stringify(command === 'serve') },
      plugins,
      resolve: {
        alias: [...(frontendAlias === undefined ? [] : [frontendAlias]), ...consumerAliases],
        dedupe: ['@forgeax/engine'],
      },
      server: {
        ...options.server,
        headers: {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        },
        fs: {
          allow: [
            facts.root,
            realProjectRoot,
            generated,
            realGeneratedRoot,
            ...roots,
            ...(engineWorkspaceRoot === undefined ? [] : [engineWorkspaceRoot]),
            ...(frontendAlias === undefined ? [] : [dirname(frontendAlias.replacement)]),
          ],
        },
      },
      build: {
        target: 'esnext',
        outDir: options.outDir ?? resolve(facts.root, 'dist'),
        emptyOutDir: true,
        modulePreload: false,
        rollupOptions: {
          preserveEntrySignatures: 'strict',
          input: {
            index: resolve(realGeneratedRoot, 'index.html'),
            'execution-bootstrap': resolve(realGeneratedRoot, 'execution-bootstrap.ts'),
          },
          output: {
            entryFileNames: (chunk) =>
              chunk.name === 'execution-bootstrap'
                ? 'assets/execution-bootstrap.js'
                : 'assets/[name]-[hash].js',
          },
        },
      },
    };
  } catch (cause) {
    const failures: unknown[] = [cause];
    try {
      await disposePreparation?.();
    } catch (error) {
      failures.push(error);
    }
    if (command === 'serve') {
      try {
        await rm(generated, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    throw failures.length === 1
      ? cause
      : new AggregateError(failures, 'Project preparation and cleanup failed');
  }
}
