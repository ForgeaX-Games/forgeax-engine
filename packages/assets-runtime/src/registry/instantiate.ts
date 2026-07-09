// @forgeax/engine-assets-runtime -- scene instantiate collaboration module
// (feat-20260705-runtime-tier2-decomposition M1 / w6, D-4 + D-1). Free functions
// taking the AssetRegistry instance as first param; logic byte-preserved from the
// class body (this. -> registry.). Hosts the SkinJointResolver + PostSpawnHook
// hook-contract types relocated from scene-instances/post-spawn-resolve-joints.ts
// (D-1); w9 wires PostSpawnHook into the AssetRegistry constructor.

import type { EcsError, EntityHandle, World } from '@forgeax/engine-ecs';
import type { PackError } from '@forgeax/engine-pack/errors';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  type Asset,
  type AssetEnvelope,
  type AssetError,
  type Handle,
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
import { extractSceneEntityHandleGuids } from '../scene-handle-fields';

/**
 * Resolver contract consumed by {@link postSpawnResolveJoints} (D-1: relocated
 * here from scene-instances/post-spawn-resolve-joints.ts so the hook contract
 * travels with the instantiate cluster into @forgeax/engine-assets-runtime).
 */
export interface SkinJointResolver {
  resolveSkinAsset(skeletonHandleRaw: number): SkinAsset | undefined;
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
): Result<EntityHandle, AssetError | PackError | EcsError> {
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
  if (sceneAsset !== undefined && sceneAsset.kind === 'scene') {
    // feat-20260622 M3 / w8: find the scene's GUID key in the catalog
    // so _resolveSceneGuids can reverse-decode from envelope.refs edges.
    const sceneGuidKey = registry._guidForAsset(sceneAsset);
    const sceneRes = registry._resolveSceneGuids(sceneAsset, world, sceneGuidKey);
    if (!sceneRes.ok) return sceneRes;

    // feat-20260703 M1 (D-1): register the resolved copy -> original
    // catalog GUID in the origin reverse-index so _guidForAsset can
    // find it even after the local sceneGuidKey variable is discarded.
    if (sceneGuidKey !== undefined) {
      registry._originIndex.set(sceneRes.value, sceneGuidKey);
    }

    // Register the GUID-resolved SceneAsset as a shared ref so
    // world._resolveSceneAsset can resolve it transparently. The shared
    // ref alloc-grant rc=1 stays held by the alloc; the SceneInstance spawn
    // retains to rc=2 and the despawn path releases back to rc=1.
    const sharedHandle = world.allocSharedRef('SceneAsset', sceneRes.value);

    // m3-i3: wire identity resolver so mount.source already resolved
    // to a live handle number by _resolveMountsRec passes through.
    // world._resolveMountSource will call this resolver during
    // _instantiateSceneRec; when source is a number (live handle),
    // return it as-is; when source is a string (unresolved GUID),
    // fail (should not happen after resolution, but fail-safe).
    world._setSceneAssetResolver((source, _parentHandle) => {
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
    // scope — the ECS boundary `world.instantiateScene` is the SSOT today.)
    const sceneInst = world.instantiateScene(sharedHandle, parent);
    if (!sceneInst.ok) {
      return sceneInst as unknown as Result<EntityHandle, AssetError | PackError | EcsError>;
    }
    instantiateResult = ok(sceneInst.value.root);
  } else {
    // Non-resolvable handle: original ecs direct path (backward compat).
    const sceneInst = world.instantiateScene(handle as Handle<'SceneAsset', 'shared'>, parent);
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
 * `world.instantiateSceneFlat` instead of `world.instantiateScene`: NO synthetic
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
): Result<EntityHandle[], AssetError | PackError | EcsError> {
  let roots: EntityHandle[];
  const sceneRes0 = resolveAssetHandle<SceneAsset>(
    world,
    handle as unknown as Handle<string, 'shared'>,
  );
  const sceneAsset = sceneRes0.ok ? sceneRes0.value : undefined;
  if (sceneAsset !== undefined && sceneAsset.kind === 'scene') {
    const sceneGuidKey = registry._guidForAsset(sceneAsset);
    const sceneRes = registry._resolveSceneGuids(sceneAsset, world, sceneGuidKey);
    if (!sceneRes.ok) return sceneRes;
    if (sceneGuidKey !== undefined) {
      registry._originIndex.set(sceneRes.value, sceneGuidKey);
    }
    const sharedHandle = world.allocSharedRef('SceneAsset', sceneRes.value);
    world._setSceneAssetResolver((source, _parentHandle) => {
      if (typeof source === 'number') {
        return ok(source as unknown as Handle<'SceneAsset', 'shared'>);
      }
      return err({
        code: 'asset-not-found' as const,
        expected: `mount source GUID ${source} resolved before instantiate`,
        hint: PACK_ERROR_HINTS['pack-cyclic-reference'],
      });
    });
    const sceneInst = world.instantiateSceneFlat(sharedHandle);
    if (!sceneInst.ok) {
      return sceneInst as unknown as Result<EntityHandle[], AssetError | PackError | EcsError>;
    }
    roots = sceneInst.value.roots;
  } else {
    const sceneInst = world.instantiateSceneFlat(handle as Handle<'SceneAsset', 'shared'>);
    if (!sceneInst.ok) {
      return sceneInst as unknown as Result<EntityHandle[], AssetError | PackError | EcsError>;
    }
    roots = sceneInst.value.roots;
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
    for (const root of roots) {
      const jointResolveResult = hook(world, resolver, root);
      if (!jointResolveResult.ok) {
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
 */
export function resolveMountsRec(
  registry: AssetRegistry,
  mounts: readonly SceneInstanceMount[],
  world: World,
  visited: Set<string>,
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
> {
  const out: SceneInstanceMount[] = [];
  for (const m of mounts) {
    const src = m.source;
    // m3-i3: if source is already a number (live handle from a prior
    // resolution pass), pass through unchanged.
    if (typeof src === 'number') {
      out.push({ ...m });
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
      // Not catalogued — pass through as-is.
      out.push({ ...m });
      continue;
    }
    const childPayload = childEnv.payload;
    if (
      typeof childPayload !== 'object' ||
      childPayload === null ||
      (childPayload as Asset).kind !== 'scene'
    ) {
      out.push({ ...m });
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
    registry._originIndex.set(resolvedChild, guidKey);

    // Replace source with live handle number (D-5: source is number|string).
    out.push({
      ...m,
      source: chRaw,
    } as SceneInstanceMount);
  }
  return ok(out);
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
