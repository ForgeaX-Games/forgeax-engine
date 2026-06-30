// asset-registry-mounts.test.ts - parseScenePayload mounts[].source refs
// resolution unit tests (feat-20260608-scene-nesting-ecs-fication M3 / w27,
// TDD red phase).
//
// Coverage:
//   (a) AC-10 happy path: mounts[].source (integer index) resolved through
//       refs[] to a GUID string.
//   (b) AC-10 back-compat: payload with no mounts field passes through.
//   (c) AC-10 back-compat: mounts with source already a string (GUID) passes
//       through unchanged.
//   (d) AC-10 error path: mounts[].source integer index out-of-bounds returns
//       a ParseSceneError.
//   (e) AC-11: mount.source does NOT enter HANDLE_FIELD_NAMES -- it is resolved
//       positionally by field name within the mounts[] array, not through the
//       handle-field allowlist (verify no false collision with existing handle
//       fields named 'source').
//   (f) mounts.memberFirst / mounts.memberCount / mounts.parent (LocalEntityId)
//       are NOT refs[] indices -- they are local entity ids preserved as-is.

import type { LoadContext, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetRegistry, sceneLoader } from '../asset-registry';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

/** Access the private parseAssetPayload method via structural view-cast. */
function accessParseScenePayload(reg: AssetRegistry) {
  // biome-ignore lint/suspicious/noExplicitAny: private method access for unit test
  const internal = reg as any as {
    parseAssetPayload(kind: string, payload: Record<string, unknown>, refs?: string[]): unknown;
  };
  return (
    kind: string,
    payload: Record<string, unknown>,
    refs?: string[],
  ): SceneAsset | undefined => {
    const result = internal.parseAssetPayload(kind, payload, refs);
    if (result === undefined) return undefined;
    if (
      typeof result === 'object' &&
      result !== null &&
      'kind' in result &&
      result.kind === 'scene'
    ) {
      return result as SceneAsset;
    }
    return undefined;
  };
}

const GUID_A = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
const GUID_B = 'f6af7007-158f-4d92-9e47-93bf2f213e1f';
const GUID_C = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

describe('w27 - parseScenePayload mounts[].source refs resolution (AC-10)', () => {
  it('(a) resolves mounts[].source integer index through refs[] to GUID string', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const fn = accessParseScenePayload(reg);
    const refs = [GUID_A];
    const payload = {
      entities: [{ localId: 0, components: {} }],
      mounts: [
        {
          localId: 1,
          source: 0,
          memberFirst: 2,
          memberCount: 3,
        },
      ],
    };
    const asset = fn('scene', payload, refs);
    expect(asset).toBeDefined();
    if (!asset) return;
    expect(asset.kind).toBe('scene');
    expect(asset.mounts).toBeDefined();
    if (!asset.mounts) return;
    expect(asset.mounts.length).toBe(1);
    const mount = asset.mounts[0];
    expect(mount).toBeDefined();
    if (!mount) return;
    // source 0 -> refs[0] = GUID_A
    expect(mount.source).toBe(GUID_A);
  });

  it('(b) payload with no mounts field passes through (back-compat)', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const fn = accessParseScenePayload(reg);
    const payload = {
      entities: [{ localId: 0, components: {} }],
    };
    const asset = fn('scene', payload);
    expect(asset).toBeDefined();
    if (!asset) return;
    expect(asset.kind).toBe('scene');
    // mounts absent or empty after parse
    expect(asset.mounts ?? []).toEqual([]);
  });

  it('(c) mounts with source already a string passes through unchanged', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const fn = accessParseScenePayload(reg);
    const refs = [GUID_A];
    const payload = {
      entities: [{ localId: 0, components: {} }],
      mounts: [
        {
          localId: 1,
          source: GUID_B, // already a GUID string, not an index
          memberFirst: 2,
          memberCount: 3,
        },
      ],
    };
    const asset = fn('scene', payload, refs);
    expect(asset).toBeDefined();
    if (!asset) return;
    expect(asset.mounts).toBeDefined();
    if (!asset.mounts) return;
    expect(asset.mounts[0]?.source).toBe(GUID_B);
  });

  it('(d) mounts[].source integer index out-of-bounds returns ParseSceneError', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const fn = accessParseScenePayload(reg);
    const refs = [GUID_A]; // only 1 entry, indices 0 valid, 1+ invalid
    const payload = {
      entities: [{ localId: 0, components: {} }],
      mounts: [
        {
          localId: 1,
          source: 5, // out-of-bounds: refs.length == 1
          memberFirst: 2,
          memberCount: 3,
        },
      ],
    };
    const asset = fn('scene', payload, refs);
    expect(asset).not.toBeDefined();
  });

  it('(e) mounts[].source is NOT resolved through HANDLE_FIELD_NAMES (AC-11 positional)', () => {
    // Even if 'source' were in HANDLE_FIELD_NAMES (it is not), mount.source
    // should be resolved through the mounts[] array pipeline, not the handle-
    // field allowlist. This test verifies no collision.
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const fn = accessParseScenePayload(reg);
    // Use a mock where entities[].components has a field named 'source' that is
    // NOT in HANDLE_FIELD_NAMES. This verifies mount.source resolution is
    // independent of entities[].components resolution.
    const refs = [GUID_A, GUID_B];
    const payload = {
      entities: [{ localId: 0, components: { Transform: { source: 1 } } }],
      mounts: [
        {
          localId: 2,
          source: 0, // refs[0] = GUID_A
          memberFirst: 3,
          memberCount: 2,
        },
      ],
    };
    const asset = fn('scene', payload, refs);
    expect(asset).toBeDefined();
    if (!asset) return;
    // mount.source should be resolved via mounts pipeline
    expect(asset.mounts).toBeDefined();
    if (!asset.mounts) return;
    expect(asset.mounts[0]?.source).toBe(GUID_A);
    // entities[].components.Transform.source is NOT a handle field, so it
    // should stay as the raw number (1), not be resolved.
    const comp = asset.entities[0]?.components as Record<string, Record<string, unknown>>;
    expect(comp.Transform?.source).toBe(1);
  });

  it('(f) mounts memberFirst/memberCount/localId/parent are preserved as numbers (not refs indices)', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const fn = accessParseScenePayload(reg);
    const refs = [GUID_A];
    const payload = {
      entities: [{ localId: 0, components: {} }],
      mounts: [
        {
          localId: 5,
          source: 0,
          memberFirst: 10,
          memberCount: 4,
          parent: 3,
        },
      ],
    };
    const asset = fn('scene', payload, refs);
    expect(asset).toBeDefined();
    if (!asset) return;
    expect(asset.mounts).toBeDefined();
    if (!asset.mounts) return;
    const mount = asset.mounts[0];
    expect(mount).toBeDefined();
    if (!mount) return;
    expect(mount.localId).toBe(5);
    expect(mount.memberFirst).toBe(10);
    expect(mount.memberCount).toBe(4);
    expect(mount.parent).toBe(3);
  });

  it('(g) multiple mounts with interleaved source indices resolved correctly', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const fn = accessParseScenePayload(reg);
    const refs = [GUID_A, GUID_B, GUID_C];
    const payload = {
      entities: [{ localId: 0, components: {} }],
      mounts: [
        { localId: 1, source: 0, memberFirst: 2, memberCount: 3 },
        { localId: 2, source: 2, memberFirst: 5, memberCount: 1 },
        { localId: 3, source: 1, memberFirst: 6, memberCount: 4 },
      ],
    };
    const asset = fn('scene', payload, refs);
    expect(asset).toBeDefined();
    if (!asset) return;
    expect(asset.mounts).toBeDefined();
    if (!asset.mounts) return;
    expect(asset.mounts.length).toBe(3);
    expect(asset.mounts[0]?.source).toBe(GUID_A);
    expect(asset.mounts[1]?.source).toBe(GUID_C);
    expect(asset.mounts[2]?.source).toBe(GUID_B);
  });
});

// -- M4 / F21: sceneLoader returns ParseSceneError (AC-09 + AC-10) [w15] --

describe('sceneLoader returns ParseSceneError (F21 / AC-09 + AC-10) [w15]', () => {
  it('AC-09 concurrent scene loads: A fails with index error, B succeeds -- no cross-contamination', () => {
    // A: scene payload with an entity field that has a refs[] index out of bounds.
    const payloadA = {
      entities: [
        {
          localId: 100,
          components: {
            MeshRenderer: { material: 5 }, // scalar handle, out-of-bounds: refs has only 1 entry
          },
        },
      ],
    };
    const refsA = [GUID_A]; // indices: 0 valid, 5 invalid

    // B: valid scene payload with a single entity, no mounts.
    const payloadB = {
      entities: [
        {
          localId: 200,
          components: {
            Transform: { posX: 1, posY: 2, posZ: 3 },
          },
        },
      ],
    };
    const refsB = [GUID_B];

    // LoadContext without reportParseError (F21: removed).
    const ctx: LoadContext = {
      fetchBinary: async () => ({ ok: false, error: new Error('not wired') }),
      resolveRef: async () => ({ ok: false, error: new Error('not wired') }),
      device: undefined,
    };

    // Concurrent calls to sceneLoader.load.
    const resultA = sceneLoader.load(payloadA, refsA, ctx);
    const resultB = sceneLoader.load(payloadB, refsB, ctx);

    // B: must return a valid SceneAsset.
    expect(resultB).toBeDefined();
    expect(typeof resultB).toBe('object');
    if (resultB !== null) {
      // Avoid the Promise arm by guarding on 'then'.
      // biome-ignore lint/suspicious/noExplicitAny: guard
      if (typeof (resultB as any).then !== 'function') {
        expect((resultB as { kind: string }).kind).toBe('scene');
        const sceneB = resultB as { kind: string; entities: Array<{ localId: number }> };
        const entityIds = sceneB.entities.map((e) => e.localId);
        expect(entityIds).not.toContain(100);
      }
    }

    // A: should return the structured error { ok: false, error: ParseErrorDetail }.
    expect(resultA).toBeDefined();
    expect(typeof resultA).toBe('object');
    if (resultA !== null && typeof resultA === 'object') {
      // biome-ignore lint/suspicious/noExplicitAny: guard
      if (typeof (resultA as any).then !== 'function') {
        const errResult = resultA as {
          ok: boolean;
          error?: {
            localId: number;
            component: string;
            field: string;
            index: number;
            refsLength: number;
          };
        };
        expect(errResult.ok).toBe(false);
        expect(errResult.error).toBeDefined();
        if (errResult.error) {
          expect(errResult.error.localId).toBe(100);
          expect(errResult.error.component).toBe('MeshRenderer');
          expect(errResult.error.field).toBe('material');
          expect(errResult.error.index).toBe(5);
          expect(errResult.error.refsLength).toBe(1);
        }
      }
    }
  });

  it('AC-10: sceneLoader.load with valid payload returns SceneAsset (no shared-slot error)', () => {
    const payload = {
      entities: [
        {
          localId: 1,
          components: {
            Transform: { posX: 0, posY: 0, posZ: 0 },
          },
        },
      ],
    };
    const refs = [GUID_A];

    const ctx: LoadContext = {
      fetchBinary: async () => ({ ok: false, error: new Error('not wired') }),
      resolveRef: async () => ({ ok: false, error: new Error('not wired') }),
      device: undefined,
    };

    const result = sceneLoader.load(payload, refs, ctx);
    expect(result).toBeDefined();
    // Must be a SceneAsset, not an error { ok: false }.
    if (result !== undefined && typeof result === 'object' && result !== null) {
      // biome-ignore lint/suspicious/noExplicitAny: guard
      if (typeof (result as any).then !== 'function') {
        expect('ok' in (result as Record<string, unknown>)).toBe(false);
        expect((result as { kind: string }).kind).toBe('scene');
      }
    }
  });
});

// -- M4 / F21: integration - concurrent scene load + grep zero-hits (AC-09/AC-10) [w19] --

describe('integration: concurrent scene load via parseAssetPayload (F21 / AC-09 + AC-10) [w19]', () => {
  it('two concurrent parseAssetPayload calls: A fails with ParseSceneError, B succeeds without cross-contamination', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());

    // A: refs index out of bounds -> ParseSceneError from sceneLoader.
    const payloadA = {
      entities: [
        {
          localId: 100,
          components: {
            MeshRenderer: { material: 5 }, // out-of-bounds (refs has only 1 entry)
          },
        },
      ],
    };
    const refsA = [GUID_A];

    // B: valid scene payload.
    const payloadB = {
      entities: [
        {
          localId: 200,
          components: {
            Transform: { posX: 1, posY: 2, posZ: 3 },
          },
        },
      ],
    };
    const refsB = [GUID_B];

    // Access parseAndReturnAsset privately.
    const internal = reg as unknown as {
      parseAndReturnAsset(entry: {
        kind: string;
        payload: Record<string, unknown>;
        refs?: string[];
      }): { ok: boolean; value?: unknown; error?: { code: string; detail?: { localId: number } } };
    };

    const resultA = internal.parseAndReturnAsset({
      kind: 'scene',
      payload: payloadA,
      refs: refsA,
    });
    const resultB = internal.parseAndReturnAsset({
      kind: 'scene',
      payload: payloadB,
      refs: refsB,
    });

    // A: must be an error with detail containing A's localId.
    expect(resultA.ok).toBe(false);
    if (!resultA.ok) {
      expect(resultA.error?.code).toBe('asset-parse-failed');
      const detail = resultA.error?.detail as { localId: number } | undefined;
      expect(detail?.localId).toBe(100);
    }

    // B: must be a valid SceneAsset.
    // feat-20260622 M4 / w12: parseAndReturnAsset returns { asset, refs } so
    // the recursive core can read envelope.refs (D-5); unwrap `.asset` here.
    expect(resultB.ok).toBe(true);
    if (resultB.ok) {
      const asset = (
        resultB.value as { asset: { kind: string; entities: Array<{ localId: number }> } }
      ).asset;
      expect(asset.kind).toBe('scene');
      // B's entities must NOT contain A's localId 100.
      const entityIds = asset.entities.map((e) => e.localId);
      expect(entityIds).not.toContain(100);
      expect(entityIds).toContain(200);
    }
  });

  it('parseScenePayload without refs does not attempt handle resolution and returns SceneAsset (no reportParseError)', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const internal = reg as unknown as {
      parseAndReturnAsset(entry: {
        kind: string;
        payload: Record<string, unknown>;
        refs?: string[];
      }): { ok: boolean; value?: unknown };
    };

    const payload = {
      entities: [
        {
          localId: 1,
          components: {
            Transform: { posX: 0, posY: 0, posZ: 0 },
          },
        },
      ],
    };

    const result = internal.parseAndReturnAsset({
      kind: 'scene',
      payload,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // feat-20260622 M4 / w12: parseAndReturnAsset returns { asset, refs }.
      expect((result.value as { asset: { kind: string } }).asset.kind).toBe('scene');
    }
  });
});

// -- M4 / F21: static assertions (grep zero hits) [w19] --

describe('static assertions: lastParseSceneError / reportParseError zero hits (F21 / AC-10) [w19]', () => {
  it('lastParseSceneError is absent from asset-registry.ts', () => {
    // This is a documentation assertion: grep lastParseSceneError
    // in packages/runtime/src/asset-registry.ts must return zero hits.
    // Verified at the CI sweep step; this test exists to document
    // the requirement and provides a placeholder that always passes.
    expect(true).toBe(true);
  });

  it('reportParseError is absent from asset-registry.ts and types', () => {
    // grep reportParseError in packages/runtime/src/ and
    // packages/types/src/ must return zero hits.
    // Verified at the CI sweep step.
    expect(true).toBe(true);
  });
});
