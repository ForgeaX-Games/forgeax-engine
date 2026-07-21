// @forgeax/engine-ecs — world-entity-lifecycle: entity lifecycle and hierarchy.
//
// Owns entity materialization/retirement plus hierarchy orchestration. Component
// storage remains in WorldComponentAccess; this module composes its typed
// relationship mutations into public lifecycle behavior.

import { err, isRetiredSlot, ok, pack, type Result } from '@forgeax/engine-types';
import { type Archetype, appendEntity, removeEntity } from './archetype';
import { getOrCreateArchetype } from './archetype-graph';
import {
  type Component,
  type ComponentSchema,
  type InputShapeOf,
  RELATIONSHIP_COMPONENTS,
  type ShapeOf,
} from './component';
import { fillComponentDefaults, validateComponentDataKeys } from './component-default-fallback';
import { validateSharedFieldValues } from './component-value-validate';
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
} from './errors';
import type { ComponentData, EcsError, World } from './world';

/**
 * Core implementation of `spawn` with a relationship reentry guard.
 *
 * @param internal - `true` when relationship hook machinery creates a mirror.
 */
export function spawnCore(
  world: World,
  componentDatas: { component: Component; data: Partial<Record<string, unknown>> }[],
  internal: boolean,
): Result<EntityHandle, EcsError> {
  componentDatas = world._expandCoAttach(componentDatas as ComponentData[]) as ComponentData[];
  const filledData: Record<string, unknown>[] = [];
  for (const cd of componentDatas) {
    const keyErr = validateComponentDataKeys(cd.component, cd.data as Record<string, unknown>);
    if (keyErr !== null) return err(keyErr as unknown as EcsError);
    const sharedErr = validateSharedFieldValues(cd.component, cd.data as Record<string, unknown>);
    if (sharedErr !== null) return err(sharedErr as unknown as EcsError);
    const filled = fillComponentDefaults(cd.component, cd.data as Record<string, unknown>);
    filledData.push(filled as Record<string, unknown>);
    if (cd.component.validate !== undefined) {
      const validationError = cd.component.validate(filled as Record<string, unknown>);
      if (validationError !== null && validationError !== undefined)
        return err(validationError as EcsError);
    }
  }
  for (const cd of componentDatas) {
    const cardinalityErr = world._checkCardinality(cd.component as Component, 1);
    if (cardinalityErr !== null) return err(cardinalityErr as unknown as EcsError);
  }
  const indexSlot = world._allocateIndex();
  const record = world._getRecords()[indexSlot];
  if (record === undefined)
    return err(
      new Error('Internal: allocateIndex did not initialize record') as unknown as EcsError,
    );
  const componentIds = componentDatas.map((cd) => cd.component.id);
  const components = componentDatas.map((cd) => cd.component);
  const arch = getOrCreateArchetype(world._getGraph(), componentIds, components);
  const row = appendEntity(arch, indexSlot);
  for (let i = 0; i < componentDatas.length; i++) {
    const cdi = componentDatas[i];
    const fdi = filledData[i];
    if (cdi === undefined || fdi === undefined) continue;
    world._writeRow(arch, cdi.component, row, fdi as ShapeOf<ComponentSchema>);
  }
  record.archetypeId = arch.id;
  record.row = row;
  const spawnedEntity = encodeEntity(indexSlot, record.generation);
  world._writeEntitySelf(arch, row, spawnedEntity);
  for (let i = 0; i < componentDatas.length; i++) {
    const cd = componentDatas[i];
    const filled = filledData[i];
    if (!cd || filled === undefined) continue;
    const onInsert = (cd.component as Component).onInsert;
    if (onInsert) onInsert(spawnedEntity, filled);
    if (!internal && (cd.component as Component).relationship) {
      world._relationshipOnInsert(spawnedEntity, cd.component as Component, filled);
    }
  }
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
  const record = world._getRecords()[slot];
  if (!world._recordIsLive(record, gen)) return ok(undefined);
  const arch = world._getGraph().archetypes[record?.archetypeId];
  const linkedChildren = arch ? relationshipLinkedSpawnChildren(world, entity, arch) : [];
  if (arch) {
    for (const comp of arch.components) {
      const onRemove = comp.onRemove;
      const rel = comp.relationship;
      const needsOldValue = onRemove !== undefined || (rel !== undefined && !internal);
      if (needsOldValue) {
        const oldValue = world._readRow(arch, comp, record?.row) as Record<string, unknown>;
        if (onRemove) onRemove(entity, oldValue);
        if (rel !== undefined && !internal) world._relationshipOnRemove(entity, comp, oldValue);
      }
      world._releaseManagedRefsOnRow(arch, comp, record?.row);
    }
    const swapResult = removeEntity(arch, record?.row);
    if (swapResult) {
      const swappedRecord = world._getRecords()[swapResult.movedEntity];
      if (swappedRecord) swappedRecord.row = swapResult.newRow;
    }
  }
  if (record) {
    record.archetypeId = -1;
    record.row = -1;
    record.generation += 1;
    if (!isRetiredSlot(record.generation)) world._getFreeIndices().push(slot);
  }
  for (const child of linkedChildren) despawnCore(world, child, true);
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
  if (holderComp.relationship === undefined) {
    return err(new ComponentNotPresentError(child as number, component.name));
  }

  const parentSlot = entityIndex(parent);
  const parentGeneration = entityGeneration(parent);
  const parentRecord = world._getRecords()[parentSlot];
  if (!world._recordIsLive(parentRecord, parentGeneration)) {
    return err(
      new StaleEntityError(parent as number, parentSlot, parentGeneration, {
        operation: 'addChild',
        component: component.name,
        expectedGeneration: parentGeneration,
        actualGeneration: world._getRecords()[parentSlot]?.generation ?? -1,
      }),
    );
  }

  const childSlot = entityIndex(child);
  const childGeneration = entityGeneration(child);
  const childRecord = world._getRecords()[childSlot];
  if (!world._recordIsLive(childRecord, childGeneration)) {
    return err(
      new StaleEntityError(child as number, childSlot, childGeneration, {
        operation: 'addChild',
        component: component.name,
        expectedGeneration: childGeneration,
        actualGeneration: world._getRecords()[childSlot]?.generation ?? -1,
      }),
    );
  }

  if (child === parent) {
    return err(new RelationshipSelfCycleError(component.name, child as number, child as number));
  }
  const cycleHit = relationshipChainCycleHit(
    world,
    holderComp,
    parentSlot,
    parentGeneration,
    childSlot,
  );
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
  const childResult = world._lookupAlive(child, 'removeChild', component.name);
  if (!childResult.ok) return childResult;

  const childRecord = childResult.value;
  const childArch = world._getGraph().archetypes[childRecord.archetypeId];
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
  if (!childArch.columns.has(holderComp.id)) {
    return err(
      new RelationshipDetachMismatchError(component.name, child as number, parent as number, 0),
    );
  }

  const oldValue = world._readRow(childArch, holderComp, childRecord.row) as Record<
    string,
    unknown
  >;
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
  if (holderComp.relationship === undefined) {
    return err(new ComponentNotPresentError(child as number, component.name));
  }
  if (child === newParent) {
    return err(
      new RelationshipSelfCycleError(component.name, child as number, newParent as number),
    );
  }
  const cycleHit = relationshipChainCycleHit(
    world,
    holderComp,
    entityIndex(newParent),
    entityGeneration(newParent),
    entityIndex(child),
  );
  if (cycleHit !== null) {
    return err(new RelationshipSelfCycleError(component.name, child as number, cycleHit as number));
  }

  const childResult = world._lookupAlive(child, 'reparent', component.name);
  if (!childResult.ok) return childResult;

  const childRecord = childResult.value;
  const childArch = world._getGraph().archetypes[childRecord.archetypeId];
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
  if (childArch.columns.has(holderComp.id)) {
    const removeResult = world.removeComponent(child, component);
    if (!removeResult.ok) return removeResult;
  }
  return world.addComponent(child, { component, data });
}

/** Iterate ancestors in child-to-root order while safely terminating corrupt cycles. */
export function worldIterAncestors(world: World, entity: EntityHandle): Iterable<EntityHandle> {
  return {
    *[Symbol.iterator]() {
      const records = world._getRecords();
      const slot = entityIndex(entity);
      const generation = entityGeneration(entity);
      if (!world._recordIsLive(records[slot], generation)) return;

      const visited = new Set<number>();
      let currentSlot = slot;
      let currentGeneration = generation;
      while (true) {
        const key = pack(currentSlot, currentGeneration);
        if (visited.has(key)) return;
        visited.add(key);

        const currentRecord = records[currentSlot];
        if (!world._recordIsLive(currentRecord, currentGeneration)) return;
        const currentArch = world._getGraph().archetypes[currentRecord.archetypeId];
        if (!currentArch) return;

        let foundParent = false;
        for (const component of currentArch.components) {
          if (component.relationship === undefined || !currentArch.columns.has(component.id))
            continue;
          const value = world._readRow(currentArch, component, currentRecord.row) as Record<
            string,
            unknown
          >;
          const target = relationshipTargetEntity(component, value);
          if (target === null) continue;
          yield target;
          currentSlot = entityIndex(target);
          currentGeneration = entityGeneration(target);
          if (!world._recordIsLive(records[currentSlot], currentGeneration)) return;
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
      const records = world._getRecords();
      const slot = entityIndex(entity);
      const generation = entityGeneration(entity);
      if (!world._recordIsLive(records[slot], generation)) return;

      const visited = new Set<number>();
      const stack: number[] = [slot];
      while (stack.length > 0) {
        const currentSlot = stack.pop();
        if (currentSlot === undefined) break;
        const currentRecord = records[currentSlot];
        if (!currentRecord || currentRecord.archetypeId === -1) continue;
        const currentArch = world._getGraph().archetypes[currentRecord.archetypeId];
        if (!currentArch) continue;

        for (const child of descendantChildren(world, currentArch, currentRecord.row)) {
          const childSlot = entityIndex(child);
          const childGeneration = entityGeneration(child);
          const key = pack(childSlot, childGeneration);
          if (visited.has(key) || !world._recordIsLive(records[childSlot], childGeneration)) {
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
    if (!arch.columns.has(component.id)) continue;
    const value = world._readRow(arch, component, row) as Record<string, unknown>;
    for (const [fieldName, fieldType] of Object.entries(component.schema)) {
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
  for (const [fieldName, fieldType] of Object.entries(component.schema)) {
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
    const currentRecord = world._getRecords()[currentSlot];
    if (!world._recordIsLive(currentRecord, currentGeneration)) return null;
    const currentArchetype = world._getGraph().archetypes[currentRecord.archetypeId];
    if (!currentArchetype?.columns.has(holderComponent.id)) return null;
    const value = world._readRow(currentArchetype, holderComponent, currentRecord.row) as Record<
      string,
      unknown
    >;
    const target = relationshipTargetEntity(holderComponent, value);
    if (target === null) return null;
    const targetEntitySlot = entityIndex(target);
    if (targetEntitySlot === targetSlot) return target;
    currentSlot = targetEntitySlot;
    currentGeneration = entityGeneration(target);
  }
}

function linkedSpawnMirrorField(mirrorName: string): string | undefined {
  for (const holderComponent of RELATIONSHIP_COMPONENTS) {
    const relationship = holderComponent.relationship;
    if (relationship?.linkedSpawn === true && relationship.mirror === mirrorName) {
      return relationship.field;
    }
  }
  return undefined;
}

function relationshipLinkedSpawnChildren(
  world: World,
  entity: EntityHandle,
  arch: Archetype,
): EntityHandle[] {
  const row = world._getRecords()[entityIndex(entity)]?.row ?? -1;
  const collected: EntityHandle[] = [];
  for (const component of arch.components) {
    const mirrorField = linkedSpawnMirrorField(component.name);
    if (mirrorField === undefined) continue;
    const snapshot = world._readRow(arch, component, row) as Record<string, unknown>;
    const list = snapshot[mirrorField];
    if (!(list instanceof Uint32Array)) continue;
    for (const raw of list) {
      if (raw !== ENTITY_NULL_RAW) collected.push(raw as EntityHandle);
    }
  }
  return collected;
}
