import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import type { ImportContext, ImportedAsset } from '@forgeax/engine-types';
import { fbxImporter } from '../src/fbx-importer.js';

const CUBE_FBX_PATH = new URL(
  '../../../forgeax-engine-assets/vendor/fbx-test/cube.fbx',
  import.meta.url,
).pathname;

// cube.fbx's declared sub-assets (mirror of cube.fbx.meta.json). The importer
// honours the GUID import-stable iron law: it only emits assets declared here,
// resolved by (kind, sourceIndex). An empty list would (correctly) yield zero
// assets, so the test must declare them.
const CUBE_SUB_ASSETS = [
  { guid: '019ecd87-179a-7435-b383-6846514b9535', kind: 'mesh', sourceIndex: 0 },
  { guid: '019ecd87-179b-7356-a2c2-8f68a936ab6a', kind: 'material', sourceIndex: 0 },
  { guid: '019ecd87-179b-773b-8679-4ee436fdd878', kind: 'scene', sourceIndex: 0 },
] as const;

/** Minimal fake ImportContext for tests. */
function fakeCtx(source: string): ImportContext {
  return {
    source,
    readSource: async () => ({
      ok: true as const,
      value: new Uint8Array(0),
    }),
    readSibling: async () => ({
      ok: false as const,
      error: {
        code: 'source-read-failed' as const,
        expected: 'mock',
        hint: 'mock',
        detail: {},
      },
    }),
    decodeImage: async () => ({
      ok: false as const,
      error: {
        code: 'image-decode-failed' as const,
        expected: 'mock',
        hint: 'mock',
        detail: { mimeType: 'image/png' as const, byteLength: 0, reason: 'mock' },
      },
    }),
    subAssets: CUBE_SUB_ASSETS,
    importSettings: {},
  };
}

describe('fbx-importer', () => {
  it('fbxImporter.key is "fbx"', () => {
    expect(fbxImporter.key).toBe('fbx');
  });

  it('import() returns ImportedAsset[] for cube.fbx when binding is built', async () => {
    if (!existsSync(CUBE_FBX_PATH)) {
      // Skip if fixture not available (CI without SDK)
      return;
    }
    // We cannot guarantee the binding is built in CI; the test will throw
    // if binding is absent, which is the expected contract (charter P3).
    // Try the import and catch the binding-not-built error gracefully.
    let result: readonly ImportedAsset[];
    try {
      result = await fbxImporter.import(fakeCtx(CUBE_FBX_PATH));
    } catch (err: unknown) {
      // R2: fbx-importer throws plain Error with code in message (Importer
      // framework contract returns Promise<ImportedAsset[]>; importers may
      // throw, runner stringifies). Match by message substring.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('fbx-binding-not-built')) {
        // Expected in CI without FBX SDK. Test passes.
        return;
      }
      throw err;
    }
    expect(Array.isArray(result)).toBe(true);
    // M3: cube.fbx has 1 mesh -> at least 3 sub-assets (mesh + material-default + scene)
    expect(result.length).toBeGreaterThanOrEqual(3);
  });
});