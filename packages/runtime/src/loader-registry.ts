// @forgeax/engine-runtime - LoaderRegistry (feat-20260603-asset-import-loader-injection M1 / w2).
//
// The runtime half of the engine's third DIP instance (after RHI + Console):
// an injectable table that maps `asset.kind` -> a `Loader` (the contract SSOT
// lives in `@forgeax/engine-types`, plan-strategy D-2). `AssetRegistry` holds
// one of these (constructor-injected, D-7) and dispatches `loadByGuid` through
// `get(kind)` instead of a hardcoded `if (kind === ...)` chain (D-1).
//
// Shape mirrors the Console `Registry` (packages/console/src/registry.ts)
// register/lookup pattern (research Finding 8), with one deliberate
// difference: the injected unit here is an **object** `{ kind, load }`, not a
// bare function, because a "one kind -> one loader" dispatch table is the
// natural shape (plan-strategy D-1 alt-B rejection).
//
// Fail-fast semantics (charter P3): `register` throws on a malformed loader
// (empty kind or non-function `load`) at wire time, so a misconfigured host
// surfaces immediately rather than at the first `loadByGuid`. `register` is
// idempotent on a repeated kind (last write wins, no throw) so re-wiring a
// registry across hot reloads is safe.

import type { Loader } from '@forgeax/engine-types';

/**
 * Injectable `asset.kind` -> {@link Loader} table held by `AssetRegistry`.
 *
 * @example Wire + dispatch (host side)
 * ```ts
 * import { LoaderRegistry, wireDefaultLoaders } from '@forgeax/engine-runtime';
 * const loaders = new LoaderRegistry();
 * wireDefaultLoaders(loaders);
 * const meshLoader = loaders.get('mesh'); // Loader | undefined
 * ```
 */
export class LoaderRegistry {
  private readonly loaders = new Map<string, Loader>();

  /**
   * Register a loader for its `loader.kind`. Fail-fast on a malformed loader
   * (charter P3); idempotent on a repeated kind (last write wins).
   *
   * @param loader the `{ kind, load }` object to register.
   * @throws TypeError when `loader.kind` is empty or `loader.load` is not a
   *   function — a wire-time misconfiguration the host must fix.
   */
  register(loader: Loader): void {
    if (typeof loader.kind !== 'string' || loader.kind.length === 0) {
      throw new TypeError(
        `LoaderRegistry.register: loader.kind must be a non-empty string (got ${JSON.stringify(loader.kind)})`,
      );
    }
    if (typeof loader.load !== 'function') {
      throw new TypeError(
        `LoaderRegistry.register: loader.load must be a function for kind "${loader.kind}"`,
      );
    }
    this.loaders.set(loader.kind, loader);
  }

  /**
   * Look up the loader registered for `kind`. Returns `undefined` when no
   * loader is wired — the `AssetRegistry` consumer maps that to a structured
   * `AssetError(code='loader-not-registered')` with the registered kinds in
   * `.detail` (charter P3).
   */
  get(kind: string): Loader | undefined {
    return this.loaders.get(kind);
  }

  /**
   * The kinds currently wired, in insertion order. Fed into the
   * `loader-not-registered` error `.detail.registeredKinds` so AI users see
   * exactly what is injectable.
   */
  registeredKinds(): readonly string[] {
    return [...this.loaders.keys()];
  }
}
