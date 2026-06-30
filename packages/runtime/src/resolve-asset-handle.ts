// M8 w59 (round 5 D-18 atomic): two-tier resolution + material-walk over
// world.sharedRefs.
//
// D-15 two-tier asset resolution: slots in [1, BUILTIN_BASE) are builtins
// (process-static, resolve through BuiltinAssetRegistry.resolve, never
// reference-counted); slots >= BUILTIN_BASE are user-tier (resolve through
// world.sharedRefs.resolve). Resolution is entirely ECS/render-side -- it
// never goes through AssetRegistry (human-inputs implement-architecture-
// correction 2026-06-16T12:35:07Z: AssetRegistry has NO handle concept).
//
// AI-user surface: `resolveAssetHandle(world, handle)` is the single entry
// point for handle-to-payload resolution; `walkMaterialPassesOverSharedRefs`
// is the material parent-chain walk used by the render extract stage. Charter
// F1 single-entry indexability -- one import, one call, no dual-path leak.

import type { World } from '@forgeax/engine-ecs';
import { SharedRefStaleError, UniqueRefStaleError } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import type {
  Asset,
  AssetError as AssetErrorType,
  Handle,
  MaterialAsset,
  MaterialPassDescriptor,
} from '@forgeax/engine-types';
import { ASSET_ERROR_HINTS, AssetError, BUILTIN_BASE, handleSlot } from '@forgeax/engine-types';
import { BuiltinAssetRegistry } from './builtin-asset-registry';
import { MaterialResolvedEmptyPassesError } from './errors';

/**
 * Resolve a handle to its asset payload with two-tier slot-range dispatch.
 *
 *   slot <  BUILTIN_BASE -> BuiltinAssetRegistry.resolve(handle) (process-static)
 *   slot >= BUILTIN_BASE -> world.sharedRefs.resolve(handle)     (user-tier RC)
 *
 * Callers must specify the expected asset type explicitly:
 * `resolveAssetHandle<MeshAsset>(world, handle)`. The type parameter is an
 * assertion -- the runtime dispatch returns the correct payload based on slot
 * range; the type parameter mirrors the caller's expectation.
 *
 * @param world - The World owning the per-World SharedRefStore (user-tier).
 * @param handle - The branded handle to resolve.
 * @returns `Result.ok(payload)` on hit, `Result.err(AssetError)` on miss.
 */
export function resolveAssetHandle<T extends Asset>(
  world: World,
  handle: Handle<string, 'shared'>,
): Result<T, AssetErrorType | SharedRefStaleError | UniqueRefStaleError> {
  const slot = handleSlot(handle);
  if (slot < BUILTIN_BASE) {
    const builtin = BuiltinAssetRegistry.resolve(handle);
    if (builtin !== null) return ok(builtin as unknown as T);
    return err(
      new AssetError({
        code: 'asset-not-found',
        expected: `builtin slot ${slot} present in BuiltinAssetRegistry`,
        hint: ASSET_ERROR_HINTS['asset-not-found'],
      }),
    );
  }
  const res = world.sharedRefs.resolve<string, T>(handle);
  if (res.ok) return ok(res.value);
  // Forward structured stale error codes transparently (D-3, AC-10).
  // instanceof guards on the concrete error classes so callers
  // (e.g. render-system-extract) can switch on err.code with
  // exhaustive-casing — stale vs released vs not-found distinguishable.
  if (res.error instanceof SharedRefStaleError) return err(res.error);
  if (res.error instanceof UniqueRefStaleError) return err(res.error);
  // Exhaustive switch over remaining error codes from SharedRefStore.resolve.
  // No default case; tsc validates completeness if new codes join the union.
  switch (res.error.code) {
    case 'shared-ref-released':
    case 'builtin-slot-not-owned':
      break;
  }
  return err(
    new AssetError({
      code: 'asset-not-found',
      expected: `user-tier slot ${slot} present in world.sharedRefs`,
      hint: ASSET_ERROR_HINTS['asset-not-found'],
    }),
  );
}

/**
 * Walk a MaterialAsset parent chain to produce the inherited passes +
 * shallow-merged paramValues (W-1..W-7 semantics). feat-20260614 M8 (D-19):
 * the starting material is resolved from a column `handle` via
 * {@link resolveAssetHandle} (builtin / user-tier world.sharedRefs); each
 * ancestor `material.parent` is an embedded GUID (AssetGuid) resolved through
 * the AssetRegistry catalogue ({@link AssetRegistry.lookup}). The registry
 * holds no handles -- it is the GUID->payload SSOT for parent resolution.
 *
 * Zero-cache (AC-04): every call full-walks. Cycle detection (W-1): returns
 * `AssetError` with code `'material-circular-inheritance'`. Empty passes
 * (AC-09, D-3): `MaterialResolvedEmptyPassesError` with `.detail.reason`
 * discriminating `'missing-parent'` vs `'no-pass-in-chain'`.
 */
export function walkMaterialPassesOverSharedRefs(
  world: World,
  handle: Handle<'MaterialAsset', 'shared'>,
  registry: { lookup(guid: AssetGuid | string): Asset | undefined },
): Result<
  { passes: MaterialPassDescriptor[]; paramValues: Record<string, unknown> },
  AssetErrorType | MaterialResolvedEmptyPassesError | SharedRefStaleError | UniqueRefStaleError
> {
  const visited = new Set<string>();
  const chainNames: string[] = [];
  let missingParent = false;

  // Resolve the root material payload from its column handle.
  const rootRes = resolveAssetHandle<MaterialAsset>(
    world,
    handle as unknown as Handle<string, 'shared'>,
  );

  function walkPayload(
    material: MaterialAsset | undefined,
    label: string,
  ): { passes: MaterialPassDescriptor[]; paramValues: Record<string, unknown> } | null {
    if (visited.has(label)) {
      chainNames.push(label);
      return null;
    }
    visited.add(label);
    chainNames.push(label);

    if (material === undefined) {
      missingParent = true;
      return { passes: [], paramValues: {} };
    }

    let parentPasses: MaterialPassDescriptor[] = [];
    let parentParamValues: Record<string, unknown> = {};
    if (material.parent !== undefined) {
      const parentGuid = material.parent as AssetGuid;
      const parentLabel = AssetGuid.format(parentGuid).toLowerCase();
      const parentMaterial = registry.lookup(parentGuid) as MaterialAsset | undefined;
      const parentResult = walkPayload(parentMaterial, parentLabel);
      if (parentResult === null) return null;
      parentPasses = parentResult.passes;
      parentParamValues = parentResult.paramValues;
    }

    // W-4: child paramValues shallow-merge over parent.
    const mergedParams: Record<string, unknown> = { ...parentParamValues };
    if (material.paramValues) {
      for (const [k, v] of Object.entries(material.paramValues)) {
        mergedParams[k] = v;
      }
    }

    // W-5: no passes -- full inheritance from parent.
    if (!material.passes || material.passes.length === 0) {
      return { passes: parentPasses, paramValues: mergedParams };
    }

    // W-6: child passes override parent by name, new names append.
    const mergedPasses: MaterialPassDescriptor[] = [];
    const seenNames = new Set<string>();
    for (const cp of material.passes) {
      seenNames.add(cp.name);
      mergedPasses.push(cp);
    }
    for (const pp of parentPasses) {
      if (!seenNames.has(pp.name)) {
        mergedPasses.push(pp);
      }
    }
    return { passes: mergedPasses, paramValues: mergedParams };
  }

  const rootLabel = `handle-${handleSlot(handle)}`;
  const result = walkPayload(rootRes.ok ? rootRes.value : undefined, rootLabel);
  if (result === null) {
    // W-7: cycle.
    return err(
      new AssetError({
        code: 'material-circular-inheritance',
        expected: 'material parent chain forms no cycle',
        hint: ASSET_ERROR_HINTS['material-circular-inheritance'],
        detail: { cycle: chainNames.join(' -> ') },
      }),
    );
  }
  if (result.passes.length === 0) {
    const reason = missingParent ? 'missing-parent' : 'no-pass-in-chain';
    return err(new MaterialResolvedEmptyPassesError(rootLabel, reason, undefined));
  }
  return ok(result);
}
