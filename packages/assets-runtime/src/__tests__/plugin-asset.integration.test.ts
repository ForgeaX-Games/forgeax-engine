import { pluginAssetOutputProducer } from '@forgeax/engine-import';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import type { PluginAsset } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';

const guid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mesh = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
afterEach(() => vi.unstubAllGlobals());

describe('Pack plugin production and runtime transport', () => {
  it('rejects a definition read whose Catalog source was replaced during transport', async () => {
    const packageUrl = 'https://project.invalid/player.pack.json';
    const publication = createRuntimePackPublication({
      scopeId: 'game',
      sourcePath: 'player',
      sourceRevision: 'fixed',
      packageUrl,
      pack: {
        assets: [
          {
            guid,
            kind: 'plugin',
            payload: { kind: 'plugin', program: 'player' },
            refs: [],
            artifacts: {},
          },
        ],
      },
    });
    const source = () => ({
      expectedScope: { scopeId: 'game', generation: 1 },
      enumerate: async () =>
        ok([
          {
            guid,
            kind: 'plugin',
            packageUrl,
            sourcePath: 'player',
            publication: publication.publication,
          },
        ]),
      subscribe: () => () => {},
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const registry = new AssetRegistry({} as never);
    registry.setCatalogSource(source(), async () => {
      enter();
      await gate;
      return new Response(JSON.stringify(publication.pack));
    });
    try {
      const pending = registry.readPluginDefinition(guid);
      await entered;
      registry.setCatalogSource(
        source(),
        async () => new Response(JSON.stringify(publication.pack)),
      );
      resume();
      expect((await pending).ok).toBe(false);
      expect(registry.packFileCache.size).toBe(0);
      expect((await registry.readPluginDefinition(guid)).ok).toBe(true);
    } finally {
      resume();
      registry.clearCatalogSource();
    }
  });
  it('rejects an older body served at the current Catalog publication URL', async () => {
    const packageUrl = 'https://project.invalid/player.pack.json';
    const publication = (revision: number) =>
      createRuntimePackPublication({
        scopeId: 'game',
        sourcePath: 'assets/player.pack.json',
        sourceRevision: String(revision),
        packageUrl,
        pack: {
          assets: [
            {
              guid,
              kind: 'plugin',
              payload: {
                kind: 'plugin',
                program: 'project:player.js#default',
                config: { revision },
              },
              refs: [],
              artifacts: {},
            },
          ],
        },
      });
    const old = publication(1);
    const current = publication(2);
    const registry = new AssetRegistry({} as never);
    registry.setCatalogSource(
      {
        expectedScope: { scopeId: 'game', generation: 1 },
        enumerate: async () =>
          ok([
            {
              guid,
              kind: 'plugin',
              packageUrl,
              sourcePath: 'assets/player.pack.json',
              publication: current.publication,
            },
          ]),
        subscribe: () => () => {},
      },
      async () => new Response(JSON.stringify(old.pack)),
    );
    try {
      expect((await registry.readPluginDefinition(guid)).ok).toBe(false);
    } finally {
      registry.clearCatalogSource();
    }
  });
  it('reads the definition and atomic tuple without loading referenced custom kinds', async () => {
    const produced = await pluginAssetOutputProducer.produce({
      guid,
      sourceKey: 'plugin/player',
      sourcePath: '/game/assets/player.pack.ts',
      projectRoot: '/game',
      asset: {
        kind: 'plugin',
        module: { specifier: './player.pack.ts', export: 'player' },
        config: { mesh: { $asset: mesh }, speed: 4 },
      },
    });
    expect(produced.ok).toBe(true);
    const product = produced.unwrap();
    const tuple = {
      scopeId: 'game',
      generation: 4,
      digest: `sha256:${'a'.repeat(64)}`,
      outputSetDigest: `sha256:${'b'.repeat(64)}`,
    };
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      ...tuple,
      assets: [
        {
          guid,
          kind: 'plugin',
          payload: product.payload,
          refs: product.refs.map((ref) => ref.guid),
          artifacts: {},
        },
      ],
    };
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url === '/pack-index.json'
              ? [
                  {
                    guid,
                    kind: 'plugin',
                    packageUrl: '/player.pack.json',
                    sourcePath: 'assets/player.pack.ts',
                  },
                ]
              : pack,
          ),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const registry = new AssetRegistry({} as never);
    registry.configurePackIndex('/pack-index.json');
    expect(await registry.loadByGuid<PluginAsset>(registry.parseGuid(guid))).toMatchObject({
      ok: true,
      value: {
        kind: 'plugin',
        program: 'project:assets/player.pack.ts#player',
        config: { mesh, speed: 4 },
      },
    });
    expect(registry.lookup(mesh)).toBeUndefined();
    const definition = await registry.readPluginDefinition(guid);
    expect(definition).toMatchObject({
      ok: true,
      value: { guid, evidence: { kind: 'publication', publication: tuple } },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
