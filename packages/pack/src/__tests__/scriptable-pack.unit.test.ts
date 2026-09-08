import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeshAsset } from '@forgeax/engine-types';
import { AssetError, err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetGuid } from '../guid.js';
import {
  createScriptablePackAuthoringGateway,
  projectScriptablePackMeta,
  SCRIPTABLE_PACK_ASSET_KINDS,
  type ScriptablePackAssetDeclarations,
  type ScriptablePackAuthoringMutation,
  type ScriptablePackDefinition,
  SOURCE_AUTHORING_OPERATION_DESCRIPTORS,
  validateScriptablePackDefinition,
} from '../scriptable-pack.js';
import {
  createFileSystemScriptablePackAuthoringPort,
  createScriptablePackModuleExecutorPool,
  loadScriptablePack,
} from '../scriptable-pack-node.js';

function guid(value: string) {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function definition(): ScriptablePackDefinition {
  const assets = {
    'scene/house': {
      guid: guid('019ffa97-be3d-7234-9128-257469394b43'),
      kind: 'scene',
      name: 'House',
    },
    'geometry/wall': {
      guid: guid('019ffa97-a5ee-7645-b613-043323952808'),
      kind: 'mesh',
      name: 'Wall',
    },
  } as const satisfies ScriptablePackAssetDeclarations;
  return {
    schemaVersion: '1.0.0',
    packageId: guid('019ffa97-8b39-7ad2-84cc-273268591ab4'),
    name: 'Low Poly House',
    assets,
    externalAssets: {
      wallTexture: guid('019ffa97-c10b-7f90-90f5-6b814226f341'),
    },
    build: () =>
      ok({
        'geometry/wall': { kind: 'mesh' } as unknown as MeshAsset,
        'scene/house': { kind: 'scene', entities: [] },
      }),
  };
}

describe('ScriptablePack definition and Meta projection', () => {
  it('exposes the complete ordinary Asset kind discovery set', () => {
    expect(SCRIPTABLE_PACK_ASSET_KINDS).toEqual([
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
    ]);
  });

  it('projects deterministic Meta without invoking build', () => {
    const source = definition();
    let buildCalls = 0;
    const tracked = {
      ...source,
      build: () => {
        buildCalls += 1;
        return source.build({} as never);
      },
    };
    const validated = validateScriptablePackDefinition(tracked, 'house.pack.ts');
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const wall = source.assets['geometry/wall'];
    if (wall === undefined) throw new Error('fixture wall descriptor missing');
    wall.guid[0] = 255;

    const meta = projectScriptablePackMeta(validated.value, 'house.pack.ts');
    expect(buildCalls).toBe(0);
    expect(meta.subAssets.map((asset) => asset.sourceKey)).toEqual([
      'geometry/wall',
      'scene/house',
    ]);
    expect(meta.subAssets.map((asset) => asset.sourceIndex)).toEqual([0, 1]);
    expect(meta.subAssets[0]?.guid).toBe('019ffa97-a5ee-7645-b613-043323952808');
    expect(meta.importSettings.externalAssets).toEqual([
      {
        alias: 'wallTexture',
        guid: '019ffa97-c10b-7f90-90f5-6b814226f341',
      },
    ]);
  });

  it('freezes component-token schemas as an ECS-neutral scene projection', () => {
    const source = definition();
    const input = {
      ...source,
      sceneComponents: [
        {
          name: 'MeshFilter',
          fields: { assetHandle: { type: 'shared<MeshAsset>', default: 0 } },
        },
      ],
    };
    const validated = validateScriptablePackDefinition(input, 'scene-components.pack.ts');
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.value.sceneComponents).toEqual([
      { name: 'MeshFilter', fields: { assetHandle: 'shared<MeshAsset>' } },
    ]);
    expect(validated.value.sceneComponents?.[0]).not.toBe(input.sceneComponents[0]);
  });

  it('rejects duplicate scene component names before build', () => {
    const source = definition();
    const validated = validateScriptablePackDefinition(
      {
        ...source,
        sceneComponents: [
          { name: 'MeshFilter', fields: {} },
          { name: 'MeshFilter', fields: {} },
        ],
      },
      'duplicate-scene-components.pack.ts',
    );
    expect(validated).toMatchObject({
      ok: false,
      error: {
        code: 'pack-source-definition-invalid',
        detail: { propertyPath: '$.sceneComponents[1].name' },
      },
    });
  });

  it('rejects duplicate local GUIDs before build', () => {
    const source = definition();
    const duplicate = {
      ...source,
      assets: {
        ...source.assets,
        duplicate: source.assets['geometry/wall'],
      },
    };
    const validated = validateScriptablePackDefinition(duplicate, 'duplicate.pack.ts');
    expect(validated).toMatchObject({
      ok: false,
      error: {
        code: 'pack-source-definition-invalid',
        detail: { propertyPath: '$.assets["duplicate"].guid' },
      },
    });
  });

  it('loads through an injected module executor and times out deterministically', async () => {
    const disposalReasons: string[] = [];
    const loaded = await loadScriptablePack('house.pack.ts', {
      executor: { load: async () => ({ default: definition() }) },
    });
    expect(loaded.ok).toBe(true);

    const metadata = await loadScriptablePack('house.pack.ts', {
      metadataOnly: true,
      executor: {
        load: async () => ({ default: definition() }),
        dispose: (reason) => {
          disposalReasons.push(reason);
        },
      },
    });
    expect(metadata.ok).toBe(true);

    const timedOut = await loadScriptablePack('slow.pack.ts', {
      timeoutMs: 1,
      executor: {
        load: () => new Promise(() => undefined),
        dispose: (reason) => {
          disposalReasons.push(reason);
        },
      },
    });
    expect(timedOut).toMatchObject({
      ok: false,
      error: {
        code: 'pack-source-load-failed',
        detail: { reason: 'timeout', sourcePath: 'slow.pack.ts' },
      },
    });
    expect(disposalReasons).toEqual(['complete', 'timeout']);
  });

  it('terminates a real worker whose module initialization blocks synchronously', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-worker-'));
    try {
      const sourcePath = join(root, 'blocked.pack.ts');
      await writeFile(sourcePath, 'while (true) {}\nexport default {};\n');
      const started = Date.now();
      const loaded = await loadScriptablePack(sourcePath, { timeoutMs: 50 });
      expect(loaded).toMatchObject({
        ok: false,
        error: { code: 'pack-source-load-failed', detail: { reason: 'timeout' } },
      });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns one structured build timeout after terminating the worker and compile root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-build-timeout-'));
    const workerTempParent = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-build-temp-parent-'));
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = workerTempParent;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const sourcePath = join(root, 'never-settles.pack.ts');
      await writeFile(
        sourcePath,
        [
          'const packageId = new Uint8Array(16);',
          'packageId[15] = 1;',
          'const meshGuid = new Uint8Array(16);',
          'meshGuid[15] = 2;',
          'export default {',
          "schemaVersion: '1.0.0', packageId,",
          "assets: { mesh: { guid: meshGuid, kind: 'mesh' } }, externalAssets: {},",
          'build: () => new Promise(() => undefined),',
          '};',
        ].join('\n'),
      );

      const loaded = await loadScriptablePack(sourcePath, { buildTimeoutMs: 25 });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      const built = await loaded.value.build({} as never);
      expect(built).toMatchObject({
        ok: false,
        error: {
          code: 'pack-source-load-failed',
          detail: {
            sourcePath,
            reason: 'timeout',
            phase: 'build',
            timeoutMs: 25,
            diagnostic: 'ScriptablePack build exceeded 25ms',
          },
        },
      });
      expect(await readdir(workerTempParent)).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      await rm(root, { recursive: true, force: true });
      await rm(workerTempParent, { recursive: true, force: true });
    }
  });

  it('preserves an ordinary worker module-load diagnostic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-worker-error-'));
    try {
      const sourcePath = join(root, 'broken.pack.ts');
      await writeFile(sourcePath, "import './missing-helper.ts';\nexport default {};\n");
      const loaded = await loadScriptablePack(sourcePath, { metadataOnly: true });
      expect(loaded).toMatchObject({
        ok: false,
        error: {
          code: 'pack-source-load-failed',
          detail: {
            reason: 'module-load',
            diagnostic: expect.stringContaining('missing-helper'),
          },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads helper changes through a fresh worker instead of the Node module cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-helper-'));
    try {
      const sourcePath = join(root, 'fresh.pack.ts');
      const helperPath = join(root, 'helper.ts');
      await writeFile(helperPath, 'export const marker = 1;\n');
      await writeFile(
        sourcePath,
        [
          "import { marker } from './helper.ts';",
          'const guid = (last: number) => new Uint8Array([...Array(15).fill(0), last]);',
          'export default {',
          "schemaVersion: '1.0.0', packageId: guid(1),",
          "assets: { mesh: { guid: guid(2), kind: 'mesh' } }, externalAssets: {},",
          "build: () => ({ ok: true, value: { mesh: { kind: 'mesh', marker } } }),",
          '};',
        ].join('\n'),
      );
      const first = await loadScriptablePack(sourcePath);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const firstBuild = await first.value.build({} as never);
      expect(firstBuild.ok && (firstBuild.value.mesh as unknown as { marker: number }).marker).toBe(
        1,
      );

      await writeFile(helperPath, 'export const marker = 2;\n');
      const second = await loadScriptablePack(sourcePath);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      const secondBuild = await second.value.build({} as never);
      expect(
        secondBuild.ok && (secondBuild.value.mesh as unknown as { marker: number }).marker,
      ).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recycles a bounded worker pool without retaining a build closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-worker-pool-'));
    const pool = createScriptablePackModuleExecutorPool({
      maxWorkers: 1,
      maxTasksPerWorker: 8,
    });
    try {
      const sourcePath = join(root, 'pooled.pack.ts');
      const helperPath = join(root, 'helper.ts');
      await writeFile(helperPath, 'export const marker = 1;\n');
      await writeFile(
        sourcePath,
        [
          "import { marker } from './helper.ts';",
          'const guid = (last: number) => new Uint8Array([...Array(15).fill(0), last]);',
          'export default {',
          "schemaVersion: '1.0.0', packageId: guid(1),",
          "assets: { mesh: { guid: guid(2), kind: 'mesh' } }, externalAssets: {},",
          "build: () => ({ ok: true, value: { mesh: { kind: 'mesh', marker } } }),",
          '};',
        ].join('\n'),
      );
      const first = await loadScriptablePack(sourcePath, {
        executor: await pool.acquire(),
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const firstBuild = await first.value.build({} as never);
      expect(firstBuild.ok && (firstBuild.value.mesh as unknown as { marker: number }).marker).toBe(
        1,
      );

      await writeFile(helperPath, 'export const marker = 2;\n');
      const second = await loadScriptablePack(sourcePath, {
        executor: await pool.acquire(),
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      const secondBuild = await second.value.build({} as never);
      expect(
        secondBuild.ok && (secondBuild.value.mesh as unknown as { marker: number }).marker,
      ).toBe(2);
    } finally {
      await pool.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves bare imports past an unrelated nested Vite node_modules cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-node-floor-'));
    try {
      const sourceRoot = join(root, 'games', 'sample', 'assets');
      await mkdir(join(root, 'games', 'sample', 'node_modules', '.vite', 'deps'), {
        recursive: true,
      });
      const packageRoot = join(root, 'node_modules', 'scriptable-pack-fixture');
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: 'scriptable-pack-fixture',
          type: 'module',
          exports: { types: './index.d.ts', import: './index.mjs' },
        }),
      );
      await writeFile(join(packageRoot, 'index.mjs'), 'export const packageMarker = 40;\n');
      await writeFile(
        join(packageRoot, 'index.d.ts'),
        'export declare const packageMarker: number;\n',
      );
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(join(sourceRoot, 'helper.ts'), 'export const helperMarker: number = 2;\n');
      const sourcePath = join(sourceRoot, 'portable.pack.ts');
      await writeFile(
        sourcePath,
        [
          "import { packageMarker } from 'scriptable-pack-fixture';",
          "import { helperMarker } from './helper.ts';",
          'const guid = (last: number) => new Uint8Array([...Array(15).fill(0), last]);',
          'export default {',
          "schemaVersion: '1.0.0', packageId: guid(1),",
          "assets: { mesh: { guid: guid(2), kind: 'mesh' } }, externalAssets: {},",
          "build: () => ({ ok: true, value: { mesh: { kind: 'mesh', marker: packageMarker + helperMarker } } }),",
          '};',
        ].join('\n'),
      );

      const loaded = await loadScriptablePack(sourcePath);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      const built = await loaded.value.build({} as never);
      expect(built.ok && (built.value.mesh as unknown as { marker: number }).marker).toBe(42);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves engine packages from the packaged worker when the game has no node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-desktop-game-'));
    try {
      const sourceRoot = join(root, 'games', 'desktop-user-game', 'assets');
      await mkdir(sourceRoot, { recursive: true });
      const sourcePath = join(sourceRoot, 'portable.pack.ts');
      await writeFile(
        sourcePath,
        [
          "import { ok } from '@forgeax/engine-types';",
          'const guid = (last: number) => new Uint8Array([...Array(15).fill(0), last]);',
          'export default {',
          "schemaVersion: '1.0.0', packageId: guid(1),",
          "assets: { mesh: { guid: guid(2), kind: 'mesh' } }, externalAssets: {},",
          "build: () => ok({ mesh: { kind: 'mesh', marker: 42 } }),",
          '};',
        ].join('\n'),
      );

      const loaded = await loadScriptablePack(sourcePath);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      const built = await loaded.value.build({} as never);
      expect(built.ok && (built.value.mesh as unknown as { marker: number }).marker).toBe(42);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves structured external-read failures across the worker boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-worker-read-error-'));
    try {
      const sourcePath = join(root, 'reader-error.pack.ts');
      await writeFile(
        sourcePath,
        [
          'const packageId = new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,0]);',
          'const dependency = new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,1]);',
          'export default {',
          "schemaVersion: '1.0.0', packageId,",
          "assets: { mesh: { guid: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,2]), kind: 'mesh' } },",
          'externalAssets: { dependency },',
          'build: (reader: { readByGuid: (guid: Uint8Array) => Promise<unknown> }) => reader.readByGuid(dependency),',
          '};',
        ].join('\n'),
      );
      const loaded = await loadScriptablePack(sourcePath);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;

      const result = await loaded.value.build({
        readByGuid: async () =>
          err(
            new AssetError({
              code: 'asset-not-found',
              expected: 'the staged dependency snapshot',
              hint: 'publish the dependency before rebuilding the ScriptablePack',
              detail: { sourcePath: 'staged-dependency' },
            }),
          ),
      } as never);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'asset-not-found',
          expected: 'the staged dependency snapshot',
          hint: 'publish the dependency before rebuilding the ScriptablePack',
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes identity mutations through one GUID-allocating authoring gateway', async () => {
    const mutations: ScriptablePackAuthoringMutation[] = [];
    const rebuilds: string[] = [];
    const sourceMeta = projectScriptablePackMeta(definition(), 'house.pack.ts');
    const port = {
      async preflight() {
        return ok({
          revision: 'preflight:house.pack.ts',
          meta: sourceMeta,
          capabilities: { inspect: true, rebuild: true, coldCook: true, addOutput: true },
          incomingRefs: [],
        } as const);
      },
      async mutate(operation: ScriptablePackAuthoringMutation) {
        mutations.push(operation);
        return ok({
          sourcePath:
            operation.kind === 'clone-scriptable-pack'
              ? operation.targetPath
              : operation.sourcePath,
          revision: `write-${mutations.length}`,
        });
      },
      async inspect(sourcePath: string) {
        return ok({ revision: `inspect:${sourcePath}`, meta: sourceMeta });
      },
      async rebuild(sourcePath: string, mode: 'rebuild' | 'cold-cook') {
        rebuilds.push(`${mode}:${sourcePath}`);
        return ok({ revision: `cook:${mode}`, meta: sourceMeta });
      },
    };
    let nextGuid = 10;
    const gateway = createScriptablePackAuthoringGateway(port, () => {
      const value = new Uint8Array(16);
      value[15] = nextGuid++;
      return value as ReturnType<typeof AssetGuid.random>;
    });

    expect(
      (
        await gateway.execute({
          requestId: 'request-create',
          kind: 'create-scriptable-pack',
          sourcePath: 'created.pack.ts',
          initialOutput: { sourceKey: 'mesh', kind: 'mesh' },
        })
      ).ok,
    ).toBe(true);
    await gateway.execute({
      requestId: 'request-add',
      kind: 'add-output',
      sourcePath: 'created.pack.ts',
      sourceKey: 'scene',
      assetKind: 'scene',
    });
    await gateway.execute({
      requestId: 'request-remove',
      kind: 'remove-output',
      sourcePath: 'created.pack.ts',
      sourceKey: 'mesh',
    });
    await gateway.execute({
      requestId: 'request-clone',
      kind: 'clone-scriptable-pack',
      sourcePath: 'house.pack.ts',
      targetPath: 'house-copy.pack.ts',
    });
    const inspected = await gateway.execute({
      requestId: 'request-inspect',
      kind: 'inspect-meta',
      sourcePath: 'house.pack.ts',
    });
    const rebuilt = await gateway.execute({
      requestId: 'request-rebuild',
      kind: 'rebuild',
      sourcePath: 'house.pack.ts',
      expectedRevision: 'preflight:house.pack.ts',
    });

    expect(mutations.map((operation) => operation.kind)).toEqual([
      'create-scriptable-pack',
      'add-output',
      'remove-output',
      'clone-scriptable-pack',
    ]);
    expect(mutations[0]).toMatchObject({ packageId: expect.any(Uint8Array) });
    expect(mutations[1]).toMatchObject({ guid: expect.any(Uint8Array) });
    expect(mutations[3]).toMatchObject({
      packageId: expect.any(Uint8Array),
      outputGuids: {
        'geometry/wall': expect.any(Uint8Array),
        'scene/house': expect.any(Uint8Array),
      },
    });
    expect(inspected.ok && inspected.value.revision).toBe('inspect:house.pack.ts');
    expect(rebuilt.ok && rebuilt.value.revision).toBe('cook:rebuild');
    expect(rebuilds).toEqual(['rebuild:house.pack.ts']);

    const staleRebuild = await gateway.execute({
      requestId: 'request-rebuild-stale',
      kind: 'rebuild',
      sourcePath: 'house.pack.ts',
      expectedRevision: 'stale-revision',
    });
    expect(staleRebuild).toMatchObject({
      ok: false,
      error: { code: 'pack-source-revision-conflict', actual: 'preflight:house.pack.ts' },
    });
    expect(rebuilds).toEqual(['rebuild:house.pack.ts']);
  });

  it('authors canonical sources with confinement, CAS, and reference-aware removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-authoring-'));
    const incoming = new Map<string, readonly string[]>();
    try {
      const port = createFileSystemScriptablePackAuthoringPort({
        gameRoot: root,
        incomingRefs: async (_sourcePath, sourceKey) => incoming.get(sourceKey ?? '*') ?? [],
      });
      let nextGuid = 40;
      const gateway = createScriptablePackAuthoringGateway(port, () => {
        const value = new Uint8Array(16);
        value[15] = nextGuid++;
        return value as ReturnType<typeof AssetGuid.random>;
      });

      const created = await gateway.execute({
        requestId: 'create-canonical',
        kind: 'create-scriptable-pack',
        sourcePath: 'assets/generated.pack.ts',
        name: 'Generated',
        initialOutput: { sourceKey: 'scene/main', kind: 'scene', name: 'Main' },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.meta.subAssets).toMatchObject([
        { sourceKey: 'scene/main', kind: 'scene', name: 'Main' },
      ]);
      expect(await readFile(join(root, 'assets/generated.pack.ts'), 'utf8')).toContain(
        '@forgeax-scriptable-pack canonical-v1',
      );

      const preflight = await gateway.execute({
        requestId: 'preflight-canonical',
        kind: 'preflight',
        sourcePath: 'assets/generated.pack.ts',
      });
      expect(preflight).toMatchObject({
        ok: true,
        value: { capabilities: { addOutput: true, removeOutput: true } },
      });
      if (!preflight.ok) return;

      const added = await gateway.execute({
        requestId: 'add-canonical-output',
        expectedRevision: preflight.value.revision,
        kind: 'add-output',
        sourcePath: 'assets/generated.pack.ts',
        sourceKey: 'material/accent',
        assetKind: 'material',
        name: 'Accent',
      });
      expect(added).toMatchObject({
        ok: true,
        value: {
          meta: { subAssets: [{ sourceKey: 'material/accent' }, { sourceKey: 'scene/main' }] },
        },
      });

      const stale = await gateway.execute({
        requestId: 'stale-canonical-edit',
        expectedRevision: preflight.value.revision,
        kind: 'rename-display',
        sourcePath: 'assets/generated.pack.ts',
        target: { kind: 'package' },
        name: 'Stale',
      });
      expect(stale).toMatchObject({ ok: false, error: { code: 'pack-source-revision-conflict' } });

      incoming.set('material/accent', ['scene.pack.json#/entities/0/components/MeshRenderer']);
      const current = await port.inspect('assets/generated.pack.ts');
      expect(current.ok).toBe(true);
      if (!current.ok) return;
      const blocked = await gateway.execute({
        requestId: 'remove-referenced-output',
        expectedRevision: current.value.revision,
        kind: 'remove-output',
        sourcePath: 'assets/generated.pack.ts',
        sourceKey: 'material/accent',
      });
      expect(blocked).toMatchObject({
        ok: false,
        error: {
          code: 'pack-source-reference-conflict',
          detail: { incomingRefs: ['scene.pack.json#/entities/0/components/MeshRenderer'] },
        },
      });

      const removed = await gateway.execute({
        requestId: 'confirm-remove-referenced-output',
        expectedRevision: current.value.revision,
        kind: 'remove-output',
        sourcePath: 'assets/generated.pack.ts',
        sourceKey: 'material/accent',
        confirmIncomingRefs: ['scene.pack.json#/entities/0/components/MeshRenderer'],
      });
      expect(removed).toMatchObject({ ok: true });

      const escaped = await gateway.execute({
        requestId: 'escape-game-root',
        kind: 'inspect-meta',
        sourcePath: '../outside.pack.ts',
      });
      expect(escaped).toMatchObject({ ok: false, error: { code: 'pack-source-path-invalid' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects operation descriptors and makes caller request ids idempotent', async () => {
    const sourceMeta = projectScriptablePackMeta(definition(), 'house.pack.ts');
    let writes = 0;
    const gateway = createScriptablePackAuthoringGateway({
      async preflight() {
        return ok({
          revision: 'revision-1',
          meta: sourceMeta,
          capabilities: { inspect: true, rebuild: true, coldCook: true, addOutput: true },
          incomingRefs: ['019ffa97-0000-7000-8000-000000000001'],
        } as const);
      },
      async mutate(operation) {
        writes += 1;
        expect(operation.expectedRevision).toBe('revision-1');
        return ok({ sourcePath: operation.sourcePath, revision: 'revision-2' });
      },
      async inspect() {
        return ok({ revision: 'revision-2', meta: sourceMeta });
      },
      async rebuild() {
        return ok({ revision: 'revision-2', meta: sourceMeta });
      },
    });

    expect(SOURCE_AUTHORING_OPERATION_DESCRIPTORS.map((descriptor) => descriptor.id)).toContain(
      'asset-source.create',
    );
    const addOutputDescriptor = SOURCE_AUTHORING_OPERATION_DESCRIPTORS.find(
      (descriptor) => descriptor.id === 'asset-source.add-output',
    );
    expect(addOutputDescriptor).toMatchObject({
      kind: 'add-output',
      domain: 'session',
      argsSchema: {
        type: 'object',
        required: ['requestId', 'sourceKey', 'assetKind', 'expectedRevision'],
        additionalProperties: false,
        anyOf: [
          { required: ['requestId', 'sourceKey', 'assetKind', 'expectedRevision', 'sourcePath'] },
          { required: ['requestId', 'sourceKey', 'assetKind', 'expectedRevision', 'ownerGuid'] },
          { required: ['requestId', 'sourceKey', 'assetKind', 'expectedRevision', 'guid'] },
        ],
        properties: {
          sourcePath: { pattern: '^[^/].*\\.pack\\.ts$' },
          ownerGuid: { type: 'string', format: 'uuid' },
          requestId: { minLength: 1 },
          expectedRevision: { minLength: 64, maxLength: 64 },
        },
      },
    });
    const preflight = await gateway.execute({
      requestId: 'request-preflight',
      kind: 'preflight',
      sourcePath: 'house.pack.ts',
    });
    expect(preflight).toMatchObject({
      ok: true,
      value: { revision: 'revision-1', capabilities: { addOutput: true } },
    });

    const operation = {
      requestId: 'request-idempotent-add',
      expectedRevision: 'revision-1',
      kind: 'add-output' as const,
      sourcePath: 'house.pack.ts',
      sourceKey: 'mesh/new',
      assetKind: 'mesh' as const,
    };
    const first = await gateway.execute(operation);
    const replay = await gateway.execute(operation);
    expect(first).toEqual(replay);
    expect(writes).toBe(1);

    const conflict = await gateway.execute({
      ...operation,
      kind: 'remove-output',
      sourceKey: 'mesh/other',
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: 'pack-source-operation-committed', retryable: false },
    });
  });
});
