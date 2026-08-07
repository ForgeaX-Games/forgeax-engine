import {
  defineComponent,
  Disabled,
  Entity,
  createQueryState,
  queryRun,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';

/** Transient gameplay marker whose hooks keep the scoring index in sync. */
export const ScoringTarget = defineComponent(
  'GameDefaultScoringTarget',
  { points: 'u32', slot: { type: 'u32', default: 0 } },
  { transient: true },
);

/** The target roster is an ECS query, never a second bootstrap-owned array. */
export function createScoringTargetQuery() {
  return {
    active: createQueryState({ with: [ScoringTarget, Entity] }),
    disabled: createQueryState({ with: [ScoringTarget, Disabled, Entity] }),
  };
}

export type ScoringTargetQuery = ReturnType<typeof createScoringTargetQuery>;

export function scoringTargetEntities(world: World, query: ScoringTargetQuery): EntityHandle[] {
  const entities: EntityHandle[] = [];
  queryRun(query.active, world, (bundle) => {
    for (const entity of bundle.Entity.self) {
      if (entity !== undefined) entities.push(entity as EntityHandle);
    }
  });
  queryRun(query.disabled, world, (bundle) => {
    for (const entity of bundle.Entity.self) {
      if (entity !== undefined) entities.push(entity as EntityHandle);
    }
  });
  return entities;
}

export function activeScoringTargetEntities(world: World, query: ScoringTargetQuery): EntityHandle[] {
  const entities: EntityHandle[] = [];
  queryRun(query.active, world, (bundle) => {
    for (const entity of bundle.Entity.self) {
      if (entity !== undefined) entities.push(entity as EntityHandle);
    }
  });
  return entities;
}

export function firstScoringTarget(world: World, query: ScoringTargetQuery): EntityHandle | undefined {
  let first: EntityHandle | undefined;
  queryRun(query.active, world, (bundle) => {
    if (first !== undefined) return;
    const entity = bundle.Entity.self[0];
    if (entity !== undefined) first = entity as EntityHandle;
  });
  return first;
}

/** Read the ECS-owned score contract; no parallel entity→points index is needed. */
export function scoringPoints(world: World, entity: EntityHandle): number | undefined {
  const target = world.get(entity, ScoringTarget);
  return target.ok ? target.value.points : undefined;
}
