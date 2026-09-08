import type { Component, FieldReflection, SchemaFieldType } from './component';

/** The complete storage placement vocabulary owned by ECS schema. */
export type ComponentStorageKind = 'table' | 'sparse';

/** The stable public facts needed to describe a component schema offline. */
export interface ComponentSchemaDefinition {
  readonly name: string;
  readonly fields: Readonly<Record<string, SchemaFieldType>>;
  readonly storage: ComponentStorageKind;
}

/**
 * Serialization facts owned beside schema registration, not carried by the
 * public component token. Queries and storage only need the token's schema
 * vocabulary; domain validation and lifecycle belong to their owners.
 */
export interface ComponentPolicy {
  readonly transient: boolean;
  readonly meta: Record<string, unknown>;
}

/** Immutable schema reflection plus non-token policy projection. */
export interface ComponentDefinition {
  readonly fields: Readonly<Record<string, FieldReflection>>;
  readonly defaults: Readonly<Record<string, unknown>> | undefined;
  readonly policy: ComponentPolicy;
}

// Component tokens can cross independently bundled ECS entry points. Share
// the owner registry through globalThis rather than attaching a hidden symbol
// to each token; `Reflect.ownKeys(token)` must remain exactly the three public
// facts name/fields/storage.
const COMPONENT_REGISTRY = Symbol.for('forgeax.ecs.componentRegistry');
interface ComponentRegistry {
  readonly definitions: WeakMap<object, ComponentDefinition>;
}
const globalSymbols = globalThis as typeof globalThis & { [key: symbol]: unknown };
const definitions =
  (globalSymbols[COMPONENT_REGISTRY] as ComponentRegistry | undefined) ??
  (() => {
    const registry: ComponentRegistry = { definitions: new WeakMap<object, ComponentDefinition>() };
    globalSymbols[COMPONENT_REGISTRY] = registry;
    return registry;
  })();

export function registerComponentDefinition(
  component: Component,
  definition: ComponentDefinition,
): void {
  definitions.definitions.set(component, definition);
}

/** Read the definition-time schema/policy projection for a component token. */
export function componentDefinition(component: Component): ComponentDefinition {
  const definition = definitions.definitions.get(component);
  if (definition === undefined) {
    throw new Error(`Component definition missing for '${component.name}'.`);
  }
  return definition;
}

/**
 * Freeze a schema value recursively.  Component descriptors are authored data,
 * so nested defaults and enum label maps must not become mutation channels.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value as Readonly<T>;
  }
  // Non-empty TypedArrays reject Object.freeze and their indexed elements
  // remain writable even when the wrapper is frozen. Treat binary views as
  // immutable leaf projections; the authored descriptor around them is still
  // recursively frozen by this function.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return value as Readonly<T>;
  }
  const object = value as object;
  for (const key of Reflect.ownKeys(object)) {
    const child = (object as Record<PropertyKey, unknown>)[key];
    if (child !== null && (typeof child === 'object' || typeof child === 'function')) {
      deepFreeze(child);
    }
  }
  return Object.freeze(value) as Readonly<T>;
}

export function assertComponentStorage(value: string): asserts value is ComponentStorageKind {
  if (value !== 'table' && value !== 'sparse') {
    throw new Error(`Unsupported component storage '${value}'. Expected 'table' or 'sparse'.`);
  }
}
