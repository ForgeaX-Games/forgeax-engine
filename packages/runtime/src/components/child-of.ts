// @forgeax/engine-runtime - ChildOf (hierarchy back-reference; Bevy-aligned).
//
// Schema (M5 / w18): `{ parent: 'entity' }`.
// Migrated from `'ref'` (raw u32 column) to the schema-vocab `'entity'`
// keyword. The on-disk column is a Uint32Array carrying the encoded Entity
// (24-bit index + 8-bit generation). The ECS does not validate the stored
// u32 against the live record on read; `world.get(child, ChildOf)` returns
// the raw encoded Entity and consumers check liveness themselves (via
// `world.get(parent, Entity)` — returns `err(stale-entity)` for despawned handles).
//
// feat-20260531-ecs-relationship-abstraction-bidirectional-sync M4 / t20:
// ChildOf is declared as the holder side of a Bevy-style bidirectional
// relationship via the `relationship` metadata block (one-cut breaking
// migration, AGENTS.md Change stance - no v1/v2 dual-path, component name +
// schema shape + holder-perspective naming all unchanged). The engine
// auto-maintains the reverse `Children.entities` list on the parent entity at
// `world.addComponent` / `world.removeComponent` / `world.despawn` time
// (M2 bidirectional-sync hook), retiring the old OOS-10 "AI user keeps the two
// sides consistent themselves" contract.
//   - mirror: 'Children'  -- the reverse-list component name (string, not a
//     type reference, so engine-ecs never imports the runtime ChildOf/Children
//     types; AC-29). Resolved at defineComponent time via resolveComponent.
//   - field: 'entities'   -- the `array<entity>` field on Children holding the
//     reverse list. Validated to be exactly `'array<entity>'` at defineComponent time.
//   - exclusive: true     -- re-adding ChildOf with a new parent auto-reparents
//     (prunes the old parent's Children entry, appends to the new) instead of
//     returning ComponentAlreadyPresentError (single-parent hierarchy, AC-12).
//   - linkedSpawn: true   -- despawning the parent cascade-despawns all
//     child entities that hold this ChildOf (AC-08; the human gate flipped
//     the D-1 default from false to true). When linkedSpawn is set to true,
//     world.despawn(parent) recursively despawns the entire subtree.
//
//     The prior default (linkedSpawn: false) meant despawning the parent only
//     pruned the Children entry, leaving the child entity alive. That behavior
//     is still available by passing linkedSpawn: false explicitly.
//
// Child despawn auto-detaches from the parent's Children list: the
// relationship `onRemove` hook fires on `world.despawn(child)` and prunes the
// child from the parent's `Children.entities` (a write-path hook). Despawning
// the PARENT does not auto-clean the child's ChildOf: the child's `parent`
// column keeps the stale encoded Entity. The ECS does not bottom out dangling
// references on read; the consumer is responsible for cleanup
// (`world.removeComponent(child, ChildOf)` / `world.get(parent, Entity)` liveness check).
//
// propagateTransforms system (./systems/propagate-transforms.ts) consumes
// this component by reading the archetype Uint32Array column directly
// (engine-internal `_getGraph()` access). When a parent has been despawned
// but the child's stale ChildOf is left in place, the live-map lookup surfaces
// `RhiError({ code: 'hierarchy-broken' })` - a deliberate per-frame fail-fast
// (the consumer is expected to despawn the subtree or remove the stale
// ChildOf), kept as the explicit-failure surface (charter proposition 4).
//
// charter mapping: proposition 2 (industry analogy: Bevy ChildOf is the
// post-0.15 rename of Parent for the same shape as glTF node parent index
// + Three.js Object3D.parent) + proposition 4 (explicit failure: dangling
// parent surfaces structured RhiError) + proposition 5
// (consistent abstraction: the schema-vocab 'entity' keyword is the SSOT
// for entity-typed columns across the engine).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Hierarchy back-reference: pointer from child entity to its parent.
 *
 * Store the parent `Entity` handle (returned by `world.spawn(...).unwrap()`)
 * in the `parent` field; `propagateTransforms` reads it each frame to
 * compose the child's derived `Transform.world` mat4 (child.world =
 * parent.world x child local). Despawning a child auto-detaches it from the
 * parent's Children list (relationship `onRemove` hook). Despawning the
 * parent does not auto-clean the child's ChildOf; the consumer removes the
 * stale ChildOf (`world.removeComponent`) or checks `world.get(parent, Entity)` for liveness.
 *
 * Because ChildOf declares a `relationship` mirror, the engine keeps the
 * parent's `Children.entities` reverse list consistent automatically: adding
 * ChildOf appends the child to the parent's Children, removing it (or
 * reparenting via the `exclusive` arm) prunes the stale entry. AI users no
 * longer hand-maintain both sides (the prior OOS-10 contract is retired).
 * Reparenting is a plain re-add: `world.addComponent(child, { component:
 * ChildOf, data: { parent: newParent } })` on an entity that already carries
 * ChildOf auto-reparents (exclusive arm), or use `world.reparent(child,
 * newParent)`.
 *
 * @example Spawn a child entity referencing an already-spawned root:
 *   const root = world.spawn({ component: Transform, data: {...} }).unwrap();
 *   const child = world.spawn(
 *     { component: Transform, data: {...} },
 *     { component: ChildOf, data: { parent: root } },
 *   ).unwrap();
 *   // root now carries Children with [child] in its `entities` list.
 */
export const ChildOf = defineComponent(
  'ChildOf',
  { parent: { type: 'entity' } },
  {
    relationship: {
      mirror: 'Children',
      field: 'entities',
      exclusive: true,
      linkedSpawn: true,
    },
  },
);
