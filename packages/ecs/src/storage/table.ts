import {
  bufferFieldByteLength,
  type Component,
  type ComponentId,
  fieldTypeToMetaKey,
  isManagedBufferField,
  parseManagedArraySchema,
  type ScalarFieldType,
  TYPE_METADATA,
} from '../component';
import { Entity, foldEssentials } from '../entity';
import type { EntityHandle } from '../entity-handle';
import {
  type ComponentEpochColumns,
  copyComponentEpoch,
  createComponentEpochColumns,
  growComponentEpochColumns,
} from './change-epoch';
import { arrayCountColumnName, type Column, createColumn, growColumn } from './column';

const INITIAL_CAPACITY = 64;

export type TableId = number;

export interface TableComponentStorage {
  readonly component: Component;
  fields: Map<string, Column>;
  epochs: ComponentEpochColumns;
}

export interface Table {
  readonly id: TableId;
  readonly key: string;
  readonly components: ReadonlyArray<Component>;
  storage: Map<ComponentId, TableComponentStorage>;
  size: number;
  capacity: number;
  version: number;
}

export function tableKey(componentIds: ReadonlyArray<ComponentId>): string {
  return [...foldEssentials(componentIds)].sort((a, b) => a - b).join('+');
}

export function canonicalComponents(components: ReadonlyArray<Component>): Component[] {
  const byId = new Map<ComponentId, Component>();
  byId.set(Entity.id, Entity as unknown as Component);
  for (const component of components) byId.set(component.id, component);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function createTable(
  components: ReadonlyArray<Component>,
  id: TableId,
  shared = false,
): Table {
  const sortedComponents = canonicalComponents(components);
  const capacity = INITIAL_CAPACITY;
  const storage = new Map<ComponentId, TableComponentStorage>();
  for (const component of sortedComponents) {
    const fields = new Map<string, Column>();
    for (const [fieldName, fieldType] of Object.entries(component.schema)) {
      const arrayMeta = parseManagedArraySchema(fieldType);
      if (arrayMeta !== null && arrayMeta.length !== undefined) {
        const metaKey = fieldTypeToMetaKey(arrayMeta.elementType);
        const scalarType: ScalarFieldType | null =
          metaKey === null ? null : (TYPE_METADATA[metaKey]?.storage ?? null);
        if (scalarType !== null) {
          fields.set(fieldName, createColumn(scalarType, capacity, arrayMeta.length, shared));
        }
        continue;
      }
      if (isManagedBufferField(fieldType) && fieldType !== 'buffer') {
        fields.set(
          fieldName,
          createColumn('u8', capacity, bufferFieldByteLength(fieldType), shared),
        );
        continue;
      }
      const metaKey = fieldTypeToMetaKey(fieldType);
      const scalarType: ScalarFieldType | null =
        metaKey === null ? null : (TYPE_METADATA[metaKey]?.storage ?? null);
      if (scalarType === null) continue;
      fields.set(fieldName, createColumn(scalarType, capacity, 1, shared));
      if (arrayMeta !== null && arrayMeta.length === undefined) {
        fields.set(arrayCountColumnName(fieldName), createColumn('u32', capacity, 1, shared));
      }
    }
    storage.set(component.id, {
      component,
      fields,
      epochs: createComponentEpochColumns(capacity),
    });
  }
  return {
    id,
    key: tableKey(sortedComponents.map((component) => component.id)),
    components: sortedComponents,
    storage,
    size: 0,
    capacity,
    version: 0,
  };
}

export function appendTableRow(table: Table, entity: EntityHandle): number {
  if (table.size === table.capacity) growTable(table, table.capacity * 2);
  const row = table.size;
  const self = table.storage.get(Entity.id)?.fields.get('self');
  if (self !== undefined) self.view[row] = entity as number;
  table.size = row + 1;
  return row;
}

export function removeTableRow(
  table: Table,
  row: number,
): { movedEntity: EntityHandle; newRow: number } | null {
  const lastRow = table.size - 1;
  if (row === lastRow) {
    table.size = lastRow;
    return null;
  }
  const movedEntity = (table.storage.get(Entity.id)?.fields.get('self')?.view[lastRow] ??
    0) as EntityHandle;
  for (const componentStorage of table.storage.values()) {
    for (const column of componentStorage.fields.values()) {
      const arity = column.arity;
      column.view.set(column.view.subarray(lastRow * arity, lastRow * arity + arity), row * arity);
    }
    copyComponentEpoch(componentStorage.epochs, lastRow, componentStorage.epochs, row);
  }
  table.size = lastRow;
  return { movedEntity, newRow: row };
}

export function growTable(table: Table, targetCapacity: number): void {
  let capacity = table.capacity;
  while (capacity < targetCapacity) capacity *= 2;
  if (capacity === table.capacity) return;
  for (const componentStorage of table.storage.values()) {
    const fields = new Map<string, Column>();
    for (const [fieldName, column] of componentStorage.fields) {
      fields.set(fieldName, growColumn(column, capacity));
    }
    componentStorage.fields = fields;
    componentStorage.epochs = growComponentEpochColumns(componentStorage.epochs, capacity);
  }
  table.capacity = capacity;
  table.version += 1;
}
