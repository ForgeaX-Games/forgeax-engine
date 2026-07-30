import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';

const ROOT = '11111111-1111-4111-8111-111111111111';
const REF = '22222222-2222-4222-8222-222222222222';

describe('registry failure cleanup and retry', () => {
  it('purges a failed ref closure before retrying the repaired package', async () => {
    const registry = new AssetRegistry({} as never);
    registry.loaders.register({
      kind: 'retry-node',
      load: (payload) => ({ kind: 'retry-node', ...payload }),
    });
    registry.configurePackIndex('/pack-index.json');
    let repaired = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('pack-index.json')) {
          return new Response(
            JSON.stringify([
              {
                guid: ROOT,
                packageUrl: '/retry.pack.json',
                kind: 'retry-node',
                sourcePath: 'root',
              },
              { guid: REF, packageUrl: '/retry.pack.json', kind: 'retry-node', sourcePath: 'ref' },
            ]),
          );
        }
        return new Response(
          JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: ROOT,
                kind: 'retry-node',
                payload: { name: 'root' },
                refs: [REF],
                artifacts: {},
              },
              ...(repaired
                ? [
                    {
                      guid: REF,
                      kind: 'retry-node',
                      payload: { name: 'ref' },
                      refs: [],
                      artifacts: {},
                    },
                  ]
                : []),
            ],
          }),
        );
      }),
    );

    const failed = await registry.loadByGuid(registry.parseGuid(ROOT));
    expect(failed.ok).toBe(false);
    expect(registry.lookup(ROOT)).toBeUndefined();
    repaired = true;
    const retried = await registry.loadByGuid(registry.parseGuid(ROOT));
    expect(retried.ok).toBe(true);
    expect(registry.lookup(REF)).toBeDefined();
  });
});
