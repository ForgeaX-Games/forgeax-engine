import type { Archetype, EntityHandle, World } from '@forgeax/engine-ecs';
import { Entity } from '@forgeax/engine-ecs';
import {
  projectHierarchy,
  type SceneHierarchyDiagnostic,
  type SceneHierarchySnapshot,
} from '@forgeax/engine-scene';
import {
  Visibility,
  type VisibilityState,
  VisibilityStateValue,
  visibilityStateFromU32,
} from '../components/visibility';

export type VisibilitySource = 'default' | 'self' | 'parent';

export interface VisibilityResolution {
  /** The component value authored on this entity before inheritance. */
  readonly intent: VisibilityState;
  /** The state consumed by render candidates after parent resolution. */
  readonly effective: 'hidden' | 'visible';
  /** Explains whether the effective state came from self, parent, or default. */
  readonly source: VisibilitySource;
}

export interface VisibilitySnapshot {
  readonly diagnostics: readonly SceneHierarchyDiagnostic[];
  readonly hasAnyIntent: boolean;
  readonly hasAnyHiddenIntent: boolean;
  get(entity: EntityHandle): VisibilityResolution | undefined;
  /** Resolve effective visibility for a render candidate, including inherited defaults. */
  effective(entity: EntityHandle): 'hidden' | 'visible';
}

interface ResolutionState {
  readonly intent: VisibilityState;
  readonly effective: 'hidden' | 'visible';
  readonly source: VisibilitySource;
}

interface InternalWorldSurface {
  /** @internal */
  _getGraph(): { archetypes: ReadonlyArray<Archetype | undefined> };
}

function readColumn(
  archetype: Archetype,
  componentId: number,
  fieldName: string,
): ArrayLike<number> | undefined {
  return archetype.columns.get(componentId)?.get(fieldName)?.view as ArrayLike<number> | undefined;
}

/**
 * Resolve author intent against the scene-owned valid parent projection.
 * Diagnostics are preserved for callers to repair hierarchy input before retry.
 */
export function resolveVisibility(
  world: World,
  hierarchy: SceneHierarchySnapshot = projectHierarchy(world),
): VisibilitySnapshot {
  const graph = (world as unknown as InternalWorldSurface)._getGraph();
  let intentCount = 0;
  let hasAnyHiddenIntent = false;
  for (const archetype of graph.archetypes) {
    if (archetype === undefined) continue;
    const states = readColumn(archetype, Visibility.id, 'state');
    if (states === undefined) continue;
    intentCount += archetype.size;
    for (let row = 0; row < archetype.size; row++) {
      if (states[row] === VisibilityStateValue.hidden) {
        hasAnyHiddenIntent = true;
        break;
      }
    }
  }

  let resolveEntity: ((entity: EntityHandle) => ResolutionState | undefined) | undefined;
  let hasIntent: ((entity: EntityHandle) => boolean) | undefined;
  const ensureResolver = (): void => {
    if (resolveEntity !== undefined) return;
    const intentByEntity = new Map<EntityHandle, VisibilityState>();
    for (const archetype of graph.archetypes) {
      if (archetype === undefined) continue;
      const entities = readColumn(archetype, Entity.id, 'self');
      const states = readColumn(archetype, Visibility.id, 'state');
      if (entities === undefined || states === undefined) continue;
      for (let row = 0; row < archetype.size; row++) {
        const intent = visibilityStateFromU32(states[row] ?? 0);
        if (intent !== undefined) {
          intentByEntity.set((entities[row] ?? 0) as EntityHandle, intent);
        }
      }
    }
    hasIntent = (entity: EntityHandle): boolean => intentByEntity.has(entity);
    const resolved = new Map<EntityHandle, ResolutionState>();
    const resolving = new Set<EntityHandle>();
    resolveEntity = (entity: EntityHandle): ResolutionState | undefined => {
      const existing = resolved.get(entity);
      if (existing !== undefined) return existing;
      if (resolving.has(entity)) return undefined;

      const intent = intentByEntity.get(entity) ?? 'inherited';
      resolving.add(entity);

      let result: ResolutionState;
      if (intent === 'hidden') {
        result = { intent, effective: 'hidden', source: 'self' };
      } else if (intent === 'visible') {
        result = { intent, effective: 'visible', source: 'self' };
      } else {
        const parent = hierarchy.getParent(entity);
        const parentResult = parent === undefined ? undefined : resolveEntity?.(parent);
        result =
          parentResult === undefined
            ? { intent, effective: 'visible', source: 'default' }
            : { intent, effective: parentResult.effective, source: 'parent' };
      }

      resolving.delete(entity);
      resolved.set(entity, result);
      return result;
    };
  };

  return {
    diagnostics: hierarchy.diagnostics,
    hasAnyIntent: intentCount > 0,
    hasAnyHiddenIntent,
    get(entity: EntityHandle): VisibilityResolution | undefined {
      ensureResolver();
      return hasIntent?.(entity) ? resolveEntity?.(entity) : undefined;
    },
    effective(entity: EntityHandle): 'hidden' | 'visible' {
      ensureResolver();
      return resolveEntity?.(entity)?.effective ?? 'visible';
    },
  };
}
