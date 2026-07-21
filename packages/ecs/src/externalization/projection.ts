// @forgeax/engine-ecs — externalization projection kernel.
//
// Pure ECS module: reads reflection-owned schema facts (arrayMeta, transient,
// field types) to produce owned, portable snapshots with injectable entity
// remapping. No network, peer, wire, profile, or codec policy.

import type { Component, ComponentSchema } from '../component';
import { fillComponentDefaults } from '../component-default-fallback';
import { classifyEntityField } from './remap';

/**
 * Copy a value deeply so the result is an owned snapshot.
 */
function deepCopyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...(value as readonly unknown[])];
  }
  if (
    value instanceof Float32Array ||
    value instanceof Int32Array ||
    value instanceof Uint32Array ||
    value instanceof Float64Array ||
    value instanceof Uint8Array ||
    value instanceof Int16Array ||
    value instanceof Uint16Array
  ) {
    return new (value.constructor as new (v: ArrayLike<number>) => unknown)(value);
  }
  return value;
}

/**
 * Project component raw data into an owned snapshot suitable for externalization
 * (scene collection or network replication). This is the pure ECS kernel:
 * no network, peer, wire, or profile policy.
 *
 * - Skips component-level and field-level transient declarations
 * - Deep-copies portable values (owned snapshot)
 * - Applies optional entity remap to `entity` and `array<entity>` fields
 *   using reflection-based classification (classifyEntityField reads arrayMeta)
 * - Fills missing fields with layer-2/layer-3 defaults
 *
 * @param token       Component token with reflection metadata
 * @param raw         Partial raw data (layer-1 explicit values)
 * @param entityRemap Optional transform for entity and array<entity> field values
 * @returns           Owned snapshot with all non-transient, portable fields filled
 */
export function projectComponentData<S extends ComponentSchema>(
  token: Component<string, S>,
  raw: Partial<Record<string, unknown>> | undefined,
  entityRemap?: (entity: number) => number,
): Record<string, unknown> {
  // Component-level transient: no fields are externalized
  if (token.transient) {
    return {};
  }

  const fields = token.fields;
  const rawObj = (raw as Record<string, unknown> | undefined) ?? undefined;
  const schema = token.schema as Record<string, string>;

  // Build input with only non-transient fields, then fill defaults.
  const filtered: Record<string, unknown> = {};

  for (const fieldName of Object.keys(schema)) {
    const fieldType = schema[fieldName];
    if (fieldType === undefined) continue;

    // Skip field-level transient in the input
    const fieldRefl = fields?.[fieldName];
    if (fieldRefl?.transient === true) continue;

    if (rawObj !== undefined && fieldName in rawObj) {
      const value = rawObj[fieldName];
      if (value !== undefined) {
        // Use reflection-based classification (arrayMeta) instead of string
        // matching. classifyEntityField reads arrayMeta.elementType and
        // arrayMeta.length presence to determine entity/array<entity> status.
        const kind = classifyEntityField(token, fieldName);
        if (kind !== null) {
          // Entity / array<entity> field — apply remap
          if (kind.isArray && (Array.isArray(value) || ArrayBuffer.isView(value))) {
            const arr = Array.from(value as ArrayLike<number>, (entity) =>
              entityRemap !== undefined ? entityRemap(entity) : entity,
            );
            filtered[fieldName] = arr;
          } else if (!kind.isArray && typeof value === 'number') {
            filtered[fieldName] = entityRemap !== undefined ? entityRemap(value) : value;
          } else {
            filtered[fieldName] = deepCopyValue(value);
          }
        } else {
          filtered[fieldName] = deepCopyValue(value);
        }
      }
    }
  }

  // fillComponentDefaults adds ALL schema fields. We must then delete
  // transient fields from the result because fillComponentDefaults doesn't
  // know about field-level transient.
  const result = fillComponentDefaults(token, filtered as Partial<Record<string, unknown>>);

  if (fields !== undefined) {
    for (const fieldName of Object.keys(schema)) {
      const fieldRefl = fields[fieldName];
      if (fieldRefl?.transient === true) {
        delete result[fieldName];
      }
    }
  }

  return result;
}

/**
 * Returns `true` when the component has at least one non-transient field
 * and the component itself is not transient.
 */
export function isComponentPortable(token: Component): boolean {
  if (token.transient) return false;
  const fields = token.fields;
  if (fields === undefined) return true; // No field reflection — assume portable
  const schema = token.schema as Record<string, string>;
  for (const fieldName of Object.keys(schema)) {
    const fieldRefl = fields[fieldName];
    if (fieldRefl?.transient !== true) return true;
  }
  return false;
}

/**
 * Returns `true` when the component carries no portable fields: either the
 * component-level `transient` flag is set, or every declared field is
 * field-level transient.
 */
export function isComponentFullyTransient(token: Component): boolean {
  return !isComponentPortable(token);
}

/**
 * Returns `true` when the schema field type is a portable value that can be
 * copied across World boundaries. Portable: numeric scalars, bool, enum,
 * string, entity, buffer, buffer<N>, array<T>, array<T,N> (with portable T).
 * Non-portable: ref, unique<T>, shared<T> — these are process-local
 * references.
 */
export function isFieldPortable(fieldType: string): boolean {
  if (fieldType === 'ref') return false;
  if (fieldType.startsWith('unique<')) return false;
  if (fieldType.startsWith('shared<')) return false;
  return true;
}

/**
 * Structured error for a single component in a profile selection that cannot
 * be replicated.
 */
export interface ProfileComponentError {
  readonly component: string;
  readonly code: 'component-fully-transient' | 'field-not-portable';
  readonly field?: string;
  readonly fieldType?: string;
  readonly expected: string;
  readonly hint: string;
}

/**
 * Validate that a set of component tokens is suitable for externalization
 * (replication profile selection). Rejects:
 * - Fully transient components (component-level transient or all fields transient)
 * - Components with non-portable field types (unique<T>, shared<T>, ref)
 */
export function validateProfileComponents(components: readonly Component[]): {
  readonly valid: boolean;
  readonly errors: readonly ProfileComponentError[];
} {
  const errors: ProfileComponentError[] = [];

  for (const token of components) {
    // Check fully transient
    if (isComponentFullyTransient(token)) {
      errors.push({
        component: token.name,
        code: 'component-fully-transient',
        expected: `Component '${token.name}' must have at least one non-transient, portable field`,
        hint: `Remove the component-level transient flag or declare at least one field as non-transient`,
      });
      continue;
    }

    // Check each field for non-portable types
    const schema = token.schema as Record<string, string>;
    const fields = token.fields;
    if (fields !== undefined) {
      for (const fieldName of Object.keys(schema)) {
        const fieldType = schema[fieldName];
        if (fieldType === undefined) continue;
        // Skip transient fields — they won't be in the projection
        const fieldRefl = fields[fieldName];
        if (fieldRefl?.transient === true) continue;

        if (!isFieldPortable(fieldType)) {
          errors.push({
            component: token.name,
            code: 'field-not-portable',
            field: fieldName,
            fieldType: fieldType,
            expected: `Field '${fieldName}' of component '${token.name}' must be a portable type (numeric, bool, enum, string, entity, buffer, or array)`,
            hint: `Field type '${fieldType}' is a process-local reference and cannot be replicated across Worlds`,
          });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
