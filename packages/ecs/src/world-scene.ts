// @forgeax/engine-ecs — scene instantiation and instance-state subsystem.

import type {
  Handle,
  LocalEntityId,
  MountOverride,
  PackErrorCode,
  PackErrorDetail,
  SceneAsset,
  SceneInstanceMount,
} from '@forgeax/engine-types';
import {
  err,
  ok,
  PACK_ERROR_HINTS,
  type Result,
  toUnique,
  unwrapHandle,
} from '@forgeax/engine-types';
import {
  type Component,
  type ComponentSchema,
  type InputShapeOf,
  resolveComponent,
  type ShapeOf,
} from './component';
import { fillComponentDefaults } from './component-default-fallback';
import { ENTITY_NULL_RAW, type EntityHandle, entityGeneration, entityIndex } from './entity-handle';
import { ComponentNotDefinedError, StaleEntityError } from './errors';
import { classifyEntityField, remapEntityFieldValue } from './externalization/index';
import type { UniqueRefStore } from './unique-ref-store';
import type { ComponentData, EcsError, World } from './world';

/**
 * C-R2 (feat-20260622-s5 / studio-issues): one structured, non-fatal record of
 * a SceneAsset payload field that did NOT match the target component's schema.
 *
 * Scene data is loader-fed and may carry a stale / deprecated / typo'd field
 * (an editor renames a field, an old `.pack.json` lags). `world.instantiateScene`
 * does NOT blank the whole scene over one such field (#478 lesson: a
 * prod-silent strip re-introduced an invisible-entity class) and does NOT abort
 * fatally. Instead it skips the unknown key (no write, no input mutation) and
 * surfaces this record on the success value's `diagnostics[]` — observable in
 * production (NOT NODE_ENV-gated), consumed by property access (no string parse):
 *
 *   const r = world.instantiateScene(handle);
 *   if (r.ok) for (const d of r.value.diagnostics)
 *     console.warn(`unknown field ${d.component}.${d.field} on localId ${d.localId}`);
 *
 * Direct `world.spawn` / `world.addComponent` / `Commands.spawn` stay fail-fast
 * with `SpawnDataUnknownFieldError` — those are explicit API calls where a typo
 * is a programming error, not loader-fed data.
 */
export type SceneInstantiateDiagnostic = {
  /** Component name (schema key) the unknown field appeared under. */
  readonly component: string;
  /** The offending field name not declared in the component schema. */
  readonly field: string;
  /** LocalEntityId (within its owning SceneAsset) of the carrying entity. */
  readonly localId: number;
};

/**
 * Success value of `world.instantiateScene`. `root` is the synthetic scene-root
 * EntityHandle (carries `SceneInstance`); `diagnostics` is the (possibly empty)
 * list of non-fatal unknown-field records aggregated across this scene and every
 * recursively mounted sub-scene (C-R2). Empty array = no diagnostics.
 */
export type SceneInstantiateOk = {
  readonly root: EntityHandle;
  readonly diagnostics: readonly SceneInstantiateDiagnostic[];
};

/**
 * Success value of `world.instantiateSceneFlat` — the "edit the scene itself"
 * primitive. Unlike `instantiateScene`, NO synthetic SceneInstance root is
 * minted and NO `ChildOf` is forced onto top-level members: the scene's own
 * entities become plain top-level world entities whose hierarchy is exactly
 * their authored `ChildOf` (an entity with no `ChildOf` stays a root). `roots`
 * is the set of those top-level handles (own rootless entities + top-level
 * mount carriers). Nested prefabs inside the scene STILL materialise as their
 * own SceneInstance anchors (charter P4: instance == entity-with-SceneInstance)
 * — only THIS scene is flat.
 */
export type SceneInstantiateFlatOk = {
  readonly roots: EntityHandle[];
  readonly diagnostics: readonly SceneInstantiateDiagnostic[];
};

/**
 * @internal Intermediate produced by `_spawnSceneMembers` and consumed by both
 * the anchor finisher (`_instantiateSceneAsset`) and the flat finisher
 * (`_instantiateSceneAssetFlat`). Holds everything the shared member-spawn
 * (mounts recursion + own-entity spawn + deferred owned-parent wiring) computes,
 * before either finisher decides whether to wrap the members in a synthetic
 * SceneInstance root.
 */
export interface SceneMembersSpawn {
  /** LocalEntityId → live Entity u32 (ENTITY_NULL_RAW for unspawned slots). */
  readonly mapping: Uint32Array;
  /** Reverse map live Entity → LocalEntityId for override / detach bookkeeping. */
  readonly entityToLocalId: Map<EntityHandle, LocalEntityId>;
  /** Own entities that carried no `ChildOf` — the scene's authored top-level roots. */
  readonly rootEntities: EntityHandle[];
  /** Mount carriers whose `mount.parent === undefined` (default-parented). */
  readonly mountEntitiesNeedingRootParent: EntityHandle[];
  /** `entities.length + mounts + Σ memberCount`, captured at instantiate-time. */
  readonly totalSlots: number;
}

export type SceneAssetResolver = (
  source: number | string,
  parentHandle: Handle<'SceneAsset', 'shared'>,
) => Result<Handle<'SceneAsset', 'shared'>, unknown>;

interface SceneWorldState {
  resolver: SceneAssetResolver | null;
  readonly uniqueRefs: UniqueRefStore;
}

const sceneWorldStates = new WeakMap<World, SceneWorldState>();

function sceneWorldState(world: World): SceneWorldState {
  const state = sceneWorldStates.get(world);
  if (state === undefined) {
    throw new Error('World scene state was not initialized.');
  }
  return state;
}

/** @internal Initialize per-World scene state without adding scene storage to World. */
export function initializeWorldScene(world: World): void {
  sceneWorldStates.set(world, { resolver: null, uniqueRefs: world._getUniqueRefs() });
}

/** @internal */
export function worldSetSceneAssetResolver(world: World, resolver: SceneAssetResolver): void {
  sceneWorldState(world).resolver = resolver;
}

/** @internal */
export function worldGetSceneAssetResolver(world: World): SceneAssetResolver | null {
  return sceneWorldState(world).resolver;
}

/**
 * Materialise a SceneAsset (and any nested SceneAsset references via
 * `mounts[]`) into live entities. Returns the synthetic root Entity that
 * carries the `SceneInstance` ECS component (charter P4: instance ==
 * entity-with-SceneInstance).
 *
 * Recursion path is closed inside `_instantiateSceneRec(handle, parent,
 * stack)` (D-3); cycle detection is fail-fast `pack-cyclic-reference +
 * detail.kind:'mount-asset'` (D-1 mirror, plan-strategy §D-3). The
 * caller-supplied `parent` flows to the synthetic root's `ChildOf` so the
 * full sub-tree attaches under the AI user's host entity.
 *
 * @example
 *   const r = world.instantiateScene(handle);
 *   if (!r.ok) return r;
 *   const { root, diagnostics } = r.value;
 *   for (const d of diagnostics) // C-R2: unknown-field records, non-fatal
 *     console.warn(`unknown field ${d.component}.${d.field} on localId ${d.localId}`);
 *   const inst = world.get(root, SceneInstance).value;
 *   const member = inst.mapping[0]; // first member entity
 */
export function worldInstantiateScene(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
  parent?: EntityHandle,
): Result<SceneInstantiateOk, EcsError> {
  const stack = new Set<number>();
  // C-R2: collect non-fatal unknown-field diagnostics across this scene and
  // every recursively mounted sub-scene. The internal recursion writes into
  // this accumulator; only the public entry packages it onto the success value.
  const diagnostics: SceneInstantiateDiagnostic[] = [];
  const r = worldInstantiateSceneRec(world, handle, parent, stack, diagnostics);
  if (!r.ok) return r;
  return ok({ root: r.value, diagnostics });
}
/**
 * Materialise a SceneAsset FLAT — the "edit the scene itself" primitive.
 * Unlike `instantiateScene`, this mints NO synthetic SceneInstance root and
 * forces NO `ChildOf` onto top-level members: the scene's own entities become
 * plain top-level world entities whose hierarchy is exactly their authored
 * `ChildOf` (an entity with no `ChildOf` is a root). Use this to OPEN a scene
 * for editing; use `instantiateScene` (anchor) at runtime / for nested
 * prefabs where an instance boundary + override isolation is wanted.
 *
 * Nested prefabs referenced via `mounts[]` STILL materialise as their own
 * SceneInstance anchors (charter P4 preserved) — only THIS top scene is flat.
 *
 * @example
 *   const r = world.instantiateSceneFlat(handle);
 *   if (!r.ok) return r;
 *   const { roots, diagnostics } = r.value; // roots = top-level handles
 */
export function worldInstantiateSceneFlat(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
): Result<SceneInstantiateFlatOk, EcsError> {
  const stack = new Set<number>();
  const diagnostics: SceneInstantiateDiagnostic[] = [];
  const handleKey = unwrapHandle(handle);
  const resolved = worldResolveSceneAsset(world, handle);
  if (!resolved.ok) return resolved;
  stack.add(handleKey);
  let r: Result<EntityHandle[], EcsError>;
  try {
    r = worldInstantiateSceneAssetFlat(world, handle, resolved.value, stack, diagnostics);
  } finally {
    stack.delete(handleKey);
  }
  if (!r.ok) return r;
  return ok({ roots: r.value, diagnostics });
}
/**
 * @internal Recursive helper carrying the cycle-detection stack. Sugar /
 * other public callers must not see this mechanic — use `instantiateScene`
 * (D-3 / charter P1).
 */
export function worldInstantiateSceneRec(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
  parent: EntityHandle | undefined,
  stack: Set<number>,
  diagnostics: SceneInstantiateDiagnostic[],
): Result<EntityHandle, EcsError> {
  const handleKey = unwrapHandle(handle);
  if (stack.has(handleKey)) {
    const cycleArr: string[] = [];
    for (const k of stack) cycleArr.push(String(k));
    cycleArr.push(String(handleKey));
    const detail: PackErrorDetail = {
      code: 'pack-cyclic-reference',
      kind: 'mount-asset',
      cycle: cycleArr,
    };
    return err({
      code: 'pack-cyclic-reference' as PackErrorCode,
      expected: 'acyclic SceneAsset mount graph',
      hint: PACK_ERROR_HINTS['pack-cyclic-reference'],
      detail,
    } as unknown as EcsError);
  }
  const resolved = worldResolveSceneAsset(world, handle);
  if (!resolved.ok) return resolved;
  const asset = resolved.value;
  stack.add(handleKey);
  try {
    return worldInstantiateSceneAsset(world, handle, asset, parent, stack, diagnostics);
  } finally {
    stack.delete(handleKey);
  }
}
/**
 * @internal Resolve a SceneAsset handle through the SharedRefStore.
 * The handle u32 is the SharedRefStore slot id (`world.allocSharedRef
 * ('SceneAsset', asset)` is the producer; rc starts at 1, the SceneInstance
 * spawn retains to rc=2 in M4 / w13). Errors propagate as EcsError so the
 * instantiateScene chain returns a single closed union.
 */
export function worldResolveSceneAsset(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
): Result<SceneAsset, EcsError> {
  const r = world.sharedRefs.resolve(handle);
  if (!r.ok) {
    return err(r.error as unknown as EcsError);
  }
  return ok(r.value as SceneAsset);
}
/**
 * @internal Spawn one SceneAsset's members — the shared body of both scene
 * finishers. Recurses into `mounts[]` (each nested prefab becomes its own
 * SceneInstance anchor), spawns `entities[]` honouring their authored
 * `ChildOf`, and wires deferred owned-parent mount edges. Does NOT create a
 * synthetic root or force any `ChildOf` — that is the caller's (finisher's)
 * job. `_instantiateSceneRec` owns cycle bookkeeping.
 */
export function worldSpawnSceneMembers(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
  asset: SceneAsset,
  stack: Set<number>,
  diagnostics: SceneInstantiateDiagnostic[],
): Result<SceneMembersSpawn, EcsError> {
  const sceneInstanceToken = resolveComponent('SceneInstance');
  if (sceneInstanceToken === undefined) {
    return err(new ComponentNotDefinedError('SceneInstance'));
  }
  const childOfToken = resolveComponent('ChildOf');
  // ChildOf is optional — only needed if the asset declares ChildOf or a
  // caller-supplied parent must be wired. If absent and we need it, we
  // fail-fast at the wiring site below.

  const ownEntities = asset.entities;
  const ownMounts = asset.mounts ?? [];
  const memberSum = ownMounts.reduce((s, m) => s + m.memberCount, 0);
  const countBaseline = ownEntities.length + ownMounts.length + memberSum;
  // C-R1 (studio-issues #6): mapping table must be sized to maxLocalId+1,
  // not to the entity count. An editor scene may have non-contiguous
  // localIds (deleted entities leave gaps); sizing to count means any
  // localId >= count is a silent Uint32Array OOB no-op -> entity spawns
  // but is unreachable by localId -> users report "character can't move".
  // Take the max of count-baseline and id-range so both packed and
  // sparse scenes work without over-allocation in the common case.
  let maxLocalId = ownEntities.reduce((m, e) => Math.max(m, e.localId as unknown as number), -1);
  for (const mount of ownMounts) {
    maxLocalId = Math.max(maxLocalId, mount.localId as unknown as number);
    const last = (mount.memberFirst as unknown as number) + mount.memberCount - 1;
    maxLocalId = Math.max(maxLocalId, last);
  }
  const totalSlots = Math.max(countBaseline, maxLocalId + 1);

  // R2/Bonus: namespace-overlap fail-fast (AC-05 /
  // pack-mount-localid-overlap). Each LocalEntityId in
  // [0, totalSlots) must be claimed by exactly one of:
  //   - entities[i].localId
  //   - mounts[i].localId
  //   - mounts[i] window slot (memberFirst .. memberFirst+memberCount-1)
  // Overlap or duplicate claim => fail-fast with the offending localIds
  // and human-readable origin labels.
  {
    const claims = new Map<number, string>();
    const overlapLids = new Set<number>();
    const overlapSources: string[] = [];
    const claim = (lid: number, src: string): void => {
      const prior = claims.get(lid);
      if (prior !== undefined) {
        if (!overlapLids.has(lid)) {
          overlapLids.add(lid);
          overlapSources.push(prior);
          overlapSources.push(src);
        } else {
          overlapSources.push(src);
        }
        return;
      }
      claims.set(lid, src);
    };
    for (const ent of ownEntities) {
      claim(ent.localId as unknown as number, `entities[${ent.localId as unknown as number}]`);
    }
    for (const mount of ownMounts) {
      const mLid = mount.localId as unknown as number;
      claim(mLid, `mount[${mLid}]`);
      const first = mount.memberFirst as unknown as number;
      for (let k = 0; k < mount.memberCount; k += 1) {
        claim(first + k, `mount[${mLid}].member[${k}]`);
      }
    }
    if (overlapLids.size > 0) {
      const overlapping = Array.from(overlapLids).sort((a, b) => a - b);
      return err({
        code: 'pack-mount-localid-overlap' as PackErrorCode,
        expected: 'each LocalEntityId claimed by exactly one entity or mount slot',
        hint: PACK_ERROR_HINTS['pack-mount-localid-overlap'],
        detail: {
          code: 'pack-mount-localid-overlap',
          overlapping,
          sources: overlapSources,
        } as PackErrorDetail,
      } as unknown as EcsError);
    }
  }

  // Slot table: indexed by LocalEntityId; populated as entities / mounts /
  // members are spawned. mapping[localId] = encoded Entity u32. Unspawned
  // slots hold ENTITY_NULL_RAW (0xffffffff) — NOT 0, because a fresh World's
  // first spawn encodes to gen=0+idx=0=raw 0, which is a valid Entity. The
  // remap path in `_buildSceneEntityComponentDatas` distinguishes the two
  // (live=ENTITY_NULL_RAW => parent unspawned at remap time => surface as
  // null sentinel; live=any other u32 => valid live Entity, including 0).
  const mapping = new Uint32Array(totalSlots).fill(ENTITY_NULL_RAW);
  const entityToLocalId = new Map<EntityHandle, LocalEntityId>();
  const rootEntities: EntityHandle[] = [];
  // R2/B-1: mount entities whose `mount.parent === undefined` need their
  // ChildOf wired to the outer synthetic root (this scene's root). Step 5
  // does the wiring once the synthetic root entity is materialised; we
  // collect them here in step 1.
  const mountEntitiesNeedingRootParent: EntityHandle[] = [];
  // D-8 (feat-20260707): mount entities whose `mount.parent` points at an
  // OWNED entity slot are wired AFTER step 2 spawns the owned entities —
  // mounts are processed first (step 1), so the owned parent slot is still
  // ENTITY_NULL_RAW at mount-processing time. Same deferred-wiring shape as
  // mountEntitiesNeedingRootParent: register [mountEntity, parentSlot] here,
  // wire ChildOf once the slot is live. Without this the edge was silently
  // dropped, and the mount carrier stayed unreachable from its owned parent.
  const mountEntitiesNeedingDeferredParent: Array<[EntityHandle, number]> = [];

  // 1. Recurse into mounts[] FIRST so the mount-window slots
  //    (`mount.localId` + `[memberFirst, memberFirst+memberCount)`) are
  //    populated before any owned entity tries to remap a LocalEntityId
  //    pointing into the mount window (AC-24 cross-boundary reference).
  for (const mount of ownMounts) {
    // R2/B-3 + R2/B-4: validate overrides BEFORE child resolution so a
    // malformed override fails fast without observable side-effects.
    const overrideValidationRes = worldValidateMountOverrides(mount);
    if (!overrideValidationRes.ok) {
      return overrideValidationRes;
    }

    // Spawn the mount entity (carries mount.components).
    const mountLid = mount.localId as unknown as number;
    const mountSpawnRes = worldSpawnMountEntity(world, mount, mapping, diagnostics);
    if (!mountSpawnRes.ok) return mountSpawnRes;
    const mountEntity = mountSpawnRes.value;
    mapping[mountLid] = mountEntity as unknown as number;

    // Resolve mount.source -> child SceneAsset handle.
    const childHandleRes = worldResolveMountSource(world, mount.source, handle);
    if (!childHandleRes.ok) return childHandleRes;
    const childHandle = childHandleRes.value;

    // Recursively instantiate the child. Its synthetic root attaches as a
    // child of the mount entity. The child writes its own unknown-field
    // diagnostics into the SAME accumulator, so they bubble to the top-level
    // instantiateScene result (C-R2 recursive aggregation).
    const childRes = worldInstantiateSceneRec(world, childHandle, mountEntity, stack, diagnostics);
    if (!childRes.ok) return childRes;

    // R2/B-2: cross-check mount.memberCount === child.totalSlots BEFORE
    // copying the mount window. The child SceneInstance.mapping length is
    // the authoritative `totalSlots` of the child. AC-04 / requirements
    // S-5 mandate fail-fast at runtime for this disagreement.
    const childInstRes = world.get(childRes.value, sceneInstanceToken);
    if (!childInstRes.ok) return childInstRes;
    const childMapping = (childInstRes.value as unknown as { mapping: Uint32Array }).mapping;
    if (childMapping.length !== mount.memberCount) {
      return err({
        code: 'pack-mount-count-mismatch' as PackErrorCode,
        expected: 'mount.memberCount === child SceneAsset totalSlots',
        hint: PACK_ERROR_HINTS['pack-mount-count-mismatch'],
        detail: {
          code: 'pack-mount-count-mismatch',
          mountLocalId: mountLid,
          declared: mount.memberCount,
          actual: childMapping.length,
        } as PackErrorDetail,
      } as unknown as EcsError);
    }

    // Pull the child's mapping into our parent window. Default unset slots
    // to ENTITY_NULL_RAW so downstream "live" checks distinguish them from
    // the first Entity (gen=0+idx=0 encodes to raw u32 0).
    const window = mount.memberCount;
    for (let k = 0; k < window; k += 1) {
      mapping[(mount.memberFirst as unknown as number) + k] = childMapping[k] ?? ENTITY_NULL_RAW;
    }

    // Apply mount.overrides at instantiate-time (AC-19).
    // Each override.localId addresses a slot in *this* (parent) namespace
    // (R2/F-8 cement: parent-namespace + memberFirst+offset addressing).
    // The state map will be populated below with these overrides — but we
    // must also write the value through to the live entity column so the
    // readback invariant holds.
    // Mount-entity itself never has children attached by the caller other
    // than via the recursive child; nothing else to wire here.
    if (childOfToken !== undefined) {
      if (mount.parent !== undefined) {
        // Reparent the mount-entity ChildOf to the caller-specified parent.
        const parentSlot = mount.parent as unknown as number;
        const parentEntity = mapping[parentSlot];
        if (parentEntity !== undefined && parentEntity !== ENTITY_NULL_RAW) {
          const r = world.addComponent(mountEntity, {
            component: childOfToken,
            data: { parent: parentEntity } as never,
          });
          if (!r.ok) {
            // ChildOf may already be present from layer-1; reparent via set.
            const set = world.set(mountEntity, childOfToken, {
              parent: parentEntity,
            } as never);
            if (!set.ok) return set as Result<SceneMembersSpawn, EcsError>;
          }
        } else {
          // D-8: the owned parent slot is not spawned yet (owned entities
          // spawn in step 2, after this mount loop). Defer the ChildOf wire
          // to step 2's tail once mapping[parentSlot] is live.
          mountEntitiesNeedingDeferredParent.push([mountEntity, parentSlot]);
        }
      } else {
        // R2/B-1: default semantic — mount.parent === undefined wires the
        // mount entity ChildOf to *this* scene's synthetic root (created
        // in step 3 below). Defer the actual wire to step 5 after the
        // synthetic root spawn; record the mount entity here.
        mountEntitiesNeedingRootParent.push(mountEntity);
      }
    }
  }

  // 2. Spawn entities[] entities. Topo-sort by ChildOf so parents are
  //    spawned before children (so localId remap can read mapping live).
  //    This runs AFTER mount processing (step 1) so cross-boundary
  //    `ChildOf {parent: <mount-window-localId>}` references resolve
  //    correctly (AC-24).
  const order = sceneTopoSort(ownEntities);
  for (const idx of order) {
    const node = ownEntities[idx];
    if (node === undefined) continue;
    const lid = node.localId as unknown as number;
    const compDataRes = worldBuildSceneEntityComponentDatas(node, mapping, diagnostics);
    if (!compDataRes.ok) return compDataRes;
    const sp = (world.spawn as (...c: ComponentData[]) => Result<EntityHandle, EcsError>)(
      ...compDataRes.value,
    );
    if (!sp.ok) return sp as Result<SceneMembersSpawn, EcsError>;
    const e = sp.value;
    mapping[lid] = e as unknown as number;
    entityToLocalId.set(e, lid as unknown as LocalEntityId);
    if (node.components.ChildOf === undefined) {
      rootEntities.push(e);
    }
  }

  // 2b. D-8 (feat-20260707): wire deferred owned-parent mount ChildOf edges.
  //     Owned entities are now live (step 2 above), so mapping[parentSlot]
  //     resolves. Same shape as the mountEntitiesNeedingRootParent wiring in
  //     step 5. The relationship mirror hook (relationshipOnInsert) pushes the
  //     carrier into the owned parent's Children mirror automatically.
  if (childOfToken !== undefined) {
    for (const [mountEntity, parentSlot] of mountEntitiesNeedingDeferredParent) {
      const parentEntity = mapping[parentSlot];
      if (parentEntity === undefined || parentEntity === ENTITY_NULL_RAW) continue;
      const set = world.set(mountEntity, childOfToken, { parent: parentEntity } as never);
      if (!set.ok) {
        const r = world.addComponent(mountEntity, {
          component: childOfToken,
          data: { parent: parentEntity } as never,
        });
        if (!r.ok) return r as Result<SceneMembersSpawn, EcsError>;
      }
    }
  }

  return ok({
    mapping,
    entityToLocalId,
    rootEntities,
    mountEntitiesNeedingRootParent,
    totalSlots,
  });
}
/**
 * @internal Spawn one SceneAsset's entities + apply mounts recursively, then
 * wrap them in a synthetic SceneInstance root (the anchor). This is the
 * runtime / Play / nested-mount finisher (charter P4: instance ==
 * entity-with-SceneInstance). Caller (`_instantiateSceneRec`) owns cycle
 * bookkeeping.
 */
export function worldInstantiateSceneAsset(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
  asset: SceneAsset,
  parent: EntityHandle | undefined,
  stack: Set<number>,
  diagnostics: SceneInstantiateDiagnostic[],
): Result<EntityHandle, EcsError> {
  const sceneInstanceToken = resolveComponent('SceneInstance');
  if (sceneInstanceToken === undefined) {
    return err(new ComponentNotDefinedError('SceneInstance'));
  }
  const childOfToken = resolveComponent('ChildOf');

  const membersRes = worldSpawnSceneMembers(world, handle, asset, stack, diagnostics);
  if (!membersRes.ok) return membersRes;
  const { mapping, entityToLocalId, rootEntities, mountEntitiesNeedingRootParent, totalSlots } =
    membersRes.value;
  const ownMounts = asset.mounts ?? [];

  // 3. Spawn the synthetic root entity carrying SceneInstance.
  //    First alloc the state ref so the SceneInstance.state column has a
  //    live u32; then attach SceneInstance to a fresh entity.
  const stateRef = world
    ._getUniqueRefs()
    .alloc<'SceneInstanceState'>('SceneInstanceState', null, () => {
      // released by despawn / despawnScene; no caller-side cleanup needed
    });
  // Spawn the root with SceneInstance component, mapping snapshot, and
  // state ref. The mapping is a Uint32Array (array<entity> field shape).
  // Convert mapping Uint32Array to plain number[] for spawn write — the
  // ECS array<entity> arm copies element-by-element and accepts both, but
  // the plain-array form sidesteps a Uint32Array.length=0 corner case
  // observed during M2 testing where a non-empty Uint32Array was written
  // as if empty (suspect: archetype write-array dispatch on instanceof
  // Array vs TypedArray).
  const mappingPlain: number[] = Array.from(mapping);
  // The synthetic root is the ChildOf parent of every owned root entity
  // (step 5 below) and may itself become a ChildOf parent of a caller-
  // supplied `parent` chain. propagateTransforms walks ChildOf parents
  // through the Transform liveMap and treats a parent missing Transform
  // as `hierarchy-broken`, so the synthetic root must carry Transform
  // (identity TRS via layer-2 defaults) when Transform is defined.
  const rootComponents: ComponentData[] = [
    {
      component: sceneInstanceToken,
      data: {
        source: handle,
        mapping: mappingPlain,
        state: stateRef,
      } as never,
    },
  ];
  const transformToken = resolveComponent('Transform');
  if (transformToken !== undefined) {
    rootComponents.push({
      component: transformToken,
      data: {} as never,
    });
  }
  const rootSpawn = (world.spawn as (...c: ComponentData[]) => Result<EntityHandle, EcsError>)(
    ...rootComponents,
  );
  if (!rootSpawn.ok) {
    sceneWorldState(world).uniqueRefs.release(stateRef);
    return rootSpawn;
  }
  const rootEntity = rootSpawn.value;

  // 4. Build SceneInstanceState payload + register it in the UniqueRefStore
  //    under the same handle. We use the public `_setUniqueRefPayload`
  //    helper (added below) so the alloc -> populate sequence stays atomic.
  const overrides = new Map<LocalEntityId, Map<string, MountOverride>>();
  for (const mount of ownMounts) {
    for (const ov of mount.overrides ?? []) {
      // feat-20260713 M2 / w8: `MountOverride.field` is optional (add-or-patch
      // discriminant carried by the shape itself). Record the override into
      // the SceneInstanceState map keyed by comp (no field) or comp:field
      // (field-patch), then apply it to the live member column via the shared
      // add-or-patch helper.
      const lid = ov.localId as unknown as LocalEntityId;
      let fieldMap = overrides.get(lid);
      if (fieldMap === undefined) {
        fieldMap = new Map();
        overrides.set(lid, fieldMap);
      }
      fieldMap.set(mountOverrideStateKey(ov), ov);
      // Apply override to the live member entity column.
      const memberEntityRaw = mapping[lid as unknown as number];
      if (memberEntityRaw !== undefined && memberEntityRaw !== ENTITY_NULL_RAW) {
        const memberEntity = memberEntityRaw as unknown as EntityHandle;
        const applyRes = worldApplyMountOverride(world, memberEntity, ov);
        if (!applyRes.ok) {
          sceneWorldState(world).uniqueRefs.release(stateRef);
          return applyRes as Result<EntityHandle, EcsError>;
        }
      }
    }
  }

  const detached = new Set<LocalEntityId>();
  const state: Record<string, unknown> = {
    source: handle,
    entityToLocalId,
    detachedLocalIds: detached,
    // Convert overrides Map<LocalEntityId, Map<string, MountOverride>>
    // into Map<LocalEntityId, Map<string, SceneInstanceOverrideRecord>>
    overrides: worldMountOverridesToStateMap(overrides),
    rootEntities,
    totalSlots,
    mountTimeOverrides: ownMounts.flatMap((m) => m.overrides ?? []),
  };
  // Stuff the state into the UniqueRefStore under the existing slot. We
  // re-use the slot we allocated above by writing directly into the
  // payloads map via a `_setUniqueRefPayload` shim.
  worldSetUniqueRefPayload(world, stateRef, state);

  // 5. Wire ChildOf for every owned root entity (no ChildOf at layer-1)
  //    to the synthetic root.
  if (childOfToken !== undefined) {
    for (const rootE of rootEntities) {
      const has = world.get(rootE, childOfToken);
      if (!has.ok) {
        // No ChildOf yet — attach to synthetic root.
        const r = world.addComponent(rootE, {
          component: childOfToken,
          data: { parent: rootEntity } as never,
        });
        if (!r.ok) return r as Result<EntityHandle, EcsError>;
      }
    }
    // R2/B-1: wire mount entities with default `mount.parent === undefined`
    // to this scene's synthetic root. _spawnMountEntity may have attached a
    // placeholder ChildOf {parent: ENTITY_NULL_RAW} when mount.components
    // was empty; overwrite via set so the ChildOf chain meshRenderer ->
    // childSyntheticRoot -> mountEntity -> outerSyntheticRoot resolves
    // through Transform-bearing parents (AC-16 / requirements S-7).
    for (const mountE of mountEntitiesNeedingRootParent) {
      const set = world.set(mountE, childOfToken, { parent: rootEntity } as never);
      if (!set.ok) {
        const r = world.addComponent(mountE, {
          component: childOfToken,
          data: { parent: rootEntity } as never,
        });
        if (!r.ok) return r as Result<EntityHandle, EcsError>;
      }
    }
    // Caller-supplied parent: synthetic root's ChildOf -> parent.
    if (parent !== undefined) {
      const r = world.addComponent(rootEntity, {
        component: childOfToken,
        data: { parent } as never,
      });
      if (!r.ok) return r as Result<EntityHandle, EcsError>;
    }
  }

  return ok(rootEntity);
}
/**
 * @internal Flat finisher — spawn one SceneAsset's members WITHOUT wrapping
 * them in a synthetic SceneInstance root and WITHOUT forcing `ChildOf` onto
 * top-level members. Used for "opening a scene to edit": the scene's own
 * entities become plain top-level world entities whose hierarchy is exactly
 * their authored `ChildOf`. Nested prefabs inside still materialise as their
 * own SceneInstance anchors (the mount recursion in `_spawnSceneMembers` is
 * always anchored). Returns the top-level handles (own rootless entities +
 * top-level mount carriers).
 */
export function worldInstantiateSceneAssetFlat(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
  asset: SceneAsset,
  stack: Set<number>,
  diagnostics: SceneInstantiateDiagnostic[],
): Result<EntityHandle[], EcsError> {
  const membersRes = worldSpawnSceneMembers(world, handle, asset, stack, diagnostics);
  if (!membersRes.ok) return membersRes;
  const { mapping, rootEntities, mountEntitiesNeedingRootParent } = membersRes.value;
  const childOfToken = resolveComponent('ChildOf');
  const ownMounts = asset.mounts ?? [];

  // Apply mount-time overrides through to the live member entity columns so a
  // hand-authored pack's `mounts[].overrides` still take visual effect. There
  // is no parent SceneInstanceState to record them in (flat = no anchor for
  // THIS scene); the nested prefab keeps its OWN anchor for round-trip.
  for (const mount of ownMounts) {
    for (const ov of mount.overrides ?? []) {
      // feat-20260713 M2 / w8: add-or-patch apply in the flat path too (same
      // shared helper as the anchor loop). Flat mode records no
      // SceneInstanceState, so overrides only need to take live effect.
      const memberEntityRaw = mapping[ov.localId as unknown as number];
      if (memberEntityRaw !== undefined && memberEntityRaw !== ENTITY_NULL_RAW) {
        const applyRes = worldApplyMountOverride(
          world,
          memberEntityRaw as unknown as EntityHandle,
          ov,
        );
        if (!applyRes.ok) return applyRes as Result<EntityHandle[], EcsError>;
      }
    }
  }

  // Default-parented mount carriers (`mount.parent === undefined`) would, in
  // anchor mode, attach to the synthetic root. Flat mode has none, so they
  // stay top-level. `_spawnMountEntity` may have left a placeholder
  // `ChildOf {parent: ENTITY_NULL_RAW}` (rare: mount with no components AND
  // Transform unregistered) — strip it so the carrier is a genuine root.
  if (childOfToken !== undefined) {
    for (const mountE of mountEntitiesNeedingRootParent) {
      const co = world.get(mountE, childOfToken);
      if (co.ok && (co.value as { parent: number }).parent === ENTITY_NULL_RAW) {
        world._removeComponentCore(mountE, childOfToken, false);
      }
    }
  }

  return ok([...rootEntities, ...mountEntitiesNeedingRootParent]);
}
/** @internal Build ComponentData[] for one SceneEntity, remapping localIds.
 *
 * C-R2 (feat-20260622-s5 M6): unknown fields on a SceneAsset payload are NOT
 * fatal. Unlike `world.spawn` (an explicit API call where a typo is a
 * programming error -> `SpawnDataUnknownFieldError`), scene data is loader-fed
 * and may carry a stale / deprecated / typo'd field. The remap below builds a
 * fresh `remappedRaw` and simply SKIPS keys absent from the schema (no input
 * mutation — the source `raw` is never deleted-from), recording each skipped
 * key as a non-fatal `SceneInstantiateDiagnostic` into the passed accumulator.
 * All known fields still write through, so one bad field cannot blank the
 * entity or the scene (C-AC-02/03/04).
 */
export function worldBuildSceneEntityComponentDatas(
  node: import('@forgeax/engine-types').SceneEntity,
  mapping: Uint32Array,
  diagnostics: SceneInstantiateDiagnostic[],
): Result<ComponentData[], EcsError> {
  const out: ComponentData[] = [];
  const nodeLocalId = node.localId as unknown as number;
  for (const compName of Object.keys(node.components)) {
    const token = resolveComponent(compName);
    if (token === undefined) {
      return err(new ComponentNotDefinedError(compName));
    }
    const raw = node.components[compName] ?? {};
    const schema = token.schema as Record<string, string>;
    const remappedRaw: Record<string, unknown> = {};
    for (const fieldName of Object.keys(raw)) {
      const fieldType = schema[fieldName];
      // C-R2: unknown key -> skip (do not copy into remappedRaw, do not
      // mutate the source `raw`) and record a structured diagnostic. The
      // downstream `spawn` only sees schema-valid keys, so its own
      // validateComponentDataKeys gate stays green.
      if (fieldType === undefined) {
        diagnostics.push({ component: compName, field: fieldName, localId: nodeLocalId });
        continue;
      }
      const value = (raw as Record<string, unknown>)[fieldName];
      const kind = classifyEntityField(token, fieldName);
      if (kind !== null) {
        // Entity / array<entity> field — remap through the shared kernel.
        // localId -> live Entity. Slots not yet spawned hold ENTITY_NULL_RAW.
        const sceneRemap = (localId: number): number => {
          if (localId < 0 || localId >= mapping.length) return ENTITY_NULL_RAW;
          const live = mapping[localId];
          return live === undefined || live === ENTITY_NULL_RAW ? ENTITY_NULL_RAW : live;
        };
        remappedRaw[fieldName] = remapEntityFieldValue(value, kind, sceneRemap);
      } else {
        remappedRaw[fieldName] = value;
      }
    }
    const filled = fillComponentDefaults(token, remappedRaw);
    out.push({ component: token, data: filled as never });
  }
  return ok(out);
}
/**
 * @internal feat-20260713 M2 / w8: apply one MountOverride to a live member
 * entity column. The `field?` shape is the add-or-patch discriminant:
 *
 *   - `field` present -> PATCH one field: `world.set(member, comp, {[field]:
 *     value})`. Omitted fields keep their authored / existing values.
 *   - `field` absent  -> ADD/UPSERT the whole component: `value` is the
 *     per-field value map for `comp`. When the member already carries `comp`
 *     it is upserted (set-over each supplied field + schema defaults for the
 *     omitted ones — the whole component is rewritten from the value map +
 *     defaults, never a `component-already-present` error). When absent it is
 *     added fresh via `addComponent` (fillComponentDefaults fills omitted
 *     fields). The value-map is fed through `fillComponentDefaults` so the
 *     add and upsert paths write byte-identical rows.
 *
 * Component registration + value-key validation happened at
 * `_validateMountOverrides` (fail-fast before any spawn); by this point the
 * comp resolves and the value keys are schema-valid. `resolveComponent`
 * still guards defensively (an unregistered comp is a no-op skip, matching
 * the prior field-patch behaviour). Returns the underlying set / addComponent
 * Result so a shared-field value gate (D-4) or any other write error
 * propagates unchanged.
 */
export function worldApplyMountOverride(
  world: World,
  member: EntityHandle,
  ov: MountOverride,
): Result<void, EcsError> {
  const ovToken = resolveComponent(ov.comp);
  if (ovToken === undefined) return ok(undefined);
  if (ov.field !== undefined) {
    // PATCH one field.
    return world.set(member, ovToken, { [ov.field]: ov.value } as never);
  }
  // ADD/UPSERT the whole component. Fill omitted fields from the schema so
  // add and upsert produce identical rows (upsert = full rewrite from the
  // value map + defaults).
  const rawValue = (ov.value ?? {}) as Record<string, unknown>;
  const filled = fillComponentDefaults(ovToken as Component, rawValue);
  const has = world.get(member, ovToken);
  if (has.ok) {
    // Already present -> upsert (set every filled field, no duplicate error).
    return world.set(member, ovToken, filled as never);
  }
  return world.addComponent(member, { component: ovToken, data: filled as never });
}
/**
 * @internal R2/B-3 + R2/B-4: validate `mount.overrides[]` BEFORE any
 * spawn so a malformed override fails fast with no observable side
 * effects (charter P3 explicit-failure). Two checks:
 *
 * 1. `override.localId` must address a slot inside the parent-namespace
 *    member window `[memberFirst, memberFirst + memberCount)` (AC-06).
 * 2. `override.field` must exist in the resolved component schema
 *    (AC-07). When the component is unregistered we cannot validate the
 *    field shape; let the existing fall-through path proceed (the
 *    `resolveComponent` guard inside the override-application loop
 *    will skip the write).
 */
export function worldValidateMountOverrides(mount: SceneInstanceMount): Result<void, EcsError> {
  const overrides = mount.overrides;
  if (overrides === undefined) return ok(undefined);
  const memberFirst = mount.memberFirst as unknown as number;
  const memberCount = mount.memberCount;
  const memberLast = memberFirst + memberCount;
  const mountLid = mount.localId as unknown as number;
  for (const ov of overrides) {
    const ovLid = ov.localId as unknown as number;
    // R2/B-3: parent-namespace check — override.localId must lie in the
    // member window [memberFirst, memberFirst + memberCount).
    if (ovLid < memberFirst || ovLid >= memberLast) {
      return err({
        code: 'pack-mount-override-localid-out-of-range' as PackErrorCode,
        expected: `override.localId in [${memberFirst}, ${memberLast})`,
        hint: PACK_ERROR_HINTS['pack-mount-override-localid-out-of-range'],
        detail: {
          code: 'pack-mount-override-localid-out-of-range',
          overrideLocalId: ovLid,
          mountLocalId: mountLid,
          memberCount,
        } as PackErrorDetail,
      } as unknown as EcsError);
    }
    // feat-20260713 M2 / w8: double-branch schema check.
    //   - field-patch form (field present): the component (when registered)
    //     must declare `override.field` in its schema (R2/B-4, unchanged).
    //   - component-add form (field absent): the component MUST be registered
    //     (component-not-defined otherwise) AND every key in the value map
    //     must be a schema field (pack-mount-override-unknown-field).
    const ovToken = resolveComponent(ov.comp);
    if (ov.field !== undefined) {
      if (ovToken !== undefined) {
        const schema = ovToken.schema as Record<string, unknown>;
        if (!(ov.field in schema)) {
          return err({
            code: 'pack-mount-override-unknown-field' as PackErrorCode,
            expected: `override.field defined on component '${ov.comp}'`,
            hint: PACK_ERROR_HINTS['pack-mount-override-unknown-field'],
            detail: {
              code: 'pack-mount-override-unknown-field',
              comp: ov.comp,
              field: ov.field,
              mountLocalId: mountLid,
            } as PackErrorDetail,
          } as unknown as EcsError);
        }
      }
    } else {
      // component-add form: comp must be registered so we can validate + apply
      // the whole component (add/upsert needs the schema).
      if (ovToken === undefined) {
        return err(new ComponentNotDefinedError(ov.comp));
      }
      const schema = ovToken.schema as Record<string, unknown>;
      const valueMap = (ov.value ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(valueMap)) {
        if (!(key in schema)) {
          return err({
            code: 'pack-mount-override-unknown-field' as PackErrorCode,
            expected: `override.value keys defined on component '${ov.comp}'`,
            hint: PACK_ERROR_HINTS['pack-mount-override-unknown-field'],
            detail: {
              code: 'pack-mount-override-unknown-field',
              comp: ov.comp,
              field: key,
              mountLocalId: mountLid,
            } as PackErrorDetail,
          } as unknown as EcsError);
        }
      }
    }
  }
  return ok(undefined);
}
/** @internal Spawn the mount-entity slot carrying mount.components (if any).
 *
 * R2/B-1: the mount entity is a structural intermediate in the ChildOf
 * chain `cube -> innerSyntheticRoot -> mountEntity -> outerSyntheticRoot`,
 * so it MUST carry Transform whenever Transform is registered (mirrors
 * the D-V-0 synthetic-root invariant). Otherwise propagateTransforms
 * walking the chain hits a Transform-less parent and emits per-frame
 * `RhiError(hierarchy-broken)` (verify R1 root cause of the
 * hello-scene-nesting demo black frames).
 */
export function worldSpawnMountEntity(
  world: World,
  mount: SceneInstanceMount,
  mapping: Uint32Array,
  diagnostics: SceneInstantiateDiagnostic[],
): Result<EntityHandle, EcsError> {
  const fakeNode: import('@forgeax/engine-types').SceneEntity = {
    localId: mount.localId,
    components: mount.components ?? {},
  };
  const cdRes = worldBuildSceneEntityComponentDatas(fakeNode, mapping, diagnostics);
  if (!cdRes.ok) return cdRes;
  // R2/B-1: ensure Transform is attached so propagateTransforms can walk
  // through this entity. Layer-2 defaults supply identity TRS; the
  // mount.components overlay (when present and including Transform) takes
  // precedence and is already in cdRes.value.
  const transformToken = resolveComponent('Transform');
  if (transformToken !== undefined) {
    const hasTransform = cdRes.value.some((c) => c.component === transformToken);
    if (!hasTransform) {
      cdRes.value.push({ component: transformToken, data: {} as never });
    }
  }
  if (cdRes.value.length === 0) {
    // Mount has no components AND Transform is unregistered (rare unit-
    // test path). Fall back to the placeholder ChildOf so the spawn has
    // a real archetype. Step 5 overwrites this placeholder.
    const childOfToken = resolveComponent('ChildOf');
    if (childOfToken === undefined) {
      return err(new ComponentNotDefinedError('ChildOf'));
    }
    cdRes.value.push({
      component: childOfToken,
      data: { parent: ENTITY_NULL_RAW } as never,
    });
  }
  return (world.spawn as (...c: ComponentData[]) => Result<EntityHandle, EcsError>)(...cdRes.value);
}
/** @internal Resolve mount.source through the wired SceneAssetResolver. */
export function worldResolveMountSource(
  world: World,
  source: number | string,
  parentHandle: Handle<'SceneAsset', 'shared'>,
): Result<Handle<'SceneAsset', 'shared'>, EcsError> {
  const resolver = worldGetSceneAssetResolver(world);
  if (resolver === null) {
    return err({
      code: 'stale-entity' as const,
      expected: 'wired SceneAssetResolver (auto-wired by engine.assets.instantiate)',
      hint:
        'engine.assets.instantiate sugar wires this for you; ' +
        'unit tests can call world._setSceneAssetResolver (@internal) directly.',
      detail: { entity: 0, slot: 0, generation: 0 },
    } as unknown as EcsError);
  }
  const r = resolver(source, parentHandle);
  if (!r.ok) {
    // Resolver carries `unknown` err (loose contract — engine-runtime may
    // wire any shape); narrow back to EcsError here at the boundary.
    return err(r.error as EcsError);
  }
  return ok(r.value);
}
/** @internal Convert mount.overrides Map shape to the SceneInstanceState shape.
 *
 * feat-20260713 M1 / w4: `field` is optional (add-or-patch discriminant). In
 * M1 only the field-patch form reaches this builder (the component-add form
 * fails fast in the apply loops); the record type stays `field?: string` so
 * the M2 add path can flow through untouched. `exactOptionalPropertyTypes`
 * forbids writing an explicit `field: undefined`, so omit the key when absent.
 */
export function worldMountOverridesToStateMap(
  src: Map<LocalEntityId, Map<string, MountOverride>>,
): Map<LocalEntityId, Map<string, { comp: string; field?: string; value: unknown }>> {
  const out = new Map<
    LocalEntityId,
    Map<string, { comp: string; field?: string; value: unknown }>
  >();
  for (const [lid, fields] of src) {
    const m = new Map<string, { comp: string; field?: string; value: unknown }>();
    for (const [k, v] of fields) {
      m.set(k, {
        comp: v.comp,
        value: v.value,
        ...(v.field !== undefined ? { field: v.field } : {}),
      });
    }
    out.set(lid, m);
  }
  return out;
}
/** @internal Set the payload of an already-allocated SceneInstance state ref. */
export function worldSetUniqueRefPayload<T>(
  world: World,
  handle: Handle<string, 'unique'>,
  payload: T,
): void {
  sceneWorldState(world).uniqueRefs._setPayload(handle, payload);
}

/**
 * @internal Resolve the SceneInstanceState payload behind the
 * `SceneInstance.state` ref column on `root`. Returns Err when `root`
 * does not carry SceneInstance or the ref slot is dead.
 */
export function worldResolveSceneInstanceStatePayload(
  world: World,
  root: EntityHandle,
): Result<SceneInstanceStatePayload, EcsError> {
  const sceneInstanceToken = resolveComponent('SceneInstance');
  if (sceneInstanceToken === undefined) {
    return err(new ComponentNotDefinedError('SceneInstance'));
  }
  const r = world.get(root, sceneInstanceToken);
  if (!r.ok) return r;
  const stateRefRaw = (r.value as unknown as { state: number }).state;
  const stateRefHandle = toUnique<'SceneInstanceState'>(stateRefRaw);
  const payloadRes = sceneWorldState(world).uniqueRefs.resolve(stateRefHandle);
  if (!payloadRes.ok) {
    return err(payloadRes.error as unknown as EcsError);
  }
  return ok(payloadRes.value as SceneInstanceStatePayload);
}
/**
 * Public sugar — get the SceneInstanceState payload (Map / Set view) for
 * `root`. Equivalent to `world.get(root, SceneInstance)` followed by a
 * managed-ref resolution; provided so AI users do not have to learn the
 * `ref<T>` slot resolution mechanic for the common read path.
 */
export function worldGetSceneInstanceState(
  world: World,
  root: EntityHandle,
): Result<SceneInstanceStatePayload, EcsError> {
  return worldResolveSceneInstanceStatePayload(world, root);
}
/**
 * Despawn a SceneInstance root + all its members. `opts.keepDetached`
 * preserves members marked via `world.detachSceneMember` (plan-strategy
 * §D-5). Returns the count of entities actually despawned (root + each
 * non-detached member).
 *
 * For a plain entity (no SceneInstance), behaviour matches
 * `world.despawn(entity)` followed by `despawnDescendants(entity)` — i.e.
 * `keepDetached` is a no-op.
 */
export function worldDespawnScene(
  world: World,
  root: EntityHandle,
  opts?: { keepDetached?: boolean },
): Result<number, EcsError> {
  const dRes = worldDespawnDescendants(world, root, opts);
  if (!dRes.ok) return dRes;
  const drop = world.despawn(root);
  if (!drop.ok) return drop;
  return ok(dRes.value + 1);
}
/**
 * Despawn every descendant of `root` reachable through Children mirror /
 * SceneInstance.mapping. `opts.keepDetached` is honoured only when `root`
 * carries a SceneInstance (otherwise the option is ignored — there is no
 * detached set on a plain entity).
 *
 * Returns the count of entities despawned. The `root` itself is NOT
 * despawned (that is `despawnScene`'s extra step).
 */
export function worldDespawnDescendants(
  world: World,
  root: EntityHandle,
  opts?: { keepDetached?: boolean },
): Result<number, EcsError> {
  let detached: Set<LocalEntityId> | null = null;
  let entityToLocalId: Map<EntityHandle, LocalEntityId> | null = null;
  if (opts?.keepDetached === true) {
    const stateRes = worldResolveSceneInstanceStatePayload(world, root);
    if (stateRes.ok) {
      detached = stateRes.value.detachedLocalIds;
      entityToLocalId = stateRes.value.entityToLocalId;
    }
  }
  let count = 0;
  // Collect descendants first (DFS via iterDescendants) to avoid mutating
  // while iterating.
  const list: EntityHandle[] = [];
  for (const e of world.iterDescendants(root)) list.push(e);
  const childOfToken = resolveComponent('ChildOf');
  for (const e of list) {
    if (detached !== null) {
      const lid = entityToLocalId?.get(e);
      if (lid !== undefined && detached.has(lid)) {
        if (childOfToken !== undefined) {
          world._removeComponentCore(e, childOfToken, false);
        }
        continue;
      }
    }
    const r = world.despawn(e);
    if (!r.ok) return r;
    count += 1;
  }
  return ok(count);
}
/**
 * Write a runtime override to a member entity belonging to `root`. Routes
 * through `world.set(member, comp, { [field]: value })` after an entity-
 * scope guard so cross-instance writes fail-fast. Type-mismatch surfaces
 * `EcsErrorCode = 'scene-override-type-mismatch'` (D-9).
 */
export function worldSetSceneOverride<S extends ComponentSchema>(
  world: World,
  root: EntityHandle,
  member: EntityHandle,
  component: Component<string, S>,
  field: keyof ShapeOf<S> & string,
  value: unknown,
): Result<void, EcsError> {
  const stateRes = worldResolveSceneInstanceStatePayload(world, root);
  if (!stateRes.ok) return stateRes;
  const state = stateRes.value;
  const lid = state.entityToLocalId.get(member);
  if (lid === undefined) {
    return err(
      new StaleEntityError(
        member as unknown as number,
        entityIndex(member),
        entityGeneration(member),
        {
          operation: 'setSceneOverride',
          component: component.name,
          expectedGeneration: entityGeneration(member),
          actualGeneration: entityGeneration(member),
        },
      ),
    );
  }
  // Type guard: only check primitive scalar field types where we can
  // narrow `typeof`; ref / handle / entity / array / buffer fields skip
  // (write would surface a deeper error from set).
  const schemaType = (component.schema as Record<string, string>)[field];
  if (schemaType !== undefined && isPrimitiveScalarFieldType(schemaType)) {
    const expectJsType = primitiveJsType(schemaType);
    const actualJsType = typeof value;
    if (expectJsType !== actualJsType) {
      return err({
        code: 'scene-override-type-mismatch' as const,
        expected: `value typeof === ${expectJsType}`,
        hint:
          `setSceneOverride(${component.name}.${field}) expected ${expectJsType}, ` +
          `got ${actualJsType}; coerce or pick a different override path.`,
        detail: {
          code: 'scene-override-type-mismatch' as const,
          comp: component.name,
          field: field as string,
          expectedType: schemaType,
          actualType: actualJsType,
        },
      } as unknown as EcsError);
    }
  }
  const setRes = world.set(member, component, { [field]: value } as Partial<InputShapeOf<S>>);
  if (!setRes.ok) return setRes;
  // Record into state.overrides
  let fieldMap = state.overrides.get(lid);
  if (fieldMap === undefined) {
    fieldMap = new Map();
    state.overrides.set(lid, fieldMap);
  }
  fieldMap.set(`${component.name}:${field}`, {
    comp: component.name,
    field: field as string,
    value,
  });
  return ok(undefined);
}
/**
 * Drop a runtime override (and any mount-time override for the same
 * (member, comp, field) triple); roll the live column value back to the
 * source SceneAsset's layer-1 explicit value (M2 v1 — M3+ widens to layer
 * 2/3 defaults via fillComponentDefaults).
 */
export function worldRemoveSceneOverride<S extends ComponentSchema>(
  world: World,
  root: EntityHandle,
  member: EntityHandle,
  component: Component<string, S>,
  field: keyof ShapeOf<S> & string,
): Result<void, EcsError> {
  const stateRes = worldResolveSceneInstanceStatePayload(world, root);
  if (!stateRes.ok) return stateRes;
  const state = stateRes.value;
  const lid = state.entityToLocalId.get(member);
  if (lid === undefined) return ok(undefined);
  const fieldMap = state.overrides.get(lid);
  if (fieldMap !== undefined) {
    fieldMap.delete(`${component.name}:${field}`);
    if (fieldMap.size === 0) state.overrides.delete(lid);
  }
  // Look up the source SceneAsset layer-1 value.
  const assetRes = worldResolveSceneAsset(world, state.source);
  if (!assetRes.ok) return assetRes;
  const node = assetRes.value.entities.find(
    (n) => (n.localId as unknown as number) === (lid as unknown as number),
  );
  const layer1 = node?.components[component.name] as Record<string, unknown> | undefined;
  if (layer1 !== undefined && field in layer1) {
    const r = world.set(member, component, { [field]: layer1[field] } as Partial<InputShapeOf<S>>);
    if (!r.ok) return r;
  }
  return ok(undefined);
}
/** Mark a member entity detached. Idempotent (set semantics). */
export function worldDetachSceneMember(
  world: World,
  root: EntityHandle,
  member: EntityHandle,
): Result<void, EcsError> {
  const sceneInstanceToken = resolveComponent('SceneInstance');
  if (sceneInstanceToken === undefined) {
    return err(new ComponentNotDefinedError('SceneInstance'));
  }
  const stateRes = worldResolveSceneInstanceStatePayload(world, root);
  if (!stateRes.ok) return stateRes;
  const state = stateRes.value;
  const lid = state.entityToLocalId.get(member);
  if (lid === undefined) return ok(undefined);
  state.detachedLocalIds.add(lid);
  return ok(undefined);
}
/** Clear a detached mark. Idempotent (set semantics). */
export function worldReattachSceneMember(
  world: World,
  root: EntityHandle,
  member: EntityHandle,
): Result<void, EcsError> {
  const stateRes = worldResolveSceneInstanceStatePayload(world, root);
  if (!stateRes.ok) return stateRes;
  const state = stateRes.value;
  const lid = state.entityToLocalId.get(member);
  if (lid === undefined) return ok(undefined);
  state.detachedLocalIds.delete(lid);
  return ok(undefined);
}
/**
 * Get the SceneAsset handle a SceneInstance root was instantiated from.
 * Returns Err on a plain entity (no SceneInstance component).
 */
export function worldGetSceneAssetForInstance(
  world: World,
  root: EntityHandle,
): Result<Handle<'SceneAsset', 'shared'>, EcsError> {
  const stateRes = worldResolveSceneInstanceStatePayload(world, root);
  if (!stateRes.ok) return stateRes;
  return ok(stateRes.value.source);
}

// SceneInstanceStatePayload — internal echo of the runtime
// `SceneInstanceState` interface for ECS-side consumption (engine-ecs cannot
// value-import engine-runtime by AC-29; structural shape only).
// ────────────────────────────────────────────────────────────────────────────

/** @internal Structural payload behind `SceneInstance.state` ref column. */
export interface SceneInstanceStatePayload {
  readonly source: Handle<'SceneAsset', 'shared'>;
  readonly entityToLocalId: Map<EntityHandle, LocalEntityId>;
  readonly detachedLocalIds: Set<LocalEntityId>;
  readonly overrides: Map<
    LocalEntityId,
    Map<string, { readonly comp: string; readonly field?: string; readonly value: unknown }>
  >;
  readonly rootEntities: EntityHandle[];
  readonly totalSlots: number;
  readonly mountTimeOverrides: readonly MountOverride[];
}

/**
 * Topological sort over the implicit ChildOf graph (parents before children).
 * Cycle-free input always covers all n nodes; cyclic input emits whatever was
 * reachable from indegree-0 (the fallback caller handles cycle reporting via
 * `pack-cyclic-reference` at the upstream scanner / runtime path).
 */
function sceneTopoSort(
  nodes: readonly import('@forgeax/engine-types').SceneEntity[],
): readonly number[] {
  const n = nodes.length;
  const childrenOf: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Uint32Array(n);
  const localIdToIdx = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    localIdToIdx.set(node.localId as unknown as number, i);
  }
  for (let i = 0; i < n; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    const child = node.components.ChildOf;
    if (child === undefined) continue;
    const p = (child as Record<string, unknown>).parent;
    if (typeof p === 'number') {
      const parentIdx = localIdToIdx.get(p);
      if (parentIdx !== undefined && parentIdx !== i) {
        childrenOf[parentIdx]?.push(i);
        indeg[i] = (indeg[i] ?? 0) + 1;
      }
    }
  }
  const order: number[] = [];
  const queue: number[] = [];
  for (let i = 0; i < n; i += 1) if ((indeg[i] ?? 0) === 0) queue.push(i);
  while (queue.length > 0) {
    const head = queue.shift();
    if (head === undefined) break;
    order.push(head);
    for (const c of childrenOf[head] ?? []) {
      indeg[c] = (indeg[c] ?? 0) - 1;
      if ((indeg[c] ?? 0) === 0) queue.push(c);
    }
  }
  // Append any nodes left unvisited (defensive — cycle would surface here).
  for (let i = 0; i < n; i += 1) {
    if (!order.includes(i) && nodes[i] !== undefined) order.push(i);
  }
  return order;
}

/**
 * @internal feat-20260713 M2 / w8: SceneInstanceState map key for a
 * MountOverride. Field-patch form keys by `comp:field` (one entry per patched
 * field); component-add form keys by `comp` (one entry per added component). The
 * two key shapes cannot collide because a field-patch always carries a `:field`
 * suffix. Later array entries for the same key overwrite earlier ones, matching
 * the array-order apply semantics.
 */
function mountOverrideStateKey(ov: MountOverride): string {
  return ov.field !== undefined ? `${ov.comp}:${ov.field}` : ov.comp;
}

/** Schema field types that are JS primitives (typeof checkable). */
function isPrimitiveScalarFieldType(fieldType: string): boolean {
  if (
    fieldType === 'f32' ||
    fieldType === 'f64' ||
    fieldType === 'u32' ||
    fieldType === 'i32' ||
    fieldType === 'u8' ||
    fieldType === 'i8' ||
    fieldType === 'u16' ||
    fieldType === 'i16' ||
    fieldType === 'bool' ||
    fieldType === 'string'
  ) {
    return true;
  }
  if (fieldType.startsWith('enum<')) return true;
  return false;
}

/** Map a primitive scalar field type to the runtime `typeof` it should narrow to. */
function primitiveJsType(fieldType: string): string {
  if (fieldType === 'bool') return 'boolean';
  if (fieldType === 'string') return 'string';
  return 'number';
}
