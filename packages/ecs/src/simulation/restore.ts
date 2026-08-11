import { err, ok, type Result } from '@forgeax/engine-types';
import { type Component, resolveComponent } from '../component';
import { Entity } from '../entity';
import { ENTITY_NULL_RAW, type EntityHandle } from '../entity-handle';
import { createSimulationError } from '../errors/simulation-errors';
import { isFieldPortable, projectComponentData } from '../externalization';
import type { RecoverableResourceDescriptor } from '../resource';
import { FixedTime, Time } from '../time';
import type { World } from '../world';
import type { SimulationParticipantRegistry } from './coordinator';
import {
  createSimulationRecordV1,
  simulationRecordFingerprint,
  validateSimulationRecordV1,
} from './record';
import type {
  SimulationClockProjection,
  SimulationComponentProjection,
  SimulationEntityProjection,
  SimulationError,
  SimulationParticipantRecord,
  SimulationRecordV1,
  SimulationResourceProjection,
  SimulationWorldProjection,
} from './types';

interface CapturedWorldProjection {
  readonly projection: SimulationWorldProjection;
  readonly sourceToLocal: ReadonlyMap<number, number>;
}

class MissingEntityMappingError extends Error {
  constructor(readonly sourceId: number) {
    super(`Simulation entity ${sourceId} has no target mapping.`);
  }
}

function clockProjection(world: World): SimulationClockProjection {
  const time = world.getResource(Time);
  const fixed = world.getResource(FixedTime);
  return {
    time: { delta: time.delta, elapsed: time.elapsed },
    fixed: {
      delta: fixed.delta,
      tick: fixed.tick,
      overstep: fixed.overstep,
      droppedSeconds: fixed.droppedSeconds,
      droppedUpdates: fixed.droppedUpdates,
    },
  };
}

function validateComponentPortable(component: Component): Result<void, SimulationError> {
  if (component.transient) return ok(undefined);
  const schema = component.schema as Record<string, string>;
  const fields = component.fields;
  for (const fieldName of Object.keys(schema)) {
    if (fields?.[fieldName]?.transient === true) continue;
    const fieldType = schema[fieldName];
    if (fieldType !== undefined && !isFieldPortable(fieldType)) {
      return err(
        createSimulationError('simulation-state-unsupported', {
          path: `${component.name}.${fieldName}`,
          component: component.name,
          field: fieldName,
        }),
      );
    }
  }
  return ok(undefined);
}

function captureWorldProjectionWithMap(
  world: World,
): Result<CapturedWorldProjection, SimulationError> {
  const graph = world._getGraph();
  const entities: SimulationEntityProjection[] = [];
  const sourceToLocal = new Map<number, number>();
  const rows: Array<{
    readonly sourceId: number;
    readonly archetype: NonNullable<(typeof graph.archetypes)[number]>;
    readonly tableRow: number;
  }> = [];

  for (const archetype of graph.archetypes) {
    if (archetype === undefined) continue;
    for (let row = 0; row < archetype.size; row += 1) {
      const tableRow = archetype.rows[row];
      if (tableRow === undefined) continue;
      const entity = world._readRow(archetype, Entity, tableRow) as { self: EntityHandle };
      const sourceId = entity.self as number;
      const localId = entities.length;
      sourceToLocal.set(sourceId, localId);
      rows.push({ sourceId, archetype, tableRow });
      entities.push({ localId, components: [] });
    }
  }

  for (const row of rows) {
    const localId = sourceToLocal.get(row.sourceId);
    if (localId === undefined) continue;
    const components: SimulationComponentProjection[] = [];
    for (const component of row.archetype.components) {
      if (component.id === Entity.id || component.transient) continue;
      const portable = validateComponentPortable(component);
      if (!portable.ok) return err(portable.error);
      try {
        const data = world._readRow(row.archetype, component, row.tableRow) as Record<
          string,
          unknown
        >;
        components.push({
          component: component.name,
          data: projectComponentData(component, data, (sourceId: number) => {
            if (sourceId === ENTITY_NULL_RAW) return ENTITY_NULL_RAW;
            const targetId = sourceToLocal.get(sourceId);
            if (targetId === undefined) throw new MissingEntityMappingError(sourceId);
            return targetId;
          }),
        });
      } catch (error) {
        if (error instanceof MissingEntityMappingError) {
          return err(
            createSimulationError('simulation-entity-unmapped', {
              sourceId: error.sourceId,
              path: `${component.name}`,
            }),
          );
        }
        return err(
          createSimulationError('simulation-state-unsupported', {
            path: component.name,
            component: component.name,
          }),
        );
      }
    }
    entities[localId] = { localId, components };
  }

  const resources: SimulationResourceProjection[] = [];
  for (const [key, entry] of world._getResources().entries) {
    if (key === Time.name || key === FixedTime.name) continue;
    const descriptor = world._getSimulationResourceDescriptors().get(key);
    if (descriptor === undefined) {
      return err(
        createSimulationError('simulation-resource-invalid', {
          key,
          path: `resources.${key}`,
        }),
      );
    }
    try {
      resources.push({
        key,
        schemaFingerprint: descriptor.schemaFingerprint,
        value: descriptor.clone(entry.value),
      });
    } catch {
      return err(
        createSimulationError('simulation-resource-invalid', {
          key,
          path: `resources.${key}`,
        }),
      );
    }
  }
  return ok({
    projection: { entities, resources },
    sourceToLocal,
  });
}

/** Capture JSON-safe World state without exposing component storage or native backend objects. */
export function captureWorldProjection(
  world: World,
): Result<SimulationWorldProjection, SimulationError> {
  const captured = captureWorldProjectionWithMap(world);
  return captured.ok ? ok(captured.value.projection) : captured;
}

/** Record ECS state plus registered participant state for a fresh-target restore. */
export function captureSimulationRecord(
  world: World,
  registry: SimulationParticipantRegistry,
): Result<SimulationRecordV1, SimulationError> {
  const capturedWorld = captureWorldProjectionWithMap(world);
  if (!capturedWorld.ok) return capturedWorld;
  const participants: SimulationParticipantRecord[] = [];
  const recordContext = {
    mapEntity: (sourceEntity: number) => capturedWorld.value.sourceToLocal.get(sourceEntity),
  };
  for (const participant of registry.entries()) {
    let state: Result<unknown, SimulationError>;
    try {
      state =
        participant.recordState === undefined ? ok(null) : participant.recordState(recordContext);
    } catch {
      return err(
        createSimulationError('simulation-state-unsupported', {
          path: `participants.${participant.id}.state`,
        }),
      );
    }
    if (!state.ok) return state;
    participants.push({
      id: participant.id,
      version: participant.version,
      schemaFingerprint: participant.schemaFingerprint,
      state: state.value,
    });
  }
  const fixed = world.getResource(FixedTime);
  return createSimulationRecordV1({
    recordTick: fixed.tick,
    clock: clockProjection(world),
    world: capturedWorld.value.projection,
    participants,
    trace: [],
  });
}

function materialize(
  target: World,
  entities: readonly SimulationEntityProjection[],
): Result<ReadonlyMap<number, number>, SimulationError> {
  const handles = entities.map(() => target._allocatePendingEntity());
  const resolveLocal = (localId: number): EntityHandle => {
    const handle = handles[localId];
    if (handle === undefined) throw new MissingEntityMappingError(localId);
    return handle;
  };
  try {
    for (let index = 0; index < entities.length; index += 1) {
      const entity = entities[index];
      const handle = handles[index];
      if (entity === undefined || handle === undefined) continue;
      const componentDatas = entity.components.map((component) => {
        const token = resolveComponent(component.component);
        if (token === undefined) {
          throw createSimulationError('simulation-state-unsupported', {
            path: `world.entities[${index}].components.${component.component}`,
            component: component.component,
          });
        }
        return {
          component: token,
          data: projectComponentData(token, component.data, (localId) =>
            localId === ENTITY_NULL_RAW ? ENTITY_NULL_RAW : resolveLocal(localId),
          ),
        };
      });
      target._materializePendingEntity(handle, componentDatas as never);
    }
  } catch (error) {
    if (error instanceof MissingEntityMappingError) {
      return err(
        createSimulationError('simulation-entity-unmapped', {
          sourceId: error.sourceId,
          path: `world.entities[${error.sourceId}]`,
        }),
      );
    }
    if (error instanceof Error && 'code' in error) return err(error as SimulationError);
    return err(createSimulationError('simulation-state-unsupported', { path: 'world.entities' }));
  }
  return ok(new Map(entities.map((_, localId) => [localId, handles[localId] as number])));
}

function validateResources(
  world: World,
  resources: readonly SimulationResourceProjection[],
): Result<void, SimulationError> {
  for (const resource of resources) {
    const descriptor = world._getSimulationResourceDescriptors().get(resource.key);
    if (descriptor === undefined || descriptor.schemaFingerprint !== resource.schemaFingerprint) {
      return err(
        createSimulationError('simulation-resource-invalid', {
          key: resource.key,
          path: `resources.${resource.key}`,
        }),
      );
    }
    try {
      descriptor.clone(resource.value);
    } catch {
      return err(
        createSimulationError('simulation-resource-invalid', {
          key: resource.key,
          path: `resources.${resource.key}`,
        }),
      );
    }
  }
  return ok(undefined);
}

/** Restore atomically through staged participants; reject non-fresh targets and schema drift. */
export function restoreSimulationRecord(
  world: World,
  registry: SimulationParticipantRegistry,
  record: SimulationRecordV1,
): Result<void, SimulationError> {
  const validation = validateSimulationRecordV1(record);
  if (!validation.ok) return validation;
  const preflight = registry.preflight(record);
  if (!preflight.ok) return preflight;
  const entityCount = world.inspect().entityCount;
  if (entityCount !== 0) {
    return err(createSimulationError('simulation-target-not-fresh', { entityCount }));
  }
  const resources = validateResources(world, record.world.resources);
  if (!resources.ok) return resources;
  const worldConstructor = world.constructor as new () => World;
  const staging = new worldConstructor();
  const staged = materialize(staging, record.world.entities);
  if (!staged.ok) {
    return err(staged.error);
  }
  const prepared = registry.prepare(record);
  if (!prepared.ok) return prepared;
  const committed = materialize(world, record.world.entities);
  if (!committed.ok) {
    registry.dispose(prepared.value);
    return err(committed.error);
  }
  for (const resource of record.world.resources) {
    const descriptor = world
      ._getSimulationResourceDescriptors()
      .get(resource.key) as RecoverableResourceDescriptor;
    world.insertResource(resource.key, descriptor.clone(resource.value));
  }
  const sourceTime = record.clock.time;
  const targetTime = world.getResource(Time);
  targetTime.delta = sourceTime.delta;
  targetTime.elapsed = sourceTime.elapsed;
  const sourceFixed = record.clock.fixed;
  const targetFixed = world.getResource(FixedTime);
  targetFixed.delta = sourceFixed.delta;
  targetFixed.tick = sourceFixed.tick;
  targetFixed.overstep = sourceFixed.overstep;
  targetFixed.droppedSeconds = sourceFixed.droppedSeconds;
  targetFixed.droppedUpdates = sourceFixed.droppedUpdates;
  registry.commit(prepared.value, {
    entityCount: record.world.entities.length,
    entityMap: committed.value,
  });
  return ok(undefined);
}

export function simulationWorldFingerprint(world: World): string {
  const projection = captureWorldProjection(world);
  if (!projection.ok) return `simulation-world-error:${projection.error.code}`;
  return simulationRecordFingerprint({
    recordTick: world.getResource(FixedTime).tick,
    clock: clockProjection(world),
    world: projection.value,
    participants: [],
    trace: [],
  });
}
