// @forgeax/engine-runtime - propagateTransforms system (root-down world mat4 derivation).
//
// Triggered by `registerPropagateTransforms(world)` which binds the system
// into the ECS schedule with `before: [<RenderSystem-shaped system name>]`
// ordering, i.e. the 'pre-render' slot (plan-strategy §D-P2 + requirements
// §AC-04 / §AC-12). Derives every entity's resolved `Transform.world` mat4
// (column-major array<f32, 16>) from the chain:
//
//   root   (Without<ChildOf>): world = compose(local.TRS)
//   child  (With<ChildOf>):    world = parent.world x compose(local.TRS)
//   stale ChildOf ref:         Result.err(RhiError({ code: 'hierarchy-broken' }))
//
// The kernel composes the local TRS scalar columns into a mat4 and writes the
// 16 contiguous floats straight into the entity's `Transform.world` slot via
// the M1 column-level zero-copy accessor (`world._getArrayView`). It never
// decomposes back to scalar columns (plan-strategy §2 D-3: compose -> multiply,
// no decompose) and never reads/writes the legacy global-transform component
// (retired in M4).
// Every entity with a Transform is processed every frame (the flat opt-out is
// gone; requirements §3): a flat entity gets `world = compose(local)` with no
// extra component registration (AC-06).
//
// The stale-ChildOf path fires when a ChildOf.parent field references an
// entity that has been despawned or never existed; architecture-principles
// #5 Fail Fast stance -- one entity's subtree is reported; other entities
// continue (charter proposition 9 graceful degradation). The error bubbles
// through the return Result; the caller (Renderer driver or test harness)
// decides whether to route through `Renderer.onError` fan-out or short-
// circuit the frame.
//
// Design notes:
//   - 'pre-render' ordering is expressed via `before: [renderSystemName]`
//     on the SystemDescriptor (the forgeax ECS DAG scheduler uses before /
//     after edges, not Bevy-style stage strings; plan-strategy §D-P2 names
//     the slot 'pre-render' as a conceptual anchor, not a literal schedule
//     key). Because RenderSystem is NOT registered in the ECS schedule
//     (`Renderer.draw(world)` invokes it directly), the registration helper
//     accepts an optional anchor system name; when omitted, the system
//     runs unconstrained and its ordering vs RenderSystem is enforced by
//     the Renderer driver (which calls `world.update()` before `draw`).
//   - Archetype iteration reads `world._getGraph()` (engine-internal access;
//     not public API). The row's full packed Entity u32 is read directly from
//     the essential id=0 `Entity` column (`arch.columns.get(Entity.id)
//     .get('self')`); the prior index-slot + generation-lookup + encodeEntity
//     rebuild is retired (feat-20260602 M2).
//   - Each entity's resolved world mat4 is read/written through
//     `world._getArrayView(entity, Transform, 'world')` -- a live Float32Array
//     aliasing the BufferPool slot bytes. Roots are processed first (Pass 1),
//     then ChildOf-bearing archetypes; within the child pass a DFS recurses
//     up the parent chain (memoised per frame via `processed`) so a parent's
//     world slot is always fresh before any child multiplies against it.
//
// charter mapping: proposition 4 (explicit-failure Result err for stale
// ChildOf) + proposition 5 (consistent abstraction: single Transform.world
// mat4 is the resolved-world SSOT; mat4.compose / mat4.multiply is the single
// derive path) + architecture-principles #2 Derive Don't Duplicate.

import {
  type Archetype,
  type Component,
  type ComponentId,
  defineSystem,
  Entity,
  type EntityHandle,
  err,
  type FieldView,
  ok,
  type Result,
  type SystemHandle,
  type World,
} from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { RhiError } from '@forgeax/engine-rhi';
import { ChildOf, Children } from '../components/index';
import { Transform } from '../components/transform';

/**
 * System name used when `registerPropagateTransforms` installs the system
 * into the ECS schedule. External consumers (tests, Renderer driver) can
 * reference this constant to declare `after: [PROPAGATE_TRANSFORMS_SYSTEM]`
 * on dependent systems.
 */
export const PROPAGATE_TRANSFORMS_SYSTEM = 'propagateTransforms' as const;

interface GraphLike {
  readonly archetypes: ReadonlyArray<Archetype | undefined>;
}

/** @internal */
interface InternalWorldSurface {
  /** @internal */
  _getGraph(): GraphLike;
  /** @internal */
  _getEntityGenerationForIndexSlot(indexSlot: number): number | undefined;
  /**
   * @internal Column-level zero-copy view of an `array<T, N>` / `buffer<N>` field.
   * Returns a `FieldView` (a TypedArray) aliasing the inline stride-N column bytes
   * (feat-20260602 inline columns). `Transform.world` is an `array<f32, 16>`, so the
   * runtime view is always a `Float32Array`; the generic `FieldView` return reflects
   * that the underlying column may store any element type without lying about the
   * source. `undefined` when the entity is dead or the column is absent.
   */
  _getArrayView(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ): FieldView | undefined;
}

/**
 * Read the full packed `Entity` handle for archetype `row` from the essential
 * id=0 `Entity` column (`self` field), present on every archetype.
 */
function readEntityAt(arch: Archetype, row: number): EntityHandle {
  const selfCol = arch.columns.get(Entity.id)?.get('self')?.view as Uint32Array | undefined;
  return (selfCol?.[row] ?? 0) as EntityHandle;
}

function asInternal(world: World): InternalWorldSurface {
  return world as unknown as InternalWorldSurface;
}

function componentPresent(arch: Archetype, id: ComponentId): boolean {
  const fieldCols = arch.columns.get(id);
  return fieldCols !== undefined && fieldCols.size > 0;
}

function getField(arch: Archetype, compId: ComponentId, fieldName: string): Float32Array {
  const fieldCols = arch.columns.get(compId);
  if (!fieldCols) {
    throw new Error(
      `[propagateTransforms] internal: component ${compId} missing on archetype ${arch.id}`,
    );
  }
  const col = fieldCols.get(fieldName);
  if (!col) {
    throw new Error(
      `[propagateTransforms] internal: field ${fieldName} missing on component ${compId}`,
    );
  }
  return col.view as Float32Array;
}

function getRefField(arch: Archetype, compId: ComponentId, fieldName: string): Uint32Array {
  const fieldCols = arch.columns.get(compId);
  if (!fieldCols) {
    throw new Error(
      `[propagateTransforms] internal: component ${compId} missing on archetype ${arch.id}`,
    );
  }
  const col = fieldCols.get(fieldName);
  if (!col) {
    throw new Error(
      `[propagateTransforms] internal: field ${fieldName} missing on component ${compId}`,
    );
  }
  return col.view as Uint32Array;
}

interface RowLocator {
  arch: Archetype;
  row: number;
  entity: EntityHandle;
  /**
   * Live view of this entity's Transform.world (16 floats). Typed as the generic
   * `FieldView` to match the widened `_getArrayView` return; at runtime it is a
   * `Float32Array` (Transform.world is `array<f32, 16>`).
   */
  worldView: FieldView;
}

/**
 * Compose an entity's local TRS scalar columns (at `row`) into `out` (mat4).
 * `out` is a `FieldView` (the live `Transform.world` view, a `Float32Array` at
 * runtime); the cast below reinterprets it as the `mat4.compose` out-param.
 */
function composeLocalInto(out: FieldView, arch: Archetype, row: number): void {
  mat4.compose(
    out as unknown as Parameters<typeof mat4.compose>[0],
    [
      getField(arch, Transform.id, 'posX')[row] as number,
      getField(arch, Transform.id, 'posY')[row] as number,
      getField(arch, Transform.id, 'posZ')[row] as number,
    ],
    [
      getField(arch, Transform.id, 'quatX')[row] as number,
      getField(arch, Transform.id, 'quatY')[row] as number,
      getField(arch, Transform.id, 'quatZ')[row] as number,
      getField(arch, Transform.id, 'quatW')[row] as number,
    ],
    [
      getField(arch, Transform.id, 'scaleX')[row] as number,
      getField(arch, Transform.id, 'scaleY')[row] as number,
      getField(arch, Transform.id, 'scaleZ')[row] as number,
    ],
  );
}

/**
 * Execute one propagateTransforms pass over the World. Derives `Transform.world`
 * (resolved world mat4) for every entity with a `Transform` (root or child)
 * per plan-strategy §2 D-3.
 *
 * @returns `Result<void, RhiError>` -- `ok(void)` when every entity's parent
 *   chain resolves; `err(RhiError({ code: 'hierarchy-broken' }))` on the
 *   first stale ChildOf ref. Partial writes up to the failure point are
 *   retained (caller decides whether to continue; charter proposition 9
 *   graceful degradation on the entity scope).
 *
 * @example Drive from a test or custom render loop:
 *   const r = propagateTransforms(world);
 *   if (!r.ok) console.error(r.error.code, r.error.hint);
 */
export function propagateTransforms(world: World): Result<void, RhiError> {
  // Keep the Children type import active (no runtime consumption).
  void Children.id;

  const internal = asInternal(world);
  const graph = internal._getGraph();

  // Collect a row locator per live entity carrying a Transform. The locator
  // pins the entity's live Transform.world view so parent lookups hit the
  // in-memory slot directly (no world.get materialisation). Building the map
  // doubles as the live-set membership check (liveMap.has(entity)).
  const liveMap = new Map<EntityHandle, RowLocator>();
  const rootArchetypes: Archetype[] = [];
  const childArchetypes: Archetype[] = [];

  for (const arch of graph.archetypes) {
    if (!arch) continue;
    if (!componentPresent(arch, Transform.id)) continue;
    const hasChildOf = componentPresent(arch, ChildOf.id);
    if (hasChildOf) childArchetypes.push(arch);
    else rootArchetypes.push(arch);

    for (let row = 0; row < arch.size; row++) {
      const entity = readEntityAt(arch, row);
      const worldView = internal._getArrayView(entity, Transform, 'world');
      if (worldView === undefined) continue; // defensive: missing world slot
      liveMap.set(entity, { arch, row, entity, worldView });
    }
  }

  // Pass 1 -- roots: world = compose(local.TRS).
  const processed = new Set<EntityHandle>();
  for (const arch of rootArchetypes) {
    for (let row = 0; row < arch.size; row++) {
      const entity = readEntityAt(arch, row);
      const loc = liveMap.get(entity);
      if (loc === undefined) continue;
      composeLocalInto(loc.worldView, arch, row);
      processed.add(entity);
    }
  }

  // Pass 2 -- children: DFS walk per entity. `processed` marks entities whose
  // Transform.world slot is already this-frame fresh (roots from Pass 1;
  // children flip on successful compose+multiply).
  const localMat = mat4.create() as unknown as Float32Array;

  for (const arch of childArchetypes) {
    const parentEntities = getRefField(arch, ChildOf.id, 'parent');
    for (let row = 0; row < arch.size; row++) {
      const selfEntity = readEntityAt(arch, row);
      const selfLoc = liveMap.get(selfEntity);
      if (selfLoc === undefined) continue;
      const r = resolveEntity(
        selfLoc,
        parentEntities[row] as EntityHandle,
        liveMap,
        processed,
        localMat,
      );
      if (!r.ok) return r;
    }
  }

  return ok(undefined);
}

/**
 * Resolve a single entity's `Transform.world` by composing its local TRS and
 * left-multiplying by the parent's resolved world mat4, recursing up the
 * parent chain to a root or a previously-processed ancestor. Memoises via the
 * `processed` set; recursion depth is bounded by hierarchy depth.
 *
 * On stale parent ref (not in `liveMap`) returns `err(RhiError({ code:
 * 'hierarchy-broken' }))`.
 */
function resolveEntity(
  selfLoc: RowLocator,
  parentEntity: EntityHandle,
  liveMap: Map<EntityHandle, RowLocator>,
  processed: Set<EntityHandle>,
  localMat: Float32Array,
): Result<void, RhiError> {
  if (processed.has(selfLoc.entity)) return ok(undefined);

  const parentLoc = liveMap.get(parentEntity);
  if (parentLoc === undefined) {
    return err(
      new RhiError({
        code: 'hierarchy-broken',
        expected: 'ChildOf component references a live entity in the world',
        hint: 'remove the stale ChildOf via world.removeComponent(entity, ChildOf) before destroying the referenced ancestor, or call engine.assets.inspect() to audit hierarchy',
      }),
    );
  }

  // Ensure the parent's world slot is fresh this frame. The parent may itself
  // be a child (depth > 1) -- recurse on its ChildOf.parent first.
  if (!processed.has(parentEntity)) {
    const parentChildOf = parentLoc.arch.columns.get(ChildOf.id);
    if (parentChildOf) {
      const parentParentCol = parentChildOf.get('parent');
      if (parentParentCol) {
        const grandParent = (parentParentCol.view as Uint32Array)[parentLoc.row] as EntityHandle;
        const r = resolveEntity(parentLoc, grandParent, liveMap, processed, localMat);
        if (!r.ok) return r;
      } else {
        // Malformed ChildOf component (missing 'parent' field).
        return err(
          new RhiError({
            code: 'hierarchy-broken',
            expected: 'ChildOf component schema carries a parent entity field',
            hint: 'check ChildOf component registration matches defineComponent("ChildOf", { parent: "entity" })',
          }),
        );
      }
    } else {
      // Parent had no ChildOf field -> should have been processed in Pass 1;
      // if not, it is a world desync (liveMap row drift). Compose its local as
      // a defensive fallback so the child still gets a sane world.
      composeLocalInto(parentLoc.worldView, parentLoc.arch, parentLoc.row);
      processed.add(parentEntity);
    }
  }

  // world(self) = parent.world x compose(self.local). Compose into a scratch
  // mat4 then multiply into the live self.worldView slot (parent and self are
  // distinct slots, so the multiply destination does not alias either source).
  composeLocalInto(localMat, selfLoc.arch, selfLoc.row);
  mat4.multiply(
    selfLoc.worldView as unknown as Parameters<typeof mat4.multiply>[0],
    parentLoc.worldView as unknown as Parameters<typeof mat4.multiply>[1],
    localMat as unknown as Parameters<typeof mat4.multiply>[2],
  );
  processed.add(selfLoc.entity);
  return ok(undefined);
}

/**
 * The `propagateTransforms` system token (M2 — full resource-ification, D-4).
 *
 * Module-level `defineSystem` with the real fn body — no closure, no
 * placeholder. The fn reads `world` from its first parameter (the M1
 * world-first signature) and delegates to {@link propagateTransforms}; the
 * returned `Result<void, RhiError>` is converted to an unwrap-style throw so
 * the ECS Layer 3 `ErrorHandler` can route the failure (world.setErrorHandler).
 *
 * Labelled `'transform'` (spec §6.2 label-anchor map).
 */
export const PropagateTransforms: SystemHandle<readonly []> = defineSystem({
  name: PROPAGATE_TRANSFORMS_SYSTEM,
  queries: [],
  labels: ['transform'],
  fn: (world) => {
    const r = propagateTransforms(world);
    if (!r.ok) {
      // Forward to the Layer 3 ErrorHandler -- this throw is intentional per
      // ECS Layer 1/3 contract (world.ts §Result propagation warning:
      // systems that need to surface err branch either unwrap or throw).
      throw r.error;
    }
  },
});

/**
 * Register `propagateTransforms` into the ECS schedule as the
 * 'pre-render' system (plan-strategy §D-P2).
 *
 * The forgeax ECS DAG scheduler orders systems via `before` / `after` edges
 * on `SystemDescriptor`. Because RenderSystem is not registered in the
 * ECS schedule (`Renderer.draw(world)` invokes it outside the schedule),
 * 'pre-render' translates here to:
 *
 *   - If `options.beforeSystemName` is provided, the system runs before
 *     that system (e.g. a user-authored 'presentation' system).
 *   - Otherwise, the system runs unconstrained; the Renderer driver
 *     ensures ordering by calling `world.update()` (which runs the
 *     schedule) before `renderer.draw(world)`.
 *
 * @example Driver registers once per World:
 *   const world = new World();
 *   registerPropagateTransforms(world);
 *   // ...spawn entities...
 *   world.update();            // propagateTransforms runs here
 *   renderer.draw(world);      // reads Transform.world column
 */
export function registerPropagateTransforms(
  world: World,
  options: { beforeSystemName?: string } = {},
): void {
  if (options.beforeSystemName !== undefined) {
    // Optional ordering edge: register a descriptor carrying the same name/fn
    // plus a `before` edge. The `before` (not `fn`) overlay keeps the real fn
    // intact (D-4: no spread-over-fn).
    world.addSystem({
      name: PROPAGATE_TRANSFORMS_SYSTEM,
      queries: [],
      labels: ['transform'],
      fn: PropagateTransforms.fn,
      before: [options.beforeSystemName],
    });
    return;
  }
  world.addSystem(PropagateTransforms);
}
