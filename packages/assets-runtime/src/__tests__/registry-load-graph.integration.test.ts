import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('registry load graph', () => {
  it('restores descriptor payloads through the production Pack path', async () => {
    const registry = new AssetRegistry({} as never);
    registry.configurePackIndex('/pack-index.json');
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: C,
          kind: 'render-pipeline',
          payload: { kind: 'render-pipeline', pipelineId: 'forgeax::urp' },
          refs: [],
          artifacts: {},
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          return new Response(
            JSON.stringify([
              {
                guid: C,
                packageUrl: '/descriptor.pack.json',
                kind: 'render-pipeline',
                sourcePath: 'pipeline',
              },
            ]),
          );
        }
        return new Response(JSON.stringify(pack));
      }),
    );

    const result = await registry.loadByGuid(registry.parseGuid(C));
    expect(result).toMatchObject({ ok: true, value: { kind: 'render-pipeline' } });
  });

  it('keeps a parent asset out of lookup when a recursive dependency is not ready', async () => {
    const registry = new AssetRegistry({} as never);
    registry.loaders.register({
      kind: 'parent-node',
      load: (payload) => ({ kind: 'parent-node', ...payload }),
    });
    registry.configurePackIndex('/pack-index.json');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          return new Response(
            JSON.stringify([
              { guid: A, packageUrl: '/parent.pack.json', kind: 'parent-node', sourcePath: 'a' },
            ]),
          );
        }
        return new Response(
          JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: A,
                kind: 'parent-node',
                payload: { name: 'parent' },
                refs: [B],
                artifacts: {},
              },
            ],
          }),
        );
      }),
    );

    const result = await registry.loadByGuid(registry.parseGuid(A));
    expect(result).toMatchObject({
      ok: false,
      error: { code: expect.any(String), hint: expect.any(String) },
    });
    expect(registry.lookup(A)).toBeUndefined();
  });

  it('terminates a cycle without exposing either provisional asset early', async () => {
    const registry = new AssetRegistry({} as never);
    registry.loaders.register({
      kind: 'cycle-node',
      load: (payload) => ({ kind: 'cycle-node', ...payload }),
    });
    registry.configurePackIndex('/pack-index.json');
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        { guid: A, kind: 'cycle-node', payload: { name: 'a' }, refs: [B], artifacts: {} },
        { guid: B, kind: 'cycle-node', payload: { name: 'b' }, refs: [A], artifacts: {} },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          return new Response(
            JSON.stringify([
              { guid: A, packageUrl: '/cycle.pack.json', kind: 'cycle-node', sourcePath: 'a' },
              { guid: B, packageUrl: '/cycle.pack.json', kind: 'cycle-node', sourcePath: 'b' },
            ]),
          );
        }
        return new Response(JSON.stringify(pack));
      }),
    );

    const result = await registry.loadByGuid(registry.parseGuid(A));
    expect(result.ok).toBe(true);
    expect(registry.lookup(A)).toBeDefined();
    expect(registry.lookup(B)).toBeDefined();
  });

  it('keeps a public concurrent load pending until a cyclic ref is ready', async () => {
    const registry = new AssetRegistry({} as never);
    registry.loaders.register({
      kind: 'race-node',
      load: (payload) => ({ kind: 'race-node', ...payload }),
    });
    registry.configurePackIndex('/pack-index.json');
    let releaseRef!: () => void;
    const refStarted = new Promise<void>((resolve) => {
      releaseRef = resolve;
    });
    let refRequested!: () => void;
    const refRequest = new Promise<void>((resolve) => {
      refRequested = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          return new Response(
            JSON.stringify([
              { guid: A, packageUrl: '/race.pack.json', kind: 'race-node', sourcePath: 'a' },
              { guid: B, packageUrl: '/race.pack.json', kind: 'race-node', sourcePath: 'b' },
            ]),
          );
        }
        if (url.endsWith('a.json')) {
          return new Response(JSON.stringify({ format: 'race', emitters: [{ id: 'a' }] }));
        }
        if (url.endsWith('b.json')) {
          refRequested();
          await refStarted;
          return new Response(JSON.stringify({ format: 'race', emitters: [{ id: 'b' }] }));
        }
        return new Response(
          JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: A,
                kind: 'race-node',
                payload: { name: 'a' },
                refs: [B],
                artifacts: { program: { path: 'a.json', mediaType: 'application/json' } },
              },
              {
                guid: B,
                kind: 'race-node',
                payload: { name: 'b' },
                refs: [],
                artifacts: { program: { path: 'b.json', mediaType: 'application/json' } },
              },
            ],
          }),
        );
      }),
    );

    const first = registry.loadByGuid(registry.parseGuid(A));
    await refRequest;
    let publicSettled = false;
    const concurrent = registry.loadByGuid(registry.parseGuid(A)).then((result) => {
      publicSettled = true;
      return result;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(publicSettled).toBe(false);

    releaseRef();
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
    expect(firstResult.ok).toBe(true);
    expect(concurrentResult).toEqual(firstResult);
  });

  it('waits for a shared sibling dependency while preserving SCC back-edges', async () => {
    const registry = new AssetRegistry({} as never);
    registry.loaders.register({
      kind: 'shared-node',
      load: (payload) => ({ kind: 'shared-node', ...payload }),
    });
    registry.configurePackIndex('/pack-index.json');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          return new Response(
            JSON.stringify([
              { guid: A, packageUrl: '/shared.pack.json', kind: 'shared-node', sourcePath: 'a' },
              { guid: B, packageUrl: '/shared.pack.json', kind: 'shared-node', sourcePath: 'b' },
              { guid: C, packageUrl: '/shared.pack.json', kind: 'shared-node', sourcePath: 'c' },
              { guid: D, packageUrl: '/shared.pack.json', kind: 'shared-node', sourcePath: 'd' },
            ]),
          );
        }
        return new Response(
          JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              { guid: A, kind: 'shared-node', payload: { name: 'a' }, refs: [B, C], artifacts: {} },
              { guid: B, kind: 'shared-node', payload: { name: 'b' }, refs: [D], artifacts: {} },
              { guid: C, kind: 'shared-node', payload: { name: 'c' }, refs: [D], artifacts: {} },
              { guid: D, kind: 'shared-node', payload: { name: 'd' }, refs: [], artifacts: {} },
            ],
          }),
        );
      }),
    );

    const result = await registry.loadByGuid(registry.parseGuid(A));

    expect(result.ok).toBe(true);
    expect(registry.lookup(A)).toBeDefined();
    expect(registry.lookup(B)).toBeDefined();
    expect(registry.lookup(C)).toBeDefined();
    expect(registry.lookup(D)).toBeDefined();
  });
});
