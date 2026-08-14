import { FixedUpdate, Update } from '@forgeax/engine-ecs';
// @forgeax/engine-runtime - propagateTransforms system (root-down world mat4 derivation).
//
// Triggered by `registerPropagateTransforms(world)`, which binds the owner to
// the ECS schedules. Update serves transform-dependent gameplay systems;
// World's internal terminal pipeline publishes the final result after later
// pose/gameplay writes and every ordinary schedule, before `world.update()`
// returns. Rendering only reads this state. Derives
// each affected entity's resolved `Transform.world` mat4
// (column-major array<f32, 16>) from the chain:
//
//   root   (Without<ChildOf>): world = compose(local.TRS)
//   child  (With<ChildOf>):    world = parent.world x compose(local.TRS)
//   stale ChildOf ref:         Result.err(SceneError({ code: 'hierarchy-broken' }))
//
// The kernel composes the local TRS array columns (pos / quat / scale, flat
// stride-N indexed reads) into a mat4 and writes the 16 contiguous floats
// straight into the entity's `Transform.world` slot via the M1 column-level
// zero-copy accessor (`world._getArrayView`). It never decomposes back to the
// local columns (plan-strategy §2 D-3: compose -> multiply, no decompose)
// and never reads/writes the legacy global-transform component (retired in M4).
// Structural or hierarchy changes rebuild the projection. Local Transform
// changes recompute only the edited entity and its descendants; unchanged
// entities retain their already-published world matrix.
//
// The stale-ChildOf path fires when a ChildOf.parent field references an
// entity that has been despawned or never existed; architecture-principles
// #5 Fail Fast stance -- one entity's subtree is reported; other entities
// continue (charter proposition 9 graceful degradation). The error bubbles
// through the return Result; the ECS schedule routes a thrown SceneError via
// the World error handler, while direct callers handle the Result themselves.
//
// Design notes:
//   - `beforeSystemName` orders the Update pass before a transform-dependent
//     gameplay system. World remains the final publication owner. The
//     Renderer is intentionally outside the ECS schedule and never derives
//     transforms; drivers call `world.update()` before `draw()`.
//   - Table iteration reads `world._getGraph()` (engine-internal access;
//     not public API). The row's full packed Entity u32 is read directly from
//     the essential id=0 `Entity` column (`table.storage.get(Entity.id)
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
  type Component,
  type ComponentId,
  defineSystem,
  defineSystemSet,
  Entity,
  type EntityHandle,
  err,
  type FieldView,
  ok,
  type Result,
  type SystemHandle,
  type Table,
  type World,
} from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { ChildOf } from '../components/child-of';
import { Transform } from '../components/transform';
import { SceneError } from '../errors';
import { projectHierarchy, type SceneHierarchySnapshot } from './hierarchy-projection';

/**
 * System name used when `registerPropagateTransforms` installs the system
 * into the ECS schedule. External consumers (tests, Renderer driver) can
 * reference this constant to declare `after: [PROPAGATE_TRANSFORMS_SYSTEM]`
 * on dependent systems.
 */
export const PROPAGATE_TRANSFORMS_SYSTEM = 'propagateTransforms' as const;
export const PROPAGATE_TRANSFORMS_FIXED_SYSTEM = 'propagateTransformsFixed' as const;
export const TransformSet = defineSystemSet({ name: 'transform' });
export const TransformFixedSet = defineSystemSet({ name: 'transform-fixed' });

interface GraphLike {
  readonly tables: ReadonlyArray<Table | undefined>;
}

interface InternalWorldSurface {
  /** @internal */
  _getGraph(): GraphLike;
  /** @internal */
  _getStructureEpoch(): number;
  /** @internal */
  _getComponentMutationEpoch(componentId: number): number;
  /** @internal */
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
function readEntityAt(table: Table, row: number): EntityHandle {
  const selfCol = table.storage.get(Entity.id)?.fields.get('self')?.view as Uint32Array | undefined;
  return (selfCol?.[row] ?? 0) as EntityHandle;
}

function asInternal(world: World): InternalWorldSurface {
  return world as unknown as InternalWorldSurface;
}

function componentPresent(table: Table, id: ComponentId): boolean {
  return table.storage.has(id);
}

function getField(table: Table, compId: ComponentId, fieldName: string): Float32Array {
  const fieldCols = table.storage.get(compId)?.fields;
  if (!fieldCols) {
    throw new Error(
      `[propagateTransforms] internal: component ${compId} missing on table ${table.id}`,
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

interface RowLocator {
  table: Table;
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
 * Module-scope scratch vectors reused by every `composeLocalInto` call so the
 * hot path feeds `mat4.compose` without allocating per-entity literal arrays
 * (D-3: TRS reads are flat-column indexed, zero per-call allocation; the
 * compose in-params reuse these three scratch buffers). propagateTransforms
 * is single-threaded per world update, so module-scope reuse is safe.
 */
const scratchPos = new Float32Array(3);
const scratchQuat = new Float32Array(4);
const scratchScale = new Float32Array(3);

interface PropagationCacheEntry {
  readonly childOfMutationEpoch: number;
  readonly structureEpoch: number;
  readonly transformMutationEpoch: number;
  readonly hierarchy: SceneHierarchySnapshot;
  readonly liveMap: ReadonlyMap<EntityHandle, RowLocator>;
  readonly childrenOf: ReadonlyMap<EntityHandle, readonly EntityHandle[]>;
  readonly result: Result<void, SceneError>;
}

function transformChangedEpoch(table: Table, row: number): number {
  return table.storage.get(Transform.id)?.epochs.changed[row] ?? 0;
}

function indexChildren(
  hierarchy: SceneHierarchySnapshot,
  liveMap: ReadonlyMap<EntityHandle, RowLocator>,
): ReadonlyMap<EntityHandle, readonly EntityHandle[]> {
  const children = new Map<EntityHandle, EntityHandle[]>();
  for (const entity of liveMap.keys()) {
    const parent = hierarchy.getParent(entity);
    if (parent === undefined) continue;
    const siblings = children.get(parent);
    if (siblings === undefined) children.set(parent, [entity]);
    else siblings.push(entity);
  }
  return children;
}

// Local Transform edits, ChildOf edits, and structural changes are the only
// authored invalidators. Direct writes to the derived `world` column are
// outside the Transform contract and are overwritten by this owner.
const PROPAGATION_CACHE = new WeakMap<World, PropagationCacheEntry>();

/**
 * Compose an entity's local TRS array columns (at `row`) into `out` (mat4).
 * `out` is a `FieldView` (the live `Transform.world` view, a `Float32Array` at
 * runtime); the cast below reinterprets it as the `mat4.compose` out-param.
 *
 * Reads go through the flat stride-N column views -- `pos[row*3+a]` /
 * `quat[row*4+a]` / `scale[row*3+a]` -- one indexed read per component lane,
 * zero per-call allocation (AC-08, research Finding 5 adjudication table).
 */
function composeLocalInto(out: FieldView, table: Table, row: number): void {
  const pos = getField(table, Transform.id, 'pos');
  const quat = getField(table, Transform.id, 'quat');
  const scale = getField(table, Transform.id, 'scale');
  const p = row * 3;
  const q = row * 4;
  scratchPos[0] = pos[p] as number;
  scratchPos[1] = pos[p + 1] as number;
  scratchPos[2] = pos[p + 2] as number;
  scratchQuat[0] = quat[q] as number;
  scratchQuat[1] = quat[q + 1] as number;
  scratchQuat[2] = quat[q + 2] as number;
  scratchQuat[3] = quat[q + 3] as number;
  scratchScale[0] = scale[p] as number;
  scratchScale[1] = scale[p + 1] as number;
  scratchScale[2] = scale[p + 2] as number;
  mat4.compose(
    out as unknown as Parameters<typeof mat4.compose>[0],
    scratchPos,
    scratchQuat,
    scratchScale,
  );
}

/**
 * Execute one propagation pass. A structural/hierarchy change derives every
 * Transform; a local edit derives only that entity and its descendants.
 *
 * @returns `Result<void, SceneError>` -- `ok(void)` when every entity's parent
 *   chain resolves; `err(SceneError({ code: 'hierarchy-broken' }))` on the
 *   first stale ChildOf ref. Partial writes up to the failure point are
 *   retained (caller decides whether to continue; charter proposition 9
 *   graceful degradation on the entity scope).
 *
 * @example Drive from a test or custom render loop:
 *   const r = propagateTransforms(world);
 *   if (!r.ok) console.error(r.error.code, r.error.hint);
 */
export function propagateTransforms(
  world: World,
  hierarchy: SceneHierarchySnapshot = projectHierarchy(world),
): Result<void, SceneError> {
  const internal = asInternal(world);
  const structureEpoch = internal._getStructureEpoch();
  const childOfMutationEpoch = internal._getComponentMutationEpoch(ChildOf.id);
  const transformMutationEpoch = internal._getComponentMutationEpoch(Transform.id);
  const cached = PROPAGATION_CACHE.get(world);
  if (
    cached !== undefined &&
    cached.structureEpoch === structureEpoch &&
    cached.childOfMutationEpoch === childOfMutationEpoch &&
    cached.transformMutationEpoch === transformMutationEpoch &&
    cached.hierarchy === hierarchy
  ) {
    return cached.result;
  }
  const graph = internal._getGraph();

  // Collect a row locator per live entity carrying a Transform. The locator
  // pins the entity's live Transform.world view so parent lookups hit the
  // in-memory slot directly (no world.get materialisation). Building the map
  // doubles as the live-set membership check (liveMap.has(entity)).
  const canIncrement =
    cached !== undefined &&
    cached.structureEpoch === structureEpoch &&
    cached.childOfMutationEpoch === childOfMutationEpoch &&
    cached.hierarchy === hierarchy;
  const liveMap = canIncrement
    ? cached.liveMap
    : (() => {
        const rebuilt = new Map<EntityHandle, RowLocator>();
        for (const table of graph.tables) {
          if (!table || !componentPresent(table, Transform.id)) continue;
          for (let row = 0; row < table.size; row++) {
            const entity = readEntityAt(table, row);
            const worldView = internal._getArrayView(entity, Transform, 'world');
            if (worldView !== undefined) rebuilt.set(entity, { table, row, entity, worldView });
          }
        }
        return rebuilt;
      })();
  const childrenOf = canIncrement ? cached.childrenOf : indexChildren(hierarchy, liveMap);

  const affected = new Set<EntityHandle>();
  if (canIncrement) {
    const pending: EntityHandle[] = [];
    for (const loc of liveMap.values()) {
      if (transformChangedEpoch(loc.table, loc.row) <= cached.transformMutationEpoch) continue;
      affected.add(loc.entity);
      pending.push(loc.entity);
    }
    for (let index = 0; index < pending.length; index += 1) {
      const parent = pending[index];
      if (parent === undefined) continue;
      for (const child of childrenOf.get(parent) ?? []) {
        if (affected.has(child)) continue;
        affected.add(child);
        pending.push(child);
      }
    }
  }

  // Pass 1 -- roots: world = compose(local.TRS). The projection, rather than
  // component presence, decides whether a malformed edge was cut.
  const processed = new Set<EntityHandle>();
  for (const loc of liveMap.values()) {
    if (canIncrement && !affected.has(loc.entity)) continue;
    if (hierarchy.getParent(loc.entity) !== undefined) continue;
    composeLocalInto(loc.worldView, loc.table, loc.row);
    processed.add(loc.entity);
  }

  // Pass 2 -- children: DFS through the same valid parent edges used by the
  // resolver. Cycle and stale edges are absent from the projection, so this
  // traversal always terminates and the affected entity is evaluated as root.
  const localMat = mat4.create() as unknown as Float32Array;

  for (const selfLoc of liveMap.values()) {
    if (canIncrement && !affected.has(selfLoc.entity)) continue;
    if (processed.has(selfLoc.entity)) continue;
    const r = resolveEntity(
      selfLoc,
      hierarchy,
      liveMap,
      processed,
      localMat,
      canIncrement ? affected : undefined,
    );
    if (!r.ok) return r;
  }

  const firstDiagnostic = hierarchy.diagnostics[0];
  if (firstDiagnostic !== undefined) {
    const result = err(
      new SceneError({
        code: firstDiagnostic.code,
        expected: firstDiagnostic.expected,
        hint: firstDiagnostic.hint,
        detail: firstDiagnostic.detail,
      }),
    );
    PROPAGATION_CACHE.set(world, {
      structureEpoch,
      childOfMutationEpoch,
      transformMutationEpoch,
      hierarchy,
      liveMap,
      childrenOf,
      result,
    });
    return result;
  }
  const result = ok(undefined);
  PROPAGATION_CACHE.set(world, {
    structureEpoch,
    childOfMutationEpoch,
    transformMutationEpoch,
    hierarchy,
    liveMap,
    childrenOf,
    result,
  });
  return result;
}

/**
 * Resolve a single entity's `Transform.world` by composing its local TRS and
 * left-multiplying by the parent's resolved world mat4, recursing up the
 * parent chain to a root or a previously-processed ancestor. Memoises via the
 * `processed` set; recursion depth is bounded by hierarchy depth.
 *
 * On stale parent ref (not in `liveMap`) returns `err(SceneError({ code:
 * 'hierarchy-broken' }))`.
 */
function resolveEntity(
  selfLoc: RowLocator,
  hierarchy: SceneHierarchySnapshot,
  liveMap: ReadonlyMap<EntityHandle, RowLocator>,
  processed: Set<EntityHandle>,
  localMat: Float32Array,
  affected?: ReadonlySet<EntityHandle>,
): Result<void, SceneError> {
  if (affected !== undefined && !affected.has(selfLoc.entity)) return ok(undefined);
  if (processed.has(selfLoc.entity)) return ok(undefined);

  const parentEntity = hierarchy.getParent(selfLoc.entity);
  if (parentEntity === undefined) {
    composeLocalInto(selfLoc.worldView, selfLoc.table, selfLoc.row);
    processed.add(selfLoc.entity);
    return ok(undefined);
  }

  const parentLoc = liveMap.get(parentEntity);
  if (parentLoc === undefined) {
    composeLocalInto(selfLoc.worldView, selfLoc.table, selfLoc.row);
    processed.add(selfLoc.entity);
    return ok(undefined);
  }

  // Ensure the parent's world slot is fresh this frame before multiplying.
  const parentResult = resolveEntity(parentLoc, hierarchy, liveMap, processed, localMat, affected);
  if (!parentResult.ok) return parentResult;

  // world(self) = parent.world x compose(self.local). Compose into a scratch
  // mat4 then multiply into the live self.worldView slot (parent and self are
  // distinct slots, so the multiply destination does not alias either source).
  composeLocalInto(localMat, selfLoc.table, selfLoc.row);
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
 * returned `Result<void, SceneError>` is converted to an unwrap-style throw so
 * the ECS Layer 3 `ErrorHandler` can route the failure (world.setErrorHandler).
 *
 * Labelled `'transform'` (spec §6.2 label-anchor map).
 */
export const PropagateTransforms: SystemHandle<readonly []> = defineSystem({
  name: PROPAGATE_TRANSFORMS_SYSTEM,
  queries: [],
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

/** FixedUpdate copy used by simulation participants before fixed physics. */
export const PropagateTransformsFixed: SystemHandle<readonly []> = defineSystem({
  name: PROPAGATE_TRANSFORMS_FIXED_SYSTEM,
  queries: [],
  fn: PropagateTransforms.fn,
});

/**
 * Register Transform derivation in the ECS schedules.
 *
 * The forgeax ECS DAG scheduler orders systems via `before` / `after` edges
 * on `SystemDescriptor`. Because RenderSystem is not registered in the
 * ECS schedule (rendering reads the terminal publication outside the schedule):
 *
 *   - If `options.beforeSystemName` is provided, the system runs before
 *     that system (e.g. a user-authored 'presentation' system).
 *   - World owns the terminal publication callback outside the public schedule
 *     graph, so no ordinary system can invalidate Transform.world after it.
 *
 * @example Driver registers once per World:
 *   const world = new World();
 *   registerPropagateTransforms(world);
 *   // ...spawn entities...
 *   world.update();            // propagateTransforms runs here
 *   renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }); // reads Transform.world column
 */
export function registerPropagateTransforms(
  world: World,
  options: { beforeSystemName?: string } = {},
): void {
  if (
    world._registerFrameTransformPublisher(runTerminalTransformPublication) === 'already-registered'
  ) {
    return;
  }
  if (options.beforeSystemName !== undefined) {
    // Optional ordering edge: register a descriptor carrying the same name/fn
    // plus a `before` edge. The `before` (not `fn`) overlay keeps the real fn
    // intact (D-4: no spread-over-fn).
    world
      .addSystems(Update, TransformSet, [
        {
          name: PROPAGATE_TRANSFORMS_SYSTEM,
          queries: [],
          fn: PropagateTransforms.fn,
          before: [options.beforeSystemName],
        },
      ])
      .unwrap();
  } else {
    world.addSystems(Update, TransformSet, [PropagateTransforms]).unwrap();
  }
  world.addSystems(FixedUpdate, TransformFixedSet, [PropagateTransformsFixed]).unwrap();
}

function runTerminalTransformPublication(world: World): void {
  const result = propagateTransforms(world);
  if (!result.ok) throw result.error;
}
