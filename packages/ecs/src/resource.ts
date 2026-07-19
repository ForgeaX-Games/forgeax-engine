// @forgeax/engine-ecs — Resource store: typed key-value global singletons.
//
// Map<string, unknown> backend. insertResource is idempotent (overwrites).
// getResource throws ResourceNotFoundError if key absent.

import { ResourceNotFoundError } from './errors';

// ────────────────────────────────────────────────────────────────────────────
// ResourceStore
// ────────────────────────────────────────────────────────────────────────────

/** Internal resource storage. */
export interface ResourceStore {
  readonly data: Map<string, unknown>;
}

/** Create a fresh resource store. */
export function createResourceStore(): ResourceStore {
  return { data: new Map() };
}

/**
 * Insert or overwrite a resource (idempotent, E-13).
 *
 * @example
 * ```ts
 * import { createResourceStore, insertResource, type ResourceStore } from '@forgeax/engine-ecs';
 *
 * const store: ResourceStore = createResourceStore();
 * insertResource(store, 'health', 100);
 * // overwriting is idempotent (no error / no duplicate slot):
 * insertResource(store, 'health', 95);
 * ```
 */
export function insertResource<T>(store: ResourceStore, key: string, value: T): void {
  store.data.set(key, value);
}

/**
 * Get a resource by key.
 * @throws ResourceNotFoundError if key does not exist (E-14).
 *
 * @example
 * ```ts
 * import { getResource, insertResource, type ResourceStore } from '@forgeax/engine-ecs';
 *
 * declare const store: ResourceStore;
 * insertResource(store, 'health', 100);
 * const hp = getResource<number>(store, 'health');
 * // hp === 100; throws ResourceNotFoundError on missing key (charter proposition 4)
 * ```
 */
export function getResource<T>(store: ResourceStore, key: string): T {
  if (!store.data.has(key)) {
    throw new ResourceNotFoundError(key);
  }
  return store.data.get(key) as T;
}

/**
 * Check if a resource exists.
 *
 * @example
 * ```ts
 * import { hasResource, insertResource, type ResourceStore } from '@forgeax/engine-ecs';
 *
 * declare const store: ResourceStore;
 * insertResource(store, 'health', 100);
 * if (hasResource(store, 'health')) {
 *   // guarded access avoids ResourceNotFoundError from getResource
 * }
 * ```
 */
export function hasResource(store: ResourceStore, key: string): boolean {
  return store.data.has(key);
}

/**
 * Remove a resource by key.
 *
 * @example
 * ```ts
 * import { hasResource, insertResource, removeResource, type ResourceStore } from '@forgeax/engine-ecs';
 *
 * declare const store: ResourceStore;
 * insertResource(store, 'health', 100);
 * removeResource(store, 'health');
 * // hasResource(store, 'health') === false; idempotent on missing keys
 * ```
 */
export function removeResource(store: ResourceStore, key: string): void {
  store.data.delete(key);
}
