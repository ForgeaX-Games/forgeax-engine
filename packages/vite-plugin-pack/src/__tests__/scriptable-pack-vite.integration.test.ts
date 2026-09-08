import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAnimationAsset } from '@forgeax/engine-animation';
import { createAssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createHostAudioConsumer, WebAudioEngine } from '@forgeax/engine-audio-webaudio';
import { World } from '@forgeax/engine-ecs';
import { resolveTilesetRuntime } from '@forgeax/engine-render/internal';
import { defaultAssetDecoderContributions } from '@forgeax/engine-runtime';
import {
  type Asset,
  createStandaloneRuntimeAssetBinding,
  type PackIndexEntry,
  type ParticleEffectAsset,
} from '@forgeax/engine-types';
import {
  loadVfxGpuEffect,
  PARTICLE_CODE_DEFAULT_MODULE_ID,
  ParticleEffectPlayer,
} from '@forgeax/engine-vfx';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { describe, expect, it, vi } from 'vitest';
import { classifyWatchedPath } from '../dev/watcher.js';
import { createPluginPackInternal } from '../plugin-pack.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

type Middleware = (
  request: {
    readonly url?: string;
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
  },
  response: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string | Uint8Array): void;
  },
  next: () => void,
) => void | Promise<void>;

async function request(
  middlewares: readonly Middleware[],
  url: string,
  method: 'GET' | 'POST' = 'GET',
  headers: Readonly<Record<string, string>> = {},
) {
  const result = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '' as string | Uint8Array,
  };
  for (const middleware of middlewares) {
    let next = false;
    await middleware(
      { url, method, headers },
      {
        get statusCode() {
          return result.statusCode;
        },
        set statusCode(value: number) {
          result.statusCode = value;
        },
        setHeader(name, value) {
          result.headers[name] = value;
        },
        end(body) {
          result.body = body ?? '';
        },
      },
      () => {
        next = true;
      },
    );
    if (!next) break;
  }
  return result;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for ScriptablePack rebuild');
}

const SCRIPTABLE_PACK_INTEGRATION_TIMEOUT_MS = 60_000;

const ALL_KINDS = [
  'mesh',
  'material',
  'scene',
  'texture',
  'equirect',
  'sampler',
  'font',
  'render-pipeline',
  'tileset',
  'video',
  'skeleton',
  'skin',
  'animation-clip',
  'animation-graph',
  'audio',
  'particle-effect',
] as const;

const ALL_KIND_GUIDS = Object.fromEntries(
  ALL_KINDS.map((kind, index) => [
    kind,
    `019ffa97-9000-7000-8000-${String(index + 1).padStart(12, '0')}`,
  ]),
) as Record<(typeof ALL_KINDS)[number], string>;

function allKindsSource(particleProgram: ParticleEffectAsset['program']): string {
  return `
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { err, ok } from '@forgeax/engine-types';
import type {
  AnimationClip,
  AnimationGraph,
  AudioClipAsset,
  EquirectAsset,
  FontAsset,
  MaterialAsset,
  MeshAsset,
  ParticleEffectAsset,
  RenderPipelineAsset,
  SamplerAsset,
  SceneAsset,
  SkeletonAsset,
  SkinAsset,
  TextureAsset,
  TilesetAsset,
  VideoAsset,
} from '@forgeax/engine-types';
import type {
  ScriptablePackAssetDeclarations,
  ScriptablePackDefinition,
} from '@forgeax/engine-pack/source';

const parseGuid = (value: string) => {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const ids = {
  mesh: parseGuid('019ffa97-9000-7000-8000-000000000001'),
  material: parseGuid('019ffa97-9000-7000-8000-000000000002'),
  scene: parseGuid('019ffa97-9000-7000-8000-000000000003'),
  texture: parseGuid('019ffa97-9000-7000-8000-000000000004'),
  equirect: parseGuid('019ffa97-9000-7000-8000-000000000005'),
  sampler: parseGuid('019ffa97-9000-7000-8000-000000000006'),
  font: parseGuid('019ffa97-9000-7000-8000-000000000007'),
  'render-pipeline': parseGuid('019ffa97-9000-7000-8000-000000000008'),
  tileset: parseGuid('019ffa97-9000-7000-8000-000000000009'),
  video: parseGuid('019ffa97-9000-7000-8000-000000000010'),
  skeleton: parseGuid('019ffa97-9000-7000-8000-000000000011'),
  skin: parseGuid('019ffa97-9000-7000-8000-000000000012'),
  'animation-clip': parseGuid('019ffa97-9000-7000-8000-000000000013'),
  'animation-graph': parseGuid('019ffa97-9000-7000-8000-000000000014'),
  audio: parseGuid('019ffa97-9000-7000-8000-000000000015'),
  'particle-effect': parseGuid('019ffa97-9000-7000-8000-000000000016'),
};
const assets = {
  mesh: { guid: ids.mesh, kind: 'mesh' },
  material: { guid: ids.material, kind: 'material' },
  scene: { guid: ids.scene, kind: 'scene' },
  texture: { guid: ids.texture, kind: 'texture' },
  equirect: { guid: ids.equirect, kind: 'equirect' },
  sampler: { guid: ids.sampler, kind: 'sampler' },
  font: { guid: ids.font, kind: 'font' },
  'render-pipeline': { guid: ids['render-pipeline'], kind: 'render-pipeline' },
  tileset: { guid: ids.tileset, kind: 'tileset' },
  video: { guid: ids.video, kind: 'video' },
  skeleton: { guid: ids.skeleton, kind: 'skeleton' },
  skin: { guid: ids.skin, kind: 'skin' },
  'animation-clip': { guid: ids['animation-clip'], kind: 'animation-clip' },
  'animation-graph': { guid: ids['animation-graph'], kind: 'animation-graph' },
  audio: { guid: ids.audio, kind: 'audio' },
  'particle-effect': { guid: ids['particle-effect'], kind: 'particle-effect' },
} satisfies ScriptablePackAssetDeclarations;
const externalAssets = {};
const mesh: MeshAsset = {
  kind: 'mesh',
  vertices: new Float32Array([
    0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0,
    1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0,
    0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0,
  ]),
  indices: new Uint16Array([0, 1, 2]),
  attributes: {
    position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normal: new Float32Array(9),
    uv: new Float32Array(6),
    tangent: new Float32Array(12),
  },
  submeshes: [{ topology: 'triangle-list', indexOffset: 0, indexCount: 3, vertexCount: 3, materialSlot: 0 }],
  materialSlots: [{ slotName: 'default' }],
};
const build = async () => {
  return ok({
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array([
        0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0,
        1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0,
        0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0,
      ]),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {
        position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normal: new Float32Array(9),
        uv: new Float32Array(6),
        tangent: new Float32Array(12),
      },
      submeshes: [{ topology: 'triangle-list', indexOffset: 0, indexCount: 3, vertexCount: 3, materialSlot: 0 }],
      materialSlots: [{ slotName: 'default' }],
    } satisfies MeshAsset,
    material: {
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'forgeax::all-kinds' } }],
      values: { roughness: 0.5 },
    } satisfies MaterialAsset,
    scene: { kind: 'scene', entities: [] } satisfies SceneAsset,
    texture: {
      kind: 'texture', width: 1, height: 1, format: 'rgba8unorm',
      data: new Uint8Array([255, 255, 255, 255]), colorSpace: 'srgb', mipmap: false,
    } satisfies TextureAsset,
    equirect: {
      kind: 'equirect', width: 1, height: 1, format: 'rgba16float',
      data: new Uint8Array(8), colorSpace: 'linear',
    } satisfies EquirectAsset,
    sampler: { kind: 'sampler', magFilter: 'linear' } satisfies SamplerAsset,
    font: {
      kind: 'font', atlas: ids.texture, sampler: ids.sampler, glyphs: {},
      common: { lineHeight: 1, base: 1, distanceRange: 4, pxRange: 4, atlasWidth: 1, atlasHeight: 1 },
    } satisfies FontAsset,
    'render-pipeline': { kind: 'render-pipeline', pipelineId: 'forgeax::urp' } satisfies RenderPipelineAsset,
    tileset: {
      kind: 'tileset', atlases: [AssetGuid.format(ids.texture)], tileWidth: 1, tileHeight: 1,
      columns: 1, rows: 1, regions: [{ x: 0, y: 0, width: 1, height: 1 }], tiles: [{ regionIndex: 0 }],
    } satisfies TilesetAsset,
    video: { kind: 'video', url: 'https://example.test/video.webm' } satisfies VideoAsset,
    skeleton: { kind: 'skeleton', inverseBindMatrices: new Float32Array(16), jointCount: 1 } satisfies SkeletonAsset,
    skin: { kind: 'skin', skeletonGuid: AssetGuid.format(ids.skeleton), jointPaths: ['root'] } satisfies SkinAsset,
    'animation-clip': { kind: 'animation-clip', duration: 1, channels: [] } satisfies AnimationClip,
    'animation-graph': {
      kind: 'animation-graph', nodes: [{ type: 'clip', clip: AssetGuid.format(ids['animation-clip']), weight: 1 }], root: 0,
    } satisfies AnimationGraph,
    audio: { kind: 'audio', sourceKey: 'external/audio', mediaType: 'audio/wav', bytes: new Uint8Array([82, 73, 70, 70]) } satisfies AudioClipAsset,
    'particle-effect': {
      kind: 'particle-effect', schemaVersion: 2, programFingerprint: ${JSON.stringify(particleProgram.fingerprint)},
      emitters: ${JSON.stringify(particleProgram.emitters.map(({ id, capacity }) => ({ id, capacity })))}, program: ${JSON.stringify(particleProgram)},
    } satisfies ParticleEffectAsset,
  });
};

export default {
  schemaVersion: '1.0.0',
  packageId: parseGuid('019ffa97-9000-7000-8000-000000000099'),
  name: 'External all kinds',
  assets,
  externalAssets,
  build,
} satisfies ScriptablePackDefinition<typeof assets>;
`;
}

async function cookExternalParticleProgram(): Promise<ParticleEffectAsset['program']> {
  const cooked = await cookParticleCodeEffect(
    {
      schemaVersion: 2,
      emitters: [
        {
          id: 'default',
          capacity: 16,
          backend: { required: 'gpu' },
          space: 'local',
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
          schedule: { rate: 2 },
          program: { module: PARTICLE_CODE_DEFAULT_MODULE_ID },
          renderers: [{ kind: 'billboard', material: ALL_KIND_GUIDS.material }],
          simulationWhenCulled: 'pause',
        },
      ],
    },
    {},
  );
  if (!cooked.ok) throw new Error(cooked.error.hint);
  const program = JSON.parse(
    JSON.stringify({
      format: 'forgeax-vfx-program-2' as const,
      emitters: cooked.value.artifact.program.emitters,
    }),
  ) as ParticleEffectAsset['program'];
  const bytes = new TextEncoder().encode(canonical(program));
  return {
    ...program,
    fingerprint: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

interface ScopedCatalog {
  readonly entries: readonly PackIndexEntry[];
}

async function waitForCatalogRevision(
  middlewares: readonly Middleware[],
  url: string,
  previousDigest: string,
): Promise<ScopedCatalog> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await request(middlewares, url);
    const snapshot = JSON.parse(String(response.body)) as ScopedCatalog;
    if (snapshot.entries[0]?.revision?.digest !== previousDigest) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for a fresh ScriptablePack Catalog revision');
}

describe.sequential('ScriptablePack Vite publication', () => {
  it(
    'loads the exact 16-kind external consumer from a production Pack URL',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-all-kinds-'));
      const assets = join(root, 'assets');
      const originalFetch = globalThis.fetch;
      try {
        await mkdir(assets);
        await mkdir(join(root, 'node_modules', '@forgeax'), { recursive: true });
        await symlink(
          join(repositoryRoot, 'packages', 'pack', 'node_modules', 'uuidv7'),
          join(root, 'node_modules', 'uuidv7'),
          'dir',
        );
        await symlink(
          join(repositoryRoot, 'packages', 'pack'),
          join(root, 'node_modules', '@forgeax', 'engine-pack'),
          'dir',
        );
        await symlink(
          join(repositoryRoot, 'packages', 'types'),
          join(root, 'node_modules', '@forgeax', 'engine-types'),
          'dir',
        );
        const particleProgram = await cookExternalParticleProgram();
        await writeFile(join(assets, 'all-kinds.pack.ts'), allKindsSource(particleProgram));
        const plugin = createPluginPackInternal({ roots: [assets] });
        const emitted = new Map<string, string | Uint8Array>();
        await plugin.generateBundle.call({
          emitFile(asset) {
            const fileName = asset.fileName ?? asset.name ?? 'asset';
            emitted.set(fileName, asset.source);
            return fileName;
          },
          getFileName(referenceId) {
            return referenceId;
          },
        });
        await plugin.closeBundle();

        const index = JSON.parse(
          String(emitted.get('pack-index.json')),
        ) as readonly PackIndexEntry[];
        expect(new Set(index.map((entry) => entry.kind))).toEqual(new Set(ALL_KINDS));
        for (const entry of index) {
          expect(entry.packageUrl).toMatch(/^\/assets\/[^/]+\.pack\.json$/);
          expect(entry.cookReceiptUrl).toMatch(/^\/assets\/[^/]+\.receipt\.json$/);
          expect(entry.revision?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
          expect(entry.refs).toBeDefined();
        }
        const packs = new Map<
          string,
          {
            readonly assets: readonly {
              readonly guid: string;
              readonly kind: string;
              readonly refs: readonly string[];
              readonly artifacts?: Readonly<Record<string, unknown>>;
            }[];
          }
        >();
        for (const entry of index) {
          const path = new URL(entry.packageUrl, 'https://production.test').pathname.slice(1);
          const source = emitted.get(path);
          expect(source, `production Pack ${path}`).toBeDefined();
          packs.set(entry.guid, JSON.parse(String(source)));
        }
        expect(new Set(index.map((entry) => entry.packageUrl)).size).toBe(1);
        expect(new Set(index.map((entry) => entry.cookReceiptUrl)).size).toBe(ALL_KINDS.length);
        expect([...packs.values()].some((pack) => pack.assets.length === ALL_KINDS.length)).toBe(
          true,
        );
        globalThis.fetch = async (input) => {
          const path = new URL(String(input), 'https://production.test').pathname.slice(1);
          const body = emitted.get(path);
          if (body === undefined) throw new Error(`missing emitted production asset: ${path}`);
          return new Response(typeof body === 'string' ? body : Buffer.from(body), { status: 200 });
        };
        const registry = createAssetRegistry({
          catalog: createCatalogSource({ entries: index }),
          fetcher: globalThis.fetch,
        });
        for (const contribution of defaultAssetDecoderContributions) {
          if (contribution.kind.kind === 'particle-effect') continue;
          registry.installDecoder(contribution.kind as never, contribution.decoder);
        }
        const vfxWorld = new World();
        const vfxHost = createVfxRuntimeHost({ camera: { read: () => undefined } });
        expect(await vfxHost.attachWorld({ world: vfxWorld, assets: registry })).toMatchObject({
          ok: true,
          value: { state: 'attached' },
        });
        const loadResults = await Promise.all([
          registry.load(ALL_KIND_GUIDS.mesh, 'mesh'),
          registry.load(ALL_KIND_GUIDS.material, 'material'),
          registry.load(ALL_KIND_GUIDS.scene, 'scene'),
          registry.load(ALL_KIND_GUIDS.texture, 'texture'),
          registry.load(ALL_KIND_GUIDS.equirect, 'equirect'),
          registry.load(ALL_KIND_GUIDS.sampler, 'sampler'),
          registry.load(ALL_KIND_GUIDS.font, 'font'),
          registry.load(ALL_KIND_GUIDS['render-pipeline'], 'render-pipeline'),
          registry.load(ALL_KIND_GUIDS.tileset, 'tileset'),
          registry.load(ALL_KIND_GUIDS.video, 'video'),
          registry.load(ALL_KIND_GUIDS.skeleton, 'skeleton'),
          registry.load(ALL_KIND_GUIDS.skin, 'skin'),
          registry.load(ALL_KIND_GUIDS['animation-clip'], 'animation-clip'),
          registry.load(ALL_KIND_GUIDS['animation-graph'], 'animation-graph'),
          registry.load(ALL_KIND_GUIDS.audio, 'audio'),
          loadVfxGpuEffect(registry, ALL_KIND_GUIDS['particle-effect']),
        ]);
        const [
          ,
          ,
          ,
          ,
          ,
          ,
          ,
          ,
          tilesetResult,
          ,
          ,
          ,
          animationClipResult,
          animationGraphResult,
          audioResult,
          particleResult,
        ] = loadResults;
        const loadedKinds = loadResults.map((result) => {
          if (!result.ok) throw result.error;
          return result.value.kind;
        });
        expect(loadedKinds).toEqual(ALL_KINDS);
        const loadedAssets = new Map<string, Asset>();
        for (const [index, result] of loadResults.entries()) {
          if (!result.ok) throw result.error;
          const kind = ALL_KINDS[index];
          if (kind === undefined) throw new Error(`missing test kind at index ${index}`);
          loadedAssets.set(ALL_KIND_GUIDS[kind].toLowerCase(), result.value);
        }
        const lookup = (guid: string): Asset | undefined => loadedAssets.get(guid.toLowerCase());
        const loadedParticle = await loadVfxGpuEffect(registry, ALL_KIND_GUIDS['particle-effect']);
        expect(loadedParticle).toMatchObject({ ok: true, value: { kind: 'particle-effect' } });
        if (loadedParticle.ok) {
          expect(loadedParticle.value.program.emitters[0]?.wgsl).toContain('@compute');
          expect(loadedParticle.value.program.emitters[0]?.reflection.entryPoints).toContain(
            'forgeax_vfx_spawn_main',
          );
        }
        if (!animationClipResult.ok || !animationGraphResult.ok) {
          throw new Error('animation assets did not load');
        }
        const animationWorld = new World();
        const resolvedClip = resolveAnimationAsset(
          animationWorld,
          ALL_KIND_GUIDS['animation-clip'],
          'animation-clip',
          lookup,
        );
        const resolvedGraph = resolveAnimationAsset(
          animationWorld,
          ALL_KIND_GUIDS['animation-graph'],
          'animation-graph',
          lookup,
        );
        expect(resolvedClip).toMatchObject({
          ok: true,
          value: { asset: { kind: 'animation-clip' } },
        });
        expect(resolvedGraph).toMatchObject({
          ok: true,
          value: { asset: { kind: 'animation-graph' } },
        });
        const firstGraphNode = animationGraphResult.value.nodes[0];
        expect(firstGraphNode?.type).toBe('clip');
        if (firstGraphNode?.type === 'clip') {
          expect(firstGraphNode.clip).toBe(ALL_KIND_GUIDS['animation-clip']);
        }

        if (!tilesetResult.ok) throw new Error('tileset asset did not load');
        const atlasGuid = tilesetResult.value.atlases[0];
        if (atlasGuid === undefined) throw new Error('tileset fixture has no atlas');
        const tileWorld = new World();
        const resolvedTileset = resolveTilesetRuntime(tileWorld, atlasGuid, lookup);
        expect(resolvedTileset).toMatchObject({
          ok: true,
          value: { payload: { kind: 'texture' } },
        });

        if (!audioResult.ok) throw new Error('audio asset did not load');
        const audioEngine = new WebAudioEngine();
        const decode = vi.spyOn(audioEngine, 'decode').mockResolvedValue({} as AudioBuffer);
        const play = vi.spyOn(audioEngine, 'play').mockImplementation(() => {});
        const audioConsumer = createHostAudioConsumer(audioEngine);
        audioConsumer.consume({
          kind: 'play',
          entityId: 1,
          sourceKey: audioResult.value.sourceKey,
          bytes: audioResult.value.bytes,
          options: { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' },
        });
        await Promise.resolve();
        expect(decode).toHaveBeenCalledWith(audioResult.value.bytes);
        expect(play).toHaveBeenCalledWith(1, expect.anything(), {
          loop: false,
          volume: 1,
          spatialBlend: 0,
          bus: 'sfx',
        });
        audioConsumer.dispose();

        if (!particleResult.ok) throw new Error('particle-effect asset did not load');
        const effect = vfxWorld.allocSharedRef('ParticleEffectAsset', particleResult.value);
        const player = vfxWorld
          .spawn({
            component: ParticleEffectPlayer,
            data: { effect, playing: true, seed: 7, timeScale: 1 },
          })
          .unwrap();
        vfxWorld.update(1 / 60).unwrap();
        expect(vfxHost.inspect(vfxWorld)?.players.some((entry) => entry.player === player)).toBe(
          true,
        );
        expect(await vfxHost.detachWorld({ world: vfxWorld })).toMatchObject({
          ok: true,
          value: { state: 'detached' },
        });
        for (const [index, kind] of ALL_KINDS.entries()) {
          const guid = ALL_KIND_GUIDS[kind];
          const pack = packs.get(guid);
          const asset = pack?.assets.find((candidate) => candidate.guid === guid);
          expect(asset?.kind).toBe(kind);
          expect(asset?.refs).toBeDefined();
          expect(asset?.artifacts).toBeDefined();
          expect(loadedAssets.get(guid.toLowerCase())?.kind).toBe(kind);
          expect(loadResults[index]?.ok).toBe(true);
        }
        const devPlugin = createPluginPackInternal({ roots: [assets] });
        const middlewares: Middleware[] = [];
        devPlugin.configureServer({
          middlewares: { use: (middleware) => middlewares.push(middleware as Middleware) },
          ws: { send: () => {} },
        });
        const binding = createStandaloneRuntimeAssetBinding('all-kinds-dev');
        await devPlugin.rebind(binding, [assets]);
        const devCatalog = JSON.parse(
          String((await request(middlewares, binding.catalogUrl)).body),
        ) as {
          readonly entries: readonly PackIndexEntry[];
        };
        expect(new Set(devCatalog.entries.map((entry) => entry.kind))).toEqual(new Set(ALL_KINDS));
        for (const guid of Object.values(ALL_KIND_GUIDS)) {
          const imported = await request(middlewares, `${binding.importUrlBase}/${guid}`, 'POST');
          expect(imported.statusCode).toBe(200);
          expect(JSON.parse(String(imported.body))).toEqual([
            expect.objectContaining({ guid, lifecycle: 'current' }),
          ]);
        }
        await devPlugin.closeBundle();
      } finally {
        globalThis.fetch = originalFetch;
        await rm(root, { recursive: true, force: true });
      }
    },
    SCRIPTABLE_PACK_INTEGRATION_TIMEOUT_MS,
  );

  it(
    'discovers, cooks, emits Pack v2 plus Meta, and publishes current Catalog rows',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-vite-'));
      try {
        await mkdir(join(root, 'assets'));
        await writeFile(
          join(root, 'assets', 'generated.pack.ts'),
          `const packageId = new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,0]);
const sceneGuid = new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,1]);
export default {
  schemaVersion: '1.0.0',
  packageId,
  name: 'Generated',
  assets: { scene: { guid: sceneGuid, kind: 'scene', name: 'Generated Scene' } },
  externalAssets: {},
  build: () => ({ ok: true, value: { scene: { kind: 'scene', entities: [] } } }),
};\n`,
        );
        const plugin = createPluginPackInternal({ roots: [join(root, 'assets')] });
        const emitted = new Map<string, string | Uint8Array>();
        await plugin.generateBundle.call({
          emitFile(asset) {
            const key = asset.fileName ?? `assets/${asset.name ?? 'asset'}`;
            emitted.set(key, asset.source);
            return key;
          },
          getFileName(referenceId) {
            return referenceId;
          },
        });
        await plugin.closeBundle();

        const catalog = JSON.parse(
          String(emitted.get('pack-index.json')),
        ) as readonly PackIndexEntry[];
        expect(catalog).toHaveLength(1);
        expect(catalog[0]).toMatchObject({
          packageUrl: '/assets/019ffa97-0000-7000-8000-000000000001.pack.json',
          cookReceiptUrl: '/assets/019ffa97-0000-7000-8000-000000000001.receipt.json',
          revision: {
            digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            observedAt: expect.any(Number),
          },
          lifecycle: 'current',
        });
        const publicationSourcePath = catalog[0]?.sourcePath;
        expect(catalog[0]?.publication).toMatchObject({
          schemaVersion: 'asset-publication/1',
          sourcePath: publicationSourcePath,
          sourceRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          generation: expect.any(Number),
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          outputSetDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          outputs: [
            expect.objectContaining({
              guid: '019ffa97-0000-7000-8000-000000000001',
              sourceKey: 'scene',
              kind: 'scene',
              digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
              refs: [],
            }),
          ],
          receipt: expect.objectContaining({
            schemaVersion: 'asset-publication-receipt/1',
            sourcePath: publicationSourcePath,
            sourceRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            inputFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            outputDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            outputSetDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          }),
          current: expect.objectContaining({
            generation: expect.any(Number),
            packageUrl: '/assets/019ffa97-0000-7000-8000-000000000001.pack.json',
          }),
        });
        expect(catalog[0]?.publication?.current).toMatchObject({
          packageUrl: '/assets/019ffa97-0000-7000-8000-000000000001.pack.json',
          generation: expect.any(Number),
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          outputSetDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        });
        expect(catalog[0]?.revision?.rootId).toBe(catalog[0]?.sourcePath);
        const receipt = JSON.parse(
          String(emitted.get('assets/019ffa97-0000-7000-8000-000000000001.receipt.json')),
        ) as {
          readonly guid: string;
          readonly origin: string;
          readonly status: string;
          readonly inputFingerprint: string;
          readonly outputDigest: string;
        };
        expect(receipt).toMatchObject({
          guid: '019ffa97-0000-7000-8000-000000000001',
          origin: 'sourceMeta',
          status: 'succeeded',
        });
        expect(receipt.inputFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(receipt.outputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        const pack = JSON.parse(
          String(emitted.get('assets/019ffa97-0000-7000-8000-000000000001.pack.json')),
        ) as {
          readonly assets: readonly { readonly artifacts: Record<string, { path: string }> }[];
        };
        const metaPath = pack.assets[0]?.artifacts['scriptable-pack.meta.json']?.path;
        expect(metaPath).toBe('019ffa97-0000-7000-8000-000000000001/scriptable-pack.meta.json');
        const metaBody = emitted.get(`assets/${metaPath ?? ''}`);
        expect(metaBody).toBeDefined();
        const meta = JSON.parse(
          typeof metaBody === 'string' ? metaBody : new TextDecoder().decode(metaBody),
        );
        expect(meta).toMatchObject({ importer: 'pack-ts', name: 'Generated' });

        const secondEmitted = new Map<string, string | Uint8Array>();
        const secondPlugin = createPluginPackInternal({ roots: [join(root, 'assets')] });
        await secondPlugin.generateBundle.call({
          emitFile(asset) {
            const key = asset.fileName ?? `assets/${asset.name ?? 'asset'}`;
            secondEmitted.set(key, asset.source);
            return key;
          },
          getFileName(referenceId) {
            return referenceId;
          },
        });
        await secondPlugin.closeBundle();
        expect([...secondEmitted.entries()]).toEqual([...emitted.entries()]);
        expect(secondEmitted.get(`assets/${metaPath ?? ''}`)).toEqual(
          emitted.get(`assets/${metaPath ?? ''}`),
        );

        const devPlugin = createPluginPackInternal({ roots: [join(root, 'assets')] });
        const middlewares: Middleware[] = [];
        devPlugin.configureServer({
          middlewares: { use: (middleware) => middlewares.push(middleware as Middleware) },
          ws: { send: () => {} },
        });
        const binding = createStandaloneRuntimeAssetBinding('scriptable-parity');
        await devPlugin.rebind(binding, [join(root, 'assets')]);
        const snapshot = JSON.parse(
          String((await request(middlewares, binding.catalogUrl)).body),
        ) as {
          readonly entries: readonly PackIndexEntry[];
        };
        const devRow = snapshot.entries[0];
        expect(devRow).toMatchObject({
          guid: catalog[0]?.guid,
          lifecycle: 'current',
          revision: catalog[0]?.revision,
        });
        const devPack = JSON.parse(
          String(
            await request(middlewares, devRow?.packageUrl ?? '').then((result) => result.body),
          ),
        ) as {
          readonly assets: readonly {
            readonly guid: string;
            readonly kind: string;
            readonly payload: unknown;
            readonly refs: readonly string[];
            readonly artifacts?: Readonly<
              Record<
                string,
                {
                  readonly path: string;
                  readonly mediaType: string;
                  readonly byteLength: number;
                  readonly integrity: unknown;
                }
              >
            >;
          }[];
        };
        const productionPack = JSON.parse(
          String(emitted.get('assets/019ffa97-0000-7000-8000-000000000001.pack.json')),
        ) as typeof devPack;
        const semantic = (pack: typeof devPack) =>
          pack.assets.map((asset) => ({
            guid: asset.guid,
            kind: asset.kind,
            payload: asset.payload,
            refs: asset.refs,
            artifacts: Object.fromEntries(
              Object.entries(asset.artifacts ?? {}).map(([key, descriptor]) => [
                key,
                {
                  mediaType: descriptor.mediaType,
                  byteLength: descriptor.byteLength,
                  integrity: descriptor.integrity,
                },
              ]),
            ),
          }));
        expect(semantic(devPack)).toEqual(semantic(productionPack));
        await devPlugin.closeBundle();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    SCRIPTABLE_PACK_INTEGRATION_TIMEOUT_MS,
  );

  it('classifies pack sources as catalog-bearing watch inputs', () => {
    expect(classifyWatchedPath('generated.pack.ts')).toEqual({ kind: 'sidecar' });
    expect(classifyWatchedPath('helpers/geometry.ts')).toEqual({ kind: 'source' });
    expect(classifyWatchedPath('hud.ui.html')).toEqual({ kind: 'source' });
    expect(classifyWatchedPath('fonts/hud.woff2')).toEqual({ kind: 'source' });
  });

  it(
    'uses a published Pack payload for ScriptablePack content reads',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-generation-owner-'));
      const assets = join(root, 'assets');
      const dependencyGuid = '019ffa97-0000-7000-8000-000000000041';
      try {
        await mkdir(assets);
        await writeFile(
          join(assets, 'dependency.pack.ts'),
          [
            'const guid = (last: number) => new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,last]);',
            'export default {',
            "schemaVersion: '1.0.0', packageId: guid(40),",
            "assets: { audio: { guid: guid(65), kind: 'audio' } }, externalAssets: {},",
            "build: () => ({ ok: true, value: { audio: { kind: 'audio', sourceKey: 'dependency', mediaType: 'audio/wav', bytes: new Uint8Array([17]) } } }),",
            '};',
          ].join('\n'),
        );
        await writeFile(
          join(assets, 'derived.pack.ts'),
          [
            'const guid = (last: number) => new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,last]);',
            `const dependency = new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,65]);`,
            'export default {',
            "schemaVersion: '1.0.0', packageId: guid(61),",
            "assets: { scene: { guid: guid(62), kind: 'scene' } },",
            'externalAssets: { dependency },',
            'build: async (reader: { readByGuid: (guid: Uint8Array) => Promise<{ ok: true; value: { bytes: Uint8Array } } | { ok: false; error: unknown }> }) => {',
            '  const source = await reader.readByGuid(dependency);',
            '  if (!source.ok) return source;',
            "  return { ok: true, value: { scene: { kind: 'scene', entities: [], marker: source.value.bytes[0] } } };",
            '},',
            '};',
          ].join('\n'),
        );
        const plugin = createPluginPackInternal({ roots: [assets] });
        const middlewares: Middleware[] = [];
        plugin.configureServer({
          middlewares: { use: (middleware) => middlewares.push(middleware as Middleware) },
          ws: { send: () => {} },
        });
        const binding = createStandaloneRuntimeAssetBinding('scriptable-generation-owner');
        await plugin.rebind(binding, [assets]);
        const catalog = await request(middlewares, binding.catalogUrl);
        expect(catalog.statusCode).toBe(200);
        const snapshot = JSON.parse(String(catalog.body)) as {
          readonly entries: readonly PackIndexEntry[];
        };
        expect(snapshot.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ guid: dependencyGuid }),
            expect.objectContaining({
              guid: '019ffa97-0000-7000-8000-00000000003e',
              lifecycle: 'current',
            }),
          ]),
        );
        const generatedRows = snapshot.entries.filter((entry) =>
          entry.sourcePath.endsWith('.pack.ts'),
        );
        expect(generatedRows).toHaveLength(2);
        const generatedPublication = generatedRows.find((entry) =>
          entry.sourcePath.endsWith('/derived.pack.ts'),
        )?.publication;
        expect(generatedPublication?.outputs).toEqual([
          expect.objectContaining({
            guid: '019ffa97-0000-7000-8000-00000000003e',
            sourceKey: 'scene',
          }),
        ]);
        expect(generatedPublication?.current).toMatchObject({
          packageUrl: expect.stringMatching(/\.pack\.json$/),
          generation: expect.any(Number),
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          outputSetDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        });
        await plugin.closeBundle();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    SCRIPTABLE_PACK_INTEGRATION_TIMEOUT_MS,
  );

  it('keeps the prior accepted Pack readable when a later ScriptablePack fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-dev-atomic-'));
    const assets = join(root, 'assets');
    const source = (lastByte: number, marker: number, fail = false) => `
const guid = (last: number) => new Uint8Array([...Array(15).fill(0), last]);
export default {
  schemaVersion: '1.0.0', packageId: guid(${lastByte + 20}),
  assets: { scene: { guid: guid(${lastByte}), kind: 'scene' } }, externalAssets: {},
  build: ${fail ? "() => ({ ok: false, error: { code: 'fixture-domain-failed', expected: 'the staged Pack to build', hint: 'repair the fixture and rebuild' } })" : `() => ({ ok: true, value: { scene: { kind: 'scene', entities: [], marker: ${marker} } } })`},
};
`;
    const plugin = createPluginPackInternal({ roots: [assets] });
    const middlewares: Middleware[] = [];
    try {
      await mkdir(assets);
      const firstPath = join(assets, 'a.pack.ts');
      const secondPath = join(assets, 'b.pack.ts');
      await writeFile(firstPath, source(31, 1));
      await writeFile(secondPath, source(32, 1));
      plugin.configureServer({
        middlewares: { use: (middleware) => middlewares.push(middleware as Middleware) },
        ws: { send: () => {} },
      });
      const binding = createStandaloneRuntimeAssetBinding('scriptable-atomic');
      await plugin.rebind(binding, [assets]);
      const initialResponse = await request(middlewares, binding.catalogUrl);
      const initial = JSON.parse(String(initialResponse.body)) as {
        readonly entries: readonly PackIndexEntry[];
      };
      expect(initial.entries).toHaveLength(2);
      const first = initial.entries.find((entry) => entry.sourcePath.endsWith('/a.pack.ts'));
      const second = initial.entries.find((entry) => entry.sourcePath.endsWith('/b.pack.ts'));
      if (first === undefined || second === undefined)
        throw new Error('ScriptablePack rows missing');
      await request(middlewares, `${binding.importUrlBase}/${first.guid}`, 'POST');
      await request(middlewares, `${binding.importUrlBase}/${second.guid}`, 'POST');
      const accepted = JSON.parse(
        String((await request(middlewares, binding.catalogUrl)).body),
      ) as {
        readonly entries: readonly PackIndexEntry[];
      };
      const acceptedFirst = accepted.entries.find((entry) => entry.guid === first.guid);
      if (acceptedFirst === undefined) {
        throw new Error('accepted ScriptablePack rows missing');
      }
      const acceptedPack = await request(middlewares, acceptedFirst.packageUrl);

      await writeFile(secondPath, source(32, 2, true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const failed = await request(middlewares, `${binding.importUrlBase}/${second.guid}`, 'POST', {
        'x-forgeax-import-mode': 'rebuild',
      });
      expect(failed.statusCode).toBe(422);
      expect(failed.body).toContain('source-package-failed');
      expect((await request(middlewares, acceptedFirst.packageUrl)).body).toBe(acceptedPack.body);

      await writeFile(secondPath, source(32, 2));
      const retried = await request(
        middlewares,
        `${binding.importUrlBase}/${second.guid}`,
        'POST',
        { 'x-forgeax-import-mode': 'rebuild' },
      );
      expect(retried.statusCode).toBe(200);
      expect(JSON.parse(String(retried.body))).toEqual([
        expect.objectContaining({ guid: second.guid, lifecycle: 'current' }),
      ]);
    } finally {
      await plugin.closeBundle();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('times out a real worker build, preserves the healthy publication, and retries in a fresh generation', async () => {
    const root = await mkdtemp(join(process.cwd(), '.forgeax-m38-scriptable-dev-timeout-retry-'));
    const assets = join(root, 'assets');
    const sourcePath = join(assets, 'retry.pack.ts');
    const displaySourcePath = 'assets/retry.pack.ts';
    const source = (buildBody: string) => `
const guid = (last: number) => new Uint8Array([...Array(15).fill(0), last]);
export default {
  schemaVersion: '1.0.0', packageId: guid(52),
  assets: { scene: { guid: guid(51), kind: 'scene' } }, externalAssets: {},
  build: ${buildBody},
};
`;
    const healthyBuild =
      "() => ({ ok: true, value: { scene: { kind: 'scene', entities: [], marker: 1 } } })";
    const correctedBuild =
      "() => ({ ok: true, value: { scene: { kind: 'scene', entities: [], marker: 2 } } })";
    const neverSettlesBuild = '() => new Promise(() => undefined)';
    const replaceSource = async (body: string) => {
      // Keep the watched inode stable: this test exercises timeout recovery and
      // fresh publication, not platform-specific atomic-save rename semantics.
      await writeFile(sourcePath, body);
    };
    const plugin = createPluginPackInternal({ roots: [assets] });
    const middlewares: Middleware[] = [];
    const wsCalls: Array<{ readonly type?: string }> = [];
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await mkdir(assets);
      await writeFile(sourcePath, source(healthyBuild));
      plugin.configureServer({
        middlewares: { use: (middleware) => middlewares.push(middleware as Middleware) },
        ws: { send: (payload) => wsCalls.push(payload) },
      });
      const binding = createStandaloneRuntimeAssetBinding('scriptable-timeout-retry');
      await plugin.rebind(binding, [assets]);
      wsCalls.length = 0;
      warnings.mockClear();

      const beforeCatalog = await request(middlewares, binding.catalogUrl);
      const beforeSnapshot = JSON.parse(String(beforeCatalog.body)) as {
        readonly entries: readonly PackIndexEntry[];
      };
      const beforeEntry = beforeSnapshot.entries[0];
      const beforeDigest = beforeEntry?.revision?.digest;
      if (beforeDigest === undefined) throw new Error('healthy ScriptablePack row has no revision');
      const beforePackUrl = beforeEntry?.packageUrl;
      expect(beforePackUrl).toBeDefined();
      const beforePack = await request(middlewares, beforePackUrl ?? '');
      const isAssetChangedWarning = (call: readonly unknown[]) =>
        typeof call[0] === 'string' && call[0].startsWith('[forgeax-pack] assets changed:');

      const timeoutReloads = warnings.mock.calls.filter(isAssetChangedWarning).length;
      await replaceSource(source(neverSettlesBuild));
      const isBuildTimeoutWarning = (call: readonly unknown[]) => {
        if (call[0] !== '[forgeax-pack] rebuild state.catalog error:') return false;
        const failure = call[1];
        if (failure === null || typeof failure !== 'object') return false;
        const detail = (failure as { readonly detail?: unknown }).detail;
        return (
          detail !== null &&
          typeof detail === 'object' &&
          (detail as { readonly reason?: unknown }).reason === 'timeout'
        );
      };
      await waitFor(() => warnings.mock.calls.some(isBuildTimeoutWarning));
      await waitFor(
        () => warnings.mock.calls.filter(isAssetChangedWarning).length >= timeoutReloads + 1,
      );
      const timeoutCall = warnings.mock.calls.find(isBuildTimeoutWarning);
      expect(timeoutCall?.[1]).toMatchObject({
        code: 'pack-source-load-failed',
        detail: {
          sourcePath: displaySourcePath,
          reason: 'timeout',
          phase: 'build',
          timeoutMs: 5_000,
          diagnostic: 'ScriptablePack build exceeded 5000ms',
        },
      });
      const afterTimeoutCatalog = await request(middlewares, binding.catalogUrl);
      const afterTimeoutPack = await request(middlewares, beforePackUrl ?? '');
      expect(afterTimeoutCatalog.body).toBe(beforeCatalog.body);
      expect(afterTimeoutPack.body).toBe(beforePack.body);
      expect(wsCalls.some((payload) => payload.type === 'full-reload')).toBe(false);

      const retryReloads = warnings.mock.calls.filter(isAssetChangedWarning).length;
      await replaceSource(source(correctedBuild));
      await waitFor(
        () => warnings.mock.calls.filter(isAssetChangedWarning).length >= retryReloads + 1,
      );
      const afterRetrySnapshot = await waitForCatalogRevision(
        middlewares,
        binding.catalogUrl,
        beforeDigest,
      );
      expect(afterRetrySnapshot.entries).toHaveLength(1);
      const afterRetryEntry = afterRetrySnapshot.entries[0];
      const afterRetryPackUrl = afterRetryEntry?.packageUrl;
      expect(afterRetryPackUrl).toBeDefined();
      expect(afterRetryPackUrl).not.toBe(beforePackUrl);
      expect(afterRetryEntry?.revision?.digest).not.toBe(beforeEntry?.revision?.digest);
      const afterRetryPack = await request(middlewares, afterRetryPackUrl ?? '');
      expect(afterRetryPack.body).not.toBe(beforePack.body);
      expect(unhandled).toEqual([]);
    } finally {
      await plugin.closeBundle();
      process.off('unhandledRejection', onUnhandled);
      warnings.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
