// @forgeax/engine-import - ImporterRegistry (feat-20260603-asset-import-loader-injection M2 / w14).
//
// The build-time twin of the runtime LoaderRegistry
// (packages/runtime/src/loader-registry.ts): an injectable table that maps a
// `meta.importer` string key -> an `Importer` (the contract SSOT lives in
// `@forgeax/engine-types`). The import runner holds one of these and dispatches
// on `meta.importer` through `get(key)` instead of a hardcoded
// `if (importer === ...)` chain (plan-strategy D-1).
//
// Shape mirrors the runtime LoaderRegistry + Console `Registry`
// (packages/console/src/registry.ts) register/lookup pattern (research
// Finding 8). The injected unit is an **object** `{ key, import }`, not a bare
// function, so a "one importer key -> one Importer" dispatch table is the
// natural shape.
//
// Fail-fast semantics (charter P3): `register` throws on a malformed importer
// (empty key or non-function `import`) at wire time, so a misconfigured host
// surfaces immediately rather than at the first import run. `register` is
// idempotent on a repeated key (last write wins, no throw) so re-wiring a
// registry across build invocations is safe.

import type { Importer } from '@forgeax/engine-types';

/**
 * Injectable `meta.importer` -> {@link Importer} table held by the import
 * runner.
 *
 * @example Wire + dispatch (build tooling side)
 * ```ts
 * import { ImporterRegistry } from '@forgeax/engine-import';
 * import { gltfImporter } from '@forgeax/engine-gltf';
 * const importers = new ImporterRegistry();
 * importers.register(gltfImporter);
 * const gltf = importers.get('gltf'); // Importer | undefined
 * ```
 */
export class ImporterRegistry {
  private readonly importers = new Map<string, Importer>();

  /**
   * Register an importer for its `importer.key`. Fail-fast on a malformed
   * importer (charter P3); idempotent on a repeated key (last write wins).
   *
   * @param importer the `{ key, import }` object to register.
   * @throws TypeError when `importer.key` is empty or `importer.import` is not
   *   a function - a wire-time misconfiguration the host must fix.
   */
  register(importer: Importer): void {
    if (typeof importer.key !== 'string' || importer.key.length === 0) {
      throw new TypeError(
        `ImporterRegistry.register: importer.key must be a non-empty string (got ${JSON.stringify(importer.key)})`,
      );
    }
    if (typeof importer.import !== 'function') {
      throw new TypeError(
        `ImporterRegistry.register: importer.import must be a function for key "${importer.key}"`,
      );
    }
    this.importers.set(importer.key, importer);
  }

  /**
   * Look up the importer registered for `key`. Returns `undefined` when no
   * importer is wired - the import runner maps that to a structured
   * `ImportError(code='importer-not-registered')` with the registered keys in
   * `.detail.registeredImporters` (charter P3).
   */
  get(key: string): Importer | undefined {
    return this.importers.get(key);
  }

  /**
   * The importer keys currently wired, in insertion order. Fed into the
   * `importer-not-registered` error `.detail.registeredImporters` so AI users
   * see exactly what is injectable.
   */
  registeredImporters(): readonly string[] {
    return [...this.importers.keys()];
  }
}
