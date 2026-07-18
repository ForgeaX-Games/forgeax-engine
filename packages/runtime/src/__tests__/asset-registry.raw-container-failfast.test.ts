// asset-registry.raw-container-failfast.test.ts -- perf-20260706-raw-container-failfast
//
// Regression for the city_Sample_512 slowness. The gltf/fbx catalog arm
// (vite-plugin-pack build-catalog) emits thin mesh/material/scene rows whose
// relativeUrl is the RAW source container (`.glb` / `.gltf` / `.fbx`); the
// per-sub-asset importer artifact (`.<guid>.bin` / `.pack.json`) only exists
// AFTER the ImportTransport (dev `POST /__import/:guid`) parses the container.
//
// Before the fix, a material/mesh/scene row with a raw `.glb` relativeUrl was
// fetched + `res.json()`-parsed FIRST (throws on binary glTF) before falling
// through to the transport -- so a 1028-sub-asset GLB re-downloaded the 62 MB
// container ~707x (once per non-texture sub-asset), ~5 min add-to-scene.
//
// The fix fails fast in ddcLoad: a non-upstream sub-asset whose relativeUrl is a
// raw container returns asset-not-imported (transport-eligible) WITHOUT fetching
// the container, mirroring the texture path's pre-fetch `.bin`-suffix guard.
//
// Assertions:
//   (1) the raw `.glb` URL is NEVER fetched (was fetched once per sub-asset)
//   (2) the transport IS called (fail-fast is transport-eligible)
//   (3) after the transport rewrites the row to a `.pack.json`, the load succeeds
//       via the imported artifact -- no loop back onto the raw container.
// Anti-vacuous: without the fix, the raw `.glb` is fetched (res.json throws).

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { ImportTransport } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const MAT_GUID = 'a0000000-0000-4000-a000-00006d6174a1';
const RAW_GLB_URL = '/preview/assets/city_like.glb';
const IMPORTED_PACK_URL = '/__forgeax-ddc/a0000000-0000-4000-a000-00006d6174a1.pack.json';
const PACK_INDEX_URL = '/pack-index.json';

function parseGuid(g: string): AssetGuid {
  const parsed = AssetGuid.parse(g);
  if (!parsed.ok) throw new Error(`bad guid ${g}`);
  return parsed.value;
}

// A material entry served from the imported `.pack.json` (the post-transport
// artifact). Minimal valid unlit material.
function importedMaterialPack() {
  return {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: MAT_GUID,
        kind: 'material',
        payload: {
          passes: [
            {
              name: 'forward',
              shader: 'test::dummy',
              tags: { LightMode: 'Forward' },
              paramValues: {},
            },
          ],
        },
        refs: [],
      },
    ],
  };
}

describe('raw-container fail-fast (perf-20260706)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    defineComponent('MeshRenderer', { materials: 'array<shared<MaterialAsset>>' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('never fetches the raw .glb; routes through transport; loads from imported .pack.json', async () => {
    // Pack-index: a single material row whose relativeUrl is the RAW .glb.
    const packIndex = [{ guid: MAT_GUID, relativeUrl: RAW_GLB_URL, kind: 'material' }];

    let rawGlbFetches = 0;
    let importedPackFetches = 0;

    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === RAW_GLB_URL) {
        // Binary GLB: res.json() would THROW (mirrors the real 62 MB container).
        rawGlbFetches++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.reject(new Error('binary glTF is not JSON')),
        });
      }
      if (url === IMPORTED_PACK_URL) {
        importedPackFetches++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(importedMaterialPack()) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof globalThis.fetch;

    // Transport: mirrors the dev POST /__import/:guid -> rewrites the row's
    // relativeUrl from the raw .glb to the imported .pack.json.
    const transport: ImportTransport = {
      fetchPack: vi.fn().mockResolvedValue({
        ok: true,
        entries: [{ guid: MAT_GUID, relativeUrl: IMPORTED_PACK_URL, kind: 'material' }],
      }),
    };

    const reg = new AssetRegistry(makeMockShaderRegistry(), transport);
    reg.configurePackIndex(PACK_INDEX_URL);

    const result = await reg.loadByGuid(parseGuid(MAT_GUID));

    // (3) load succeeds via the imported artifact.
    expect(result.ok).toBe(true);
    // (1) the raw .glb was NEVER fetched (fail-fast before the fetch).
    expect(rawGlbFetches).toBe(0);
    // (2) the transport ran, and (3) the imported pack was fetched once.
    expect(transport.fetchPack).toHaveBeenCalledTimes(1);
    expect(importedPackFetches).toBe(1);
  });

  it('shipped form (no transport): raw-container row fails fast with asset-not-imported, no .glb fetch', async () => {
    const packIndex = [{ guid: MAT_GUID, relativeUrl: RAW_GLB_URL, kind: 'material' }];
    let rawGlbFetches = 0;
    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === RAW_GLB_URL) {
        rawGlbFetches++;
        return Promise.resolve({ ok: true, json: () => Promise.reject(new Error('binary')) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry()); // no transport
    reg.configurePackIndex(PACK_INDEX_URL);

    const result = await reg.loadByGuid(parseGuid(MAT_GUID));
    expect(result.ok).toBe(false);
    // The fail-fast surfaces `source-not-imported` (transport-eligible); with no
    // transport wired, transportOrFail then returns the generic
    // `asset-not-imported` (shipped-form fail-fast, AC-22). Either way the raw
    // container is never fetched.
    if (!result.ok) expect(result.error.code).toBe('asset-not-imported');
    expect(rawGlbFetches).toBe(0);
  });
});
