import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('registry load graph', () => {
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
});
