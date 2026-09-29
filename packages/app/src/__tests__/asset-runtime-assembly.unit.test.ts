import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import type { Loader } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';

import { createAssetRuntimeAssembly } from '../assets-runtime-assembly';

describe('AssetRegistry app assembly', () => {
  it('reuses the supplied Registry, installs explicit decoders, and disposes the lease', () => {
    const registry = new AssetRegistry({} as never);
    const decoder = {
      kind: 'app-test-decoder',
      load: () => ({ kind: 'app-test-asset' }),
    } as Loader<unknown>;
    const result = createAssetRuntimeAssembly(registry, {
      registry,
      catalogSource: createCatalogSource({ entries: [] }),
      decoderContributions: [decoder],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.registry).toBe(registry);
    expect(registry.packIndexUrl).toBeUndefined();
    expect(registry.loaders.get(decoder.kind)).toBe(decoder);

    result.value.dispose();
    result.value.dispose();
    expect(registry.loaders.get(decoder.kind)).toBeUndefined();
    expect(registry.catalogSnapshot()).toBeUndefined();
  });

  it('keeps the default shipped source and accepts an explicit content transport', async () => {
    const registry = new AssetRegistry({} as never);
    const shipped = createAssetRuntimeAssembly(registry).unwrap();
    expect(registry.packIndexUrl).toBe('/pack-index.json');
    shipped.dispose();
    const fetcher = vi.fn<typeof fetch>(async () => new Response('local bytes'));
    const explicit = createAssetRuntimeAssembly(registry, {
      catalogSource: createCatalogSource({ entries: [] }),
      fetcher,
    }).unwrap();
    expect(await (await registry.fetchAsset('https://runtime.invalid/body')).text()).toBe(
      'local bytes',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    explicit.dispose();
  });

  it('returns a closed assembly error instead of creating a second Registry owner', () => {
    const rendererRegistry = new AssetRegistry({} as never);
    const injectedRegistry = new AssetRegistry({} as never);
    const result = createAssetRuntimeAssembly(rendererRegistry, { registry: injectedRegistry });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'asset-assembly-failed',
        detail: expect.objectContaining({ kind: 'registry' }),
      }),
    });
  });
});
