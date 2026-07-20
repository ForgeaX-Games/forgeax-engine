// M6 w46 (AC-30): BuiltinAssetRegistry process-static resolution TDD.
//
// D-15 two-tier asset resolution: builtin payloads live in a process-static
// const keyed by fixed slot u32 (1..5), resolved without any World. Slots
// >= BUILTIN_BASE belong to the user tier (World.sharedRefs) and resolve to
// null here. R-13: module init order — importing BuiltinAssetRegistry then
// immediately resolving all 5 handles must not throw / return undefined.
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
  HANDLE_CYLINDER,
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

// bug-20260709-builtin-quad-withoutaabb-disables-sprite-frustum-cu M2 / AC-02.
//
// Lock the Stage 1 invariant that HANDLE_QUAD funnels through the frustum-cull
// three-gate branch the same way a user-imported MeshAsset does — its payload
// must carry a non-empty local-space aabb. The 5 non-QUAD builtins keep the
// pre-fix baseline: their payload still short-circuits through the aabb ===
// undefined gate (always visible), pending an explicit opt-out migration in
// Stage 2 (plan-decisions §D-4).
//
// Flat aabb layout is `Float32Array` of length 6 [minX, minY, minZ,
// maxX, maxY, maxZ] per `packages/types/src/index.ts:308` — the requirements
// wording "min/max both length-3 arrays with min[i] <= max[i]" reads as
// index [0..2] vs [3..5] within that flat array (no {min,max} object wrap).
describe('HANDLE_QUAD payload carries a non-empty local-space aabb (AC-02 Stage 1 lock)', () => {
  it('payload.aabb is a Float32Array of length 6 (flat [minX, minY, minZ, maxX, maxY, maxZ])', () => {
    const payload = BuiltinAssetRegistry.resolve(HANDLE_QUAD);
    expect(payload).not.toBeNull();
    expect(payload?.aabb).toBeDefined();
    expect(payload?.aabb).toBeInstanceOf(Float32Array);
    expect(payload?.aabb).toHaveLength(6);
  });

  it('payload.aabb per-axis min <= max (no inverted-infinity empty box)', () => {
    const payload = BuiltinAssetRegistry.resolve(HANDLE_QUAD);
    const aabb = payload?.aabb;
    expect(aabb).toBeDefined();
    if (aabb === undefined) return;
    for (let axis = 0; axis < 3; axis++) {
      const minV = aabb[axis];
      const maxV = aabb[axis + 3];
      expect(minV).toBeDefined();
      expect(maxV).toBeDefined();
      expect(minV as number).toBeLessThanOrEqual(maxV as number);
    }
  });

  it('BUILTIN_QUAD export mirrors the resolved payload (same reference / same aabb)', () => {
    // The frozen module-level const and the resolve() lookup are the same
    // process-static payload (D-15 two-tier); aabb identity should hold.
    expect(BUILTIN_QUAD.aabb).toBeDefined();
    expect(BuiltinAssetRegistry.resolve(HANDLE_QUAD)?.aabb).toBe(BUILTIN_QUAD.aabb);
  });
});

// AC-02 regression lock (Stage 2 deferred, plan-decisions §D-4): the 5
// non-QUAD builtins keep `withoutAabb()` short-circuit — payload.aabb ===
// undefined so `render-system-extract.ts` skips them at the aabb-undefined
// gate. If a follow-up loop restores their aabb without the opt-out
// migration, this table trips and the shadow-opt-out / picking / UI-hidden
// couplings surface here first.
describe('non-QUAD builtin payloads keep aabb === undefined (AC-02 regression lock)', () => {
  it.each([
    ['HANDLE_CUBE', HANDLE_CUBE, BUILTIN_CUBE],
    ['HANDLE_TRIANGLE', HANDLE_TRIANGLE, BUILTIN_TRIANGLE],
    ['HANDLE_SPHERE', HANDLE_SPHERE, BUILTIN_SPHERE],
    ['HANDLE_NINESLICE_QUAD', HANDLE_NINESLICE_QUAD, BUILTIN_NINESLICE_QUAD],
    ['HANDLE_CYLINDER', HANDLE_CYLINDER, undefined],
  ])('%s payload.aabb is undefined (withoutAabb short-circuit still applied)', (_name, handle, exportedConst) => {
    const payload = BuiltinAssetRegistry.resolve(handle);
    expect(payload).not.toBeNull();
    expect(payload?.aabb).toBeUndefined();
    if (exportedConst !== undefined) {
      // The module-level frozen export must match the registry lookup for
      // the aabb-undefined invariant (no divergence between the two access
      // paths AI users could reach for).
      expect(exportedConst.aabb).toBeUndefined();
    }
  });
});
