import { describe, expect, it } from 'vitest';
import { type AssetHostRefreshPolicy, reloadAssetHost } from '../catalog-client.js';
import { createPackageRoutes } from '../dev/package-routes.js';

describe('explicit asset-host refresh policy', () => {
  it('turns a watched source or sidecar change into Vite full-reload only when the host opts in', () => {
    const sent: Array<{ type: 'full-reload' }> = [];
    reloadAssetHost()({ ws: { send: (message) => sent.push(message) } });

    expect(sent).toEqual([{ type: 'full-reload' }]);
  });

  it('has no implicit fallback when a host deliberately supplies no refresh policy', () => {
    const sent: Array<{ type: 'full-reload' }> = [];
    const host: { readonly refresh?: AssetHostRefreshPolicy } = {};
    host.refresh?.({ ws: { send: (message) => sent.push(message) } });

    expect(sent).toEqual([]);
  });
});

describe('shared package route delivery', () => {
  it('deduplicates repeated publication of one logical package', async () => {
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    const routes = createPackageRoutes();
    const logicalPackage = {
      schemaVersion: '2.0.0' as const,
      kind: 'internal-text-package' as const,
      assets: [],
    };
    const sink = {
      write(path: string, bytes: Uint8Array) {
        writes.push({ path, bytes });
      },
    };
    const policy = {
      base: '/preview/',
      packagePath: 'assets/package.json',
      artifactPath: (guid: string, key: string) => `assets/${guid}/${key}.bin`,
    };

    const first = await routes.publish(
      { origin: 'sourceMeta', cooked: true, logicalPackage },
      sink,
      policy,
    );
    const second = await routes.publish(
      { origin: 'sourceMeta', cooked: true, logicalPackage },
      sink,
      policy,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.cacheHit).toBe(true);
    expect(writes).toHaveLength(1);
  });
});
