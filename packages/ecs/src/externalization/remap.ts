// @forgeax/engine-ecs — externalization entity remap kernel.
//
// Pure ECS module: injectable entity remapping for `entity` and `array<entity>`
// field values. Classification uses reflection arrayMeta rather than schema-text
// parsing. No network, peer, wire, profile, or codec policy.

import type { Component } from '../component';

/**
 * Identifies schema fields that carry entity references and need remapping.
 * Returns `null` for non-entity fields.
 */
export type EntityFieldKind =
  | { readonly kind: 'entity'; readonly isArray: false }
  | { readonly kind: 'entity'; readonly isArray: true };

/**
 * Classify a schema field type to determine whether it carries entity references
 * and whether it's a scalar or array form. Uses reflection metadata (arrayMeta)
 * rather than string parsing.
 *
 * - `entity` → `{ kind: 'entity', isArray: false }`
 * - `array<entity>` or `array<entity, N>` → `{ kind: 'entity', isArray: true }`
 * - Everything else → `null`
 *
 * The classification strength comes from the reflection layer: `arrayMeta` is
 * pre-parsed at registration time and its presence is the SSOT for array-ness.
 * A field with `arrayMeta` and `elementType === 'entity'` is an entity array
 * (both fixed and variable). A field without `arrayMeta` whose type is `entity`
 * is a scalar entity reference.
 */
export function classifyEntityField(token: Component, fieldName: string): EntityFieldKind | null {
  const fields = token.fields;
  if (fields === undefined) return null;

  const fieldRefl = fields[fieldName];
  if (fieldRefl === undefined) return null;

  const arrayMeta = fieldRefl.arrayMeta;
  if (arrayMeta !== undefined) {
    // Has arrayMeta — check if it's an entity array
    if (arrayMeta.elementType === 'entity') {
      return { kind: 'entity', isArray: true };
    }
    return null;
  }

  // No arrayMeta — check if it's a scalar entity
  const schema = token.schema as Record<string, string>;
  const fieldType = schema[fieldName];
  if (fieldType === 'entity') {
    return { kind: 'entity', isArray: false };
  }

  return null;
}

/**
 * Apply entity remapping to a single field value. For scalar `entity` fields,
 * passes the value through the remap function. For `array<entity>` fields,
 * remaps each element.
 *
 * @param value    Raw field value from the component data
 * @param kind     Entity field classification
 * @param remapFn  Entity number → remapped entity number
 * @returns        Remapped value (new array for array<entity>)
 */
export function remapEntityFieldValue(
  value: unknown,
  kind: EntityFieldKind | null,
  remapFn: (entity: number) => number,
): unknown {
  if (kind === null) return value;
  if (kind.isArray) {
    if (!Array.isArray(value)) return value;
    return (value as readonly number[]).map((v: number) => remapFn(v));
  }
  if (typeof value === 'number') return remapFn(value);
  return value;
}

/**
 * Build a remap function from a mapping table where `mapping[sourceId] = targetId`.
 * For values outside the mapping range, returns the identity.
 *
 * @param mapping  Indexed mapping table: source ID → target ID
 * @returns        A function that translates entity numbers
 */
export function createEntityRemap(
  mapping: Uint32Array | readonly number[],
): (entity: number) => number {
  return (entity: number): number => {
    if (entity < 0 || entity >= mapping.length) return entity;
    const mapped = mapping[entity];
    return mapped !== undefined ? mapped : entity;
  };
}
