// @forgeax/engine-ecs — ArchetypeGraph: manages archetype creation and edge caching.
//
// O(1) archetype migration lookup via cached edges (D-02 / Finding 2).
// Global `generation` counter incremented on each new archetype creation
// (ArchetypeGeneration for query cache incremental update).

import { type Archetype, type ArchetypeId, archetypeKey, createArchetype } from './archetype';
import type { Component, ComponentId } from './component';

/**
 * The ArchetypeGraph owns all archetypes and their edge caches.
 *
 * `archetypes` is the SSOT: a dense array indexed by `ArchetypeId` (the id is
 * allocated as the next array slot, so `archetypes[id].id === id`).
 * `dedupByKey` is a derived index `key → ArchetypeId` used only at archetype
 * creation to dedupe; consumers always read through `archetypes[id]`
 * (architecture-principles.md §1 SSOT, §2 Derive — replaces the historical
 * `byKey: Map<string, Archetype>` / `byId: Archetype[]` pair which carried two
 * full Archetype refs per row).
 */
export interface ArchetypeGraph {
  /** SSOT: dense array indexed by `ArchetypeId` (id == array slot). */
  archetypes: Archetype[];
  /** Derived dedup index: canonical-key string → ArchetypeId. */
  dedupByKey: Map<string, ArchetypeId>;
  /** Global generation counter. Incremented on each new archetype. */
  generation: number;
}

/**
 * Create a fresh ArchetypeGraph.
 */
export function createArchetypeGraph(): ArchetypeGraph {
  return {
    archetypes: [],
    dedupByKey: new Map(),
    generation: 0,
  };
}

/**
 * Get or create an archetype for the given component set.
 * ComponentIds are sorted to produce a canonical key.
 */
export function getOrCreateArchetype(
  graph: ArchetypeGraph,
  componentIds: ReadonlyArray<ComponentId>,
  components: ReadonlyArray<Component>,
): Archetype {
  const key = archetypeKey(componentIds);
  const existingId = graph.dedupByKey.get(key);
  if (existingId !== undefined) {
    // biome-ignore lint/style/noNonNullAssertion: dedupByKey only ever holds ids that were pushed into archetypes[].
    return graph.archetypes[existingId]!;
  }

  const archId = graph.archetypes.length;
  const arch = createArchetype(components, archId);
  graph.archetypes.push(arch);
  graph.dedupByKey.set(key, archId);
  graph.generation += 1;
  return arch;
}

/**
 * Get the target archetype after adding `componentId` to `src`.
 * Caches the edge for O(1) subsequent lookups.
 */
export function getAddEdge(
  graph: ArchetypeGraph,
  src: Archetype,
  componentId: ComponentId,
  component: Component,
): Archetype {
  const cached = src.addEdges.get(componentId);
  if (cached !== undefined) {
    const target = graph.archetypes[cached];
    if (target) {
      return target;
    }
  }

  // Compute target archetype: src components + new component.
  const newIds = [...src.components.map((c) => c.id), componentId];
  const newComponents = [...src.components, component];
  const target = getOrCreateArchetype(graph, newIds, newComponents);
  src.addEdges.set(componentId, target.id);
  return target;
}

/**
 * Get the target archetype after removing `componentId` from `src`.
 * Caches the edge for O(1) subsequent lookups.
 *
 * Component list is derived from `src.components.filter(c => c.id !== componentId)`
 * (no separate componentRegistry — feat-20260611 AC-09).
 */
export function getRemoveEdge(
  graph: ArchetypeGraph,
  src: Archetype,
  componentId: ComponentId,
): Archetype {
  const cached = src.removeEdges.get(componentId);
  if (cached !== undefined) {
    const target = graph.archetypes[cached];
    if (target) {
      return target;
    }
  }

  // Compute target archetype: src components minus removed component.
  // Derive componentIds from src.components (single-field Archetype).
  const newIds = src.components.map((c) => c.id).filter((id) => id !== componentId);
  const newComponents = src.components.filter((c) => c.id !== componentId);
  const target = getOrCreateArchetype(graph, newIds, newComponents);
  src.removeEdges.set(componentId, target.id);
  return target;
}
