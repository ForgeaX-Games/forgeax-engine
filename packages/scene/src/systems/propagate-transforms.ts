import {
  defineSystem,
  defineSystemSet,
  type EntityHandle,
  FixedUpdate,
  type SystemHandle,
  Update,
  type World,
} from '@forgeax/engine-ecs';
import {
  createWorldProjection,
  setDerivedComponent,
  type WorldProjection,
} from '@forgeax/engine-ecs/projection';
import { type Mat4, mat4 } from '@forgeax/engine-math';
import { err, ok, type Result } from '@forgeax/engine-types';
import { ChildOf } from '../components/child-of';
import { Transform } from '../components/transform';
import { SceneError } from '../errors';
import { projectHierarchy, type SceneHierarchySnapshot } from './hierarchy-projection';

export const PROPAGATE_TRANSFORMS_SYSTEM = 'propagateTransforms' as const;
export const PROPAGATE_TRANSFORMS_FIXED_SYSTEM = 'propagateTransformsFixed' as const;
export const TransformSet = defineSystemSet({ name: 'transform' });
export const TransformFixedSet = defineSystemSet({ name: 'transform-fixed' });

interface LocalState {
  readonly pos: Float32Array;
  readonly quat: Float32Array;
  readonly scale: Float32Array;
}

interface PropagationCache {
  readonly projection: WorldProjection;
  readonly hierarchy: SceneHierarchySnapshot;
  readonly parentOf: ReadonlyMap<EntityHandle, EntityHandle>;
  readonly childrenOf: ReadonlyMap<EntityHandle, readonly EntityHandle[]>;
  readonly entities: ReadonlySet<EntityHandle>;
  readonly locals: Map<EntityHandle, LocalState>;
  readonly derived: Map<EntityHandle, Float32Array>;
  result: Result<void, SceneError>;
}

const CACHE = new WeakMap<World, PropagationCache>();

interface TransformRegistrationLease {
  refs: number;
}

// A World can be consumed by more than one renderer/view. Keep the schedule
// registration leased per World so one owner disposing cannot remove the
// shared transform system from another owner. This is lifecycle bookkeeping,
// not a second component/system authority; the World schedule remains the
// source of truth.
const REGISTRATION_LEASES = new WeakMap<World, TransformRegistrationLease>();

function copyState(value: {
  readonly pos: ArrayLike<number>;
  readonly quat: ArrayLike<number>;
  readonly scale: ArrayLike<number>;
}): LocalState {
  return {
    pos: new Float32Array(value.pos),
    quat: new Float32Array(value.quat),
    scale: new Float32Array(value.scale),
  };
}

function sameArray(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameState(left: LocalState | undefined, right: LocalState): boolean {
  return (
    left !== undefined &&
    sameArray(left.pos, right.pos) &&
    sameArray(left.quat, right.quat) &&
    sameArray(left.scale, right.scale)
  );
}

function compose(state: LocalState, out: Mat4): void {
  mat4.compose(out, state.pos, state.quat, state.scale);
}

function indexChildren(
  hierarchy: SceneHierarchySnapshot,
): ReadonlyMap<EntityHandle, readonly EntityHandle[]> {
  const childrenOf = new Map<EntityHandle, EntityHandle[]>();
  for (const [child, parent] of hierarchy.parentOf) {
    const children = childrenOf.get(parent);
    if (children === undefined) childrenOf.set(parent, [child]);
    else children.push(child);
  }
  return childrenOf;
}

function descendants(
  childrenOf: ReadonlyMap<EntityHandle, readonly EntityHandle[]>,
  roots: ReadonlySet<EntityHandle>,
): Set<EntityHandle> {
  const affected = new Set(roots);
  const pending = [...roots];
  for (let index = 0; index < pending.length; index += 1) {
    const parent = pending[index];
    if (parent === undefined) continue;
    for (const child of childrenOf.get(parent) ?? []) {
      if (affected.has(child)) continue;
      affected.add(child);
      pending.push(child);
    }
  }
  return affected;
}

function hierarchyError(hierarchy: SceneHierarchySnapshot): Result<void, SceneError> {
  const first = hierarchy.diagnostics[0];
  if (first === undefined) return ok(undefined);
  return err(
    new SceneError({
      code: first.code,
      expected: first.expected,
      hint: first.hint,
      detail: first.detail,
    }),
  );
}

function buildCache(world: World, projection: WorldProjection): PropagationCache {
  const hierarchy = projectHierarchy(world);
  const locals = new Map<EntityHandle, LocalState>();
  const entities = new Set<EntityHandle>();
  const query = world.query({ read: [Transform], optional: [ChildOf] });
  if (query.ok) {
    for (const row of query.value) {
      const transform = row.get(Transform);
      if (transform === undefined) continue;
      entities.add(row.entity);
      locals.set(row.entity, copyState(transform));
    }
  }
  return {
    projection,
    hierarchy,
    parentOf: hierarchy.parentOf,
    childrenOf: indexChildren(hierarchy),
    entities,
    locals,
    derived: new Map(),
    result: ok(undefined),
  };
}

function deriveEntity(
  world: World,
  entity: EntityHandle,
  cache: PropagationCache,
  affected: ReadonlySet<EntityHandle>,
  visiting: Set<EntityHandle>,
  published: Set<EntityHandle>,
): Result<void, SceneError> {
  if (!affected.has(entity) || cache.derived.has(entity)) return ok(undefined);
  if (visiting.has(entity)) return ok(undefined);
  visiting.add(entity);
  const local = cache.locals.get(entity);
  if (local === undefined) {
    visiting.delete(entity);
    return ok(undefined);
  }
  const parent = cache.parentOf.get(entity);
  if (parent !== undefined && cache.entities.has(parent)) {
    const parentResult = deriveEntity(world, parent, cache, affected, visiting, published);
    if (!parentResult.ok) return parentResult;
  }
  const localWorld = mat4.create();
  compose(local, localWorld);
  const parentWorld = parent === undefined ? undefined : cache.derived.get(parent);
  const resolved = mat4.create();
  if (parentWorld === undefined) resolved.set(localWorld);
  else mat4.multiply(resolved, parentWorld, localWorld);
  const write = setDerivedComponent(world, entity, Transform, { world: resolved });
  if (!write.ok) {
    visiting.delete(entity);
    return err(
      new SceneError({
        code: 'hierarchy-broken',
        expected: 'the derived Transform.world write to succeed',
        hint: 'inspect the ECS mutation error before retrying transform propagation',
        detail: { entity, parent: entity },
      }),
    );
  }
  cache.derived.set(entity, resolved);
  published.add(entity);
  visiting.delete(entity);
  return ok(undefined);
}

function drainPublishedChanges(
  cache: PropagationCache,
  published: ReadonlySet<EntityHandle>,
): boolean {
  const drained = cache.projection.poll();
  if (drained.status === 'rebuild') return true;
  return drained.changes.every(
    (change) =>
      change.kind === 'derived-component-changed' &&
      change.component === Transform &&
      published.has(change.entity),
  );
}

export function propagateTransforms(
  world: World,
  _hierarchy?: SceneHierarchySnapshot,
): Result<void, SceneError> {
  let cache = CACHE.get(world);
  if (cache === undefined) {
    cache = buildCache(world, createWorldProjection(world, { components: [Transform, ChildOf] }));
    CACHE.set(world, cache);
    const initial = new Set(cache.entities);
    const published = new Set<EntityHandle>();
    for (const entity of initial) {
      const result = deriveEntity(world, entity, cache, initial, new Set(), published);
      if (!result.ok) return result;
    }
    if (!drainPublishedChanges(cache, published)) {
      CACHE.delete(world);
      return propagateTransforms(world);
    }
    cache.result = hierarchyError(cache.hierarchy);
    return cache.result;
  }

  const evidence = cache.projection.poll();
  if (evidence.status === 'rebuild') {
    cache = buildCache(world, cache.projection);
    CACHE.set(world, cache);
    const all = new Set(cache.entities);
    const published = new Set<EntityHandle>();
    for (const entity of all) {
      const result = deriveEntity(world, entity, cache, all, new Set(), published);
      if (!result.ok) return result;
    }
    if (!drainPublishedChanges(cache, published)) {
      CACHE.delete(world);
      return propagateTransforms(world);
    }
    cache.result = hierarchyError(cache.hierarchy);
    return cache.result;
  }
  if (evidence.changes.length === 0) return cache.result;

  const transformSeeds = new Set<EntityHandle>();
  let rebuild = false;
  for (const change of evidence.changes) {
    if (
      change.kind === 'entity-removed' ||
      change.kind === 'component-added' ||
      change.kind === 'component-removed'
    ) {
      rebuild = true;
      break;
    }
    if (change.kind !== 'component-changed') continue;
    if (change.component === ChildOf) {
      rebuild = true;
      break;
    }
    // Derived Transform publications are deliberately not dirty seeds. Only
    // authored component-changed records can invalidate local TRS state.
    if (change.component === Transform) transformSeeds.add(change.entity);
  }
  if (rebuild) {
    CACHE.delete(world);
    return propagateTransforms(world);
  }

  // A World can record several authored writes before this pass. Read each
  // seed once so the final local state decides whether propagation is needed.
  const changed = new Set<EntityHandle>();
  for (const entity of transformSeeds) {
    const current = world.get(entity, Transform);
    if (!current.ok) {
      CACHE.delete(world);
      return propagateTransforms(world);
    }
    const next = copyState(current.value);
    if (!sameState(cache.locals.get(entity), next)) changed.add(entity);
    cache.locals.set(entity, next);
  }
  if (changed.size === 0) return cache.result;

  const affected = descendants(cache.childrenOf, changed);
  const published = new Set<EntityHandle>();
  for (const entity of affected) cache.derived.delete(entity);
  for (const entity of affected) {
    const result = deriveEntity(world, entity, cache, affected, new Set(), published);
    if (!result.ok) return result;
  }
  if (!drainPublishedChanges(cache, published)) {
    CACHE.delete(world);
    return propagateTransforms(world);
  }
  cache.result = hierarchyError(cache.hierarchy);
  return cache.result;
}

export const PropagateTransforms: SystemHandle<readonly []> = defineSystem({
  name: PROPAGATE_TRANSFORMS_SYSTEM,
  queries: [],
  fn: (world) => {
    const result = propagateTransforms(world);
    if (!result.ok) throw result.error;
  },
});

export const PropagateTransformsFixed: SystemHandle<readonly []> = defineSystem({
  name: PROPAGATE_TRANSFORMS_FIXED_SYSTEM,
  queries: [],
  fn: PropagateTransforms.fn,
});

export function registerPropagateTransforms(
  world: World,
  options: { beforeSystemName?: string } = {},
): () => void {
  const existing = REGISTRATION_LEASES.get(world);
  if (existing !== undefined) {
    existing.refs += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      existing.refs -= 1;
      if (existing.refs === 0) {
        world.removeSystem(FixedUpdate, PROPAGATE_TRANSFORMS_FIXED_SYSTEM);
        world.removeSystem(Update, PROPAGATE_TRANSFORMS_SYSTEM);
        REGISTRATION_LEASES.delete(world);
        CACHE.delete(world);
      }
    };
  }
  if (options.beforeSystemName === undefined) {
    world.addSystems(Update, TransformSet, [PropagateTransforms]).unwrap();
  } else {
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
  }
  world.addSystems(FixedUpdate, TransformFixedSet, [PropagateTransformsFixed]).unwrap();
  const lease: TransformRegistrationLease = { refs: 1 };
  REGISTRATION_LEASES.set(world, lease);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    lease.refs -= 1;
    if (lease.refs !== 0) return;
    world.removeSystem(FixedUpdate, PROPAGATE_TRANSFORMS_FIXED_SYSTEM);
    world.removeSystem(Update, PROPAGATE_TRANSFORMS_SYSTEM);
    REGISTRATION_LEASES.delete(world);
    CACHE.delete(world);
  };
}
