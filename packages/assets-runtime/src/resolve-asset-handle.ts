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
import type { AssetGuid } from '@forgeax/engine-pack/guid';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import type {
  Asset,
  AssetError as AssetErrorType,
  Handle,
  MaterialAsset,
  MaterialError,
  MaterialPass,
} from '@forgeax/engine-types';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  BUILTIN_BASE,
  handleSlot,
  materialGuidText,
  resolveMaterialAsset,
} from '@forgeax/engine-types';
import { BuiltinAssetRegistry } from './builtin-asset-registry';

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
 * shallow-merged values (W-1..W-7 semantics). feat-20260614 M8 (D-19):
 * the starting material is resolved from a column `handle` via
 * {@link resolveAssetHandle} (builtin / user-tier world.sharedRefs); each
 * ancestor `material.parent` is an embedded GUID (AssetGuid) resolved through
 * the AssetRegistry catalogue ({@link AssetRegistry.lookup}). The registry
 * holds no handles -- it is the GUID->payload SSOT for parent resolution.
 *
 * Zero-cache (AC-04): every call builds the same table-shaped input and delegates
 * inheritance semantics to the MaterialAsset resolver in `@forgeax/engine-types`.
 * Compiler and runtime therefore share root-contract ownership and child-value
 * override semantics instead of maintaining two subtly different walks.
 */
export function walkMaterialPassesOverSharedRefs(
  world: World,
  handle: Handle<'MaterialAsset', 'shared'>,
  registry: { lookup(guid: AssetGuid | string): Asset | undefined },
): Result<
  {
    passes: MaterialPass[];
    parameters: MaterialAsset['parameters'];
    values: Record<string, unknown>;
  },
  AssetErrorType | MaterialError | SharedRefStaleError | UniqueRefStaleError
> {
  // Resolve the root material payload from its column handle.
  const rootRes = resolveAssetHandle<MaterialAsset>(
    world,
    handle as unknown as Handle<string, 'shared'>,
  );

  const rootLabel = `handle-${handleSlot(handle)}`;
  if (!rootRes.ok) return err(rootRes.error);

  const table: Record<string, MaterialAsset> = {};
  const visited = new Set<string>();
  const collect = (label: string, material: MaterialAsset): void => {
    if (visited.has(label)) return;
    visited.add(label);
    table[label] = material;
    if (material.parent === undefined) return;
    const parentId = materialGuidText(material.parent);
    const parent = registry.lookup(material.parent);
    if (parent?.kind === 'material') collect(parentId, parent);
  };
  collect(rootLabel, rootRes.value);

  const resolved = resolveMaterialAsset(rootLabel, table);
  if (!resolved.ok) return err(resolved.error);
  return ok({
    passes: [...(resolved.value.asset.passes ?? [])],
    parameters: resolved.value.asset.parameters ?? [],
    values: { ...(resolved.value.asset.values ?? {}) },
  });
}
