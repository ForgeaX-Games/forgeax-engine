/**
 * ECS package-internal World seam.
 *
 * This module is intentionally not re-exported by the package entry points.
 * It keeps implementation access out of World's discoverable API while
 * retaining direct bound calls for the hot query and structural paths.
 */
// Bundled ECS entry points (`index` and `projection`) each include this module
// in their own closure. A plain Symbol() therefore gives World and projection
// different property keys at runtime even though their source imports agree.
// The registry is package-private by convention: no root/advanced export
// exposes this key, while Symbol.for keeps source/dist and split bundles on
// one identity.
export const worldInternal: unique symbol = Symbol.for(
  'forgeax.ecs.worldInternal',
) as unknown as typeof worldInternal;

type InternalName =
  | 'addComponentCore'
  | 'allocateIndex'
  | 'allocatePendingEntity'
  | 'cancelPendingEntity'
  | 'despawnCore'
  | 'getArrayView'
  | 'getBufferPool'
  | 'getChangeCursor'
  | 'getClockWriter'
  | 'getComponentChange'
  | 'getComponentMutationEpoch'
  | 'getEntityArchetype'
  | 'getFixedAccumulator'
  | 'getFreeIndices'
  | 'getGraph'
  | 'getMutationEpoch'
  | 'getQueryRow'
  | 'getRecords'
  | 'getRelationshipEpoch'
  | 'getRelationshipTargetEntities'
  | 'getResources'
  | 'getSchedule'
  | 'getSchedules'
  | 'getSharedRefs'
  | 'getStructureEpoch'
  | 'getUniqueRefs'
  | 'lookupAlive'
  | 'markComponentAdded'
  | 'markComponentChanged'
  | 'markComponentRangeChanged'
  | 'markComponentsAdded'
  | 'markDerivedComponentChanges'
  | 'markStructureChanged'
  | 'materializePendingEntity'
  | 'nextMutationEpoch'
  | 'poisonExecution'
  | 'preflightComponentData'
  | 'readChangesSince'
  | 'readRow'
  | 'recordIsLive'
  | 'relationshipOnInsert'
  | 'relationshipOnRemove'
  | 'releaseManagedRefsOnRow'
  | 'removeComponentChange'
  | 'removeComponentCore'
  | 'removeEntityChanges'
  | 'routeError'
  | 'setFixedAccumulator'
  | 'setQueryRow'
  | 'spawnCore'
  | 'writeEntitySelf'
  | 'writeRow';

export type WorldInternal = {
  // biome-ignore lint/suspicious/noExplicitAny: this closed package-internal seam preserves each method's existing inferred result type.
  readonly [K in InternalName]: (...args: any[]) => any;
};
