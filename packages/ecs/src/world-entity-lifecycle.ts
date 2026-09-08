// @forgeax/engine-ecs — world-entity-lifecycle: entity lifecycle and hierarchy.
//
// Owns entity materialization/retirement plus hierarchy orchestration. Component
// storage remains in WorldComponentAccess; this module composes its typed
// relationship mutations into public lifecycle behavior.

import { err, isRetiredSlot, ok, pack, type Result } from '@forgeax/engine-types';
import type { Component, ComponentSchema, InputShapeOf, ShapeOf } from './component';
import { componentId, componentSchema } from './component';
import { fillComponentDefaults, validateComponentDataKeys } from './component-default-fallback';
import { validateManagedArrayValues, validateSharedFieldValues } from './component-value-validate';
import { Entity } from './entity';
import {
  ENTITY_NULL_RAW,
  type EntityHandle,
  encodeEntity,
  entityGeneration,
  entityIndex,
} from './entity-handle';
import {
  ComponentNotPresentError,
  RelationshipDetachMismatchError,
  RelationshipSelfCycleError,
  StaleEntityError,
  validateEnumFieldValues,
} from './errors';
import { relationshipRole, relationshipSource } from './relationship-index';
import { type Archetype, appendArchetypeRow, removeArchetypeRow } from './storage/archetype';
import type { ArchetypeGraph } from './storage/archetype-graph';
import { getOrCreateArchetype, getTable } from './storage/archetype-graph';
import { removeSparseTag } from './storage/change-detection';
import { appendTableRow, removeTableRow } from './storage/table';
import type { EcsError, World } from './world';
import { worldInternal } from './world-internal';

function tableRow(world: World, record: { archetypeId: number; archetypeRow: number }): number {
  const archetype = world[worldInternal].getGraph().archetypes[record.archetypeId];
  return archetype?.rows[record.archetypeRow] ?? -1;
}

/**
 * Core implementation of `spawn` with a relationship reentry guard.
 *
 * @param internal - `true` when relationship maintenance creates a mirror.
 */
export function spawnCore(
  world: World,
  componentDatas: { component: Component; data: Partial<Record<string, unknown>> }[],
  internal: boolean,
): Result<EntityHandle, EcsError> {
  const filledData: Record<string, unknown>[] = [];
  for (const cd of componentDatas) {
    const preflight = world[worldInternal].preflightComponentData(null, cd);
    if (!preflight.ok) return preflight;
    const keyErr = validateComponentDataKeys(cd.component, cd.data as Record<string, unknown>);
    if (keyErr !== null) return err(keyErr as unknown as EcsError);
    const arrayErr = validateManagedArrayValues(cd.component, cd.data as Record<string, unknown>);
    if (arrayErr !== null) return err(arrayErr as unknown as EcsError);
    const sharedErr = validateSharedFieldValues(cd.component, cd.data as Record<string, unknown>);
    if (sharedErr !== null) return err(sharedErr as unknown as EcsError);
    const filled = fillComponentDefaults(cd.component, cd.data as Record<string, unknown>);
    const enumErr = validateEnumFieldValues(cd.component, filled);
    if (enumErr !== null) return err(enumErr as unknown as EcsError);
    filledData.push(filled as Record<string, unknown>);
  }
  const indexSlot = world[worldInternal].allocateIndex();
  const record = world[worldInternal].getRecords()[indexSlot];
  if (record === undefined)
    return err(
      new Error('Internal: allocateIndex did not initialize record') as unknown as EcsError,
    );
  const componentIds = componentDatas.map((cd) => componentId(cd.component));
  const components = componentDatas.map((cd) => cd.component);
  const graph = world[worldInternal].getGraph();
  const arch = getOrCreateArchetype(graph, componentIds, components);
  const table = getTable(graph, arch.tableId);
  const spawnedEntity = encodeEntity(indexSlot, record.generation);
  const tableRow = appendTableRow(table, spawnedEntity);
  const archetypeRow = appendArchetypeRow(arch, tableRow);
  record.archetypeId = arch.id;
  record.archetypeRow = archetypeRow;
  for (let i = 0; i < componentDatas.length; i++) {
    const cdi = componentDatas[i];
    const fdi = filledData[i];
    if (cdi === undefined || fdi === undefined) continue;
    world[worldInternal].writeRow(arch, cdi.component, tableRow, fdi as ShapeOf<ComponentSchema>);
  }
  world[worldInternal].writeEntitySelf(arch, tableRow, spawnedEntity);
  world[worldInternal].markComponentsAdded(spawnedEntity, [
    componentId(Entity),
    ...componentDatas.map((cd) => componentId(cd.component)),
  ]);
  for (let i = 0; i < componentDatas.length; i++) {
    const cd = componentDatas[i];
    const filled = filledData[i];
    if (!cd || filled === undefined) continue;
    if (!internal && relationshipRole(cd.component as Component)?.kind === 'source') {
      const relation = world[worldInternal].relationshipOnInsert(
        spawnedEntity,
        cd.component as Component,
        filled,
      );
      if (!relation.ok) return relation;
    }
  }
  world[worldInternal].markStructureChanged();
  return ok(spawnedEntity);
}

/**
 * Core implementation of `despawn` with a linked-spawn cascade guard.
 *
 * @param internal - `true` while recursively retiring linked children.
 */
export function despawnCore(
  world: World,
  entity: EntityHandle,
  internal: boolean,
): Result<void, EcsError> {
  const slot = entityIndex(entity);
  const gen = entityGeneration(entity);
  const record = world[worldInternal].getRecords()[slot];
  if (!world[worldInternal].recordIsLive(record, gen)) return ok(undefined);
  const arch = world[worldInternal].getGraph().archetypes[record?.archetypeId];
  const linkedChildren = arch ? relationshipLinkedSpawnChildren(world, entity, arch) : [];
  if (arch) {
    const graph = world[worldInternal].getGraph();
    const table = getTable(graph, arch.tableId);
    const archetypeRow = record.archetypeRow;
    const tableRow = arch.rows[archetypeRow] ?? 0;
    for (const comp of arch.components) {
      const role = relationshipRole(comp);
      const needsOldValue = role?.kind === 'source' && !internal;
      if (needsOldValue) {
        const oldValue = world[worldInternal].readRow(arch, comp, tableRow) as Record<
          string,
          unknown
        >;
        if (role?.kind === 'source' && !internal) {
          const relation = world[worldInternal].relationshipOnRemove(entity, comp, oldValue);
          if (!relation.ok) return relation;
        }
      }
      world[worldInternal].releaseManagedRefsOnRow(arch, comp, tableRow);
    }
    for (const component of arch.components) {
      if (component.storage !== 'sparse') continue;
      const set = graph.sparseTags.get(componentId(component));
      if (set !== undefined) removeSparseTag(set, entity);
    }
    const archetypeSwap = removeArchetypeRow(arch, archetypeRow);
    if (archetypeSwap !== null) {
      const movedEntity = (table.storage.get(componentId(Entity))?.fields.get('self')?.view[
        archetypeSwap.movedTableRow
      ] ?? 0) as EntityHandle;
      const movedRecord = world[worldInternal].getRecords()[entityIndex(movedEntity)];
      if (movedRecord?.generation === entityGeneration(movedEntity)) {
        movedRecord.archetypeRow = archetypeSwap.newRow;
      }
    }
    const tableSwap = removeTableRow(table, tableRow);
    if (tableSwap !== null) {
      const movedRecord = world[worldInternal].getRecords()[entityIndex(tableSwap.movedEntity)];
      if (movedRecord?.generation === entityGeneration(tableSwap.movedEntity)) {
        const movedArchetype = graph.archetypes[movedRecord.archetypeId];
        if (movedArchetype !== undefined) {
          movedArchetype.rows[movedRecord.archetypeRow] = tableSwap.newRow;
        }
      }
    }
  }
  if (record) {
    world[worldInternal].removeEntityChanges(entity);
    record.archetypeId = -1;
    record.archetypeRow = -1;
    record.generation += 1;
    if (!isRetiredSlot(record.generation)) world[worldInternal].getFreeIndices().push(slot);
  }
  for (const child of linkedChildren) despawnCore(world, child, true);
  world[worldInternal].markStructureChanged();
  return ok(undefined);
}

/** Attach a child and maintain the relationship mirror through component storage. */
export function worldAddChild<S extends ComponentSchema>(
  world: World,
  parent: EntityHandle,
  child: EntityHandle,
  component: Component<string, S>,
  data: Partial<InputShapeOf<S>>,
): Result<void, EcsError> {
  const holderComp = component as Component;
  if (relationshipRole(holderComp)?.kind !== 'source') {
    return err(new ComponentNotPresentError(child as number, component.name));
  }

  const parentSlot = entityIndex(parent);
  const parentGeneration = entityGeneration(parent);
  const parentRecord = world[worldInternal].getRecords()[parentSlot];
  if (!world[worldInternal].recordIsLive(parentRecord, parentGeneration)) {
    return err(
      new StaleEntityError(parent as number, parentSlot, parentGeneration, {
        operation: 'addChild',
        component: component.name,
        expectedGeneration: parentGeneration,
        actualGeneration: world[worldInternal].getRecords()[parentSlot]?.generation ?? -1,
      }),
    );
  }

  const childSlot = entityIndex(child);
  const childGeneration = entityGeneration(child);
  const childRecord = world[worldInternal].getRecords()[childSlot];
  if (!world[worldInternal].recordIsLive(childRecord, childGeneration)) {
    return err(
      new StaleEntityError(child as number, childSlot, childGeneration, {
        operation: 'addChild',
        component: component.name,
        expectedGeneration: childGeneration,
        actualGeneration: world[worldInternal].getRecords()[childSlot]?.generation ?? -1,
      }),
    );
  }

  const role = relationshipRole(holderComp);
  if (child === parent && !(role?.kind === 'source' && role.allowSelf)) {
    return err(new RelationshipSelfCycleError(component.name, child as number, child as number));
  }
  const cycleHit =
    child === parent && role?.kind === 'source' && role.allowSelf
      ? null
      : relationshipChainCycleHit(world, holderComp, parentSlot, parentGeneration, childSlot);
  if (cycleHit !== null) {
    return err(new RelationshipSelfCycleError(component.name, child as number, cycleHit as number));
  }

  return world.addComponent(child, { component, data });
}

/** Detach a child only when its current relationship target matches `parent`. */
export function worldRemoveChild<S extends ComponentSchema>(
  world: World,
  parent: EntityHandle,
  child: EntityHandle,
  component: Component<string, S>,
): Result<void, EcsError> {
  const holderComp = component as Component;
  const childResult = world[worldInternal].lookupAlive(child, 'removeChild', component.name);
  if (!childResult.ok) return childResult;

  const childRecord = childResult.value;
  const childArch = (world[worldInternal].getGraph() as ArchetypeGraph).archetypes[
    childRecord.archetypeId
  ];
  if (!childArch) {
    return err(
      new StaleEntityError(child as number, entityIndex(child), entityGeneration(child), {
        operation: 'removeChild',
        component: component.name,
        expectedGeneration: entityGeneration(child),
        actualGeneration: childRecord.generation,
      }),
    );
  }
  if (
    !childArch.components.some((component) => componentId(component) === componentId(holderComp))
  ) {
    return err(
      new RelationshipDetachMismatchError(component.name, child as number, parent as number, 0),
    );
  }

  const oldValue = world[worldInternal].readRow(
    childArch,
    holderComp,
    tableRow(world, childRecord),
  ) as Record<string, unknown>;
  const currentTarget = relationshipTargetEntity(holderComp, oldValue);
  if (currentTarget !== parent) {
    return err(
      new RelationshipDetachMismatchError(
        component.name,
        child as number,
        parent as number,
        currentTarget ?? 0,
      ),
    );
  }

  return world.removeComponent(child, component);
}

/** Move a child to a new parent after cycle validation and old-mirror detachment. */
export function worldReparent<S extends ComponentSchema>(
  world: World,
  child: EntityHandle,
  newParent: EntityHandle,
  component: Component<string, S>,
  data: Partial<InputShapeOf<S>>,
): Result<void, EcsError> {
  const holderComp = component as Component;
  if (relationshipRole(holderComp)?.kind !== 'source') {
    return err(new ComponentNotPresentError(child as number, component.name));
  }
  const role = relationshipRole(holderComp);
  if (child === newParent && !(role?.kind === 'source' && role.allowSelf)) {
    return err(
      new RelationshipSelfCycleError(component.name, child as number, newParent as number),
    );
  }
  const cycleHit =
    child === newParent && role?.kind === 'source' && role.allowSelf
      ? null
      : relationshipChainCycleHit(
          world,
          holderComp,
          entityIndex(newParent),
          entityGeneration(newParent),
          entityIndex(child),
        );
  if (cycleHit !== null) {
    return err(new RelationshipSelfCycleError(component.name, child as number, cycleHit as number));
  }

  const childResult = world[worldInternal].lookupAlive(child, 'reparent', component.name);
  if (!childResult.ok) return childResult;

  const childRecord = childResult.value;
  const childArch = (world[worldInternal].getGraph() as ArchetypeGraph).archetypes[
    childRecord.archetypeId
  ];
  if (!childArch) {
    return err(
      new StaleEntityError(child as number, entityIndex(child), entityGeneration(child), {
        operation: 'reparent',
        component: component.name,
        expectedGeneration: entityGeneration(child),
        actualGeneration: childRecord.generation,
      }),
    );
  }
  if (
    childArch.components.some((component) => componentId(component) === componentId(holderComp))
  ) {
    const removeResult = world.removeComponent(child, component);
    if (!removeResult.ok) return removeResult;
  }
  return world.addComponent(child, { component, data });
}

/** Iterate ancestors in child-to-root order while safely terminating corrupt cycles. */
export function worldIterAncestors(world: World, entity: EntityHandle): Iterable<EntityHandle> {
  return {
    *[Symbol.iterator]() {
      const records = world[worldInternal].getRecords();
      const slot = entityIndex(entity);
      const generation = entityGeneration(entity);
      if (!world[worldInternal].recordIsLive(records[slot], generation)) return;

      const visited = new Set<number>();
      let currentSlot = slot;
      let currentGeneration = generation;
      while (true) {
        const key = pack(currentSlot, currentGeneration);
        if (visited.has(key)) return;
        visited.add(key);

        const currentRecord = records[currentSlot];
        if (!world[worldInternal].recordIsLive(currentRecord, currentGeneration)) return;
        const currentArch = (world[worldInternal].getGraph() as ArchetypeGraph).archetypes[
          currentRecord.archetypeId
        ];
        if (!currentArch) return;

        let foundParent = false;
        for (const component of currentArch.components) {
          if (
            relationshipRole(component)?.kind !== 'source' ||
            !currentArch.components.some(
              (candidate) => componentId(candidate) === componentId(component),
            )
          )
            continue;
          const value = world[worldInternal].readRow(
            currentArch,
            component,
            tableRow(world, currentRecord),
          ) as Record<string, unknown>;
          const target = relationshipTargetEntity(component, value);
          if (target === null) continue;
          yield target;
          currentSlot = entityIndex(target);
          currentGeneration = entityGeneration(target);
          if (!world[worldInternal].recordIsLive(records[currentSlot], currentGeneration)) return;
          foundParent = true;
          break;
        }
        if (!foundParent) return;
      }
    },
  };
}

/** Iterate descendants depth-first through relationship mirror lists. */
export function worldIterDescendants(world: World, entity: EntityHandle): Iterable<EntityHandle> {
  return {
    *[Symbol.iterator]() {
      const records = world[worldInternal].getRecords();
      const slot = entityIndex(entity);
      const generation = entityGeneration(entity);
      if (!world[worldInternal].recordIsLive(records[slot], generation)) return;

      const visited = new Set<number>();
      const stack: number[] = [slot];
      while (stack.length > 0) {
        const currentSlot = stack.pop();
        if (currentSlot === undefined) break;
        const currentRecord = records[currentSlot];
        if (!currentRecord || currentRecord.archetypeId === -1) continue;
        const currentArch = world[worldInternal].getGraph().archetypes[currentRecord.archetypeId];
        if (!currentArch) continue;

        for (const child of descendantChildren(
          world,
          currentArch,
          tableRow(world, currentRecord),
        )) {
          const childSlot = entityIndex(child);
          const childGeneration = entityGeneration(child);
          const key = pack(childSlot, childGeneration);
          if (
            visited.has(key) ||
            !world[worldInternal].recordIsLive(records[childSlot], childGeneration)
          ) {
            continue;
          }
          visited.add(key);
          yield child;
          stack.push(childSlot);
        }
      }
    },
  };
}

function descendantChildren(world: World, arch: Archetype, row: number): EntityHandle[] {
  const children: EntityHandle[] = [];
  for (const component of arch.components) {
    if (!arch.components.some((candidate) => componentId(candidate) === componentId(component)))
      continue;
    const value = world[worldInternal].readRow(arch, component, row) as Record<string, unknown>;
    for (const [fieldName, fieldType] of Object.entries(componentSchema(component))) {
      if (fieldType !== 'array<entity>') continue;
      const list = value[fieldName];
      if (!(list instanceof Uint32Array)) continue;
      for (const raw of list) children.push(raw as EntityHandle);
    }
  }
  return children;
}

function relationshipTargetEntity(
  component: Component,
  value: Record<string, unknown>,
): EntityHandle | null {
  for (const [fieldName, fieldType] of Object.entries(componentSchema(component))) {
    if (fieldType !== 'entity') continue;
    const raw = value[fieldName];
    if (raw === null || raw === undefined || raw === ENTITY_NULL_RAW) return null;
    return raw as EntityHandle;
  }
  return null;
}

function relationshipChainCycleHit(
  world: World,
  holderComponent: Component,
  startSlot: number,
  startGeneration: number,
  targetSlot: number,
): EntityHandle | null {
  const visited = new Set<number>();
  let currentSlot = startSlot;
  let currentGeneration = startGeneration;
  while (true) {
    const key = pack(currentSlot, currentGeneration);
    if (visited.has(key)) return null;
    visited.add(key);
    const currentRecord = world[worldInternal].getRecords()[currentSlot];
    if (!world[worldInternal].recordIsLive(currentRecord, currentGeneration)) return null;
    const currentArchetype = (world[worldInternal].getGraph() as ArchetypeGraph).archetypes[
      currentRecord.archetypeId
    ];
    if (
      !currentArchetype?.components.some(
        (candidate) => componentId(candidate) === componentId(holderComponent),
      )
    )
      return null;
    const value = world[worldInternal].readRow(
      currentArchetype,
      holderComponent,
      tableRow(world, currentRecord),
    ) as Record<string, unknown>;
    const target = relationshipTargetEntity(holderComponent, value);
    if (target === null) return null;
    const targetEntitySlot = entityIndex(target);
    if (targetEntitySlot === targetSlot) return target;
    currentSlot = targetEntitySlot;
    currentGeneration = entityGeneration(target);
  }
}

function linkedSpawnMirrorField(mirror: Component): string | undefined {
  const source = relationshipSource(mirror);
  const role = source === undefined ? undefined : relationshipRole(source);
  return role?.kind === 'source' && role.linkedSpawn ? role.targetField : undefined;
}

function relationshipLinkedSpawnChildren(
  world: World,
  entity: EntityHandle,
  arch: Archetype,
): EntityHandle[] {
  const record = world[worldInternal].getRecords()[entityIndex(entity)];
  const row = record === undefined ? -1 : tableRow(world, record);
  const collected: EntityHandle[] = [];
  for (const component of arch.components) {
    const mirrorField = linkedSpawnMirrorField(component);
    if (mirrorField === undefined) continue;
    const snapshot = world[worldInternal].readRow(arch, component, row) as Record<string, unknown>;
    const list = snapshot[mirrorField];
    if (!(list instanceof Uint32Array)) continue;
    for (const raw of list) {
      if (raw !== ENTITY_NULL_RAW) collected.push(raw as EntityHandle);
    }
  }
  return collected;
}
