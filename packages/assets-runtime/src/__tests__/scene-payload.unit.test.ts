// @forgeax/engine-assets-runtime -- parseScenePayload coverage (fix issue #709).
// Exercises the entities/mounts/skinGuids refs-resolution branches + fail-fast
// return shapes. parseScenePayload keys handle fields off the HANDLE_FIELD_NAMES
// / HANDLE_ARRAY_FIELD_NAMES name allowlists, so no component registration needed.

import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { parseScenePayload } from '../scene-payload';

function isScene(v: unknown): v is SceneAsset {
  return typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'scene';
}

describe('parseScenePayload without refs', () => {
  it('returns undefined when entities is not an array', () => {
    expect(parseScenePayload({})).toBeUndefined();
    expect(parseScenePayload({ entities: 'nope' })).toBeUndefined();
  });

  it('returns undefined when an entity localId is not a number', () => {
    expect(parseScenePayload({ entities: [{ localId: 'x', components: {} }] })).toBeUndefined();
  });

  it('passes component fields through verbatim (no refs table)', () => {
    const out = parseScenePayload({
      entities: [{ localId: 0, components: { MeshFilter: { assetHandle: 3 } } }],
    });
    expect(isScene(out)).toBe(true);
    if (!isScene(out)) return;
    expect(out.entities[0]?.components.MeshFilter?.assetHandle).toBe(3);
  });
});

describe('parseScenePayload with refs', () => {
  const refs = ['guid-a', 'guid-b', 'guid-c'];

  it('resolves a scalar handle field index to its GUID string', () => {
    const out = parseScenePayload(
      { entities: [{ localId: 0, components: { MeshFilter: { assetHandle: 1 } } }] },
      refs,
    );
    expect(isScene(out)).toBe(true);
    if (!isScene(out)) return;
    expect(out.entities[0]?.components.MeshFilter?.assetHandle).toBe('guid-b');
  });

  it('keeps non-handle integer fields as-is (e.g. ChildOf.parent)', () => {
    const out = parseScenePayload(
      { entities: [{ localId: 0, components: { ChildOf: { parent: 2 } } }] },
      refs,
    );
    if (!isScene(out)) throw new Error('expected scene');
    expect(out.entities[0]?.components.ChildOf?.parent).toBe(2);
  });

  it('resolves array<handle> fields (materials) element-wise', () => {
    const out = parseScenePayload(
      { entities: [{ localId: 0, components: { MeshRenderer: { materials: [0, 2] } } }] },
      refs,
    );
    if (!isScene(out)) throw new Error('expected scene');
    expect(out.entities[0]?.components.MeshRenderer?.materials).toEqual(['guid-a', 'guid-c']);
  });

  it('returns a ParseSceneError for an out-of-bounds scalar handle index', () => {
    const out = parseScenePayload(
      { entities: [{ localId: 7, components: { MeshFilter: { assetHandle: 9 } } }] },
      refs,
    );
    expect(isScene(out)).toBe(false);
    expect(out).toMatchObject({
      localId: 7,
      component: 'MeshFilter',
      field: 'assetHandle',
      index: 9,
      refsLength: 3,
    });
  });

  it('returns a ParseSceneError for an out-of-bounds array handle element', () => {
    const out = parseScenePayload(
      { entities: [{ localId: 1, components: { MeshRenderer: { materials: [0, 99] } } }] },
      refs,
    );
    expect(isScene(out)).toBe(false);
    expect(out).toMatchObject({ localId: 1, field: 'materials[1]', index: 99 });
  });

  it('resolves mounts[].source through refs', () => {
    const out = parseScenePayload(
      {
        entities: [{ localId: 0, components: {} }],
        mounts: [{ localId: 1, source: 2, memberFirst: 2, memberCount: 0 }],
      },
      refs,
    );
    if (!isScene(out)) throw new Error('expected scene');
    expect(out.mounts?.[0]?.source).toBe('guid-c');
  });

  it('returns undefined when a mount source index is out of bounds', () => {
    const out = parseScenePayload(
      {
        entities: [{ localId: 0, components: {} }],
        mounts: [{ localId: 1, source: 42, memberFirst: 2, memberCount: 0 }],
      },
      refs,
    );
    expect(out).toBeUndefined();
  });

  it('resolves skinGuids from refs indices and passes pre-resolved strings through', () => {
    const idx = parseScenePayload(
      { entities: [{ localId: 0, components: {} }], skinGuids: [0, 2] },
      refs,
    );
    if (!isScene(idx)) throw new Error('expected scene');
    expect(idx.skinGuids).toEqual(['guid-a', 'guid-c']);

    const strs = parseScenePayload({
      entities: [{ localId: 0, components: {} }],
      skinGuids: ['g1'],
    });
    if (!isScene(strs)) throw new Error('expected scene');
    expect(strs.skinGuids).toEqual(['g1']);
  });

  it('returns undefined when a skinGuids index is out of bounds', () => {
    const out = parseScenePayload(
      { entities: [{ localId: 0, components: {} }], skinGuids: [99] },
      refs,
    );
    expect(out).toBeUndefined();
  });
});
