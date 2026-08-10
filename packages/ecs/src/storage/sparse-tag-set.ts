import type { Component } from '../component';
import type { EntityHandle } from '../entity-handle';
import { entityIndex } from '../entity-handle';

const INITIAL_CAPACITY = 64;

export interface SparseTagSet {
  readonly component: Component;
  sparse: Int32Array;
  dense: Uint32Array;
  added: Float64Array;
  changed: Float64Array;
  size: number;
}

export function createSparseTagSet(component: Component): SparseTagSet {
  const sparse = new Int32Array(INITIAL_CAPACITY);
  sparse.fill(-1);
  return {
    component,
    sparse,
    dense: new Uint32Array(INITIAL_CAPACITY),
    added: new Float64Array(INITIAL_CAPACITY),
    changed: new Float64Array(INITIAL_CAPACITY),
    size: 0,
  };
}

export function sparseTagIndex(set: SparseTagSet, entity: EntityHandle): number {
  const denseIndex = set.sparse[entityIndex(entity)] ?? -1;
  return denseIndex >= 0 && set.dense[denseIndex] === (entity as number) ? denseIndex : -1;
}

export function sparseTagHas(set: SparseTagSet, entity: EntityHandle): boolean {
  return sparseTagIndex(set, entity) >= 0;
}

export function insertSparseTag(set: SparseTagSet, entity: EntityHandle, epoch: number): number {
  const present = sparseTagIndex(set, entity);
  if (present >= 0) {
    set.changed[present] = epoch;
    return present;
  }
  growSparseSlots(set, entityIndex(entity) + 1);
  if (set.size === set.dense.length) growSparseDense(set, set.size + 1);
  const denseIndex = set.size;
  set.dense[denseIndex] = entity as number;
  set.added[denseIndex] = epoch;
  set.changed[denseIndex] = epoch;
  set.sparse[entityIndex(entity)] = denseIndex;
  set.size += 1;
  return denseIndex;
}

export function removeSparseTag(set: SparseTagSet, entity: EntityHandle): boolean {
  const denseIndex = sparseTagIndex(set, entity);
  if (denseIndex < 0) return false;
  const lastIndex = set.size - 1;
  set.sparse[entityIndex(entity)] = -1;
  if (denseIndex !== lastIndex) {
    const movedEntity = set.dense[lastIndex] as EntityHandle;
    set.dense[denseIndex] = movedEntity as number;
    set.added[denseIndex] = set.added[lastIndex] ?? 0;
    set.changed[denseIndex] = set.changed[lastIndex] ?? 0;
    set.sparse[entityIndex(movedEntity)] = denseIndex;
  }
  set.size = lastIndex;
  return true;
}

function growSparseSlots(set: SparseTagSet, targetCapacity: number): void {
  if (targetCapacity <= set.sparse.length) return;
  let capacity = set.sparse.length;
  while (capacity < targetCapacity) capacity *= 2;
  const sparse = new Int32Array(capacity);
  sparse.fill(-1);
  sparse.set(set.sparse);
  set.sparse = sparse;
}

function growSparseDense(set: SparseTagSet, targetCapacity: number): void {
  let capacity = set.dense.length;
  while (capacity < targetCapacity) capacity *= 2;
  const dense = new Uint32Array(capacity);
  dense.set(set.dense);
  set.dense = dense;
  const added = new Float64Array(capacity);
  added.set(set.added);
  set.added = added;
  const changed = new Float64Array(capacity);
  changed.set(set.changed);
  set.changed = changed;
}
