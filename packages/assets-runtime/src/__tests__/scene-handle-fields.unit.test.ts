// @forgeax/engine-assets-runtime -- scene-handle-fields coverage (fix issue #709).
// extractSceneEntityHandleGuids + extractMountOverrideHandleGuids identify
// shared<T> / array<shared<T>> schema fields via resolveComponent and read the
// raw GUID string(s). Uses test-unique component names to avoid colliding with
// the engine's real component registry in the shared coverage run.

import { defineComponent } from '@forgeax/engine-ecs';
import type { MountOverride } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  extractMountOverrideHandleGuids,
  extractSceneEntityHandleGuids,
} from '../scene-handle-fields';

// Register once at module load (nameToToken is last-write-wins, no throw).
defineComponent('T709MeshFilter', { assetHandle: 'shared<MeshAsset>' });
defineComponent('T709MeshRenderer', { materials: 'array<shared<MaterialAsset>>' });
defineComponent('T709Transform', { x: 'f32' });

describe('extractSceneEntityHandleGuids', () => {
  it('extracts scalar shared<T> GUID strings', () => {
    const entries = extractSceneEntityHandleGuids([
      { localId: 5, components: { T709MeshFilter: { assetHandle: 'mesh-guid' } } },
    ]);
    expect(entries).toEqual([
      {
        entityLocalId: 5,
        componentName: 'T709MeshFilter',
        fieldName: 'assetHandle',
        guidString: 'mesh-guid',
      },
    ]);
  });

  it('extracts array<shared<T>> element GUIDs with their arrayIndex', () => {
    const entries = extractSceneEntityHandleGuids([
      { localId: 1, components: { T709MeshRenderer: { materials: ['m0', 'm1'] } } },
    ]);
    expect(entries).toEqual([
      {
        entityLocalId: 1,
        componentName: 'T709MeshRenderer',
        fieldName: 'materials',
        guidString: 'm0',
        arrayIndex: 0,
      },
      {
        entityLocalId: 1,
        componentName: 'T709MeshRenderer',
        fieldName: 'materials',
        guidString: 'm1',
        arrayIndex: 1,
      },
    ]);
  });

  it('skips unknown components, non-shared fields, and already-resolved numbers', () => {
    const entries = extractSceneEntityHandleGuids([
      { localId: 0, components: { NotRegistered709: { assetHandle: 'x' } } },
      { localId: 1, components: { T709Transform: { x: 3 } } },
      { localId: 2, components: { T709MeshFilter: { assetHandle: 42 } } },
      { localId: 3, components: { T709MeshRenderer: { materials: [7, 'm-str'] } } },
    ]);
    // Only the string array element survives.
    expect(entries).toEqual([
      {
        entityLocalId: 3,
        componentName: 'T709MeshRenderer',
        fieldName: 'materials',
        guidString: 'm-str',
        arrayIndex: 1,
      },
    ]);
  });
});

describe('extractMountOverrideHandleGuids', () => {
  it('patch form (field present) extracts one GUID from a shared field', () => {
    const overrides: MountOverride[] = [
      { localId: 1 as never, comp: 'T709MeshFilter', field: 'assetHandle', value: 'mesh-guid' },
    ];
    const entries = extractMountOverrideHandleGuids(overrides);
    expect(entries).toEqual([
      {
        overrideIndex: 0,
        componentName: 'T709MeshFilter',
        fieldName: 'assetHandle',
        guidString: 'mesh-guid',
      },
    ]);
  });

  it('add form (field absent, value is a per-field map) extracts array GUIDs', () => {
    const overrides: MountOverride[] = [
      { localId: 1 as never, comp: 'T709MeshRenderer', value: { materials: ['a', 'b'] } },
    ];
    const entries = extractMountOverrideHandleGuids(overrides);
    expect(entries).toEqual([
      {
        overrideIndex: 0,
        componentName: 'T709MeshRenderer',
        fieldName: 'materials',
        guidString: 'a',
        arrayIndex: 0,
      },
      {
        overrideIndex: 0,
        componentName: 'T709MeshRenderer',
        fieldName: 'materials',
        guidString: 'b',
        arrayIndex: 1,
      },
    ]);
  });

  it('skips unknown components and non-object add values', () => {
    const overrides: MountOverride[] = [
      { localId: 1 as never, comp: 'NotRegistered709', value: { assetHandle: 'x' } },
      { localId: 2 as never, comp: 'T709MeshFilter', value: 5 },
    ];
    expect(extractMountOverrideHandleGuids(overrides)).toEqual([]);
  });
});
