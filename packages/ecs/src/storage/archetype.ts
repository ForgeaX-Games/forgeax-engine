import type { Component, ComponentId } from '../component';
import { foldEssentials } from '../entity';
import type { TableId } from './table';

const INITIAL_CAPACITY = 64;

export type ArchetypeId = number;

export interface Archetype {
  readonly id: ArchetypeId;
  readonly key: string;
  readonly components: ReadonlyArray<Component>;
  readonly tableId: TableId;
  rows: Uint32Array;
  size: number;
  capacity: number;
  addEdges: Map<ComponentId, ArchetypeId>;
  removeEdges: Map<ComponentId, ArchetypeId>;
}

export function archetypeKey(componentIds: ReadonlyArray<ComponentId>): string {
  return [...foldEssentials(componentIds)].sort((a, b) => a - b).join('+');
}

export function createArchetype(
  components: ReadonlyArray<Component>,
  id: ArchetypeId,
  tableId: TableId,
): Archetype {
  const byId = new Map<ComponentId, Component>();
  for (const component of components) byId.set(component.id, component);
  const sorted = [...byId.values()].sort((a, b) => a.id - b.id);
  return {
    id,
    key: archetypeKey(sorted.map((component) => component.id)),
    components: sorted,
    tableId,
    rows: new Uint32Array(INITIAL_CAPACITY),
    size: 0,
    capacity: INITIAL_CAPACITY,
    addEdges: new Map(),
    removeEdges: new Map(),
  };
}

export function appendArchetypeRow(archetype: Archetype, tableRow: number): number {
  if (archetype.size === archetype.capacity) growArchetype(archetype, archetype.capacity * 2);
  const row = archetype.size;
  archetype.rows[row] = tableRow;
  archetype.size = row + 1;
  return row;
}

export function removeArchetypeRow(
  archetype: Archetype,
  row: number,
): { movedTableRow: number; newRow: number } | null {
  const lastRow = archetype.size - 1;
  if (row === lastRow) {
    archetype.size = lastRow;
    return null;
  }
  const movedTableRow = archetype.rows[lastRow] ?? 0;
  archetype.rows[row] = movedTableRow;
  archetype.size = lastRow;
  return { movedTableRow, newRow: row };
}

export function growArchetype(archetype: Archetype, targetCapacity: number): void {
  let capacity = archetype.capacity;
  while (capacity < targetCapacity) capacity *= 2;
  if (capacity === archetype.capacity) return;
  const rows = new Uint32Array(capacity);
  rows.set(archetype.rows);
  archetype.rows = rows;
  archetype.capacity = capacity;
}
