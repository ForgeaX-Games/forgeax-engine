// @forgeax/engine-ecs — per-entity and per-resource change ticks.

import type { EntityHandle } from '../entity-handle';
import type { ArchetypeGraph } from './archetype-graph';
import { getOrCreateSparseTagSet } from './archetype-graph';
import { insertSparseTag, sparseTagIndex } from './sparse-tag-set';

export interface ChangeTicks {
  added: number;
  changed: number;
}

export const NEVER_CHANGED_TICK = -1;

export function createChangeTicks(tick: number): ChangeTicks {
  return { added: tick, changed: tick };
}

interface EntityLocation {
  readonly archetypeId: number;
  readonly archetypeRow: number;
}

export function readComponentChange(
  graph: ArchetypeGraph,
  location: EntityLocation,
  entity: EntityHandle,
  componentId: number,
): ChangeTicks | undefined {
  const sparseSet = graph.sparseTags.get(componentId);
  if (sparseSet !== undefined) {
    const denseIndex = sparseTagIndex(sparseSet, entity);
    if (denseIndex < 0) return undefined;
    return {
      added: sparseSet.added[denseIndex] ?? 0,
      changed: sparseSet.changed[denseIndex] ?? 0,
    };
  }
  const archetype = graph.archetypes[location.archetypeId];
  if (archetype === undefined) return undefined;
  const epochs = graph.tables[archetype.tableId]?.storage.get(componentId)?.epochs;
  if (epochs === undefined) return undefined;
  const tableRow = archetype.rows[location.archetypeRow] ?? -1;
  return {
    added: epochs.added[tableRow] ?? 0,
    changed: epochs.changed[tableRow] ?? 0,
  };
}

export function markComponentsAdded(
  graph: ArchetypeGraph,
  location: EntityLocation,
  entity: EntityHandle,
  componentIds: readonly number[],
  epoch: number,
): void {
  const archetype = graph.archetypes[location.archetypeId];
  const table = archetype === undefined ? undefined : graph.tables[archetype.tableId];
  const tableRow = archetype?.rows[location.archetypeRow] ?? -1;
  for (const componentId of componentIds) {
    const component = archetype?.components.find((candidate) => candidate.id === componentId);
    if (component?.storage === 'sparse') {
      insertSparseTag(getOrCreateSparseTagSet(graph, component), entity, epoch);
      continue;
    }
    const epochs = table?.storage.get(componentId)?.epochs;
    if (epochs === undefined) continue;
    epochs.added[tableRow] = epoch;
    epochs.changed[tableRow] = epoch;
  }
}

export function markComponentChanged(
  graph: ArchetypeGraph,
  location: EntityLocation,
  entity: EntityHandle,
  componentId: number,
  epoch: () => number,
): void {
  const sparseSet = graph.sparseTags.get(componentId);
  if (sparseSet !== undefined) {
    const denseIndex = sparseTagIndex(sparseSet, entity);
    if (denseIndex >= 0) sparseSet.changed[denseIndex] = epoch();
    return;
  }
  const archetype = graph.archetypes[location.archetypeId];
  if (archetype === undefined) return;
  const epochs = graph.tables[archetype.tableId]?.storage.get(componentId)?.epochs;
  if (epochs === undefined) return;
  const tableRow = archetype.rows[location.archetypeRow] ?? -1;
  epochs.changed[tableRow] = epoch();
}
