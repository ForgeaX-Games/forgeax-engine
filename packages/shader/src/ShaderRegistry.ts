// @forgeax/engine-shader/ShaderRegistry — runtime shader registry, instance-per-engine shape.
//
// Shape rules (plan-strategy §S-10 / D-R10 / OQ-5 close + AC-03):
// - instance-per-engine — must be created via
//   `new ShaderRegistry({device, manifestUrl})`; module-level singletons
//   (`export const registry = ...`) and static methods (`static get`) are
//   forbidden — aligned with the instance-based style of
//   `Engine.create({ rhi })`.
// - Physical isolation — this file does **not** import @forgeax/engine-shader-compiler /
//   @forgeax/engine-naga / @forgeax/engine-wgpu-wasm (guarded by the AC-06 triple-grep gate;
//   feat-20260511-naga-rhi-wgpu-merge M4 replaced the legacy single-shim ban
//   with the merged ban list).
// - Result model — `loadManifest()` / `get()` always go through Result.ok /
//   Result.err and **never throw** (AGENTS.md "Errors are structured" / charter
//   proposition 4: explicit failure).
// - 9-member error union — `get()` returns
//   `Result<ShaderModule, RhiError | ShaderError>` (AGENTS.md "RHI / Shader /
//   error-model contract").

import type { Result, RhiError, ShaderModule } from '@forgeax/engine-rhi';
import type { ManifestEntry, ParamSchemaEntry } from '@forgeax/engine-types';
import { findUndeclaredSampledTextures } from '@forgeax/engine-types';
import {
  err,
  manifestMalformed,
  materialShaderNotFound,
  ok,
  type ShaderError,
  type Result as ShaderResult,
  shaderNotFound,
} from './errors.js';
import type { MaterialShaderManifestEntry } from './types.js';

// ─── Device dependency-injection interface ──────────────────────────────────────

/**
 * Device dependency-injection interface — ShaderRegistry does not directly
 * depend on `@forgeax/engine-rhi-webgpu` (physical isolation); the caller (engine or
 * tests) supplies a device-like object that implements
 * `createShaderModule(desc) → Result<ShaderModule, RhiError>`.
 *
 * Difference from the top-level async `createShaderModule(device, desc)` in
 * `@forgeax/engine-rhi-webgpu`:
 * - This interface is synchronous — so `registry.get()` can return a cached
 *   module synchronously.
 * - The caller is responsible for wrapping the async real path into a sync one
 *   (e.g. the engine pre-compiles and caches modules during `loadManifest`).
 *
 * Mock test shape: a direct sync implementation (see `createMockDevice` in
 * src/__tests__/registry.test.ts).
 */
export interface ShaderRegistryDevice {
  createShaderModule(desc: {
    readonly code: string;
    readonly label?: string | undefined;
  }): Result<ShaderModule, RhiError>;
}

// ─── MaterialShader registry types (feat-20260523-shader-template-instance-split M5) ──

/**
 * The `forgeax::` prefix reserves engine-shipped material shader identifiers
 * (plan-strategy D-DefaultStandardPbr-Identifier + §8 charter F1 grep gate).
 * AI users grep `forgeax::` to enumerate every reserved shader identifier in
 * one shot. Custom user-side shaders pick their own identifier path
 * (typically `<package>::<id>`) — anything that is not a `<guid>`
 * (UUIDv5/v7) shape and not `forgeax::*`.
 */
export const FORGEAX_RESERVED_PATH_PREFIX = 'forgeax::' as const;

/**
 * Registered material shader entry — 2-field record stored in the registry
 * by `registerMaterialShader(identifier, entry)` and returned by
 * `lookupMaterialShader(identifier)`.
 *
 * - `source`: composed WGSL source (post-naga_oil); the final form fed to
 *   `device.createShaderModule({ code })` at pipeline-build time.
 * - `paramSchema`: closed list of `{name, type, default?}` triples that the
 *   `MaterialAsset.payload.paramValues` is validated against at register-time
 *   (feat-20260523-shader-template-instance-split M4 3-tier validation). Per
 *   feat-20260613-material-paramschema-driven-binding M3 / w12-w13, the
 *   paramSchema is also the SSOT for the pipeline BGL via
 *   `derive(paramSchema).bglEntries` — there is no longer a separate
 *   `bindingLayout` field on this entry (D-1 / D-2).
 *
 * The shape is symmetric across engine-default + user-custom paths
 * (charter P4 consistent abstraction): both go through the same
 * `registerMaterialShader` API regardless of whether the host wires the
 * default-standard-pbr triple at boot or the user registers a custom
 * shader after asset import.
 */
export interface MaterialShaderEntry {
  readonly source: string;
  readonly paramSchema: readonly ParamSchemaEntry[];
}

// ─── Public registry types ──────────────────────────────────────────────────────

export interface ShaderRegistryOptions {
  readonly device: ShaderRegistryDevice;
  /**
   * URL the registry fetches `manifest.json` from. `undefined` puts the
   * registry into the **zero-entry** mode: `loadManifest()` resolves
   * `Result.ok(undefined)` without issuing a fetch and `entries()` returns
   * an empty iterator. This is the bug-20260519 clear-pass-only path
   * where AI users build a `Camera`-only world (no PBR / unlit pipeline
   * is ever needed). `createRenderer.ts` Step 2 narrows on
   * `manifestEntries.length > 0` to skip the dual `createShaderModule`
   * compile in the same path (charter P3 + plan-strategy D-1 + D-2).
   */
  readonly manifestUrl: string | undefined;
}

// ─── ShaderRegistry main class (instance-per-engine) ============================

/**
 * Runtime shader registry — content-addressable manifest lookup →
 * `device.createShaderModule`.
 *
 * Usage:
 * ```
 * const registry = new ShaderRegistry({ device, manifestUrl: '/shaders/manifest.json' });
 * const loaded = await registry.loadManifest();
 * if (!loaded.ok) handleError(loaded.error); // ShaderError.manifest-malformed
 *
 * const result = registry.get('abc12345');
 * if (!result.ok) handleError(result.error); // RhiError | ShaderError.shader-not-found
 * else useModule(result.value);
 * ```
 *
 * `static get` / module-level singletons are **forbidden** (plan-strategy
 * §S-10).
 */
export class ShaderRegistry {
  readonly #device: ShaderRegistryDevice;
  readonly #manifestUrl: string | undefined;
  // hash → ManifestEntry index (populated after loadManifest).
  readonly #entries = new Map<string, ManifestEntry>();
  // hash → ShaderModule cache (populated lazily on first get()).
  readonly #moduleCache = new Map<string, ShaderModule>();
  // hash → RhiError previously seen (avoids re-triggering the underlying
  // createShaderModule on cache miss).
  readonly #errorCache = new Map<string, RhiError>();
  // identifier → MaterialShaderEntry index (populated by
  // registerMaterialShader; feat-20260523-shader-template-instance-split M5 / T05).
  readonly #materialShaders = new Map<string, MaterialShaderEntry>();
  readonly #materialShaderManifestEntries: MaterialShaderManifestEntry[] = [];
  #manifestLoaded = false;

  constructor(opts: ShaderRegistryOptions) {
    this.#device = opts.device;
    this.#manifestUrl = opts.manifestUrl;
  }

  /**
   * Loads manifest.json and populates the hash → ManifestEntry index.
   *
   * Failure paths (charter proposition 4: explicit failure):
   * - fetch / data: URL parse failed → `Result.err(ShaderError.manifest-malformed)`
   * - JSON.parse failed → ditto
   * - schema missing the `entries` field / an entries element missing
   *   hash/wgsl/bindings → ditto
   *
   * Idempotent: subsequent calls reuse the first result (never re-fetch;
   * charter proposition 6: idempotency).
   */
  async loadManifest(): Promise<ShaderResult<void, ShaderError>> {
    if (this.#manifestLoaded) return ok(undefined);

    // bug-20260519 D-2: zero-entry mode. `manifestUrl === undefined` means
    // the host opted out of shipping a shader manifest (Camera-only /
    // clear-pass-only LO 1.1 path); resolve `Result.ok` without issuing a
    // fetch. `entries()` then yields nothing and createRenderer Step 2
    // skips the dual `createShaderModule` compile (D-1 + D-3 nullable
    // PipelineState). Subsequent `get(hash)` calls fall through to the
    // shader-not-found arm via the empty entries map (charter P3
    // explicit failure on misuse).
    if (this.#manifestUrl === undefined) {
      this.#manifestLoaded = true;
      return ok(undefined);
    }

    let raw: string;
    try {
      const response = await fetch(this.#manifestUrl);
      raw = await response.text();
    } catch (e) {
      return err(
        manifestMalformed({
          message: `ShaderRegistry: failed to fetch manifest at ${this.#manifestUrl}`,
          hint: 'verify manifest URL is reachable; check bundler emitFile output path',
          reason: e instanceof Error ? e.message : String(e),
        }),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return err(
        manifestMalformed({
          message: 'ShaderRegistry: manifest JSON parse failed',
          hint: 'manifest.json must be valid JSON; rebuild via @forgeax/engine-vite-plugin-shader generateBundle',
          reason: e instanceof Error ? e.message : String(e),
        }),
      );
    }

    if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed)) {
      return err(
        manifestMalformed({
          message: 'ShaderRegistry: manifest missing required `entries` field',
          hint: 'manifest schema requires top-level `entries: ManifestEntry[]`',
        }),
      );
    }

    const entries = (parsed as { entries: unknown }).entries;
    if (!Array.isArray(entries)) {
      return err(
        manifestMalformed({
          message: 'ShaderRegistry: manifest.entries is not an array',
          hint: 'manifest schema requires `entries: ManifestEntry[]`',
        }),
      );
    }

    for (const entry of entries) {
      if (!isValidManifestEntry(entry)) {
        return err(
          manifestMalformed({
            message: 'ShaderRegistry: manifest entry missing required fields',
            hint: 'every entry needs {hash, wgsl, glsl, bindings} per @forgeax/engine-types.ManifestEntry',
            reason: `bad entry: ${JSON.stringify(entry)}`,
          }),
        );
      }
      this.#entries.set(entry.hash, entry);
    }

    // feat-20260526-pbr-uniform-fallback-no-storage-buffer M3 / w12:
    // parse and store materialShaders[] from the manifest for
    // createRenderer variant resolution. Non-existent / non-array
    // materialShaders is treated as empty (backward-compatible with
    // manifests from pre-M2 build runs).
    const parsedSlim = parsed as { materialShaders?: unknown };
    if (Array.isArray(parsedSlim.materialShaders)) {
      for (const ms of parsedSlim.materialShaders) {
        if (
          typeof ms === 'object' &&
          ms !== null &&
          typeof (ms as Record<string, unknown>).identifier === 'string'
        ) {
          this.#materialShaderManifestEntries.push(ms as MaterialShaderManifestEntry);
        }
      }
    }

    this.#manifestLoaded = true;
    return ok(undefined);
  }

  /**
   * Iterate every `ManifestEntry` populated by the most recent successful
   * `loadManifest()` call. Order matches the manifest JSON `entries` array
   * (insertion order; charter P2 structured-over-prose: AI users walk this
   * to discover engine-shipped entries by content marker without
   * re-fetching the manifest).
   *
   * Returns an empty iterator when no manifest has been loaded yet
   * (charter P3 explicit failure: the empty case is not an error — the
   * absent SSOT is the absent contract).
   */
  entries(): IterableIterator<ManifestEntry> {
    return this.#entries.values();
  }

  /**
   * Looks up a hash and forwards to `device.createShaderModule` (creates lazily
   * on first hit, then caches).
   *
   * Error paths:
   * - hash miss → `Result.err(ShaderError.shader-not-found)`
   * - device.createShaderModule failed → `Result.err(RhiError)` passes through
   *   (it is **not** wrapped as a ShaderError).
   *
   * Sync shape: on cache miss, the underlying `device.createShaderModule` is
   * called synchronously; the caller is responsible for handling the async
   * real path at the device-wrapper layer (e.g. the engine pre-compiles
   * during `loadManifest`).
   */
  get(hash: string): Result<ShaderModule, RhiError | ShaderError> {
    // Error cache: avoids re-triggering the underlying createShaderModule for
    // the same hash (idempotency).
    const cachedError = this.#errorCache.get(hash);
    if (cachedError !== undefined) {
      return err(cachedError);
    }

    const cachedModule = this.#moduleCache.get(hash);
    if (cachedModule !== undefined) {
      return ok(cachedModule);
    }

    const entry = this.#entries.get(hash);
    if (entry === undefined) {
      return err(
        shaderNotFound({
          hash,
          hint: 'verify manifest.json contains the expected hash; rerun build to regenerate manifest',
        }),
      );
    }

    const result = this.#device.createShaderModule({ code: entry.wgsl, label: hash });
    if (!result.ok) {
      this.#errorCache.set(hash, result.error);
      return result;
    }
    this.#moduleCache.set(hash, result.value);
    return result;
  }

  // ─── MaterialShader registry surface ───────────────────────────────────────
  // (feat-20260523-shader-template-instance-split M5 / T05 — plan-strategy
  // D-DefaultStandardPbr-Identifier).
  //
  // Two-tier identifier namespace:
  //   - `forgeax::*`  — engine-shipped reserved prefix; the host wires
  //     `forgeax::default-standard-pbr` at engine boot from the
  //     vite-plugin-shader manifest's `materialShaders[]` row + the
  //     `default-standard-pbr.schema.json` SSOT (M5 / T08 + M6).
  //   - any other identifier — user-side custom material shader, registered
  //     after asset import.
  //
  // The registry is the runtime SSOT consumed by:
  //   - `parseAssetPayload`'s `'::' two-way dispatch` (M4 / T01) — the path
  //     branch validates against `paramSchema` and feeds `MaterialSnapshot.
  //     materialShaderId` (M4 / T05).
  //   - `render-system-record`'s pipeline cache key (M4 / T06) — same
  //     identifier feeds the per-pipeline `(materialShaderId, stateHash)` key.

  /**
   * Register a material shader entry under a stable identifier.
   *
   * **Throws** on:
   *   - duplicate registration of the same identifier (programmer error per
   *     AGENTS.md "explicit registration" + Inspector "fail-fast no overwrite"
   *     pattern; charter P3 explicit failure on misuse).
   *
   * Successful path returns void — the registry mutates in-place. Use
   * {@link lookupMaterialShader} to read back.
   *
   * Identifier conventions (charter F1 / plan-strategy §8 §2):
   *   - `forgeax::<kebab-case>` — engine-shipped reserved prefix; the host
   *     registers `forgeax::default-standard-pbr` at boot.
   *   - `<package>::<id>` or `<guid>` — user-side custom shaders.
   *
   * @example
   * ```ts
   * const registry = new ShaderRegistry({ device, manifestUrl });
   * registry.registerMaterialShader('forgeax::default-standard-pbr', {
   *   source: composedWgsl,
   *   paramSchema: defaultStandardPbrSchema,
   * });
   * ```
   */
  registerMaterialShader(identifier: string, entry: MaterialShaderEntry): void {
    if (this.#materialShaders.has(identifier)) {
      throw new Error(
        `ShaderRegistry: material shader identifier '${identifier}' already registered; same-name re-register is forbidden (AGENTS.md "explicit registration" + Inspector "fail-fast no overwrite" pattern). Use lookupMaterialShader to read back the existing entry.`,
      );
    }
    // bug-20260619: user shaders registered directly here bypass the build-time
    // superset gate (vite-plugin-shader's WGSL reflection). A schema that omits
    // a texture field the WGSL actually samples would let the extract stage's
    // `validateTextureHandle` silently drop the handle and fall back to the
    // default white texture (opaque-white grass/windows in the LO 4.3 blending
    // demo). Fail fast at register time instead (charter P3 explicit failure).
    // Scoped to user shaders: engine `forgeax::*` shaders go through the
    // build-time gate and may sample engine-injected textures (emissive /
    // occlusion) absent from their schema by design.
    if (!identifier.startsWith(FORGEAX_RESERVED_PATH_PREFIX)) {
      const undeclared = findUndeclaredSampledTextures(entry.source, entry.paramSchema);
      if (undeclared.length > 0) {
        throw new Error(
          `ShaderRegistry: material shader '${identifier}' samples texture(s) [${undeclared.join(', ')}] in its WGSL but its paramSchema does not declare them as texture entries. Add { name: '${undeclared[0]}', type: 'texture2d' } (and any others listed) to the paramSchema, or the engine would silently bind the default white texture (charter P3 explicit failure; see docs/handover/2026-06-19-blending-transparency-regression-bisect.md).`,
        );
      }
    }
    this.#materialShaders.set(identifier, entry);
  }

  /**
   * Lookup a previously-registered material shader entry by identifier.
   *
   * Returns `Result.ok(entry)` on hit, `Result.err(material-shader-not-found)`
   * on miss. The `Result` shape mirrors `get(hash)` for consistent
   * abstraction across the runtime registry surface (charter P4).
   *
   * @example
   * ```ts
   * const r = registry.lookupMaterialShader('forgeax::default-standard-pbr');
   * if (!r.ok) return handleError(r.error);
   * const { source, paramSchema } = r.value;
   * ```
   */
  lookupMaterialShader(identifier: string): ShaderResult<MaterialShaderEntry, ShaderError> {
    const entry = this.#materialShaders.get(identifier);
    if (entry === undefined) {
      return err(
        materialShaderNotFound({
          identifier,
          expected: Array.from(this.#materialShaders.keys()),
          hint: `register the shader via ShaderRegistry.registerMaterialShader('${identifier}', ...) at engine boot, or grep '${FORGEAX_RESERVED_PATH_PREFIX}' to enumerate engine-shipped reserved identifiers`,
        }),
      );
    }
    return ok(entry);
  }

  /**
   * Iterate every registered material shader identifier in registration
   * order (charter F1 grep gate: `for (const id of registry.materialShaderIdentifiers())`
   * lists every `forgeax::*` + user shader without a private-field reach-in).
   */
  materialShaderIdentifiers(): IterableIterator<string> {
    return this.#materialShaders.keys();
  }

  /**
   * Iterate every MaterialShaderManifestEntry parsed from manifest.json's
   * `materialShaders[]` field during `loadManifest()`.
   *
   * feat-20260526-pbr-uniform-fallback-no-storage-buffer M3 / w12:
   * createRenderer variant resolution consumes this list to select the
   * correct variant (by `caps.storageBuffer`) and register the resolved
   * WGSL via `registerMaterialShader`.
   *
   * Returns an empty iterator when no manifest has been loaded yet or
   * the manifest lacks `materialShaders` (backward-compatible).
   */
  materialShaderManifestEntries(): IterableIterator<MaterialShaderManifestEntry> {
    return this.#materialShaderManifestEntries.values();
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────────

function isValidManifestEntry(value: unknown): value is ManifestEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.hash !== 'string') return false;
  if (typeof v.wgsl !== 'string') return false;
  // glsl allows string | undefined | null (manifest.json may serialize null as
  // 'glsl: null').
  if (v.glsl !== undefined && v.glsl !== null && typeof v.glsl !== 'string') return false;
  if (typeof v.bindings !== 'string') return false;
  return true;
}
