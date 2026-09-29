import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProjectCookers, type ProjectCookers } from '../build/cookers.js';
import { discoverPluginAssets } from '../build/plugin-assets.js';
import type { ProjectFacts } from '../types.js';

const namespace = '019fb7ce-4200-7000-8000-000000000000';
const parsed = PackageId.parse(namespace);
if (!parsed.ok) throw parsed.error;
const guid = AssetGuid.format(AssetGuid.derive(parsed.value, 'plugin/build'));
const roots: string[] = [];
const sessions: ProjectCookers[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(body: string, nested = false): Promise<ProjectFacts> {
  const parent = await mkdtemp(resolve(import.meta.dirname, '../../..', '.build-fixture-'));
  roots.push(parent);
  const root = nested ? resolve(parent, '.forgeax/game') : parent;
  await mkdir(resolve(root, 'assets'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(
    resolve(root, 'forge.json'),
    JSON.stringify({
      id: 'fixture',
      name: 'Fixture',
      schemaVersion: '3.0.0',
      roots: { build: guid },
    }),
  );
  await writeFile(
    resolve(root, 'assets/build.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: namespace,
      assets: {
        'plugin/build': { kind: 'plugin', payload: { module: { specifier: './build.ts' } } },
      },
    }),
  );
  await writeFile(resolve(root, 'assets/build.ts'), body);
  return {
    root,
    id: 'fixture',
    name: 'Fixture',
    packageJson: {},
    assetRoots: ['assets'],
    roots: { build: guid },
  };
}

describe('native build root process', () => {
  it('cold-starts an original Cooker in one process and preserves its closure across calls', async () => {
    const facts = await fixture(`export default { inject: ['nativeCookers'], apply(ctx) {
      let sequence = 0;
      const pid = process.pid;
      ctx.effect(() => ctx.nativeCookers.register({ key: 'fixture',
        discover(input) { return { ...input, transformed: true }; },
        cook(input) { return { guid: input.guid, payload: { pid, sequence: ++sequence, transformed: input.transformed },
          refs: [], artifacts: { body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2]) } }, inputFingerprint: 'fixture' }; }
      }));
    } };`);
    const first = await discoverPluginAssets(facts);
    const second = await discoverPluginAssets(facts);
    expect([...second.assets]).toEqual([...first.assets]);
    const session = await loadProjectCookers(facts, []);
    sessions.push(session);
    expect(session.cookers).toHaveLength(1);
    if (!session.cookers[0]) throw new Error('required fixture session.cookers[0] missing');
    const a = await session.cookers[0].cook({ guid });
    const b = await session.cookers[0].cook({ guid });
    expect(a.payload).toMatchObject({ sequence: 1, transformed: true });
    expect(b.payload).toMatchObject({ sequence: 2 });
    expect((a.payload as { pid: number }).pid).not.toBe(process.pid);
    expect((b.payload as { pid: number }).pid).toBe((a.payload as { pid: number }).pid);
    expect(a.artifacts.body?.bytes).toEqual(new Uint8Array([1, 2]));
    await session.dispose();
    expect(await readdir(resolve(facts.root, '.forgeax/build'))).toEqual([]);
    await expect(session.cookers[0].cook({ guid })).rejects.toThrow('unavailable');
  }, 30_000);

  it('rejects a builtin key collision and leaves no build process artifacts', async () => {
    const facts = await fixture(`export default { inject: ['nativeCookers'], apply(ctx) {
      ctx.effect(() => ctx.nativeCookers.register({ key: 'builtin', cook() {} }));
    } };`);
    await expect(
      loadProjectCookers(facts, [
        {
          key: 'builtin',
          cook() {
            throw new Error('unused');
          },
        },
      ]),
    ).rejects.toThrow('duplicate builtin/project cooker');
    expect(await readdir(resolve(facts.root, '.forgeax/build'))).toEqual([]);
  }, 30_000);

  it('reports unowned producer residue instead of treating native disposal as clean', async () => {
    const facts = await fixture(`export default { inject: ['nativeCookers'], apply(ctx) {
      ctx.nativeCookers.register({ key: 'leaked', cook() {} });
    } };`);
    const session = await loadProjectCookers(facts, []);
    sessions.push(session);
    await expect(session.dispose()).rejects.toMatchObject({
      message: expect.stringContaining('cleanup left registered cookers'),
    });
    expect(await readdir(resolve(facts.root, '.forgeax/build'))).toEqual([]);
  }, 30_000);
  it('keeps Importer reads, decoder capabilities, visibility and finalization in the build owner', async () => {
    const facts = await fixture(`export default { inject: ['importers'], apply(ctx) {
      const pid = process.pid;
      ctx.effect(() => ctx.importers.register({ key: 'fixture-importer',
        async import(input) {
          const source = await input.readSource();
          const sibling = await input.readSibling('sibling.bin');
          const decoded = await input.decodeImage(source.value, 'image/png', {});
          return { pid, source, sibling, decoded };
        },
        capabilities: {
          decodeImage: async bytes => ({ ok: true, value: { texture: { kind: 'texture', pid }, bytes } }),
          catalog: { publish: ({ importSettings }) => importSettings.visible === true },
        },
        finalize(product, { artifactUrl }) {
          return { ok: true, value: { asset: { pid, url: artifactUrl({ path: 'body' }) }, artifacts: [] } };
        },
      }));
    } };`);
    const session = await loadProjectCookers(facts, []);
    sessions.push(session);
    const importer = session.importers[0];
    if (!importer) throw new Error('required fixture importer missing');
    const decode = importer.capabilities?.decodeImage,
      publish = importer.capabilities?.catalog?.publish,
      finalize = importer.finalize;
    if (!decode) throw new Error('required fixture decode missing');
    if (!publish) throw new Error('required fixture publish missing');
    if (!finalize) throw new Error('required fixture finalize missing');
    const result = await importer.import({
      source: 'source.bin',
      subAssets: [],
      importSettings: {},
      readSource: async () => ({ ok: true, value: new Uint8Array([7]) }),
      readSibling: async (uri) => {
        expect(uri).toBe('sibling.bin');
        return { ok: true, value: new Uint8Array([8]) };
      },
      decodeImage: (...args) => decode(...args),
    });
    expect(result.pid).not.toBe(process.pid);
    expect(result.source.value).toEqual(new Uint8Array([7]));
    expect(result.sibling.value).toEqual(new Uint8Array([8]));
    expect(result.decoded.value.texture.pid).toBe(result.pid);
    expect(
      await publish({
        importSettings: { visible: false },
        subAssets: [],
      }),
    ).toBe(false);
    const finalized = await finalize(
      {
        assets: [
          {
            guid,
            kind: 'blob',
            payload: {},
            refs: [],
            artifacts: {
              body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([7]) },
            },
          },
        ],
        sourceDependencies: [],
      },
      { artifactUrl: ({ path }) => `/published/${path}` },
    );
    expect(finalized).toMatchObject({
      ok: true,
      value: { asset: { pid: result.pid, url: '/published/body' } },
    });
    await session.dispose();
  }, 30_000);
});

describe('build environment deadlines', () => {
  it.each([
    'startup',
    'cook',
    'cleanup',
  ] as const)('terminates an uncooperative %s operation and removes its session', async (operation) => {
    const facts = await fixture(
      operation === 'startup'
        ? 'export default { apply() { return new Promise(() => {}); } };'
        : `export default { inject: ['nativeCookers'], apply(ctx) {
          ctx.effect(() => ctx.nativeCookers.register({ key: 'hung', cook() { return new Promise(() => {}); } }));
          ${operation === 'cleanup' ? 'ctx.effect(() => () => new Promise(() => {}));' : ''}
        } };`,
    );
    const pending = loadProjectCookers(
      facts,
      [],
      {},
      {
        startupTimeoutMs: operation === 'startup' ? 100 : 10_000,
        operationTimeoutMs: 100,
        cleanupTimeoutMs: 100,
      },
    );
    if (operation === 'startup') await expect(pending).rejects.toThrow('process terminated');
    else {
      const session = await pending;
      sessions.push(session);
      if (!session.cookers[0]) throw new Error('required fixture session.cookers[0] missing');
      if (operation === 'cook')
        await expect(session.cookers[0].cook({ guid })).rejects.toThrow('process terminated');
      else await expect(session.dispose()).rejects.toThrow('process terminated');
      await session.dispose();
    }
    expect(await readdir(resolve(facts.root, '.forgeax/build'))).toEqual([]);
  }, 30_000);
});

it('discovers projects beneath an ancestor cache while ignoring their own generated sources', async () => {
  const facts = await fixture('export default { apply() {} };', true);
  await mkdir(resolve(facts.root, 'assets/.forgeax'));
  await writeFile(resolve(facts.root, 'assets/.forgeax/broken.pack.json'), 'not authored JSON');
  const inventory = await discoverPluginAssets(facts);
  expect([...inventory.assets.keys()]).toEqual([guid]);
});
