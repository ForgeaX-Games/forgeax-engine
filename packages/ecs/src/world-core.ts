import { BufferPool } from './buffer-pool';
import { createWorldIdentity } from './execution/shared-kernel';
import type { RelationshipIndex } from './relationship-index';
import type { SharedRefStore } from './shared-ref-store';
import { SharedRefStore as SharedRefStoreImpl } from './shared-ref-store';
import { type ArchetypeGraph, createArchetypeGraph } from './storage/archetype-graph';
import { WorldChangeJournal } from './storage/change-detection';
import type { UniqueRefStore } from './unique-ref-store';
import { UniqueRefStore as UniqueRefStoreImpl } from './unique-ref-store';
import type { EntityRecord } from './world';

interface WorldStorageCore {
  readonly graph: ArchetypeGraph;
  readonly records: EntityRecord[];
  readonly freeIndices: number[];
  readonly bufferPool: BufferPool;
  readonly uniqueRefs: UniqueRefStore;
  readonly sharedRefs: SharedRefStore;
}

function createWorldStorageCore(
  shared: boolean,
  refs: { readonly uniqueRefs: UniqueRefStore; readonly sharedRefs: SharedRefStore },
): WorldStorageCore {
  return {
    graph: createArchetypeGraph(shared),
    records: [],
    freeIndices: [],
    bufferPool: new BufferPool(),
    uniqueRefs: refs.uniqueRefs,
    sharedRefs: refs.sharedRefs,
  };
}

/**
 * Package-private state authority for World.  A World is the public facade;
 * this object is the only owner of archetype storage, entity records, managed
 * stores, epochs, and bounded change evidence.
 */
export class WorldCore {
  readonly identity: string = createWorldIdentity();
  readonly uniqueRefs: UniqueRefStore = new UniqueRefStoreImpl();
  readonly sharedRefs: SharedRefStore = new SharedRefStoreImpl();
  readonly storage: WorldStorageCore;
  readonly componentMutationEpochs: number[] = [];
  readonly changeJournal = new WorldChangeJournal();
  /** One packed reverse index per relationship source component. */
  readonly relationshipIndexes = new Map<number, RelationshipIndex>();
  mutationEpoch = 0;
  structureEpoch = 0;

  constructor(sharedStorage: boolean) {
    this.storage = createWorldStorageCore(sharedStorage, {
      uniqueRefs: this.uniqueRefs,
      sharedRefs: this.sharedRefs,
    });
  }

  get graph() {
    return this.storage.graph;
  }

  get records() {
    return this.storage.records;
  }

  get freeIndices() {
    return this.storage.freeIndices;
  }

  get bufferPool() {
    return this.storage.bufferPool;
  }
}
