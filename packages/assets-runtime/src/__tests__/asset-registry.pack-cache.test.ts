import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';

const GUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('asset registry cache cleanup', () => {
  it('clears failed package and in-flight state so a retry can succeed', async () => {
    const registry = new AssetRegistry({} as never);
    registry.loaders.register({
      kind: 'host-blob',
      load: (payload) => ({ kind: 'host-blob', ...payload }),
    });
    registry.configurePackIndex('/pack-index.json');
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          return new Response(
            JSON.stringify([
              {
                guid: GUID,
                packageUrl: '/asset.pack.json',
                kind: 'host-blob',
                sourcePath: 'asset',
              },
            ]),
          );
        }
        attempts += 1;
        if (attempts === 1) return new Response('missing', { status: 404 });
        return new Response(
          JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              { guid: GUID, kind: 'host-blob', payload: { value: 1 }, refs: [], artifacts: {} },
            ],
          }),
        );
      }),
    );

    const first = await registry.loadByGuid(registry.parseGuid(GUID));
    expect(first.ok).toBe(false);
    const second = await registry.loadByGuid(registry.parseGuid(GUID));
    expect(second.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(registry.lookup(GUID)).toBeDefined();
  });

  it('does not expose an unresolved package as a public fast-path hit', async () => {
    const registry = new AssetRegistry({} as never);
    registry.loaders.register({
      kind: 'host-blob',
      load: (payload) => ({ kind: 'host-blob', ...payload }),
    });
    registry.configurePackIndex('/pack-index.json');
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          return new Response(
            JSON.stringify([
              {
                guid: GUID,
                packageUrl: '/asset.pack.json',
                kind: 'host-blob',
                sourcePath: 'asset',
              },
            ]),
          );
        }
        await pending;
        return new Response(
          JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              { guid: GUID, kind: 'host-blob', payload: { value: 1 }, refs: [], artifacts: {} },
            ],
          }),
        );
      }),
    );

    const loading = registry.loadByGuid(registry.parseGuid(GUID));
    expect(registry.lookup(GUID)).toBeUndefined();
    release?.();
    await loading;
  });
});
