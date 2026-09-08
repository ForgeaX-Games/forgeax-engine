import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { BUILTIN_MESH_ASSETS } from '@forgeax/engine-pack/builtin';
import { scanInventory } from '@forgeax/engine-pack/scanner';
import { validateCanonicalKitReceipt } from '@forgeax/engine-preview';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding, type Importer } from '@forgeax/engine-types';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import type { InlineConfig, Plugin } from 'vite';
import { inspectEngineWorkspace, readEngineBinding } from './engine-binding.js';
import type { BootstrapRoot } from './host/base-host.js';
import type { ProjectFacts, ProjectPortOptions } from './types.js';

interface CatalogModule {
  readonly name: string;
  readonly realm: 'host' | 'engine';
}

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
  return ignoreDevKitCatalogPath(path) || path.endsWith('.wgsl.meta.json');
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
  projectRoots: readonly string[],
  generated: string,
  ignorePath: (path: string) => boolean,
): Promise<string | undefined> {
  const inventory = await scanInventory(projectRoots, { ignorePath });
  if (!inventory.ok) return undefined;
  const declared = new Set<string>();
  for (const declaration of inventory.value.declarations.values()) {
    if (declaration.format === 'pack.json') {
      for (const asset of declaration.value.assets) declared.add(asset.guid.toLowerCase());
      continue;
    }
    for (const asset of declaration.value.subAssets) declared.add(asset.guid.toLowerCase());
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

async function engineWorkspacePackages(
  workspaceRoot = findEngineWorkspaceRoot(),
): Promise<ReadonlyMap<string, EngineWorkspacePackage>> {
  if (workspaceRoot === undefined) return new Map<string, EngineWorkspacePackage>();
  const packageRoot = resolve(workspaceRoot, 'packages');
  // A generated game is a pnpm workspace too, but it does not own a local
  // `packages/` tree. Its installed Engine packages are resolved by Node;
  // the workspace resolver is only an SDK/source-checkout fallback.
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

function moduleSpecifier(from: string, to: string): string {
  const value = relative(from, to).split(sep).join('/');
  return value.startsWith('.') ? value : `./${value}`;
}

function catalogModules(facts: ProjectFacts): CatalogModule[] {
  const modules = new Map<string, CatalogModule>();
  const visit = (
    entries: ProjectFacts['plugins'],
    inheritedRealm: 'host' | 'engine' | 'build' = 'engine',
  ): void => {
    for (const entry of entries) {
      const realm = entry.realm ?? inheritedRealm;
      if (entry.group === true) {
        visit(entry.config as ProjectFacts['plugins'], realm);
        continue;
      }
      if (entry.name.startsWith('cordis:') || realm === 'build') continue;
      const current = modules.get(entry.name);
      if (current !== undefined && current.realm !== realm) {
        throw new Error(`plugin module ${entry.name} is assigned to multiple realms`);
      }
      modules.set(entry.name, { name: entry.name, realm });
    }
  };
  visit(facts.plugins);
  return [...modules.values()];
}

function catalogImport(facts: ProjectFacts, generated: string, name: string): string {
  const specifier = name.startsWith('.')
    ? moduleSpecifier(generated, resolve(facts.root, name))
    : name;
  return `() => import(${JSON.stringify(specifier)})`;
}

type JitiLoader = (id: string) => unknown;
type JitiFactory = (filename: string, options: { readonly esmResolve: boolean }) => JitiLoader;

function projectImporters(facts: ProjectFacts): readonly Importer[] {
  const specs = facts.assetImporters ?? [];
  if (specs.length === 0) return [];
  const createJiti = hostRequire('jiti') as JitiFactory;
  const load = createJiti(resolve(facts.root, 'package.json'), { esmResolve: true });
  return specs.map((spec) => {
    const separator = spec.lastIndexOf('#');
    const moduleSpecifier = separator < 0 ? spec : spec.slice(0, separator);
    const exportName = separator < 0 ? 'default' : spec.slice(separator + 1);
    const modulePath = moduleSpecifier.startsWith('.')
      ? resolve(facts.root, moduleSpecifier)
      : moduleSpecifier;
    const namespace = load(modulePath);
    if (namespace === null || typeof namespace !== 'object') {
      throw new Error(`project-asset-importer-module-invalid: ${spec}`);
    }
    const factory = (namespace as Record<string, unknown>)[exportName];
    if (typeof factory !== 'function') {
      throw new Error(`project-asset-importer-export-missing: ${spec}`);
    }
    const importer = factory();
    if (importer === null || typeof importer !== 'object') {
      throw new Error(`project-asset-importer-invalid: ${spec}`);
    }
    return importer as Importer;
  });
}

function hostSource(
  facts: ProjectFacts,
  bootstrapRoot: BootstrapRoot,
  canonicalEnvironmentGuid?: string,
): string {
  const generated = resolve(facts.root, '.forgeax', 'generated');
  const plugins =
    bootstrapRoot === 'resource-bootstrap'
      ? []
      : [
          `webAudioPlugin()`,
          `audioPlugin()`,
          `skinningPlugin()`,
          ...(facts.physics === undefined
            ? []
            : [`physicsPlugin('${facts.physics === '2d' ? 'rapier-2d' : 'rapier-3d'}')`]),
        ];
  const bootstrapPlugin =
    facts.bootstrapEntry === undefined
      ? ''
      : `const bootstrapModule = await import(${JSON.stringify(
          moduleSpecifier(generated, resolve(facts.root, facts.bootstrapEntry)),
        )});
if (typeof bootstrapModule.bootstrap !== 'function') {
  throw new Error('forgeax: project entry must export bootstrap(world, context)');
}
await app.pluginContext.plugin({
  name: 'project-entry-bootstrap',
  inject: ['gameHost'],
  async apply(ctx) {
    if (ctx.gameHost === undefined) throw new Error('forgeax: gameHost unavailable');
    await bootstrapModule.bootstrap(ctx.gameHost.app.world, ctx.gameHost);
  },
});`;
  return `import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createApp, createToolPreviewHost, createToolPreviewRecipe, fitToolPreviewCameraToAabb, gameHostPlugin, replayToolPreviewCapture } from '@forgeax/engine/app';
import { createCatalogSource } from '@forgeax/engine/assets-runtime';
import {
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from 'virtual:forgeax/pack-runtime';
import { installCatalogLoader, projectPluginEntries } from '@forgeax/engine/plugin/loader';
import { audioPlugin } from '@forgeax/engine/audio';
import { webAudioPlugin } from '@forgeax/engine/audio-webaudio';
import { physicsPlugin } from '@forgeax/engine/physics';
import { skinningPlugin } from '@forgeax/engine/skinning';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { mat4 } from '@forgeax/engine/math';
import { CAMERA_PROJECTION_ORTHOGRAPHIC, Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, Skylight, SkyboxBackground, TONEMAP_NONE, TONEMAP_REINHARD_EXTENDED } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { type SceneAsset } from '@forgeax/engine/types';
import { ParticleEffectPlayer, vfxGpuEffectContribution } from '@forgeax/engine/vfx';
import { createVfxRuntimeHost } from '@forgeax/engine/vfx-render';

const pluginCatalog = new Map([
${catalogModules(facts)
  .map(
    ({ name, realm }) =>
      `  [${JSON.stringify(name)}, { realm: ${JSON.stringify(realm)}, load: ${catalogImport(facts, generated, name)} }],`,
  )
  .join('\n')}
]);
const pluginEntries = ${JSON.stringify(facts.plugins, null, 2)};
const bootstrapRoot = ${JSON.stringify(bootstrapRoot)};
const canonicalEnvironmentGuid = ${JSON.stringify(canonicalEnvironmentGuid ?? null)};
const resourceValue = new URLSearchParams(location.search).get('forgeax-resource-preview');
const resource = resourceValue === null ? undefined : JSON.parse(resourceValue);
const previewCameraEntities = new WeakMap();
const previewCameraTargets = new WeakMap();
let previewWorld;
const vfxRuntimeHost = resource?.kind === 'vfx'
  ? createVfxRuntimeHost({
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
            viewProjection: mat4.computeViewProj(
              mat4.create(),
              position,
              target,
              [0, 1, 0],
              camera.value.fov,
              camera.value.aspect,
              camera.value.near,
              camera.value.far,
            ),
          };
        },
      },
    })
  : undefined;

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
const resizeCanvas = () => {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
};
const resizeObserver = new ResizeObserver(resizeCanvas);
resizeObserver.observe(canvas);
resizeCanvas();
const runtimeScopeBinding = runtimeBinding;
if (runtimeScopeBinding === undefined) {
  throw new Error('forgeax: Vite Pack runtime binding is required in the generated host');
}
const assetCatalog = createCatalogSource({
  url: import.meta.env.DEV
    ? runtimeScopeBinding.catalogUrl
    : new URL('pack-index.json', document.baseURI).href,
  ...(import.meta.env.DEV ? { expectedScope: runtimeScopeBinding } : {}),
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
    if (import.meta.env.DEV) {
      assets.configureRuntimeBinding(runtimeScopeBinding);
    } else {
      assets.configurePackIndex(new URL('pack-index.json', document.baseURI).href);
    }
    assets.setCatalogSource(assetCatalog);
    if (vfxRuntimeHost !== undefined) {
      assets.installDecoder(vfxGpuEffectContribution.kind, vfxGpuEffectContribution.decoder);
    }
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

async function previewOwnerFacts(assets, resource, payload) {
  if (resource.kind === 'material') {
    const primaryPass = Array.isArray(payload.passes) ? payload.passes[0] : undefined;
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
    const mipCount = typeof payload.mipLevelCount === 'number' ? payload.mipLevelCount : 1;
    const filter = 'linear';
    return {
      subjectDigest: await previewDigest(payload),
      boundDigest: await previewDigest({ width: payload.width, height: payload.height, format: payload.format }),
      uvDigest: await previewDigest({ offset: [0, 0], scale: [1, 1], rotation: 0 }),
      bindingDigest: await previewDigest({ format: payload.format, colorSpace: payload.colorSpace, filter, mipCount }),
      format: payload.format,
      colorSpace: payload.colorSpace,
      filter,
      mipCount,
      dimensions: [payload.width, payload.height],
      payloadClass: 'color',
    };
  }
  return undefined;
}

async function prepareProject(app) {
await prepareAssetRegistry(app.assets);
previewWorld = app.world;
const assets = app.assets;
let canonicalEnvironment;
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
    canonicalEnvironment = app.world.allocSharedRef('EquirectAsset', environment.value);
  }
  if (resource.kind === 'vfx') {
    if (vfxRuntimeHost === undefined) throw new Error('VFX preview host was not created');
    const attached = await vfxRuntimeHost.attachWorld({ world: app.world, assets });
    if (!attached.ok) throw attached.error;
  }
  const loaded = await assets.loadByGuid(assets.parseGuid(resource.guid));
  if (!loaded.ok) throw loaded.error;
  const payload = loaded.value;
  if (resource.kind === 'vfx' && payload.kind !== 'particle-effect') {
    throw new Error(\`VFX preview expected ParticleEffectAsset, received \${payload.kind}\`);
  }
  const vfxBounds = resource.kind === 'vfx' ? previewVfxBounds(payload) : undefined;
  if (resource.kind === 'vfx' && vfxBounds === undefined) {
    throw new Error('VFX preview owner did not publish finite emitter bounds');
  }
  const meshMaterialHandles = resource.kind === 'mesh' && payload.kind === 'mesh'
    ? await Promise.all(payload.materialSlots.map(async (slot) => {
        if (slot.defaultMaterial === undefined) return 0;
        const material = await assets.loadByGuid(assets.parseGuid(slot.defaultMaterial));
        if (!material.ok) throw material.error;
        if (material.value.kind !== 'material') {
          throw new Error('mesh material slot resolved to a non-material asset');
        }
        return app.world.allocSharedRef('MaterialAsset', material.value);
      }))
    : undefined;
  const meshHandle = resource.kind === 'mesh' && payload.kind === 'mesh'
    ? app.world.allocSharedRef('MeshAsset', payload)
    : app.world.internSharedRef(
        'MeshAsset',
        createPrimitiveMesh(resource.kind === 'texture' ? 'quad' : 'sphere').unwrap(),
      );
  const textureHandle = resource.kind === 'texture' && payload.kind === 'texture'
    ? app.world.allocSharedRef('TextureAsset', payload)
    : undefined;
  if (textureHandle !== undefined && payload.kind === 'texture') {
    const bytes = payload.data instanceof Uint8ClampedArray
      ? new Uint8Array(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength)
      : payload.data;
    const uploaded = await app.renderer.store.uploadTexture(textureHandle, payload, {
      bytes,
      width: payload.width,
      height: payload.height,
      mime: 'image/png',
      colorSpace: payload.colorSpace,
      mipmap: payload.mipmap,
    });
    if (!uploaded.ok) throw uploaded.error;
  }
  const materialPayload = resource.kind === 'texture' && payload.kind === 'texture'
    ? Materials.unlit([1, 1, 1, 1], { baseColorTexture: textureHandle })
    : resource.kind === 'material' && payload.kind === 'material'
      ? payload
      : undefined;
  const materialHandle = materialPayload === undefined
    ? undefined
    : app.world.allocSharedRef('MaterialAsset', materialPayload);
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
  const textureWidth = resource.kind === 'texture' && payload.kind === 'texture' && typeof payload.width === 'number'
    ? Math.max(1, payload.width)
    : 1;
  const textureHeight = resource.kind === 'texture' && payload.kind === 'texture' && typeof payload.height === 'number'
    ? Math.max(1, payload.height)
    : 1;
  const textureAspect = textureWidth / textureHeight;
  const textureScale = textureAspect >= 1
    ? [textureAspect, 1, 1]
    : [1, 1 / textureAspect, 1];
  const center = meshFrame?.center ?? vfxBounds?.center ?? [(aabb[0] + aabb[3]) / 2, (aabb[1] + aabb[4]) / 2, (aabb[2] + aabb[5]) / 2];
  const radius = meshFrame?.radius ?? vfxBounds?.radius ?? Math.max(1, Math.hypot(aabb[3] - aabb[0], aabb[4] - aabb[1], aabb[5] - aabb[2]));
  const texturePreview = resource.kind === 'texture';
  if (resource.kind === 'vfx') {
    const effect = app.world.allocSharedRef('ParticleEffectAsset', payload);
    app.world.spawn(
      { component: Transform, data: { pos: center } },
      { component: ParticleEffectPlayer, data: { effect, playing: true, seed: 0, timeScale: 1 } },
    );
  } else {
    app.world.spawn(
      { component: Transform, data: { pos: center, ...(texturePreview ? { scale: textureScale } : {}) } },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: materialBindings === undefined ? {} : { materials: materialBindings } },
    );
  }
  const cameraData = texturePreview
    ? {
        fov: 0,
        aspect: 1,
        near: 0.01,
        far: 100,
        projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
        left: -textureScale[0] * 0.6,
        right: textureScale[0] * 0.6,
        bottom: -textureScale[1] * 0.6,
        top: textureScale[1] * 0.6,
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
  const cameraEntity = app.world.spawn({ component: Camera, data: cameraData }, { component: Transform, data: { pos: cameraPosition } }).unwrap();
  previewCameraEntities.set(app.world, cameraEntity);
  previewCameraTargets.set(app.world, center);
  if (!texturePreview) {
    app.world.spawn({ component: DirectionalLight, data: { direction: [-0.5, -1, -0.3], intensity: 2 } });
    if (canonicalEnvironment === undefined) throw new Error('canonical preview environment was not loaded');
    app.world.spawn({ component: Skylight, data: { equirect: canonicalEnvironment } });
    app.world.spawn({ component: SkyboxBackground, data: { equirect: canonicalEnvironment } });
  }
  const ownerFacts = await previewOwnerFacts(assets, resource, payload);
  const publishedAsset = resource.kind === 'mesh' && payload.kind === 'mesh' && payload.aabb !== undefined
    ? { ...payload, aabb: Array.from(payload.aabb) }
    : payload;
  return {
    kind: resource.kind,
    guid: resource.guid,
    asset: publishedAsset,
    ...(ownerFacts === undefined ? {} : { ownerFacts }),
  };
}
if (bootstrapRoot === 'resource-bootstrap') return;
let defaultScene;
let defaultSceneRoot;
const defaultSceneGuid = ${JSON.stringify(facts.defaultScene)};
if (defaultSceneGuid !== undefined) {
  const loaded = await assets.loadByGuid<SceneAsset>(assets.parseGuid(defaultSceneGuid));
  if (!loaded.ok) throw loaded.error;
  defaultScene = loaded.value;
  const handle = app.world.allocSharedRef('SceneAsset', loaded.value);
  const instantiated = assets.instantiate<SceneAsset>(handle, app.world);
  if (!instantiated.ok) throw instantiated.error;
  defaultSceneRoot = instantiated.value;
}
const uiRoot = document.querySelector('#game-ui');
await app.pluginContext.plugin(gameHostPlugin({
  app,
  assets,
  canvas,
  renderer: app.renderer,
  ...(defaultScene === undefined ? {} : { defaultScene }),
  ...(defaultSceneRoot === undefined ? {} : { defaultSceneRoot }),
  uiRoot: uiRoot instanceof HTMLElement ? uiRoot : document.body,
  setPointerLockAllowed: (allowed) => app.input?.setPointerLockAllowed?.(allowed),
}));
const { loader: pluginLoader } = await installCatalogLoader(app.pluginContext, pluginCatalog, 'engine');
await pluginLoader.root.update(projectPluginEntries(pluginEntries, 'engine'));
await pluginLoader.await();
}

const query = new URLSearchParams(location.search);
const recipeValue = query.get('forgeax-tool-recipe');
const snapshotValue = query.get('forgeax-tool-snapshot');
const runIdValue = query.get('forgeax-tool-run-id');
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
      ...(vfxRuntimeHost === undefined ? {} : { features: [vfxRuntimeHost.feature] }),
    },
    bundler,
    prepare: prepareProject,
    collectResourceFacts(app, current) {
      if (current === undefined) return current;
      if (resource?.kind !== 'vfx') {
        if (resource?.kind === 'material' || resource?.kind === 'mesh' || resource?.kind === 'texture') {
          if (app.renderer.drawCalls <= 0) return current;
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
          return {
            ...current,
            observation: current.ownerFacts,
          };
        }
        return current;
      }
      if (vfxRuntimeHost === undefined) return current;
      const hostInspection = vfxRuntimeHost.inspect(app.world);
      const player = hostInspection?.players[0];
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
      if (vfxRuntimeHost === undefined || previewWorld === undefined) return;
      const detached = await vfxRuntimeHost.detachWorld({ world: previewWorld });
      if (!detached.ok) throw detached.error;
    },
    executeAction(action) {
      return !globalThis.dispatchEvent(new CustomEvent('forgeax-tool-action', {
        detail: action,
        cancelable: true,
      }));
    },
  });
  if (!host.ok) {
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
} else {
  // WebDriver/headless browsers cannot satisfy the trusted-gesture requirement
  // for pointer lock. Keep the game running and let its keyboard fallback own
  // camera input; real browser users retain the normal click-to-lock path.
  const pointerLockAllowed =
    typeof navigator !== 'undefined' && navigator.webdriver === true ? () => false : undefined;
  const result = await createApp(
    canvas,
    {
      plugins: [${plugins.join(', ')}],
      ...(pointerLockAllowed === undefined ? {} : { pointerLockAllowed }),
    },
    bundler,
  );
  if (!result.ok) throw result.error;
  const app = result.value;
  await prepareProject(app);
${bootstrapPlugin}
  app.start().unwrap();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    resizeObserver.disconnect();
    void app.dispose();
  };
  window.addEventListener('pagehide', dispose);
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

function htmlSource(title: string): string {
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
      #app-shell { position: relative; }
      #game-ui { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
      #game-ui > * { pointer-events: auto; }
      #forgeax-fatal { position: fixed; inset: 0; z-index: 2147483647; display: none; place-items: center; padding: 24px; background: #0b0d10; color: #e6e6e6; font: 15px/1.6 system-ui, sans-serif; text-align: center; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div id="app-shell"><canvas id="app"></canvas><div id="game-ui"></div></div><div id="forgeax-fatal" role="alert"></div>
    <script>
      (() => {
        const appendStructuredFailure = (value, prefix, depth, seen, lines) => {
          if (value === null || typeof value !== 'object' || depth > 3) return;
          if (seen.has(value)) {
            lines.push((prefix || 'cause') + ': [circular]');
            return;
          }
          seen.add(value);
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
            if (typeof record[key] === 'string' && record[key].length > 0) {
              lines.push((prefix ? prefix + '.' : '') + key + ': ' + record[key]);
            }
          }
          for (const key of ['cause', 'detail', 'webgpuError', 'wgpuError', 'error']) {
            const nested = record[key];
            const nestedPrefix = (prefix ? prefix + '.' : '') + key;
            if (nested !== null && typeof nested === 'object') {
              appendStructuredFailure(nested, nestedPrefix, depth + 1, seen, lines);
            } else if (typeof nested === 'string' && nested.length > 0) {
              lines.push(nestedPrefix + ': ' + nested);
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
          const notice = document.querySelector('#forgeax-fatal');
          if (!(notice instanceof HTMLElement)) return;
          let message = formatStartupFailure(reason);
          if (/webgpu|adapter-unavailable|no usable (rendering )?backend/i.test(message)) {
            message += '\\n\\nRenderer diagnosis: ForgeaX supports browser WebGPU and a wgpu/WebGL2 fallback. This failure alone does not prove that WebGPU is unsupported; use the structured code, hint, and nested backend causes above.';
          }
          notice.textContent = 'ForgeaX game failed to start.\\n' + message;
          notice.style.display = 'grid';
        };
        window.addEventListener('error', (event) => show(event.error ?? event.message));
        window.addEventListener('unhandledrejection', (event) => show(event.reason));
      })();
    </script>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
`;
}

export async function createViteConfig(
  facts: ProjectFacts,
  command: 'serve' | 'build',
  base = '/',
  options: {
    readonly bootstrapRoot?: BootstrapRoot;
    readonly outDir?: string;
    readonly server?: ProjectPortOptions;
  } = {},
): Promise<InlineConfig> {
  const bootstrapRoot = options.bootstrapRoot ?? 'project-bootstrap';
  // The canonical kit ships the engine's default environment (sky.hdr equirect).
  // Authored scenes (e.g. the default game template) reference it as a Skylight /
  // SkyboxBackground dependency, so a self-contained standalone build must catalog
  // it on the game path too — not only the tool-preview (resource-bootstrap) path.
  const canonicalKit = await resolveCanonicalKit();
  const generated = resolve(facts.root, '.forgeax', 'generated');
  await mkdir(generated, { recursive: true });
  const projectRoots = facts.assetRoots.map((root) => resolve(facts.root, root));
  const ignorePath =
    bootstrapRoot === 'resource-bootstrap'
      ? isResourcePreviewIgnoredPath
      : isProjectSourceIgnoredPath;
  const builtinPack = await prepareBuiltinPack(projectRoots, generated, ignorePath);
  await Promise.all([
    writeFile(resolve(generated, 'index.html'), htmlSource(facts.name)),
    writeFile(resolve(generated, 'main.ts'), hostSource(facts, bootstrapRoot, canonicalKit?.guid)),
  ]);
  const roots = [
    ...projectRoots,
    ...(builtinPack === undefined ? [] : [builtinPack]),
    ...(canonicalKit === undefined ? [] : [canonicalKit.root]),
  ];
  const importers = [...projectImporters(facts)];
  const runtimeBinding = createStandaloneRuntimeAssetBinding(facts.id);
  const engineWorkspaceResolver = await createEngineWorkspaceResolver(facts.root);
  const consumerAliases = await consumerEngineAliases(facts.root);
  const plugins: Plugin[] = [
    ...(engineWorkspaceResolver === undefined ? [] : [engineWorkspaceResolver]),
    forgeaxShader() as Plugin,
    pluginPack({
      roots,
      runtimeBinding,
      ddc: devKitDdcRoots(facts.root),
      refresh: command === 'serve' ? reloadAssetHost() : undefined,
      importers: [
        audioImporter,
        imageImporter,
        fbxImporter,
        gltfImporter,
        fontImporter,
        ...importers,
      ],
      cookers: [createMaterialPackCooker(roots), createParticleCodeNativeCookerFromRoots(roots)],
      ignorePath,
    }) as Plugin,
  ];
  return {
    root: generated,
    base,
    configFile: false,
    publicDir:
      facts.assetPublicDir === undefined ? false : resolve(facts.root, facts.assetPublicDir),
    plugins,
    resolve: {
      alias: consumerAliases,
      dedupe: ['@forgeax/engine'],
    },
    server: { ...options.server, fs: { allow: [facts.root, ...roots] } },
    build: {
      target: 'esnext',
      outDir: options.outDir ?? resolve(facts.root, 'dist'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(generated, 'index.html') },
    },
  };
}
