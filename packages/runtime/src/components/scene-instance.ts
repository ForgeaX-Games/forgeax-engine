// @forgeax/engine-runtime - SceneInstance component (feat-20260608-
// scene-nesting-ecs-fication M2 / w16).
//
// Single ECS fat component carrying everything that used to live on the
// old `SceneInstance` + `SceneInstanceContainer` pair (deleted
// in M3). Schema fits the ECS schema vocab (3 single-identifier fields):
//
//   { source:  'shared<SceneAsset>',
//     mapping: 'array<entity>',
//     state:   'unique<SceneInstanceState>' }
//
// `source` carries the SceneAsset handle the synthetic root entity was
// instantiated from (Tier-A AssetUnion handle, AGENTS.md §Assets submodule).
// `mapping` is the LocalEntityId -> Entity table indexed positionally
// (mapping[localId] = spawned Entity); the ECS variable-array column gives
// us a SoA-friendly read path for query<SceneInstance> scans without
// touching the dynamic Map/Set state.
// `state` is a `ref<SceneInstanceState>` slot — World holds the live
// SceneInstanceState payload in its UniqueRefStore and World despawn
// auto-releases the ref u32 (the same path used by audio / physics
// payloads, plan-strategy §D-2). Each instantiateScene call calls
// `world.allocUniqueRef('SceneInstanceState', state)` once and stores the
// returned u32 in this column.
//
// Decision anchors:
//   - plan-strategy §D-2 (single ref wraps SceneInstanceState dynamic
//     structure; ECS schema vocab `\w+` rejects `ref<Map<...>>`)
//   - plan-strategy §3.2 sequence (sequence diagram step 'set ... state:
//     {entityToLocalId, detached, overrides, rootEntities}')
//   - AGENTS.md §Component naming rule #1 (single-semantic component drops
//     `Component` suffix)
//   - charter F1 (single-import barrel: SceneInstance lives in
//     `@forgeax/engine-runtime` next to Transform / Camera / DirectionalLight)
//   - charter P3 (machine-readable schema: 3 closed fields)
//   - charter P4 (consistent abstraction: instance == entity carrying
//     SceneInstance — same `world.queryRun([SceneInstance], ...)` /
//     `world.get(root, SceneInstance)` path as any other component)

import { defineComponent, type EntityHandle } from '@forgeax/engine-ecs';
import type { LocalEntityId, MountOverride } from '@forgeax/engine-types';

/**
 * Per-component, per-field override record carried in `SceneInstanceState`.
 *
 * Composite key `<componentName>:<fieldName>` keeps the override map flat
 * (single Map nesting level) so AI users walking `state.overrides` see one
 * iteration depth — D-2 prefers a single SSOT over multi-Map nesting that
 * would make iteration order ambiguous (charter F1: single mental model).
 *
 * The value is `unknown` because the per-component schema vocab lives in the
 * ECS layer; runtime fail-fast via `EcsErrorCode = 'scene-override-type-
 * mismatch'` (plan-strategy §D-9) catches type drift on the apply path.
 *
 * @internal Surface from `state.overrides` only; AI users never construct a
 *   record directly. Use `world.setSceneOverride(root, member, comp,
 *   field, value)` to write and `world.removeSceneOverride(root, member,
 *   comp, field)` to roll back to the source SceneAsset value.
 */
export interface SceneInstanceOverrideRecord {
  readonly comp: string;
  readonly field: string;
  readonly value: unknown;
}

/**
 * Dynamic state payload for one SceneInstance — held in the World's
 * UniqueRefStore behind a `ref<SceneInstanceState>` slot on the synthetic
 * root entity. Mirrors the old class-based layout (plan-strategy §D-2 +
 * design doc §11.2 internal-state-table) but flattened into plain JS Maps/Sets so
 * AI users can iterate without indirection.
 *
 * Lifecycle:
 *   - allocated by `world.instantiateScene(handle, parent?)` — the W in
 *     `world.allocUniqueRef('SceneInstanceState', state)` returns the u32
 *     slot id stored in the SceneInstance.state column;
 *   - released by `world.despawn(root)` (the standard `ref<T>` release loop)
 *     or explicitly via `world.despawnScene(root)` / `world.despawnDescendants(root)`.
 *
 * AI users typically reach this struct only through the read path
 * `world.get(root, SceneInstance).state.overrides.get(<comp>:<field>)` for
 * inspection; mutation happens through the 8 World methods.
 */
export interface SceneInstanceState {
  /**
   * SceneAsset handle the instance was instantiated from. Mirrors the
   * SceneInstance.source column for AI users who already have a
   * SceneInstanceState in hand and want the source handle without a second
   * `world.get` round-trip.
   */
  readonly source: import('@forgeax/engine-types').Handle<'SceneAsset', 'shared'>;

  /**
   * Reverse mapping (live `Entity` -> source `LocalEntityId`). Used by
   * `world.setSceneOverride` to validate the member entity belongs to this
   * instance + by `world.detachSceneMember` / `world.reattachSceneMember`
   * to translate caller-side Entity values back to their authored localId.
   */
  readonly entityToLocalId: Map<EntityHandle, LocalEntityId>;

  /**
   * LocalEntityIds of members the AI user marked detached via
   * `world.detachSceneMember(root, member)`. The member entities stay
   * alive in the World; only the bookkeeping marker moves so
   * `world.despawnDescendants(root, { keepDetached: true })` can skip them.
   * Detach is idempotent (set semantics).
   */
  readonly detachedLocalIds: Set<LocalEntityId>;

  /**
   * Per-member runtime overrides keyed by `<localId>` -> `<comp>:<field>`
   * -> override record. mount-time overrides (authored on the SceneAsset's
   * `mounts[].overrides`) populate this map at instantiate-time so AI
   * users see them via the same read path as runtime
   * `setSceneOverride` writes (single SSOT).
   */
  readonly overrides: Map<LocalEntityId, Map<string, SceneInstanceOverrideRecord>>;

  /**
   * Top-level root entities of the materialised tree (members without a
   * ChildOf parent at instantiate time). The synthetic root entity that
   * carries the SceneInstance component itself is NOT in this list — it is
   * the parent of every member entity (plan-strategy §3.2 sequence step 7).
   */
  readonly rootEntities: EntityHandle[];

  /**
   * Total slot count `entities.length + sum(mounts[].memberCount)` —
   * captured at instantiate-time so cycle / count consistency checks
   * (e.g. `world.getSceneAssetForInstance(root)` symmetry) can compare
   * against the live SceneInstance.mapping column without re-reading the
   * SceneAsset.
   */
  readonly totalSlots: number;

  /**
   * Mount-time override authored on the parent SceneAsset's `mounts[]`
   * record. Captured at instantiate-time so `world.removeSceneOverride`
   * can fall back to the mount-time value before going to the source
   * SceneAsset value (plan-strategy §D-2).
   */
  readonly mountTimeOverrides: readonly MountOverride[];
}

/**
 * SceneInstance ECS component — synthetic root entity payload for one
 * materialised SceneAsset (instance == entity carrying SceneInstance,
 * charter P4).
 *
 * AI users discover the component via IDE autocomplete on
 * `@forgeax/engine-runtime` (single-import barrel; AGENTS.md §Components):
 *
 * ```ts
 * import { SceneInstance } from '@forgeax/engine-runtime';
 * world.queryRun([SceneInstance], (entity, instance) => {
 *   console.log(`root=${entity} source=${instance.source}`);
 * });
 *
 * const inst = world.get(root, SceneInstance).value;
 * const memberEntity = inst.mapping[localId]; // Uint32Array snapshot
 * for (const detached of inst.state.detachedLocalIds) { /* ... *\/ }
 * ```
 *
 * The component does not register a relationship — synthetic root +
 * members are wired through the standard `ChildOf` (member -> root) so
 * the existing `world.iterDescendants(root)` / Children mirror code paths
 * apply unchanged (plan-strategy §D-5).
 *
 * @example Materialise + inspect a SceneAsset:
 *   const root = world.instantiateScene(handle).value;
 *   const inst = world.get(root, SceneInstance).value;
 *   // inst.source === handle, inst.mapping is Uint32Array(totalSlots)
 *   // inst.state holds entityToLocalId / detachedLocalIds / overrides /
 *   // rootEntities / totalSlots / mountTimeOverrides.
 */
export const SceneInstance = defineComponent('SceneInstance', {
  source: { type: 'shared<SceneAsset>' },
  mapping: { type: 'array<entity>' },
  state: { type: 'unique<SceneInstanceState>' },
});
