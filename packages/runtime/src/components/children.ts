// @forgeax/engine-runtime - Children (forward-list of child entities).
//
// Schema: 1 array<entity> field `entities` (variable-length, ECS-managed via
// the BufferPool slot column + sidecar count column allocated by the ECS M2
// `world.push` / `world.pop` / `world.capacity` command surface).
//
// feat-20260515-buffer-array-vocab-collapse M3 / w17:
// the legacy `VarArrayView<Entity>` value-shape wrapper was retired in
// favour of a direct `TypedArray` snapshot returned by `world.get` plus the
// three `world` commands. AI users mutate the list through:
//
//   world.push(parent, Children, 'entities', child).unwrap();
//   world.pop(parent, Children, 'entities').unwrap();
//   world.capacity(parent, Children, 'entities').unwrap();
//
// And read through the read-only `Uint32Array` snapshot:
//
//   const snap = world.get(parent, Children).unwrap().entities;
//   const liveCount = snap.length;
//   for (let i = 0; i < liveCount; i++) { const child = snap[i]; ... }
//
// Snapshot length equals the live element count (sidecar count column owned
// by the ECS layer); the snapshot is rematerialised on every `world.get`
// (D-4 no-cache); writes routed through the snapshot are undefined behaviour
// (the contract is read-only, plan-strategy §2.2 D-R3).
//
// feat-20260531-ecs-relationship-abstraction-bidirectional-sync M4 / t20:
// Children is the MIRROR side of the ChildOf relationship. Its schema is
// unchanged (the `entities: 'array<entity>'` shape is exactly what the
// relationship mirror contract requires), but the engine now maintains this
// list automatically whenever ChildOf is added / removed / reparented on a
// child entity (M2 bidirectional-sync hook on ChildOf). The prior OOS-10
// "AI users keep the two sides consistent themselves" contract is retired:
// `world.addComponent(child, ChildOf{parent})` appends `child` to
// `parent.Children.entities`, `world.removeComponent` / reparent prunes it.
// AI users still MAY push/pop the list manually (the three `world` commands
// below remain valid for non-ChildOf forward-lists), but for the ChildOf
// hierarchy the engine owns consistency.
//
// feat-20260514-ecs-children-instances-managed-buffer-array M3 / w13 (kept
// for context): migrated from the legacy `{ count: 'u32' }` advisory marker
// to the real variable-length entity-array storage path.
//   - OOS-09 (prior loop): no `addChild` / `removeChild` / `removeChildren`
//     Commands API. Retired this feat: `world.addChild` / `world.removeChild`
//     / `world.reparent` ship in M3, plus the relationship hook above.
//   - OOS-01 (prior loop): no dangling-entity sweep on `array<entity>`. If a
//     child entity has been despawned, the stored u32 still occupies the
//     slot; AI users explicitly call the engine's entity-liveness check
//     before consuming a child id (see `world.get(child, ChildOf)` returns
//     `Result.err(...)` for a despawned entity --- the stored u32 surfaces
//     as a dead handle, not a silent zero). Charter proposition 4
//     (explicit failure): the engine does not silently drop dangling
//     entries.
//
// charter mapping: proposition 2 (Bevy ChildOf+Children pair, holder
// perspective) + proposition 3 (machine-readable schema:
// `Children.schema.entities === 'array<entity>'`) + proposition 4 (explicit
// failure: dangling entries surface to the AI user via `world.get(parent, Entity)` liveness probe,
// not silent drop) + proposition 5 (consistent abstraction: Children is the
// generic relationship-mirror shape, not a ChildOf special case).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Hierarchy forward-list of child entities.
 *
 * `entities` is a variable-length `array<entity>` field; each element is
 * an `Entity` u32 the AI user pushed via
 * `world.push(parent, Children, 'entities', child)`. The value returned by
 * `world.get(parent, Children).unwrap().entities` is a read-only
 * `Uint32Array` snapshot rematerialised fresh on every read (D-4 no-cache);
 * the snapshot's `length` equals the live element count.
 *
 * Invariants:
 *   - Children is NOT consumed by `propagateTransforms` (which walks ChildOf
 *     upward, D-P2). The forward list is for AI-user traversal / debug /
 *     inspection.
 *   - Children <-> ChildOf consistency is maintained by the engine via the
 *     ChildOf `relationship` mirror hook (see ./child-of.ts): adding /
 *     removing / reparenting ChildOf on a child auto-updates the parent's
 *     `entities` list. AI users do not hand-sync the two sides for the
 *     hierarchy.
 *   - Stored entity u32s are NOT auto-cleared when the referenced entity is
 *     despawned (OOS-01 above); a `world.get(despawnedChild, ...)` call
 *     returns `Result.err(...)` so AI users discover the dangling state
 *     through the engine's structured-error channel.
 *
 * @example Spawn a parent and two children via ChildOf (engine maintains Children):
 *   const parent = world.spawn({ component: Transform, data: identityXf() }).unwrap();
 *   const a = world.spawn(
 *     { component: Transform, data: identityXf() },
 *     { component: ChildOf, data: { parent } },
 *   ).unwrap();
 *   const b = world.spawn(
 *     { component: Transform, data: identityXf() },
 *     { component: ChildOf, data: { parent } },
 *   ).unwrap();
 *   // Read back via the read-only snapshot - engine appended a, b:
 *   const snap = world.get(parent, Children).unwrap().entities;
 *   for (let i = 0; i < snap.length; i++) {
 *     const child = snap[i];
 *     // ... consume; world.get(child, ...) surfaces a structured error
 *     // if the child has been despawned (OOS-01 dangling-entity surface).
 *   }
 */
export const Children = defineComponent(
  'Children',
  {
    entities: { type: 'array<entity>' },
  },
  { transient: true },
);
