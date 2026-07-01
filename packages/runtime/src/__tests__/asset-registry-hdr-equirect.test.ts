// asset-registry-hdr-equirect.test.ts
// feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M1 / w1.
//
// TDD red->green: locks the runtime equirectLoader (w4) loading an
// EquirectAsset POD from a build-time-imported rgba16float .bin, and its
// registration into UPSTREAM_ENTRY_LOADERS (so 'equirect' is derived into
// UPSTREAM_ENTRY_KINDS without a second hand-edited list). research F-1.

import type { LoadContext, LoaderAsyncResult } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { equirectLoader, UPSTREAM_ENTRY_LOADERS } from '../asset-registry.js';

function mockCtx(binaries: Record<string, Uint8Array>): LoadContext {
  return {
    fetchBinary: async (url: string) => {
      const b = binaries[url];
      return b !== undefined
        ? { ok: true as const, value: b }
        : { ok: false as const, error: new Error(`no binary for ${url}`) };
    },
    resolveRef: async () => ({ ok: false as const, error: new Error('no ref') }),
    device: undefined,
  };
}

describe('equirectLoader (w1)', () => {
  it('(a) UPSTREAM_ENTRY_LOADERS includes equirect after texture + font', () => {
    expect(UPSTREAM_ENTRY_LOADERS.map((l) => l.kind)).toContain('equirect');
  });

  it('(b) loads an EquirectAsset POD (kind:"equirect" + rgba16float) from .bin bytes', async () => {
    const url = '/imported/env.bin';
    // rgba16float = 8 bytes per pixel; 2x2 = 32 bytes.
    const data = new Uint8Array(2 * 2 * 4 * 2).fill(0x3c);
    const entry = {
      relativeUrl: url,
      kind: 'equirect',
      metadata: {
        kind: 'texture' as const,
        width: 2,
        height: 2,
        format: 'rgba16float' as const,
        colorSpace: 'linear' as const,
        mipmap: false,
      },
    };
    const out = (await equirectLoader.load(
      entry as unknown as Record<string, unknown>,
      undefined,
      mockCtx({ [url]: data }),
    )) as LoaderAsyncResult;
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).toMatchObject({
        kind: 'equirect',
        width: 2,
        height: 2,
        format: 'rgba16float',
      });
    }
  });

  it('(c) fails when the source is not an imported .bin', async () => {
    const out = (await equirectLoader.load(
      { relativeUrl: '/env.hdr', kind: 'equirect' } as unknown as Record<string, unknown>,
      undefined,
      mockCtx({}),
    )) as LoaderAsyncResult;
    expect(out.ok).toBe(false);
  });
});
