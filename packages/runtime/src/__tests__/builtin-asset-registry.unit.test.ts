// M6 w46 (AC-30): BuiltinAssetRegistry process-static resolution TDD.
//
// D-15 two-tier asset resolution: builtin payloads live in a process-static
// const keyed by fixed slot u32 (1..5), resolved without any World. Slots
// >= BUILTIN_BASE belong to the user tier (World.sharedRefs) and resolve to
// null here. R-13: module init order — importing BuiltinAssetRegistry then
// immediately resolving all 5 handles must not throw / return undefined.

import {
  BUILTIN_BASE,
  BUILTIN_CUBE,
  BUILTIN_NINESLICE_QUAD,
  BUILTIN_QUAD,
  BUILTIN_SPHERE,
  BUILTIN_TRIANGLE,
  BuiltinAssetRegistry,
  HANDLE_CUBE,
  HANDLE_NINESLICE_QUAD,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
} from '@forgeax/engine-assets-runtime';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

describe('BuiltinAssetRegistry.resolve (AC-30)', () => {
  it('resolves each builtin slot 1..5 to its frozen payload', () => {
    expect(BuiltinAssetRegistry.resolve(HANDLE_CUBE)).toBe(BUILTIN_CUBE);
    expect(BuiltinAssetRegistry.resolve(HANDLE_TRIANGLE)).toBe(BUILTIN_TRIANGLE);
    expect(BuiltinAssetRegistry.resolve(HANDLE_QUAD)).toBe(BUILTIN_QUAD);
    expect(BuiltinAssetRegistry.resolve(HANDLE_SPHERE)).toBe(BUILTIN_SPHERE);
    expect(BuiltinAssetRegistry.resolve(HANDLE_NINESLICE_QUAD)).toBe(BUILTIN_NINESLICE_QUAD);
  });

  it('returns frozen payloads (Object.isFrozen)', () => {
    expect(Object.isFrozen(BUILTIN_CUBE)).toBe(true);
    expect(Object.isFrozen(BUILTIN_TRIANGLE)).toBe(true);
    expect(Object.isFrozen(BUILTIN_QUAD)).toBe(true);
    expect(Object.isFrozen(BUILTIN_SPHERE)).toBe(true);
    expect(Object.isFrozen(BUILTIN_NINESLICE_QUAD)).toBe(true);
  });

  it('returns null for user-tier slots (slot >= BUILTIN_BASE)', () => {
    expect(BuiltinAssetRegistry.resolve(toShared<'MeshAsset'>(BUILTIN_BASE))).toBeNull();
    expect(BuiltinAssetRegistry.resolve(toShared<'MeshAsset'>(BUILTIN_BASE + 1))).toBeNull();
    expect(BuiltinAssetRegistry.resolve(toShared<'MeshAsset'>(99999))).toBeNull();
  });

  it('returns null for slot 0 (no builtin reserves slot 0)', () => {
    expect(BuiltinAssetRegistry.resolve(toShared<'MeshAsset'>(0))).toBeNull();
  });

  it('R-13: module-first-import probe resolves all 5 handles without throwing or undefined', () => {
    // Importing BuiltinAssetRegistry then resolving must observe fully
    // constructed frozen payloads — no init-order hazard (synchronous,
    // module-level, no side effect).
    for (const handle of [
      HANDLE_CUBE,
      HANDLE_TRIANGLE,
      HANDLE_QUAD,
      HANDLE_SPHERE,
      HANDLE_NINESLICE_QUAD,
    ]) {
      const payload = BuiltinAssetRegistry.resolve(handle);
      expect(payload).not.toBeUndefined();
      expect(payload).not.toBeNull();
    }
  });
});
