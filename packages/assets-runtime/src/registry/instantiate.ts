// @forgeax/engine-assets-runtime -- scene instantiate collaboration module
// (feat-20260705-runtime-tier2-decomposition M1 / w6, D-4 + D-1). Free functions
// taking the AssetRegistry instance as first param; logic byte-preserved from the
// class body (this. -> registry.). Hosts the SkinJointResolver + PostSpawnHook
// hook-contract types relocated from scene-instances/post-spawn-resolve-joints.ts
// (D-1); w9 wires PostSpawnHook into the AssetRegistry constructor.

import type { EcsError, EntityHandle, World } from '@forgeax/engine-ecs';
import type { PackError } from '@forgeax/engine-pack/errors';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  worldDespawnScene,
  worldInstantiateScene,
  worldInstantiateSceneFlat,
  worldSetSceneAssetResolver,
} from '@forgeax/engine-scene';
import {
  type Asset,
  type AssetEnvelope,
  AssetError,
  type CatalogEntry,
  type Handle,
  type MountOverride,
  PACK_ERROR_HINTS,
  type SceneAsset,
  type SceneInstanceMount,
  type SkeletonAsset,
  type SkinAsset,
  type TagOf,
  unwrapHandle,
} from '@forgeax/engine-types';
import type { AssetRegistry } from '../asset-registry';
import { resolveAssetHandle } from '../resolve-asset-handle';
import {
  extractMountOverrideHandleGuids,
  extractSceneEntityHandleGuids,
} from '../scene-handle-fields';
import {
  compareScenePublicationFences,
  parseScenePublicationFence,
  type ScenePublicationFence,
  type ScenePublicationFenceError,
  scenePublicationFenceFromCatalog,
} from './scene-publication-fence';

/**
 * Resolver contract consumed by {@link postSpawnResolveJoints} (D-1: relocated
 * here from scene-instances/post-spawn-resolve-joints.ts so the hook contract
 * travels with the instantiate cluster into @forgeax/engine-assets-runtime).
 */
export interface SkinJointResolver {
  resolveSkinAsset(skeletonHandleRaw: number): SkinAsset | undefined;
}

function catalogSourceGuidForFence(
  registry: AssetRegistry,
  expected: ScenePublicationFence,
): string | undefined {
  const entries = catalogEntriesForFence(registry);
  for (const entry of entries) {
    if (entry.kind !== 'scene') continue;
    const current = scenePublicationFenceFromCatalog(entries, entry.guid);
    if (current.ok && compareScenePublicationFences(expected, current.value).ok) {
      return entry.guid;
    }
  }
  return undefined;
}

/** Merge the live Edit Catalog and the Play pack-index projection for fences. */
function catalogEntriesForFence(registry: AssetRegistry): readonly CatalogEntry[] {
  const byGuid = new Map<string, CatalogEntry>();
  for (const entry of registry.catalogSnapshot()?.entries ?? []) {
    byGuid.set(entry.guid.toLowerCase(), entry);
  }
  for (const [guid, record] of registry.packIndexCache ?? []) {
    if (record.sourcePath === undefined) continue;
    const candidate = { ...record, guid, sourcePath: record.sourcePath } as CatalogEntry;
    const current = byGuid.get(guid.toLowerCase());
    if (
      current === undefined ||
      (current.publication === undefined && candidate.publication !== undefined)
    ) {
      byGuid.set(guid.toLowerCase(), candidate);
    }
  }
  return [...byGuid.values()];
}

/**
 * Post-spawn hook contract (D-1). A hook runs after instantiate spawns the
 * scene subtree; the shipped implementation is runtime's `postSpawnResolveJoints`
 * (auto-wire Skin.joints). Injected at the sole production assembly point
 * (createRenderer) in w9/w10; when absent, instantiate skips joint wiring.
 */
export type PostSpawnHook = (
  world: World,
  resolver: SkinJointResolver,
  root: EntityHandle,
) => { ok: true } | { ok: false; error: unknown };

/**
 * Remove the entities and producer grants created by one instantiate call.
 *
 * GUID fields use World interning, so an interned handle is released only when
 * its producer grant is the last live reference. A failed scene has no live
 * holders after `despawnScene`; a handle retained by an unrelated sibling is
 * therefore left untouched. Fresh scene and nested-scene alloc grants are
 * always released after their spawned holders are gone.
 */
function rollbackSpawn(
  world: World,
  roots: readonly EntityHandle[],
  allocHandles: readonly number[],
  internedHandles: readonly number[],
  sharedRefBaseline: number,
): void {
  for (const root of new Set(roots)) {
    void worldDespawnScene(world, root);
  }

  for (const raw of new Set(allocHandles)) {
    const handle = raw as never;
    if (world.sharedRefs.refcount(handle) > 0) void world.sharedRefs.release(handle);
  }

  for (const raw of new Set(internedHandles)) {
    if (world.sharedRefs._liveCount() <= sharedRefBaseline) break;
    const handle = raw as never;
    if (world.sharedRefs.refcount(handle) === 1) void world.sharedRefs.release(handle);
  }
}

/**
 * Materialise a `SceneAsset` into an existing `World` and return the
 * synthetic root `Entity` (feat-20260514 w31 sugar wrapper; AC-03 +
 * requirements §IN-3; M3: returns Entity not SceneInstanceId).
 *
 * Before spawning, handle-type component fields (e.g. `assetHandle`,
 * `material`, `skeleton`) containing GUID strings are resolved to fresh
 * user-tier `Handle` numbers via `world.allocSharedRef` (feat-20260614 M8
 * D-19 instantiate-time GUID->handle mint; supersedes the pre-D-17
 * `resolveGuid` map). GUIDs that fail to parse or are not catalogued return
 * `AssetError(code='asset-not-found')` with a hint containing the GUID,
 * node localId, and field name.
 *
 * Errors propagate verbatim through the closed
 * `AssetError | PackError | EcsError` union so AI users that already
 * narrow `loadByGuid<SceneAsset>` results reuse the same `switch
 * (err.code)` exhaustively (charter proposition 3 machine-readable
 * union; plan-strategy §3.3 closed-union transparency).
 *
 * @example
 * ```ts
 * const sceneRes = await engine.assets.loadByGuid<SceneAsset>(roomGuid); // payload (D-17)
 * if (!sceneRes.ok) return;
 * const handle = world.allocSharedRef('SceneAsset', sceneRes.value);     // mint column handle
 * const r = engine.assets.instantiate(handle, world);
 * if (!r.ok) {
 *   switch (r.error.code) {
 *     case 'asset-not-found':
 *     case 'pack-cyclic-reference':
 *     // ... AssetErrorCode | PackErrorCode | EcsErrorCode exhaustive
 *   }
 * }
 * ```
 */
export function instantiate<T extends SceneAsset>(
  registry: AssetRegistry,
  handle: Handle<TagOf<T>, 'shared'>,
  world: World,
  parent?: EntityHandle,
  expectedPublication?: ScenePublicationFence,
): Result<EntityHandle, AssetError | PackError | EcsError | ScenePublicationFenceError> {
  const sharedRefBaseline = world.sharedRefs._liveCount();
  const allocHandles: number[] = [];
  const internedHandles: number[] = [];
  // feat-20260614 M8 (D-15 / D-17): resolve the SceneAsset payload from the
  // handle through the two-tier `resolveAssetHandle` (builtin / user-tier
  // world.sharedRefs) -- the registry holds no handle->payload map. Scene
  // GUID-type component fields are then resolved to fresh user-tier handles
  // via `world.allocSharedRef` (instantiate-time GUID->handle mint). When the
  // handle does not resolve to a scene payload, fall through to the ecs-only
  // path (an externally-resolved SceneAssetResolver handle).
  let instantiateResult: Result<EntityHandle, AssetError | PackError | EcsError>;
  const sceneRes0 = resolveAssetHandle<SceneAsset>(
    world,
    handle as unknown as Handle<string, 'shared'>,
  );
  const sceneAsset = sceneRes0.ok ? sceneRes0.value : undefined;
  if (sceneAsset !== undefined && sceneAsset.kind !== 'scene') {
    return err(
      new AssetError({
        code: 'asset-invalid-value',
        expected: 'instantiate handle resolves to a SceneAsset',
        hint: `resolved asset kind was ${sceneAsset.kind}`,
      }),
    );
  }
  if (sceneAsset !== undefined && sceneAsset.kind === 'scene') {
    // feat-20260622 M3 / w8: find the scene's GUID key in the catalog
    // so _resolveSceneGuids can reverse-decode from envelope.refs edges.
    const sceneGuidKey = registry._guidForAsset(sceneAsset);
    if (expectedPublication !== undefined) {
      const entries = catalogEntriesForFence(registry);
      if (sceneGuidKey === undefined) {
        return err({
          code: 'asset-generation-fence-mismatch',
          phase: 'instantiate',
          hint: 'generated Scene source has no Catalog identity for publication fence validation',
          retryable: true,
          recoveryActions: ['continue-last-known-good', 'retry-rebuild', 'fresh-reopen'],
        } as const);
      }
      const current = scenePublicationFenceFromCatalog(entries, sceneGuidKey);
      if (!current.ok) return current;
      const matches = compareScenePublicationFences(expectedPublication, current.value);
      if (!matches.ok) return matches;
    }
    const guidToHandle = new Map<string, number>();
    const resolvedSceneHandles = new Map<string, number>();
    const sceneRes = registry._resolveSceneGuids(
      sceneAsset,
      world,
      sceneGuidKey,
      undefined,
      guidToHandle,
      resolvedSceneHandles,
    );
    if (!sceneRes.ok) {
      rollbackSpawn(
        world,
        [],
        [...resolvedSceneHandles.values()],
        [...guidToHandle.values()],
        sharedRefBaseline,
      );
      return sceneRes;
    }
    internedHandles.push(...guidToHandle.values());
    allocHandles.push(...resolvedSceneHandles.values());

    // feat-20260703 M1 (D-1): register the resolved copy -> original
    // catalog GUID in the origin reverse-index so _guidForAsset can
    // find it even after the local sceneGuidKey variable is discarded.
    if (sceneGuidKey !== undefined) {
      registry._originIndex.set(sceneRes.value, sceneGuidKey);
    }

    // Register the GUID-resolved SceneAsset as a shared ref so
    // Scene owner resolves it transparently. The shared
    // ref alloc-grant rc=1 stays held by the alloc; the SceneInstance spawn
    // retains to rc=2 and the despawn path releases back to rc=1.
    const sharedHandle = world.allocSharedRef('SceneAsset', sceneRes.value);
    allocHandles.push(unwrapHandle(sharedHandle));

    // m3-i3: wire identity resolver so mount.source already resolved
    // to a live handle number by _resolveMountsRec passes through.
    // Scene mount resolution calls this resolver; when source is a number (live handle),
    // return it as-is; when source is a string (unresolved GUID),
    // fail (should not happen after resolution, but fail-safe).
    worldSetSceneAssetResolver(world, (source, _parentHandle) => {
      if (typeof source === 'number') {
        return ok(source as unknown as Handle<'SceneAsset', 'shared'>);
      }
      return err({
        code: 'asset-not-found' as const,
        expected: `mount source GUID ${source} resolved before instantiate`,
        hint: PACK_ERROR_HINTS['pack-cyclic-reference'],
      });
    });

    // C-R2 (feat-20260622-s5 M6): instantiateScene now returns
    // `{ root, diagnostics }` on success. This runtime API keeps its
    // `Result<EntityHandle>` contract; unwrap to `root`. (Surfacing scene
    // unknown-field diagnostics through `assets.instantiate` is M7 README
    // scope — the Scene package owns this boundary.)
    const sceneInst = worldInstantiateScene(world, sharedHandle, parent);
    if (!sceneInst.ok) {
      rollbackSpawn(world, [], allocHandles, internedHandles, sharedRefBaseline);
      return sceneInst as unknown as Result<EntityHandle, AssetError | PackError | EcsError>;
    }
    instantiateResult = ok(sceneInst.value.root);
  } else {
    // Non-resolvable handle: original ecs direct path (backward compat).
    const sceneInst = worldInstantiateScene(
      world,
      handle as Handle<'SceneAsset', 'shared'>,
      parent,
    );
    if (!sceneInst.ok) {
      return sceneInst as unknown as Result<EntityHandle, AssetError | PackError | EcsError>;
    }
    instantiateResult = ok(sceneInst.value.root);
  }

  // Post-spawn hook: auto-wire Skin.joints from jointPaths. feat-20260614 M8
  // (D-15): the Skin column holds a user-tier SkeletonAsset handle; resolve
  // it to the payload via the two-tier `resolveAssetHandle`, then match the
  // catalogued SkinAsset whose resolved skeleton payload is the same object
  // (the registry holds no handle->guid index).
  //
  // feat-20260705-runtime-tier2-decomposition M1 / w9 (D-1): the hook is
  // injected via `registry.postSpawnHook` (the sole production assembly point
  // createRenderer wires `postSpawnResolveJoints`). When no hook is present
  // (standalone / test registries without joint-wiring needs), instantiate
  // skips the post-spawn wiring silently -- the resolver closure below stays
  // inline (it reads registry-internal state: assetCatalog / _guidForAsset).
  const hook = registry.postSpawnHook;
  if (hook !== undefined) {
    const self = registry;
    const resolver: SkinJointResolver = {
      resolveSkinAsset(skeletonHandleRaw: number) {
        const skelRes = resolveAssetHandle<SkeletonAsset>(
          world,
          skeletonHandleRaw as unknown as Handle<string, 'shared'>,
        );
        if (!skelRes.ok) return undefined;
        const skeletonPayload = skelRes.value as Asset;
        const skeletonGuid = self._guidForAsset(skeletonPayload);
        if (skeletonGuid === undefined) return undefined;
        for (const [, envelope] of self.assetCatalog) {
          const asset = envelope.payload;
          if (asset.kind !== 'skin') continue;
          const skinSkeletonGuid = asset.skeletonGuid;
          if (skinSkeletonGuid === undefined) continue;
          if (skinSkeletonGuid.toLowerCase() === skeletonGuid) {
            return asset;
          }
        }
        return undefined;
      },
    };
    const jointResolveResult = hook(world, resolver, instantiateResult.value);
    if (!jointResolveResult.ok) {
      rollbackSpawn(
        world,
        [instantiateResult.value],
        allocHandles,
        internedHandles,
        sharedRefBaseline,
      );
      return { ok: false, error: jointResolveResult.error } as unknown as Result<
        EntityHandle,
        AssetError | PackError | EcsError
      >;
    }
  }

  return instantiateResult;
}

/**
 * Materialise a `SceneAsset` FLAT into an existing `World` — the "edit the
 * scene itself" registry entry (#655). Shares the GUID-resolution + shared-ref +
 * SceneAssetResolver prelude with {@link instantiate}, but calls
 * `worldInstantiateSceneFlat` instead of `worldInstantiateScene`: NO synthetic
 * SceneInstance root, NO forced `ChildOf` on top-level members. The scene's own
 * entities become plain top-level world entities; nested prefabs (`mounts[]`)
 * still become their own SceneInstance anchors. Returns the set of top-level
 * entity handles.
 *
 * Use this to OPEN a scene for authoring; use {@link instantiate} (anchor) at
 * runtime / Play and for nested prefabs.
 *
 * The post-spawn Skin.joints hook (when wired via `registry.postSpawnHook`)
 * runs once per top-level root: each GLB root keeps its own `ChildOf` subtree,
 * so joint resolution is scoped to each subtree exactly as the anchor path
 * scopes it to the single synthetic root.
 */
export function instantiateFlat<T extends SceneAsset>(
  registry: AssetRegistry,
  handle: Handle<TagOf<T>, 'shared'>,
  world: World,
  expectedPublication?: ScenePublicationFence,
): Result<EntityHandle[], AssetError | PackError | EcsError | ScenePublicationFenceError> {
  const sharedRefBaseline = world.sharedRefs._liveCount();
  const allocHandles: number[] = [];
  const internedHandles: number[] = [];
  let roots: EntityHandle[];
  let mountEntities: EntityHandle[];
  const sceneRes0 = resolveAssetHandle<SceneAsset>(
    world,
    handle as unknown as Handle<string, 'shared'>,
  );
  const sceneAsset = sceneRes0.ok ? sceneRes0.value : undefined;
  if (sceneAsset !== undefined && sceneAsset.kind === 'scene') {
    const sceneGuidKey = registry._guidForAsset(sceneAsset);
    if (expectedPublication !== undefined) {
      const entries = catalogEntriesForFence(registry);
      if (sceneGuidKey === undefined) {
        return err({
          code: 'asset-generation-fence-mismatch',
          phase: 'instantiate',
          hint: 'generated Scene source has no Catalog identity for publication fence validation',
          retryable: true,
          recoveryActions: ['continue-last-known-good', 'retry-rebuild', 'fresh-reopen'],
        } as const);
      }
      const current = scenePublicationFenceFromCatalog(entries, sceneGuidKey);
      if (!current.ok) return current;
      const matches = compareScenePublicationFences(expectedPublication, current.value);
      if (!matches.ok) return matches;
    }
    const guidToHandle = new Map<string, number>();
    const resolvedSceneHandles = new Map<string, number>();
    const sceneRes = registry._resolveSceneGuids(
      sceneAsset,
      world,
      sceneGuidKey,
      undefined,
      guidToHandle,
      resolvedSceneHandles,
    );
    if (!sceneRes.ok) {
      rollbackSpawn(
        world,
        [],
        [...resolvedSceneHandles.values()],
        [...guidToHandle.values()],
        sharedRefBaseline,
      );
      return sceneRes;
    }
    internedHandles.push(...guidToHandle.values());
    allocHandles.push(...resolvedSceneHandles.values());
    if (sceneGuidKey !== undefined) {
      registry._originIndex.set(sceneRes.value, sceneGuidKey);
    }
    const sharedHandle = world.allocSharedRef('SceneAsset', sceneRes.value);
    allocHandles.push(unwrapHandle(sharedHandle));
    worldSetSceneAssetResolver(world, (source, _parentHandle) => {
      if (typeof source === 'number') {
        return ok(source as unknown as Handle<'SceneAsset', 'shared'>);
      }
      return err({
        code: 'asset-not-found' as const,
        expected: `mount source GUID ${source} resolved before instantiate`,
        hint: PACK_ERROR_HINTS['pack-cyclic-reference'],
      });
    });
    const sceneInst = worldInstantiateSceneFlat(world, sharedHandle);
    if (!sceneInst.ok) {
      rollbackSpawn(world, [], allocHandles, internedHandles, sharedRefBaseline);
      return sceneInst as unknown as Result<EntityHandle[], AssetError | PackError | EcsError>;
    }
    roots = sceneInst.value.roots;
    mountEntities = sceneInst.value.mountEntities;
  } else {
    const sceneInst = worldInstantiateSceneFlat(world, handle as Handle<'SceneAsset', 'shared'>);
    if (!sceneInst.ok) {
      return sceneInst as unknown as Result<EntityHandle[], AssetError | PackError | EcsError>;
    }
    roots = sceneInst.value.roots;
    mountEntities = sceneInst.value.mountEntities;
  }

  // Post-spawn Skin.joints wiring, per top-level root. Mirrors the anchor
  // path's hook (D-1: injected via `registry.postSpawnHook`); when no hook is
  // present the flat path skips joint wiring silently.
  const hook = registry.postSpawnHook;
  if (hook !== undefined) {
    const self = registry;
    const resolver: SkinJointResolver = {
      resolveSkinAsset(skeletonHandleRaw: number) {
        const skelRes = resolveAssetHandle<SkeletonAsset>(
          world,
          skeletonHandleRaw as unknown as Handle<string, 'shared'>,
        );
        if (!skelRes.ok) return undefined;
        const skeletonPayload = skelRes.value as Asset;
        const skeletonGuid = self._guidForAsset(skeletonPayload);
        if (skeletonGuid === undefined) return undefined;
        for (const [, envelope] of self.assetCatalog) {
          const asset = envelope.payload;
          if (asset.kind !== 'skin') continue;
          const skinSkeletonGuid = asset.skeletonGuid;
          if (skinSkeletonGuid === undefined) continue;
          if (skinSkeletonGuid.toLowerCase() === skeletonGuid) {
            return asset;
          }
        }
        return undefined;
      },
    };
    const hookRoots = new Set<EntityHandle>(roots);
    for (const mountEntity of mountEntities) hookRoots.add(mountEntity);
    for (const root of hookRoots) {
      const jointResolveResult = hook(world, resolver, root);
      if (!jointResolveResult.ok) {
        rollbackSpawn(
          world,
          [...roots, ...mountEntities],
          allocHandles,
          internedHandles,
          sharedRefBaseline,
        );
        return { ok: false, error: jointResolveResult.error } as unknown as Result<
          EntityHandle[],
          AssetError | PackError | EcsError
        >;
      }
    }
  }

  return ok(roots);
}

/**
 * m3-i2: Recursively resolve mounts[].source GUID strings.
 * Returns a PackError-shaped object on cycle (R-9) or AssetError
 * on child resolution failure.
 *
 * feat-20260713 M3 / w13: also down-drills `mounts[].overrides[].value`,
 * resolving any GUID string bound to a `shared<...>` / `array<shared<...>>`
 * schema field to a live handle (D-2). `guidToHandle` is the caller's per-scene
 * dedup map (shared with the entity-field resolution in `_resolveSceneGuids`) so
 * the same catalogued GUID mints exactly one user-tier handle across entity
 * fields and override values (D-15/D-17 dedup contract); it defaults to a fresh
 * map so standalone callers keep working. Override resolution runs for every
 * mount regardless of `source` branch — an unresolvable GUID fail-fasts here,
 * before any spawn (P3: no half-initialized member).
 */
export function resolveMountsRec(
  registry: AssetRegistry,
  mounts: readonly SceneInstanceMount[],
  world: World,
  visited: Set<string>,
  guidToHandle: Map<string, number> = new Map(),
  resolvedSceneHandles: Map<string, number> = new Map(),
): Result<
  SceneInstanceMount[],
  | AssetError
  | {
      readonly code: 'pack-cyclic-reference';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly code: 'pack-cyclic-reference';
        readonly kind: 'mount-asset';
        readonly cycle: readonly string[];
      };
    }
  | ScenePublicationFenceError
> {
  const out: SceneInstanceMount[] = [];
  for (const m of mounts) {
    if (m.publicationFence !== undefined) {
      const parsedFence = parseScenePublicationFence(m.publicationFence);
      if (!parsedFence.ok) return parsedFence;
      const handleSourceGuid =
        typeof m.source === 'string'
          ? m.source
          : (() => {
              const resolved = resolveAssetHandle<SceneAsset>(world, m.source as never);
              return resolved.ok && resolved.value.kind === 'scene'
                ? registry._guidForAsset(resolved.value)
                : undefined;
            })();
      const sourceGuid =
        handleSourceGuid ??
        (typeof m.source === 'string'
          ? undefined
          : catalogSourceGuidForFence(registry, parsedFence.value));
      if (sourceGuid === undefined) {
        return err({
          code: 'asset-generation-fence-mismatch',
          phase: 'instantiate',
          hint: 'publication-fenced mount has no source GUID identity for validation',
          expected: parsedFence.value,
          retryable: true,
          recoveryActions: ['continue-last-known-good', 'retry-rebuild', 'fresh-reopen'],
        });
      }
      const currentFence = scenePublicationFenceFromCatalog(
        catalogEntriesForFence(registry),
        sourceGuid,
      );
      if (!currentFence.ok) return currentFence;
      const matches = compareScenePublicationFences(parsedFence.value, currentFence.value);
      if (!matches.ok) return matches;
    }
    let componentPatch:
      | { components: NonNullable<SceneInstanceMount['components']> }
      | Record<string, never> = {};
    if (m.components !== undefined) {
      const resolvedComponents = resolveMountComponents(
        registry,
        world,
        m.components,
        guidToHandle,
      );
      if (!resolvedComponents.ok) return resolvedComponents;
      componentPatch = {
        components: resolvedComponents.value as NonNullable<SceneInstanceMount['components']>,
      };
    }
    // Resolve override value GUIDs first — applies to every mount regardless of
    // the source branch below (a number-source mount can still carry overrides).
    let overridePatch: { overrides: readonly MountOverride[] } | Record<string, never> = {};
    if (m.overrides !== undefined && m.overrides.length > 0) {
      const ro = resolveMountOverrides(registry, world, m.overrides, guidToHandle);
      if (!ro.ok) return ro;
      overridePatch = { overrides: ro.value };
    }

    const src = m.source;
    // m3-i3: if source is already a number (live handle from a prior
    // resolution pass), pass through unchanged.
    if (typeof src === 'number') {
      out.push({ ...m, ...componentPatch, ...overridePatch });
      continue;
    }

    // source is a GUID string — resolve it.
    const guidKey = src.toLowerCase();

    // Cycle detection.
    if (visited.has(guidKey)) {
      return err({
        code: 'pack-cyclic-reference' as const,
        expected: 'no circular mount.source GUID references',
        hint: PACK_ERROR_HINTS['pack-cyclic-reference'],
        detail: {
          code: 'pack-cyclic-reference' as const,
          kind: 'mount-asset' as const,
          cycle: [...visited, guidKey],
        },
      });
    }

    // Look up child scene.
    const childEnv = registry.assetCatalog.get(guidKey);
    if (childEnv === undefined) {
      // Not catalogued — pass through as-is (overrides still resolved above).
      out.push({ ...m, ...componentPatch, ...overridePatch });
      continue;
    }
    const childPayload = childEnv.payload;
    if (
      typeof childPayload !== 'object' ||
      childPayload === null ||
      (childPayload as Asset).kind !== 'scene'
    ) {
      out.push({ ...m, ...componentPatch, ...overridePatch });
      continue;
    }

    const cachedChildHandle = resolvedSceneHandles.get(guidKey);
    if (cachedChildHandle !== undefined) {
      out.push({
        ...m,
        source: cachedChildHandle,
        ...componentPatch,
        ...overridePatch,
      } as SceneInstanceMount);
      continue;
    }

    // Resolve mounts recursively.
    const childVisited = new Set(visited);
    // Don't add guidKey to visited here — _resolveSceneGuids will do it
    // via its own _visitedMountGuids parameter.
    const childRes = registry._resolveSceneGuids(
      childPayload as SceneAsset,
      world,
      guidKey,
      childVisited,
      guidToHandle,
      resolvedSceneHandles,
      true,
    );

    if (!childRes.ok) {
      // Propagate child resolution error.
      return childRes as unknown as Result<SceneInstanceMount[], AssetError>;
    }

    // Build resolved child with its own mounts.
    const resolvedChild: SceneAsset = {
      kind: 'scene',
      entities: childRes.value.entities,
      ...(childRes.value.mounts !== undefined && childRes.value.mounts.length > 0
        ? { mounts: childRes.value.mounts }
        : {}),
    } as SceneAsset;

    // allocSharedRef + register in originIndex (D-7).
    const chRaw = unwrapHandle(world.allocSharedRef('SceneAsset', resolvedChild));
    resolvedSceneHandles.set(guidKey, chRaw);
    registry._originIndex.set(resolvedChild, guidKey);

    // Replace source with live handle number (D-5: source is number|string).
    out.push({
      ...m,
      source: chRaw,
      ...componentPatch,
      ...overridePatch,
    } as SceneInstanceMount);
  }
  return ok(out);
}

function resolveMountComponents(
  registry: AssetRegistry,
  world: World,
  components: NonNullable<SceneInstanceMount['components']>,
  guidToHandle: Map<string, number>,
): Result<Record<string, Record<string, unknown>>, AssetError> {
  const source = components as Record<string, Record<string, unknown>>;
  const output: Record<string, Record<string, unknown>> = {};
  for (const [componentName, fields] of Object.entries(source))
    output[componentName] = { ...fields };
  const entries = extractSceneEntityHandleGuids(world.components.entries(), [
    { localId: 0, components: source },
  ]);
  for (const entry of entries) {
    const fieldPath =
      `${entry.componentName}.${entry.fieldName}` +
      (entry.arrayIndex === undefined ? '' : `[${entry.arrayIndex}]`);
    const resolved = resolveHandleGuid(
      registry,
      world,
      entry.guidString,
      guidToHandle,
      fieldPath,
      'mount.components',
    );
    if (!resolved.ok) return resolved;
    const fields = output[entry.componentName];
    if (fields === undefined) continue;
    if (entry.arrayIndex === undefined) {
      fields[entry.fieldName] = resolved.value;
      continue;
    }
    const current = fields[entry.fieldName];
    if (!Array.isArray(current)) continue;
    const next = [...current];
    next[entry.arrayIndex] = resolved.value;
    fields[entry.fieldName] = next;
  }
  return ok(output);
}

/**
 * Resolve one GUID string to a live user-tier handle (feat-20260713 M3 / w13
 * SSOT). Parses the GUID, uses `guidToHandle` as the per-resolution fast path,
 * and on a miss looks the envelope up in the catalog + interns its shared ref
 * by `(target, payload identity)` in the World. An unparseable / uncatalogued
 * GUID returns `AssetError(code='asset-not-found')` with a breadcrumb hint
 * (`fieldPath` + `location`) for AI-user debuggability (P3). Shared by the
 * entity-field fallback in `_resolveSceneGuids` and the override-value down-drill
 * in {@link resolveMountOverrides} so the parse/dedup/lookup/mint idiom has one
 * home (architecture-principles §1 SSOT).
 */
export function resolveHandleGuid(
  registry: AssetRegistry,
  world: World,
  guidString: string,
  guidToHandle: Map<string, number>,
  fieldPath: string,
  location: string,
): Result<number, AssetError> {
  const guidRes = AssetGuid.parse(guidString);
  if (!guidRes.ok) {
    return err(
      new AssetError({
        code: 'asset-not-found',
        expected: `valid GUID string for field ${fieldPath}`,
        hint: `GUID "${guidString}" could not be parsed; at ${location}, field=${fieldPath}`,
      }),
    );
  }
  const guidKey = guidString.toLowerCase();
  let slot = guidToHandle.get(guidKey);
  if (slot === undefined) {
    const envelope = registry.assetCatalog.get(guidKey);
    if (envelope === undefined) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `GUID ${guidString} catalogued in AssetRegistry`,
          hint:
            `GUID ${guidString} not catalogued; ` +
            `call loadByGuid('${guidString}') before instantiate; ` +
            `at ${location}, field=${fieldPath}`,
        }),
      );
    }
    slot = unwrapHandle(world.internSharedRef(envelope.payload.kind, envelope.payload));
    guidToHandle.set(guidKey, slot);
  }
  return ok(slot);
}

/**
 * feat-20260713 M3 / w13: resolve every GUID string inside a mount's
 * `overrides[].value` to a live handle, returning a new overrides array whose
 * shared fields hold numeric handles (D-2 — the ecs apply loop never sees a
 * GUID). Identification is delegated to the shared w12 core
 * ({@link extractMountOverrideHandleGuids}); resolution reuses the
 * `envelope.payload → world.internSharedRef` path with the caller's
 * `guidToHandle` fast path (D-15/D-17). Stop-on-first-error: an unparseable /
 * uncatalogued GUID
 * returns `AssetError(code='asset-not-found')` with a breadcrumb hint (P3),
 * aborting before any spawn. Number elements pass through untouched (D-8).
 */
function resolveMountOverrides(
  registry: AssetRegistry,
  world: World,
  overrides: readonly MountOverride[],
  guidToHandle: Map<string, number>,
): Result<MountOverride[], AssetError> {
  const entries = extractMountOverrideHandleGuids(world.components.entries(), overrides);
  if (entries.length === 0) return ok([...overrides]);

  // resolvedMap key: `${overrideIndex}|${fieldName}|${arrayIndex ?? ''}`.
  const resolvedMap = new Map<string, number>();
  for (const entry of entries) {
    const fieldPath =
      `${entry.componentName}.${entry.fieldName}` +
      (entry.arrayIndex !== undefined ? `[${entry.arrayIndex}]` : '');
    const slot = resolveHandleGuid(
      registry,
      world,
      entry.guidString,
      guidToHandle,
      fieldPath,
      `mount override index=${entry.overrideIndex}`,
    );
    if (!slot.ok) return slot;
    resolvedMap.set(
      overrideFieldKey(entry.overrideIndex, entry.fieldName, entry.arrayIndex),
      slot.value,
    );
  }

  // Reconstruct: substitute resolved handles back into each override's value.
  const out: MountOverride[] = [];
  for (let ovIdx = 0; ovIdx < overrides.length; ovIdx++) {
    out.push(reconstructOverride(overrides[ovIdx] as MountOverride, ovIdx, resolvedMap));
  }
  return ok(out);
}

/** resolvedMap key for a resolved override handle. */
function overrideFieldKey(overrideIndex: number, fieldName: string, arrayIndex?: number): string {
  return `${overrideIndex}|${fieldName}|${arrayIndex ?? ''}`;
}

/**
 * Rebuild one override with its shared-field GUID strings replaced by resolved
 * handles from `resolvedMap`. Preserves object identity when nothing resolved
 * (no shared GUID in this override). Patch form substitutes the single `value`;
 * add form substitutes each key of the value map.
 */
function reconstructOverride(
  ov: MountOverride,
  ovIdx: number,
  resolvedMap: Map<string, number>,
): MountOverride {
  if (ov.field !== undefined) {
    const nv = reconstructFieldValue(ovIdx, ov.field, ov.value, resolvedMap);
    return nv === ov.value ? ov : { ...ov, value: nv };
  }
  const value = ov.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ov;
  const map = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(map)) {
    const nv = reconstructFieldValue(ovIdx, key, map[key], resolvedMap);
    next[key] = nv;
    if (nv !== map[key]) changed = true;
  }
  return changed ? { ...ov, value: next } : ov;
}

/**
 * Resolve one field value: a scalar `shared<T>` string becomes its handle; an
 * `array<shared<T>>` becomes an array with resolved handles substituted and
 * already-numeric elements passed through (D-8). Non-shared / unresolved values
 * pass through unchanged (identity preserved).
 */
function reconstructFieldValue(
  ovIdx: number,
  fieldName: string,
  value: unknown,
  resolvedMap: Map<string, number>,
): unknown {
  const scalar = resolvedMap.get(overrideFieldKey(ovIdx, fieldName));
  if (scalar !== undefined) return scalar;
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    let anyResolved = false;
    for (let i = 0; i < value.length; i++) {
      const resolved = resolvedMap.get(overrideFieldKey(ovIdx, fieldName, i));
      if (resolved !== undefined) {
        arr.push(resolved);
        anyResolved = true;
      } else {
        arr.push(value[i]);
      }
    }
    return anyResolved ? arr : value;
  }
  return value;
}

/**
 * tweak-20260609 M1 helper: build the per-sub-ref parent context for a
 * SceneAsset child. feat-20260622 M3 / w9: re-sourced to lookup in the
 * scene envelope's ``refs[]`` edges instead of walking entity components
 * via extractSceneEntityHandleGuids (D-7). When the scene envelope is not
 * found in the catalog, falls back to the entity-walk path (backward compat
 * for call sites that lack a catalogued envelope).
 *
 * Texture edges (sourceField=undefined) produce ``componentField:
 * undefined`` — the breadcrumb will show GUID+kind only, no per-entity
 * detail (D-2: texture has no per-entity origin).
 */
export function buildSceneChildContext(
  registry: AssetRegistry,
  scene: Asset & { kind: 'scene' },
  subGuidKey: string,
  sceneGuidKey?: string,
):
  | {
      sceneEntityId?: number;
      componentField?: string;
      sourceField?: {
        componentName?: string;
        fieldName: string;
        arrayIndex?: number;
      };
    }
  | undefined {
  // feat-20260622 M3 / w9: direct lookup in envelope.refs edges.
  // feat-20260622 review r1: address the recursing scene's OWN envelope by
  // its guidKey, not the first scene in the catalog -- under a multi-scene
  // glTF catalog the first-scene scan attributes the breadcrumb to the wrong
  // scene. Fall back to the first-scene scan only when no guidKey is given
  // (legacy call sites lacking a catalogued envelope).
  let sceneEnvelope: AssetEnvelope | undefined;
  if (sceneGuidKey !== undefined) {
    const env = registry.assetCatalog.get(sceneGuidKey);
    if (env?.kind === 'scene') sceneEnvelope = env;
  }
  if (sceneEnvelope === undefined) {
    for (const [, env] of registry.assetCatalog) {
      if (env.kind === 'scene' && env.refs !== undefined && env.refs.length > 0) {
        sceneEnvelope = env;
        break;
      }
    }
  }
  let edgeResult:
    | {
        sceneEntityId?: number;
        componentField?: string;
      }
    | undefined;
  if (sceneEnvelope?.refs !== undefined) {
    for (const ref of sceneEnvelope.refs) {
      if (ref.guid.toLowerCase() === subGuidKey) {
        const { sceneEntityId, sourceField } = ref;
        const result: {
          sceneEntityId?: number;
          componentField?: string;
          sourceField?: {
            componentName?: string;
            fieldName: string;
            arrayIndex?: number;
          };
        } = {};
        if (sceneEntityId !== undefined) {
          result.sceneEntityId = sceneEntityId;
        }
        if (sourceField?.componentName !== undefined && sourceField?.fieldName !== undefined) {
          result.componentField =
            `${sourceField.componentName}.${sourceField.fieldName}` +
            (sourceField.arrayIndex !== undefined ? `[${sourceField.arrayIndex}]` : '');
        }
        if (sourceField !== undefined) {
          result.sourceField = sourceField;
        }
        // A rich edge (dev register path) carries full detail — return now.
        if (result.sceneEntityId !== undefined || result.componentField !== undefined) {
          return result;
        }
        // feat-20260622 M4 / w14: a GUID-only edge (prod path: on-disk refs[]
        // strip sourceField / sceneEntityId at the serialization boundary, w7
        // D-10) carries no per-entity detail. Keep this empty-but-defined
        // result as the fallback, then try the entity walk below to recover
        // the entity localId + component.field path (D-7 / B-8). The walk
        // recovers handle-field edges (mesh / material); a texture edge (D-2:
        // no per-entity origin) is not found by the walk, so the empty
        // edgeResult is returned (w10 texture-edge contract preserved).
        edgeResult = result;
        break;
      }
    }
  }
  // Backward compat: fall back to entity walk when the envelope edge carries
  // no per-entity detail (prod path: GUID-only refs[]) or no envelope is
  // available (e.g. direct catalog() registration with scene payload, no refs).
  const entries = extractSceneEntityHandleGuids(
    registry.componentCatalog,
    scene.entities as unknown as ReadonlyArray<{
      readonly localId: number;
      readonly components: Record<string, Record<string, unknown>>;
    }>,
  );
  for (const entry of entries) {
    if (entry.guidString.toLowerCase() === subGuidKey) {
      return {
        sceneEntityId: entry.entityLocalId,
        componentField: `${entry.componentName}.${entry.fieldName}${entry.arrayIndex !== undefined ? `[${entry.arrayIndex}]` : ''}`,
        // feat-20260622 verify r1: also surface the recovered provenance in
        // structured parts so the failure `.detail` can expose them for AI
        // property access (charter P3), not only the concatenated hint string.
        sourceField: {
          componentName: entry.componentName,
          fieldName: entry.fieldName,
          ...(entry.arrayIndex !== undefined ? { arrayIndex: entry.arrayIndex } : {}),
        },
      };
    }
  }
  return edgeResult;
}

/**
 * tweak-20260609 M1 helper: build the error-hint breadcrumb string
 * containing the parent asset's GUID + kind, enriched with the
 * caller-provided `parentContext` (entity localId + component.field).
 *
 * Per D-7 / B-8: the breadcrumb appears before the sub-asset's own hint,
 * separated by " / ".
 */
export function buildBreadcrumbHint(
  parentGuidKey: string,
  parentKind: string,
  subGuidKey: string,
  parentContext?: {
    sceneEntityId?: number;
    componentField?: string;
  },
): string {
  let breadcrumb = `sub-asset ${subGuidKey} referenced by ${parentKind} ${parentGuidKey}`;
  if (parentContext?.sceneEntityId !== undefined && parentContext?.componentField !== undefined) {
    breadcrumb += ` (entity ${parentContext.sceneEntityId}, field ${parentContext.componentField})`;
  }
  return breadcrumb;
}
