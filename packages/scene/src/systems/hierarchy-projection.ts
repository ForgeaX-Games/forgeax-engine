import type { EntityHandle, Table, World } from '@forgeax/engine-ecs';
import { Entity } from '@forgeax/engine-ecs';
import { ChildOf } from '../components';
import type { SceneErrorCode, SceneErrorDetail } from '../errors';

export interface SceneHierarchyDiagnostic {
  readonly code: SceneErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SceneErrorDetail;
}

export interface SceneHierarchySnapshot {
  readonly parentOf: ReadonlyMap<EntityHandle, EntityHandle>;
  readonly diagnostics: readonly SceneHierarchyDiagnostic[];
  getParent(entity: EntityHandle): EntityHandle | undefined;
}

interface HierarchyGraph {
  readonly tables: ReadonlyArray<Table | undefined>;
}

interface InternalWorldSurface {
  /** @internal */
  _getGraph(): HierarchyGraph;
  /** @internal Archetype/layout token used to invalidate derived projections. */
  _getStructureEpoch(): number;
  /** @internal Component mutation token used to invalidate derived projections. */
  _getComponentMutationEpoch(componentId: number): number;
}

interface HierarchyProjectionCacheEntry {
  readonly childOfMutationEpoch: number;
  readonly structureEpoch: number;
  readonly snapshot: SceneHierarchySnapshot;
}

// A World can be observed by the transform system, renderer visibility, and
// editor projections in the same frame. Keep one World-local projection so
// those consumers do not each rescan every archetype. Structure changes and
// the ChildOf component's own mutation token are the invalidation keys; the
// global mutation epoch is intentionally too broad because animation and
// runtime-only component writes may advance it every frame. Direct table
// writes are internal-only and must not mutate authored hierarchy state.
const HIERARCHY_PROJECTION_CACHE = new WeakMap<World, HierarchyProjectionCacheEntry>();

function readColumn(table: Table, componentId: number, fieldName: string): Uint32Array | undefined {
  return table.storage.get(componentId)?.fields.get(fieldName)?.view as Uint32Array | undefined;
}

function diagnostic(
  code: SceneErrorCode,
  entity: EntityHandle,
  parent: EntityHandle,
): SceneHierarchyDiagnostic {
  if (code === 'hierarchy-cycle') {
    return {
      code,
      expected: 'ChildOf parent edges form an acyclic live hierarchy',
      hint: 'remove one ChildOf edge from the reported cycle, then re-run the extract',
      detail: { entity, parent },
    };
  }
  return {
    code,
    expected: 'ChildOf.parent references a live entity in the same World',
    hint: 'remove the stale ChildOf component or restore the referenced parent in this World',
    detail: { entity, parent },
  };
}

/** Build the only World-local projection of ChildOf parent facts. */
export function projectHierarchy(world: World): SceneHierarchySnapshot {
  const internal = world as unknown as InternalWorldSurface;
  const childOfMutationEpoch = internal._getComponentMutationEpoch(ChildOf.id);
  const structureEpoch = internal._getStructureEpoch();
  const cached = HIERARCHY_PROJECTION_CACHE.get(world);
  if (
    cached !== undefined &&
    cached.childOfMutationEpoch === childOfMutationEpoch &&
    cached.structureEpoch === structureEpoch
  ) {
    return cached.snapshot;
  }

  const graph = internal._getGraph();
  const liveEntities = new Set<EntityHandle>();
  const authoredParents = new Map<EntityHandle, EntityHandle>();

  for (const table of graph.tables) {
    if (table === undefined) continue;
    const entities = readColumn(table, Entity.id, 'self');
    if (entities === undefined) continue;
    const parents = readColumn(table, ChildOf.id, 'parent');
    for (let row = 0; row < table.size; row++) {
      const entity = (entities[row] ?? 0) as EntityHandle;
      liveEntities.add(entity);
      if (parents !== undefined) {
        authoredParents.set(entity, (parents[row] ?? 0) as EntityHandle);
      }
    }
  }

  const parentOf = new Map<EntityHandle, EntityHandle>();
  const diagnostics: SceneHierarchyDiagnostic[] = [];
  for (const [entity, parent] of authoredParents) {
    if (liveEntities.has(parent)) {
      parentOf.set(entity, parent);
    } else {
      diagnostics.push(diagnostic('hierarchy-broken', entity, parent));
    }
  }

  const state = new Map<EntityHandle, 0 | 1 | 2>();
  const stack: EntityHandle[] = [];
  const cycleMembers = new Set<EntityHandle>();
  const visit = (entity: EntityHandle): void => {
    const currentState = state.get(entity) ?? 0;
    if (currentState === 2) return;
    if (currentState === 1) {
      const cycleStart = stack.indexOf(entity);
      for (let index = cycleStart; index >= 0 && index < stack.length; index++) {
        const member = stack[index];
        if (member !== undefined) cycleMembers.add(member);
      }
      return;
    }

    state.set(entity, 1);
    stack.push(entity);
    const parent = parentOf.get(entity);
    if (parent !== undefined) visit(parent);
    stack.pop();
    state.set(entity, 2);
  };

  for (const entity of liveEntities) visit(entity);
  for (const entity of cycleMembers) {
    const parent = authoredParents.get(entity);
    if (parent !== undefined) diagnostics.push(diagnostic('hierarchy-cycle', entity, parent));
    parentOf.delete(entity);
  }

  diagnostics.sort((left, right) => {
    const entityDelta = (left.detail.entity as number) - (right.detail.entity as number);
    if (entityDelta !== 0) return entityDelta;
    return left.code.localeCompare(right.code);
  });

  const stableParentOf = new Map(parentOf);
  const stableDiagnostics = Object.freeze(diagnostics.slice());
  const snapshot: SceneHierarchySnapshot = {
    parentOf: stableParentOf,
    diagnostics: stableDiagnostics,
    getParent(entity: EntityHandle): EntityHandle | undefined {
      return stableParentOf.get(entity);
    },
  };
  HIERARCHY_PROJECTION_CACHE.set(world, { childOfMutationEpoch, structureEpoch, snapshot });
  return snapshot;
}
