// @forgeax/engine-assets-runtime -- load-by-guid + pack-fetch collaboration module
// (feat-20260705-runtime-tier2-decomposition M1 / w7, D-4). Free functions
// taking the AssetRegistry instance as first param; logic byte-preserved from the
// class body (this. -> registry.). This is the largest method cluster (loadByGuid
// + the DDC / pack-index / pack-file fetch + parse pipeline).

import { AssetGuid } from '@forgeax/engine-pack/guid';
import { err, ok, type Result, type RhiError } from '@forgeax/engine-rhi';
import {
  ASSET_ERROR_HINTS,
  type Asset,
  type AssetCompression,
  AssetError,
  type AssetErrorCode,
  type AssetErrorDetail,
  type AssetRef,
  derive,
  type ImageError,
  type ImageMetadata,
  type LoadContext,
  type LoaderAsyncResult,
  type MaterialAsset,
  type ParseErrorDetail,
} from '@forgeax/engine-types';
import type { AssetRegistry, ParsedPackFile } from '../asset-registry';
import { isRawAssetContainerUrl, UPSTREAM_ENTRY_KINDS } from '../loaders/upstream-entry';
import { unpackMeshBin } from '../mesh-bin';
import { buildBreadcrumbHint, buildSceneChildContext } from './instantiate';

/**
 * Load an asset and all its transitively referenced sub-assets by GUID;
 * returns `ok(handle)` only when the asset and every sub-asset are in the
 * registry.
 *
 * **Post-condition:** `ok(payload)` is returned ONLY when the asset AND every
 * transitively referenced sub-asset (per the asset envelope's `refs[]`) are
 * present in this registry. The implementation walks `envelope.refs` and
 * recursively calls `loadByGuid` on each ref before cataloguing the top-level
 * asset. The resolved value is the PAYLOAD `T`
 * (D-17), never a handle -- mint a column handle with
 * `world.allocSharedRef('Kind', payload)` when one is needed (e.g. before
 * `instantiate`).
 *
 * Two paths:
 * - **Dev / fallback** (no `configurePackIndex` call): synchronous catalogue
 *   lookup wrapped in `Promise.resolve`. Returns `Err(asset-not-found)` if not
 *   catalogued.
 * - **Prod** (after `configurePackIndex(url)`): fetches `pack-index.json`
 *   on the first call (cached as a `Map<guid, {relativeUrl, kind}>`), then
 *   fetches the individual resource URL and parses the asset payload, then
 *   catalogues it (GUID -> payload) and returns the payload.
 *
 * Error union: `AssetError | PackError | ImageError | RhiError` (closed -- no
 * new codes were introduced by the recursive walk; every code is pre-existing).
 *
 * An in-flight `Map` (D-5) deduplicates concurrent calls for the same GUID and
 * prevents stack overflow on cycles (A->B->A).
 *
 * **Breaking-change classification:** this is a semantic strengthening, not a
 * shape change. Sub-assets catalogued by a prior `catalog(guid, payload)` /
 * `loadByGuid` call are protected by the catalogue fast-path: the recursive
 * walk hits cache on every node and incurs zero additional fetch.
 *
 * @example
 * ```ts
 * const res = await engine.assets.loadByGuid<SceneAsset>(sceneGuid);
 * if (!res.ok) {
 *   switch (res.error.code) {
 *     case 'asset-not-found':
 *       // top GUID or any sub-asset GUID is missing from the catalog
 *       break;
 *     case 'asset-fetch-failed':
 *       // network / CORS
 *       break;
 *     case 'asset-parse-failed':
 *       // payload malformed
 *       break;
 *     // ... AssetErrorCode | PackErrorCode | ImageErrorCode | RhiErrorCode exhaustive
 *   }
 *   return;
 * }
 * ```
 */
export async function loadByGuid<T = Asset>(
  registry: AssetRegistry,
  guid: AssetGuid,
  parentContext?: {
    sceneEntityId?: number;
    componentField?: string;
  },
): Promise<Result<T, AssetError | ImageError | RhiError>> {
  const guidKey = AssetGuid.format(guid).toLowerCase();

  // feat-20260614 M8 (D-17): the registry catalogues GUID -> payload and
  // returns the PAYLOAD (never a handle). Fast path: already catalogued
  // (covers dev catalog() + prod cached repeat calls).
  const existing = registry.assetCatalog.get(guidKey);
  if (existing !== undefined) {
    return ok(existing.payload as T);
  }

  // In-flight dedup (D-5 / B-10): if another call is already loading this
  // GUID, return that same Promise — covers (a) concurrent same-GUID calls
  // and (b) cycle A→B→A termination (B reaches A's in-flight entry).
  const inFlightPromise = registry.inFlight.get(guidKey);
  if (inFlightPromise !== undefined) {
    return inFlightPromise as Promise<Result<T, AssetError | ImageError | RhiError>>;
  }

  // Prod fetch path: only enabled when packIndexUrl is configured.
  if (registry.packIndexUrl !== undefined && typeof globalThis.fetch === 'function') {
    // F22: capture generation snapshot at Promise creation time so the
    // resolve path can detect whether invalidate/invalidateAll was called
    // while the fetch was in flight.
    const genAtStart = registry.generations.get(guidKey) ?? 0;
    const globalGenAtStart = registry.globalGeneration;

    const promise = loadByGuidProd<T>(registry, guid, guidKey, parentContext);
    registry.inFlight.set(guidKey, promise);
    try {
      const result = await promise;
      // F22: if the generation counters changed since the Promise was
      // created, discard the result -- the asset was invalidated. The
      // inFlight.delete in the finally block still runs (correctly).
      if (
        genAtStart !== (registry.generations.get(guidKey) ?? 0) ||
        globalGenAtStart !== registry.globalGeneration
      ) {
        // Clean up catalog -- loadByGuidProd may have already written
        // the payload via catalog() before the generation check runs.
        registry.assetCatalog.delete(guidKey);
        return err(
          new AssetError({
            code: 'asset-invalidated',
            expected: `GUID ${guidKey} was invalidated during load`,
            hint: ASSET_ERROR_HINTS['asset-invalidated'],
          }),
        );
      }
      return result;
    } finally {
      registry.inFlight.delete(guidKey);
    }
  }

  // Dev / fallback: synchronous catalogue miss (no network).
  return Promise.resolve(
    err(
      new AssetError({
        code: 'asset-not-found',
        expected: `GUID ${guidKey} catalogued in AssetRegistry`,
        hint: ASSET_ERROR_HINTS['asset-not-found'],
      }),
    ),
  );
}

/**
 * feat-20260603-asset-import-loader-injection M1 / w6: load an
 * upstream-branch kind (texture / font) straight from its catalog entry
 * through the injected async loader, then register the produced POD. Replaces
 * the bespoke `loadTextureFromEntry` / `loadFontFromEntry` methods; the decode
 * / glyph-parse logic moved verbatim into the loader bodies (D-2 — loader is
 * pure of `registerWithGuid`, which stays here).
 */
export async function loadFromUpstreamEntry<T = Asset>(
  registry: AssetRegistry,
  guidKey: string,
  entry: {
    relativeUrl: string;
    kind: string;
    name?: string;
    metadata?: ImageMetadata | undefined;
  },
): Promise<Result<T, AssetError | ImageError | RhiError>> {
  const loader = registry.loaders.get(entry.kind);
  if (loader === undefined) {
    return err(
      new AssetError({
        code: 'loader-not-registered',
        expected: `a loader registered for kind '${entry.kind}'`,
        hint: ASSET_ERROR_HINTS['loader-not-registered'],
        detail: { kind: entry.kind, registeredKinds: registry.loaders.registeredKinds() },
      }),
    );
  }
  const out = loader.load({ ...entry, guidKey }, undefined, makeLoadContext(registry));
  // Upstream-branch loaders are async (Promise<LoaderAsyncResult>).
  const result = (await out) as LoaderAsyncResult;
  if (!result.ok) {
    return err(result.error as AssetError | ImageError | RhiError);
  }
  const guid = AssetGuid.parse(guidKey);
  if (!guid.ok) {
    return err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: `valid GUID ${guidKey}`,
        hint: ASSET_ERROR_HINTS['asset-parse-failed'],
      }),
    );
  }
  return registry.catalog(guid.value, result.value) as Result<
    T,
    AssetError | ImageError | RhiError
  >;
}

/**
 * Internal: prod fetch path for `loadByGuid`.
 * Fetches pack-index.json (cached), then fetches the pack file, parses the
 * asset payload, and registers it.
 */
export async function loadByGuidProd<T = Asset>(
  registry: AssetRegistry,
  guid: AssetGuid,
  guidKey: string,
  parentContext?: {
    sceneEntityId?: number;
    componentField?: string;
  },
): Promise<Result<T, AssetError | ImageError | RhiError>> {
  // feat-20260603-asset-import-loader-injection M4 / w31 (AC-19 lazy iron law):
  // wrap the DDC fetch + load path so a DDC miss can be routed through the
  // injected ImportTransport (studio form) or fail-fast with
  // `asset-not-imported` (shipped form, AC-22). The load path after a
  // successful DDC resolve is identical in both forms -- zero branches on
  // `registry.importTransport` (AC-23 key invariant).
  //
  // A DDC miss is: (a) the GUID is absent from the catalog, OR (b) the
  // `.pack.json` fetch returns `asset-not-found` / `asset-fetch-failed`.
  // In case (a) the transport is probed first (the pack-index may have been
  // built before the asset was imported); in case (b) the transport is the
  // only fallback (the pack file is genuinely missing).

  const entry = await resolveCatalogEntry(registry, guidKey);
  if (entry !== undefined) {
    // Catalog hit: try the DDC load path.
    const result = await ddcLoad<T>(registry, guid, guidKey, entry, parentContext);
    if (result.ok) return result;
    // DDC miss: only route through transport when the error indicates a
    // missing pack file (not a parse / validation failure inside the pack) or
    // an unimported texture source (feat-20260604 M2 / D-1: import-on-demand).
    // `texture-source-not-imported` is an AssetError, so it passes the
    // `instanceof AssetError` guard naturally. `image-decode-failed` is an
    // ImageError (a genuinely corrupt imported .bin) -- it fails the guard and
    // is therefore never transport-eligible (Risk-1), so a real decode
    // failure is never silently lazy-imported.
    const ddcError = result.error;
    const transportEligible =
      ddcError instanceof AssetError &&
      (ddcError.code === 'asset-not-found' ||
        ddcError.code === 'asset-fetch-failed' ||
        ddcError.code === 'texture-source-not-imported' ||
        // perf-20260706: the raw-container fail-fast (mesh/material/scene whose
        // relativeUrl is still a .glb/.gltf/.fbx) surfaces source-not-imported;
        // it is transport-eligible so the import runs once and rewrites the row
        // to .bin/.pack.json (the shipped form, with no transport, fails fast).
        // Distinct from the generic asset-not-imported, which must stay
        // NON-eligible so the parent-missing breadcrumb is never masked.
        ddcError.code === 'source-not-imported');
    if (transportEligible) {
      return transportOrFail<T>(registry, guid, guidKey, ddcError.code);
    }
    return result;
  }

  // Catalog miss: the GUID is not in the pack-index. In the studio form the
  // import transport can lazily create the missing DDC.
  return transportOrFail<T>(registry, guid, guidKey, 'asset-not-found');
}

/**
 * Resolve the catalog entry for a GUID, lazily fetching the pack-index on
 * first call. Returns `undefined` when the GUID is absent from the catalog.
 */
export async function resolveCatalogEntry(
  registry: AssetRegistry,
  guidKey: string,
): Promise<
  | {
      relativeUrl: string;
      kind: string;
      name?: string;
      metadata?: ImageMetadata | undefined;
      compression?: AssetCompression;
    }
  | undefined
> {
  const key = guidKey.toLowerCase();
  // Re-fetch the pack-index when it has never been fetched (=== undefined) OR
  // when the cached Map lacks this GUID. The miss case covers invalidate(guid)
  // round-2 M-A, which deletes the per-GUID index entry (targeted, bystanders
  // survive) without nuking the whole Map to undefined: the next loadByGuid
  // must re-consult the source so the GUID re-resolves and its freshly-cleared
  // body cache re-fetches. A genuinely absent GUID re-fetches once then still
  // misses, falling through to the transport / asset-not-found path as before.
  if (registry.packIndexCache === undefined || !registry.packIndexCache.has(key)) {
    const catalogResult = await fetchPackIndex(registry);
    if (!catalogResult.ok) {
      // Keep packIndexCache === undefined so next resolveCatalogEntry re-enters
      // the fetch path instead of short-circuiting on an empty (polluted) cache.
      if (registry.packIndexCache === undefined) return undefined;
    } else {
      registry.packIndexCache = catalogResult.value;
      registerPackagesFromIndex(registry, registry.packIndexCache);
    }
  }
  return registry.packIndexCache?.get(key);
}

/**
 * feat-20260618 M3 (D-2): once the pack-index is parsed, group every row by
 * its `relativeUrl` and register each package fully -- all of its GUIDs and
 * their entry display names in one `registerPackage` call. Registering the
 * whole package at once (rather than one GUID per load) means the package
 * cardinality is known up front, so `resolveName` returns the basename for a
 * genuinely single-asset package and the entry name for a multi-asset one,
 * with no incremental 1->N promotion needed on the prod path. The name travels
 * entry -> Package, never through the payload (Risk-3 JSON-roundtrip safety),
 * and covers both the sync (parseAssetPayload) and async (texture/font) loads.
 */
export function registerPackagesFromIndex(
  registry: AssetRegistry,
  catalog: Map<string, { relativeUrl: string; name?: string }>,
): void {
  const byPath = new Map<string, { guids: string[]; names: Map<string, string> }>();
  for (const [guidKey, entry] of catalog) {
    let group = byPath.get(entry.relativeUrl);
    if (group === undefined) {
      group = { guids: [], names: new Map() };
      byPath.set(entry.relativeUrl, group);
    }
    group.guids.push(guidKey);
    if (entry.name !== undefined) group.names.set(guidKey, entry.name);
  }
  for (const [path, group] of byPath) {
    registry._registerPackage(path, group.guids, group.names);
  }
}

/**
 * Load an asset through the DDC (catalog entry -> fetch pack -> loader.load
 * -> register). Returns `Err(asset-not-found)` or `Err(asset-fetch-failed)`
 * on DDC miss (the caller then decides whether to route through the
 * import transport).
 *
 * This path is IDENTICAL in studio and shipped forms -- the only difference
 * between the two is whether `registry.importTransport` exists when the caller
 * falls back to `transportOrFail` (AC-23 key invariant).
 */
export async function ddcLoad<T = Asset>(
  registry: AssetRegistry,
  guid: AssetGuid,
  guidKey: string,
  entry: {
    relativeUrl: string;
    kind: string;
    name?: string;
    metadata?: ImageMetadata | undefined;
    compression?: AssetCompression;
  },
  parentContext?: {
    sceneEntityId?: number;
    componentField?: string;
  },
): Promise<Result<T, AssetError | ImageError | RhiError>> {
  // Engine-owned upstream-entry loaders retain their derived seed table. A
  // caller-injected loader may opt into the same catalog-entry path, so audio
  // reaches the Web Audio decoder without assets-runtime importing that backend.
  const loader = registry.loaders.get(entry.kind);
  if (UPSTREAM_ENTRY_KINDS.has(entry.kind) || loader?.fromCatalogEntry === true) {
    return loadFromUpstreamEntry<T>(registry, guidKey, entry);
  }

  // perf-20260706: fail-fast for a DDC sub-asset whose relativeUrl still
  // points at a RAW container (`.glb` / `.gltf` / `.fbx`) rather than an
  // importer-produced artifact (`.bin` / `.pack.json`). The gltf/fbx catalog
  // arm (vite-plugin-pack build-catalog) emits thin rows for mesh / material /
  // scene / skeleton / skin / animation-clip whose relativeUrl is the source
  // container; the per-sub-asset body only exists AFTER the ImportTransport
  // (dev `POST /__import/:guid`) parses the container once and rewrites each
  // row to `.<guid>.bin`. Without this guard, every such sub-asset first
  // fetch+parse-FAILS the whole container (e.g. `res.json()` on a 62 MB binary
  // GLB) before falling through to the transport -- so a 1028-sub-asset GLB
  // re-downloaded the 62 MB file ~707x (once per mesh/material/scene) at
  // ~5 min add-to-scene. Returning `asset-not-imported` here routes straight
  // to `transportOrFail` (loadByGuidProd), which imports the container ONCE
  // and patches the rows to `.bin`; the re-entry then no longer trips this
  // guard (no loop). This mirrors the texture path, which already fails fast
  // on its `!relativeUrl.endsWith('.bin')` check in loadTextureAsset.
  if (isRawAssetContainerUrl(entry.relativeUrl)) {
    return err(
      new AssetError({
        code: 'source-not-imported',
        expected:
          `an imported artifact URL (.bin / .pack.json) for ${entry.kind} ` +
          `GUID ${guidKey}; got the raw container ${entry.relativeUrl}`,
        hint: ASSET_ERROR_HINTS['source-not-imported'],
      }),
    );
  }

  // bug-20260610 / feat-20260614 M8 (D-19): when the asset is a material, its
  // paramValues handle fields (e.g. baseColorTexture) are stored on disk as
  // refs[] indices. The materialLoader rewrites each to its refs[] GUID
  // string verbatim (D-19: no handle minting at load time -- the ECS/render
  // side resolves GUID -> column handle at use time).
  // feat-20260622 M4 / w12 + w13: each branch yields the parsed asset AND its
  // pack-entry refs[] (GUID-string projection). The refs ride onto the
  // catalogued envelope (D-9), and the recursive core reads envelope.refs as
  // the single recursion source (D-5) — no per-kind ref re-derivation,
  // and no more per-kind texture preload (the former material Path A is folded
  // into the unified for-loop, R1). loadByGuid stays idempotent on cache hit,
  // so the unified for-loop loading texture sub-assets after the material is
  // registered preserves the cycle-safety register-before-recurse invariant.
  let packResult: Result<{ asset: Asset; refs: readonly string[] }, AssetError>;
  if (entry.kind === 'mesh' && entry.relativeUrl.endsWith('.bin')) {
    // bug-20260610 Fix A: mesh sub-assets carry their vertices / indices in
    // a sibling `<guid>.bin` produced by `packMeshBin` (build-time, in
    // @forgeax/engine-import), not as inline JSON arrays. The catalog row's
    // relativeUrl points straight at the .bin (D-3); we read it via
    // `LoadContext.fetchBinary`, decode through `unpackMeshBin`, and feed a
    // hydrated synthetic payload through the meshLoader (no .pack.json
    // round-trip for mesh -- saves the 80 MB JSON parse on Sponza). The
    // legacy inline-array path (CON-7) still flows through the regular
    // `fetchPackFile` -> meshLoader branch below when the catalog row
    // points at a `.pack.json` carrying number-array vertices (older
    // fixtures and direct-register tests).
    const ctx = makeLoadContext(registry);
    const binFetch = await ctx.fetchBinary(
      entry.relativeUrl,
      entry.compression ? { compression: entry.compression } : undefined,
    );
    if (!binFetch.ok) {
      return err(binFetch.error) as Result<T, AssetError>;
    }
    const unpacked = unpackMeshBin(binFetch.value);
    if (unpacked === undefined) {
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: `decodable mesh-bin payload for GUID ${guidKey}`,
          hint: ASSET_ERROR_HINTS['asset-parse-failed'],
        }),
      );
    }
    // feat-20260612 M2 fixup: pass `indices` through verbatim (including the
    // undefined case for mesh-bins with `ilen=0`, e.g. Fox.glb non-indexed
    // primitives). The previous `?? new Uint16Array(0)` synthesised an
    // empty typed array; meshLoader accepted it but downstream
    // gpu-resource-store treated `indices !== undefined` as "has indices",
    // allocated a 0-byte IBO, and the first frame's
    // `setIndexBuffer(buffer.slice(0..0), ...)` panicked wgpu's
    // `BufferSlice` "buffer slices can not be empty" assertion. meshLoader
    // now accepts undefined and returns a MeshAsset whose `indices` field
    // is omitted, taking the non-indexed `pass.draw` path in record stage.
    const synthIndices: Uint16Array | Uint32Array | undefined = unpacked.indices;
    // bug-20260610: per-stream typed arrays for position / normal / uv /
    // tangent are intentionally absent from the .bin payload (they
    // duplicate the interleaved bytes already in `vertices`); the
    // meshLoader's `payload.attributes ?? {}` fallback handles that.
    // feat-20260611 (w17-b): skinIndex / skinWeight are an exception --
    // they ride alongside the interleaved buffer because the runtime
    // pbr-skin VBO layout reads `attributes.skinIndex` directly via
    // `deriveVertexBufferLayout`. When present in the .bin, hydrate them
    // back into `attributes`; absent (legacy / unskinned) -> empty object.
    const synthAttributes: Record<string, unknown> = {};
    if (unpacked.skinIndex !== undefined) synthAttributes.skinIndex = unpacked.skinIndex;
    if (unpacked.skinWeight !== undefined) synthAttributes.skinWeight = unpacked.skinWeight;
    // feat-20260629 multi-uv regression fix: the extra UV sets (uv1..uvK)
    // ride inside the interleaved `vertices` buffer, but the .bin format
    // stores only the header's `uvSetCount` / `floatsPerVertex` -- not the
    // per-set standalone arrays. Downstream (register stride validator +
    // gpu-resource-store stride + deriveVertexBufferLayout) derives the UV
    // set count from `attributes` via countUvSets, so a decode that omits
    // uv1..uvK makes the wide interleaved buffer disagree with attributes
    // (14-float stride vs. attributes-implied 12) -> every multi-UV mesh
    // fails register with `mesh-vertex-stride-mismatch`. Reconstruct the
    // standalone uv1..uvK Float32Arrays from the interleaved buffer so the
    // attribute set faithfully reflects the packed geometry. UV values are
    // still uploaded from `vertices` (interleaved) -- these arrays only
    // carry the count + let writeback / custom shaders read per-set UVs.
    const uvSetCount = unpacked.uvSetCount ?? 1;
    const floatsPerVertex = unpacked.floatsPerVertex ?? 0;
    if (uvSetCount > 1 && floatsPerVertex > 0 && unpacked.vertices.length > 0) {
      const extraUvSets = uvSetCount - 1;
      // UV1 starts right after the base region (canonical interleaved order:
      // position/normal/uv/tangent[/skinIndex/skinWeight]/uv1..uvK), so the
      // base width is the total stride minus the extra-UV floats.
      const uv1Offset = floatsPerVertex - extraUvSets * 2;
      const vertexCount = unpacked.vertices.length / floatsPerVertex;
      for (let k = 1; k <= extraUvSets; k++) {
        const cat = new Float32Array(vertexCount * 2);
        const interleavedOffset = uv1Offset + (k - 1) * 2;
        for (let v = 0; v < vertexCount; v++) {
          const src = v * floatsPerVertex + interleavedOffset;
          cat[v * 2 + 0] = unpacked.vertices[src + 0] as number;
          cat[v * 2 + 1] = unpacked.vertices[src + 1] as number;
        }
        synthAttributes[`uv${k}`] = cat;
      }
    }
    const synthPayload: Record<string, unknown> = {
      vertices: unpacked.vertices,
      ...(synthIndices !== undefined ? { indices: synthIndices } : {}),
      attributes: synthAttributes,
      ...(unpacked.submeshes !== undefined ? { submeshes: unpacked.submeshes } : {}),
      ...(unpacked.aabb !== undefined ? { aabb: unpacked.aabb } : {}),
    };
    const parsed = parseAssetPayload(registry, 'mesh', synthPayload);
    if (parsed === undefined || (typeof parsed === 'object' && 'ok' in parsed)) {
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: `parseable mesh payload for GUID ${guidKey}`,
          hint: ASSET_ERROR_HINTS['asset-parse-failed'],
        }),
      );
    }
    // mesh is a leaf asset (no sub-asset refs).
    packResult = ok({ asset: parsed as Asset, refs: [] });
  } else if (entry.kind === 'material') {
    // feat-20260622 M4 / w13 (R1): fold the former Path A (material texture
    // preload) into the unified envelope.refs for-loop. The material parse
    // (materialLoader.load) resolves each paramValues texture field by
    // index -> refs[] GUID string verbatim — it never reads the texture
    // sub-asset from the catalog, only the refs[] string projection. So the
    // texture sub-assets do NOT need pre-loading before parse; the unified
    // for-loop (w12) iterates the catalogued material envelope.refs (which
    // include the texture edges produced by gltf-importer, w5) and loads
    // them, idempotent on cache hit. We fetch the raw entry, parse, and let
    // the unified for-loop handle every refs[] edge.
    const rawResult = await fetchPackEntry(registry, entry.relativeUrl, guidKey);
    if (!rawResult.ok) {
      return rawResult as unknown as Result<T, AssetError>;
    }
    const refsRaw = rawResult.value.refs ?? [];
    const parsed = parseAssetPayload(
      registry,
      rawResult.value.kind,
      rawResult.value.payload,
      rawResult.value.refs,
    );
    if (parsed === undefined || (typeof parsed === 'object' && 'ok' in parsed)) {
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: `parseable material payload for GUID ${guidKey}`,
          hint: ASSET_ERROR_HINTS['asset-parse-failed'],
        }),
      );
    }
    packResult = ok({ asset: parsed as Asset, refs: refsRaw });
  } else {
    packResult = await fetchPackFile(registry, entry.relativeUrl, guidKey, entry.kind);
  }
  if (!packResult.ok) {
    return packResult as Result<T, AssetError>;
  }

  const asset = packResult.value.asset;
  // feat-20260622 M4 / w12: project the pack-entry refs[] (GUID strings) into
  // AssetRef[] for the envelope. The on-disk pack.json refs[] carries only
  // GUID strings (sourceField / sceneEntityId are stripped at the
  // serialization boundary, w7 D-10), so prod-loaded edges have no per-entity
  // metadata — the scene breadcrumb fallback (buildSceneChildContext) still
  // walks the payload for entity/field detail. Dev-server register paths that
  // carry rich AssetRef[] keep their edge metadata end-to-end.
  const packRefs: readonly AssetRef[] = packResult.value.refs.map((g) => ({ guid: g }));

  // feat-20260622 M5 / w17 (D-8, R5): the former material parent preload
  // "Path B" (an independent early-return that loaded the parent BEFORE the
  // unified for-loop and carried the precise breadcrumb hint `loading parent
  // material X for child Y`) is folded into the unified envelope.refs
  // for-loop. The parent GUID already rides on the material envelope.refs
  // (gltf-importer w5 writes it; the on-disk pack refs[] carries it as a
  // GUID string -> packRefs above projects it), so the unified for-loop
  // recurses on it like any other edge. Here we only resolve the parent
  // GUID -> AssetGuid and stamp `parent` onto the asset payload (the
  // renderer-facing field read by walkMaterialPassesOverSharedRefs); the
  // parent EDGE load + the `loading parent material X for child Y` breadcrumb
  // + the not-a-material guard all move into the for-loop's
  // sourceField.fieldName==='parent' / parent-edge branch below. No early
  // return: the material registers (register-before-recurse) and its parent
  // edge loads through the same unified path as texture / scene edges.
  let assetToRegister: Asset = asset;
  let parentGuidKey: string | undefined;
  if (
    asset.kind === 'material' &&
    'parentGuid' in (asset as unknown as Record<string, unknown>) &&
    typeof (asset as unknown as Record<string, unknown>).parentGuid === 'string'
  ) {
    const parentGuidStr = (asset as unknown as MaterialAsset & { parentGuid: string }).parentGuid;
    const parentGuid = AssetGuid.parse(parentGuidStr);
    if (!parentGuid.ok) {
      return err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: `valid parent GUID for child ${guidKey}`,
          hint: `parent GUID '${parentGuidStr}' is not a valid UUID format`,
        }),
      );
    }
    parentGuidKey = parentGuidStr.toLowerCase();
    const matAsset = asset as unknown as MaterialAsset & { parentGuid?: string };
    const passes = matAsset.passes;
    const paramValues = matAsset.paramValues;
    assetToRegister = {
      kind: 'material',
      ...(passes !== undefined ? { passes } : {}),
      ...(paramValues !== undefined ? { paramValues } : {}),
      parent: parentGuid.value,
    };
  }

  // tweak-20260609 M1: catalogue the asset BEFORE recursing into its
  // sub-assets. This way, when a cycle (A→B→A) reaches back to A during
  // B's recursion, A is already catalogued (fast-path hit) and the inFlight
  // Promise for A can be fulfilled. The inFlight entry in `loadByGuid` is
  // the second line of defense — it catches concurrent same-GUID calls
  // before the asset is catalogued.
  const registerResult = registerParsedAsset<T>(registry, guid, assetToRegister, guidKey, packRefs);
  if (!registerResult.ok) return registerResult;
  const registeredPayload = registerResult.value;

  // feat-20260622 M4 / w12 (D-5): the recursion source is the just-catalogued
  // envelope's refs[]. The for-loop is kind-agnostic
  // — every AssetRef carries the GUID to recurse on; scene/material/skin all
  // flow through this one loop. Each edge optionally carries sourceField /
  // sceneEntityId; when present the childContext is built straight from the
  // edge, otherwise the scene branch falls back to walking the payload
  // (buildSceneChildContext) so the prod-path breadcrumb keeps its entity /
  // field detail (on-disk refs[] are GUID-string-only, w7 D-10).
  const envelope = registry.assetCatalog.get(guidKey);
  const refs: readonly AssetRef[] = envelope?.refs ?? [];
  if (refs.length > 0) {
    const subResults = await Promise.all(
      refs.map((ref) => {
        const refGuidKey = ref.guid.toLowerCase();
        const parsedRef = AssetGuid.parse(ref.guid);
        if (!parsedRef.ok) {
          return Promise.resolve({
            guidKey: refGuidKey,
            result: err(
              new AssetError({
                code: 'asset-parse-failed',
                expected: `valid sub-asset GUID referenced by ${asset.kind} ${guidKey}`,
                hint: `refs[] entry '${ref.guid}' is not a valid UUID format`,
              }),
            ) as Result<Asset, AssetError | ImageError | RhiError>,
            childContext: undefined as
              | {
                  sceneEntityId?: number;
                  componentField?: string;
                  sourceField?: {
                    componentName?: string;
                    fieldName: string;
                    arrayIndex?: number;
                  };
                }
              | undefined,
            isParentEdge: false,
            edge: ref,
          });
        }
        let childContext:
          | {
              sceneEntityId?: number;
              componentField?: string;
              sourceField?: {
                componentName?: string;
                fieldName: string;
                arrayIndex?: number;
              };
            }
          | undefined;
        if (ref.sceneEntityId !== undefined || ref.sourceField !== undefined) {
          childContext = {};
          if (ref.sceneEntityId !== undefined) childContext.sceneEntityId = ref.sceneEntityId;
          if (ref.sourceField?.fieldName !== undefined) {
            childContext.componentField =
              (ref.sourceField.componentName !== undefined
                ? `${ref.sourceField.componentName}.`
                : '') +
              ref.sourceField.fieldName +
              (ref.sourceField.arrayIndex !== undefined ? `[${ref.sourceField.arrayIndex}]` : '');
            childContext.sourceField = ref.sourceField;
          }
        } else if (asset.kind === 'scene') {
          childContext = buildSceneChildContext(registry, asset, refGuidKey, guidKey);
        }
        // feat-20260622 M5 / w17 (D-8): the material parent edge. Identify it
        // by either the rich dev-path marker (sourceField.fieldName==='parent')
        // or the prod-path GUID match against the resolved parent GUID
        // (on-disk refs[] strip sourceField, w7 D-10, so the GUID is the only
        // signal). The parent edge carries the distinct `loading parent
        // material X for child Y` breadcrumb (AC-10) instead of the generic
        // buildBreadcrumbHint form, and is guarded to be a material.
        const isParentEdge =
          asset.kind === 'material' &&
          (ref.sourceField?.fieldName === 'parent' ||
            (parentGuidKey !== undefined && refGuidKey === parentGuidKey));
        return loadByGuid(registry, parsedRef.value, childContext ?? parentContext).then((r) => ({
          guidKey: refGuidKey,
          result: r,
          childContext,
          isParentEdge,
          edge: ref,
        }));
      }),
    );

    // If any sub-asset load failed, propagate the first error enriched with
    // parent breadcrumb.
    for (const {
      guidKey: subGuidKey,
      result: subResult,
      childContext: subChildContext,
      isParentEdge,
      edge: subEdge,
    } of subResults) {
      // feat-20260622 M5 / w17: parent-edge breadcrumb migration (former Path
      // B). On load failure, carry the distinct `loading parent material X for
      // child Y: <subErr.hint>` form (AC-10 downstream literal assertion) and
      // propagate the parent's own error code verbatim.
      if (isParentEdge && !subResult.ok) {
        const subErr = subResult.error;
        const code: AssetErrorCode =
          subErr instanceof AssetError ? subErr.code : 'asset-parse-failed';
        return err(
          new AssetError({
            code,
            expected: subErr.expected,
            hint: `loading parent material ${subGuidKey} for child ${guidKey}: ${
              subErr.hint ?? ''
            }`,
            ...(subErr instanceof AssetError && subErr.detail !== undefined
              ? { detail: subErr.detail as Readonly<AssetErrorDetail> }
              : {}),
          }),
        );
      }
      // feat-20260622 M5 / w17: parent edge loaded but is not a material —
      // same guard the former Path B carried, with the matching breadcrumb.
      if (isParentEdge && subResult.ok && subResult.value?.kind !== 'material') {
        return err(
          new AssetError({
            code: 'asset-parse-failed',
            expected: `parent GUID ${subGuidKey} to reference a MaterialAsset`,
            hint: `loading parent material ${subGuidKey} for child ${guidKey}: referenced asset is ${subResult.value?.kind ?? 'unknown'}, not 'material'`,
          }),
        );
      }
      if (!subResult.ok) {
        const subErr = subResult.error;
        const breadcrumb = buildBreadcrumbHint(
          guidKey,
          asset.kind,
          subGuidKey,
          subChildContext ?? parentContext,
        );
        const code: AssetErrorCode =
          subErr instanceof AssetError ? subErr.code : 'asset-fetch-failed';
        // feat-20260622 verify r1: deliver the breadcrumb provenance in
        // structured form so AI users locate the broken edge by property
        // access (charter P3), not by parsing the hint. Preserve the sub
        // error's own detail when it carries one (more specific); otherwise
        // expose the edge provenance (entity / source field).
        // Prefer the rich dev-path edge provenance; on the prod path the
        // on-disk edge is GUID-only (sourceField stripped, w7 D-10), so fall
        // back to the entity-walk-recovered provenance carried on the
        // childContext (verify r1).
        const provEntityId = subEdge?.sceneEntityId ?? subChildContext?.sceneEntityId;
        const provSourceField = subEdge?.sourceField ?? subChildContext?.sourceField;
        const breadcrumbDetail: Readonly<AssetErrorDetail> = {
          referencedByGuid: guidKey,
          referencedByKind: asset.kind,
          subAssetGuid: subGuidKey,
          ...(provEntityId !== undefined ? { sceneEntityId: provEntityId } : {}),
          ...(provSourceField !== undefined ? { sourceField: provSourceField } : {}),
        };
        const detail: Readonly<AssetErrorDetail> =
          subErr instanceof AssetError && subErr.detail !== undefined
            ? subErr.detail
            : breadcrumbDetail;
        return err(
          new AssetError({
            code,
            expected: subErr.expected,
            hint: `${breadcrumb} / ${subErr.hint ?? ''}`,
            detail,
          }),
        );
      }
    }
  }

  return ok(registeredPayload as T);
}

/**
 * M4 transport fallback: try the injected {@link ImportTransport} to lazily
 * import a missing DDC, then re-enter the DDC load path. When no transport
 * is wired (shipped form), fail fast with `asset-not-imported` (AC-22).
 */
export async function transportOrFail<T = Asset>(
  registry: AssetRegistry,
  guid: AssetGuid,
  guidKey: string,
  _missReason: AssetErrorCode,
): Promise<Result<T, AssetError | ImageError | RhiError>> {
  if (registry.importTransport === undefined) {
    // shipped form: no transport wired -> fail fast, never degrade to
    // runtime import (AC-22, charter P3 explicit failure).
    return err(
      new AssetError({
        code: 'asset-not-imported',
        expected: `GUID ${guidKey} to have been pre-imported at build time or to have an ImportTransport wired`,
        hint: ASSET_ERROR_HINTS['asset-not-imported'],
      }),
    );
  }

  // studio form: request the transport to import this GUID on-the-fly.
  // After a successful transport call the DDC is available; re-enter the
  // catalog + DDC load path (the transport writes the DDC but does NOT
  // register the asset — that's the Loader's job).
  const transportResult = await registry.importTransport.fetchPack(guidKey);
  if (!transportResult.ok) {
    return err(
      new AssetError({
        code: 'asset-not-imported',
        expected: `import transport to fetch pack for GUID ${guidKey}`,
        hint: ASSET_ERROR_HINTS['asset-not-imported'],
      }),
    );
  }

  // Patch ONLY the freshly imported rows into the catalog cache (per-asset
  // incremental, the four-verb redesign 2026-06-06) instead of nuking the
  // cache and re-fetching the whole pack-index. The transport returns the one
  // imported entry (+ sub-asset siblings); each becomes / overwrites a cache
  // row. This keeps 122 concurrent texture imports O(N) instead of O(N^2)
  // whole-catalog re-fetches and never resets a sibling's imported row.
  const importedEntries = 'entries' in transportResult ? transportResult.entries : undefined;
  if (importedEntries !== undefined && importedEntries.length > 0) {
    // F20: serialise packIndexCache writes through a per-cache Promise queue.
    // The "check -> new Map -> set" block is not atomic across concurrent
    // transportOrFail calls; chaining through the queue ensures each patch
    // completes before the next starts, preventing new-Map overwrite races.
    registry.packIndexCachePatchQueue = registry.packIndexCachePatchQueue.then(() => {
      if (registry.packIndexCache === undefined) registry.packIndexCache = new Map();
      for (const e of importedEntries) {
        registry.packIndexCache.set(e.guid.toLowerCase(), {
          relativeUrl: resolveCatalogAssetUrl(registry, e.relativeUrl),
          kind: e.kind,
          // Carry the transport's derived display name into the cache row.
          // buildCatalog already resolves it (deriveAssetName: basename of the
          // source for single-/no-storedName sub-assets), so a freshly imported
          // GLB's 1000+ sub-assets show as "<file>.glb" in the Content Browser
          // instead of blank. Dropping it here made listCatalog fall back to
          // `entry.name ?? ''` — the whole-index re-read path (else branch) kept
          // names, so only the incremental patch path was blank.
          ...(e.name !== undefined ? { name: e.name } : {}),
          ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
          // Carry refs on the incremental patch path too, else an asset
          // imported via POST /__import shows missing dependency edges until
          // the next full pack-index refresh (feat: listCatalog refs).
          ...(e.refs !== undefined ? { refs: e.refs } : {}),
          ...(e.compression !== undefined ? { compression: e.compression } : {}),
          // Carry sourcePath on the incremental patch path too (same red-line
          // as refs above): an asset imported via POST /__import would
          // otherwise expose no source-file path in listCatalog until the next
          // full pack-index refresh, breaking editor CRUD sidecar lookup for
          // freshly imported assets. `sourcePath` is a required PackIndexEntry
          // field, so it is always present on the transport row.
          ...(e.sourcePath !== undefined ? { sourcePath: e.sourcePath } : {}),
        });
      }
    });
    await registry.packIndexCachePatchQueue;
  } else {
    // No inline rows -- fall back to a full pack-index re-read so the freshly
    // imported DDC entry is visible (legacy / non-row-returning transports).
    registry.packIndexCache = undefined;
  }
  const entry = await resolveCatalogEntry(registry, guidKey);
  if (entry === undefined) {
    return err(
      new AssetError({
        code: 'asset-not-imported',
        expected: `import transport to produce a catalog entry for GUID ${guidKey}`,
        hint: ASSET_ERROR_HINTS['asset-not-imported'],
      }),
    );
  }

  // Re-enter the DDC load path (identical to the catalog-hit path).
  return ddcLoad<T>(registry, guid, guidKey, entry);
}

/**
 * Register a parsed asset POD (the synchronous tail of the DDC load path:
 * `registerWithGuid`). Material parent preload is handled asynchronously
 * inside `ddcLoad` before calling this method; the registered asset is
 * always fully resolved by the time it reaches here.
 *
 * Extracted from the old `loadByGuidProd` body so `ddcLoad` and
 * `transportOrFail` share an identical load path (AC-23 key invariant).
 */
export function registerParsedAsset<T = Asset>(
  registry: AssetRegistry,
  guid: AssetGuid,
  asset: Asset,
  _guidKey: string,
  refs?: readonly AssetRef[],
): Result<T, AssetError | ImageError | RhiError> {
  // feat-20260614 M8 (D-17): catalogue the parsed payload under its GUID and
  // return the PAYLOAD. `catalog` validates mesh stride + material passes and
  // returns Result.err on failure (no throw), so the loadByGuid surface stays
  // a consistent Result (charter P4 consistent abstraction).
  //
  // feat-20260622 M4 / w12 (D-9): the pack-entry refs[] ride onto the
  // catalogued envelope here so the recursive core can read envelope.refs as
  // its single recursion source.
  return registry.catalog<T>(guid, asset as T, refs) as Result<
    T,
    AssetError | ImageError | RhiError
  >;
}

/**
 * Fetch and parse pack-index.json into a Map<guidKey, {relativeUrl, kind}>.
 */
/**
 * Resolve a catalog entry URL against the configured pack-index URL.
 *
 * The pack index is the asset delivery boundary: a catalog may use relative
 * paths, root-relative paths, or absolute URLs, but the registry must always
 * fetch them from the host that supplied that index. In a browser, first
 * canonicalize a host-relative index against the page URL. A non-absolute index
 * in a non-browser host intentionally remains untouched.
 */
export function resolveCatalogAssetUrl(registry: AssetRegistry, relativeUrl: string): string {
  const packIndexUrl = registry.packIndexUrl;
  if (packIndexUrl === undefined) return relativeUrl;

  try {
    const baseUrl = new URL(packIndexUrl, globalThis.location?.href).href;
    return new URL(relativeUrl, baseUrl).href;
  } catch {
    // Preserve the caller's URL only when neither the index nor the browser
    // context can provide an absolute base (for example a Node unit test using
    // `/pack-index.json`).
    return relativeUrl;
  }
}

export async function fetchPackIndex(registry: AssetRegistry): Promise<
  Result<
    Map<
      string,
      {
        relativeUrl: string;
        kind: string;
        name?: string;
        metadata?: ImageMetadata | undefined;
        refs?: readonly string[];
        compression?: AssetCompression;
        sourcePath?: string;
      }
    >,
    AssetError
  >
> {
  let raw: unknown;
  try {
    const res = await globalThis.fetch(registry.packIndexUrl as string);
    if (!res.ok) {
      return err(
        new AssetError({
          code: 'asset-fetch-failed',
          expected: `fetch(${registry.packIndexUrl}) to return ok`,
          hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
        }),
      );
    }
    raw = (await res.json()) as unknown;
  } catch {
    return err(
      new AssetError({
        code: 'asset-fetch-failed',
        expected: `fetch(${registry.packIndexUrl}) to succeed`,
        hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
      }),
    );
  }

  if (!Array.isArray(raw)) {
    return err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: 'pack-index.json to be a JSON array',
        hint: ASSET_ERROR_HINTS['asset-parse-failed'],
      }),
    );
  }

  const catalog = new Map<
    string,
    {
      relativeUrl: string;
      kind: string;
      name?: string;
      metadata?: ImageMetadata | undefined;
      refs?: readonly string[];
      compression?: AssetCompression;
      sourcePath?: string;
    }
  >();
  for (const item of raw as Array<{
    guid?: unknown;
    relativeUrl?: unknown;
    kind?: unknown;
    name?: unknown;
    metadata?: unknown;
    refs?: unknown;
    compression?: unknown;
    sourcePath?: unknown;
  }>) {
    if (
      typeof item.guid === 'string' &&
      typeof item.relativeUrl === 'string' &&
      typeof item.kind === 'string'
    ) {
      // metadata is the optional 5th field introduced by feat-20260517
      // D-2 (catalog builder writes it for kind: 'texture' rows; legacy
      // 4-field rows leave it undefined). Pass-through is structural --
      // runtime narrows on `entry.metadata !== undefined` inside the
      // texture arm and routes to `image-meta-missing` otherwise.
      //
      // feat-20260618 M3 (D-2): `name` is the optional display name the
      // catalog builder writes for multi-asset entries. It flows entry ->
      // Package (registerPackage in the load path), never into the payload,
      // so loader payload parsing stays untouched (Risk-3 roundtrip safety).
      const row: {
        relativeUrl: string;
        kind: string;
        name?: string;
        metadata?: ImageMetadata | undefined;
        refs?: readonly string[];
        compression?: AssetCompression;
        sourcePath?: string;
      } = {
        relativeUrl: resolveCatalogAssetUrl(registry, item.relativeUrl),
        kind: item.kind,
        metadata: item.metadata as ImageMetadata | undefined,
      };
      if (typeof item.name === 'string') row.name = item.name;
      // sourcePath is the on-disk source-file location (pack-index required
      // field, `PackIndexEntry.sourcePath`); the catalog builder always emits
      // it. Preserve it so editors can locate the `.meta.json` sidecar for
      // CRUD (delete/rename/duplicate) -- `relativeUrl` points at the runtime
      // load artefact (DDC `.bin` / `.pack.json`) and cannot be reversed to
      // the source path.
      if (typeof item.sourcePath === 'string') row.sourcePath = item.sourcePath;
      // refs is the optional dependency-edge field (feat: listCatalog refs);
      // narrow to a string[] so a malformed pack-index row cannot inject
      // non-string edges into the catalog.
      if (Array.isArray(item.refs) && item.refs.every((r) => typeof r === 'string')) {
        row.refs = item.refs as readonly string[];
      }
      // compression is the optional compression strategy field. Narrow to
      // the five AssetCompression literals to reject malformed rows (R-8:
      // this catalog site must stay in sync with the union; the basis-*
      // members only record the encoding here -- the transcode load path is
      // M5's fetchBinary + loader, not this immediate catalog record).
      if (
        item.compression === 'none' ||
        item.compression === 'zstd' ||
        item.compression === 'basis-etc1s' ||
        item.compression === 'basis-uastc' ||
        item.compression === 'basis-uastc-hdr'
      ) {
        row.compression = item.compression;
      }
      catalog.set(item.guid.toLowerCase(), row);
    }
  }
  return ok(catalog);
}

/**
 * Fetch a .pack.json file, find the asset entry matching guidKey, and
 * reconstruct the Asset from its payload.
 */
/**
 * bug-20260610: fetch one pack file and return the raw asset entry without
 * parsing. Used by `loadByGuidProd` for material kinds so the caller can
 * recursively preload `refs[]` (texture sub-assets) BEFORE the synchronous
 * materialLoader runs and rewrites paramValues handle fields to their refs[]
 * GUID strings (feat-20260614 M8 / D-19: GUID verbatim, no handle minting).
 */
export async function fetchPackEntry(
  _registry: AssetRegistry,
  relativeUrl: string,
  guidKey: string,
): Promise<
  Result<{ kind: string; payload: Record<string, unknown>; refs?: string[] }, AssetError>
> {
  let raw: unknown;
  try {
    const res = await globalThis.fetch(relativeUrl);
    if (!res.ok) {
      return err(
        new AssetError({
          code: 'asset-fetch-failed',
          expected: `fetch(${relativeUrl}) to return ok`,
          hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
        }),
      );
    }
    raw = (await res.json()) as unknown;
  } catch {
    return err(
      new AssetError({
        code: 'asset-fetch-failed',
        expected: `fetch(${relativeUrl}) to succeed`,
        hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
      }),
    );
  }
  const packFile = raw as {
    assets?: Array<{
      guid: string;
      kind: string;
      payload: Record<string, unknown>;
      refs?: string[];
    }>;
  };
  const assetEntry = (packFile.assets ?? []).find(
    (a) => a.guid.toLowerCase() === guidKey.toLowerCase(),
  );
  if (assetEntry === undefined) {
    return err(
      new AssetError({
        code: 'asset-not-found',
        expected: `GUID ${guidKey} present in pack file ${relativeUrl}`,
        hint: ASSET_ERROR_HINTS['asset-not-found'],
      }),
    );
  }
  return ok({
    kind: assetEntry.kind,
    payload: assetEntry.payload,
    ...(assetEntry.refs !== undefined ? { refs: assetEntry.refs } : {}),
  });
}

/**
 * Fetch one pack file, locate the requested asset entry, and either parse it
 * inline or expose the entry to the caller (for kinds that need to preload
 * `refs[]` BEFORE running the loader — currently 'material', whose
 * paramValues handle fields are rewritten to their refs[] GUID strings
 * (feat-20260614 M8 / D-19: GUID verbatim, no handle minting at load time)).
 *
 * bug-20260610 Fix B (M3 / D-4): the fetch+parse result is cached per
 * `relativeUrl` in `packFileCache`; concurrent calls for the same URL share
 * a single in-flight promise via `packFileInFlight`. Only the raw parsed
 * body is cached — `parseAssetPayload` still runs per-call (CON-2).
 */
export async function fetchPackFile(
  registry: AssetRegistry,
  relativeUrl: string,
  guidKey: string,
  _kind: string,
): Promise<Result<{ asset: Asset; refs: readonly string[] }, AssetError>> {
  // ── cache hit ───────────────────────────────────────────────────────
  const cached = registry.packFileCache.get(relativeUrl);
  if (cached !== undefined) {
    const assetEntry = cached.assets.find((a) => a.guid.toLowerCase() === guidKey.toLowerCase());
    if (assetEntry === undefined) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `GUID ${guidKey} present in pack file ${relativeUrl}`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      );
    }
    return parseAndReturnAsset(registry, assetEntry);
  }

  // ── in-flight dedup ─────────────────────────────────────────────────
  const inFlight = registry.packFileInFlight.get(relativeUrl);
  if (inFlight !== undefined) {
    try {
      const packFile = await inFlight;
      const assetEntry = packFile.assets.find(
        (a) => a.guid.toLowerCase() === guidKey.toLowerCase(),
      );
      if (assetEntry === undefined) {
        return err(
          new AssetError({
            code: 'asset-not-found',
            expected: `GUID ${guidKey} present in pack file ${relativeUrl}`,
            hint: ASSET_ERROR_HINTS['asset-not-found'],
          }),
        );
      }
      return parseAndReturnAsset(registry, assetEntry);
    } catch {
      // In-flight promise rejected (network failure) — fall through to
      // re-fetch. The in-flight entry was already cleaned by the
      // catch block in the original miss path.
    }
  }

  // ── miss: fetch + parse + cache ─────────────────────────────────────
  return fetchAndCachePackFile(registry, relativeUrl, guidKey);
}

/**
 * Parse the asset payload from a pack-file entry and return the result.
 * Extracted so cache-hit and in-flight-dedup paths share the same
 * parseAssetPayload + error-wrapping logic.
 */
export function parseAndReturnAsset(
  registry: AssetRegistry,
  assetEntry: {
    kind: string;
    payload: Record<string, unknown>;
    refs?: string[];
  },
): Result<{ asset: Asset; refs: readonly string[] }, AssetError> {
  const parsed = parseAssetPayload(registry, assetEntry.kind, assetEntry.payload, assetEntry.refs);
  // F21: the scene loader returns its structured ParseErrorDetail inline via
  // the LoaderOutput `{ ok: false, error }` arm, surfaced here through
  // parseAssetPayload's return value -- no shared instance slot.
  if (parsed !== undefined && typeof parsed === 'object' && 'ok' in parsed) {
    const e = (parsed as { readonly ok: false; readonly error: ParseErrorDetail }).error;
    return err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: `refs index ${e.index} within [0, ${e.refsLength})`,
        detail: {
          localId: e.localId,
          component: e.component,
          field: e.field,
          index: e.index,
          refsLength: e.refsLength,
        },
        hint:
          `at node localId=${e.localId}, component=${e.component}, ` +
          `field=${e.field}: index ${e.index} is out of bounds ` +
          `(refs has ${e.refsLength} entries)`,
      }),
    );
  }
  if (parsed === undefined) {
    return err(
      new AssetError({
        code: 'asset-parse-failed',
        expected: `parseable asset payload for kind ${assetEntry.kind}`,
        hint: ASSET_ERROR_HINTS['asset-parse-failed'],
      }),
    );
  }
  // feat-20260622 M4 / w12: surface the pack-entry refs[] (GUID-string
  // projection) alongside the parsed payload so ddcLoad can store them on
  // the catalogued envelope. The recursive core then reads envelope.refs
  // as the single recursion source (D-5), never re-deriving them from
  // the payload.
  return ok({ asset: parsed as Asset, refs: assetEntry.refs ?? [] });
}

/**
 * Fetch a pack file from the network, parse the JSON body, store the
 * result in the cache, and return the requested asset entry.
 *
 * Registers the in-flight promise in `packFileInFlight` so concurrent
 * callers share a single fetch. On success the body moves to
 * `packFileCache`; on failure the in-flight entry is removed so
 * subsequent retries re-fetch (D-7).
 */
export async function fetchAndCachePackFile(
  registry: AssetRegistry,
  relativeUrl: string,
  guidKey: string,
): Promise<Result<{ asset: Asset; refs: readonly string[] }, AssetError>> {
  const fetchPromise = (async (): Promise<ParsedPackFile> => {
    let raw: unknown;
    try {
      const res = await globalThis.fetch(relativeUrl);
      if (!res.ok) {
        throw new AssetError({
          code: 'asset-fetch-failed',
          expected: `fetch(${relativeUrl}) to return ok`,
          hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
        });
      }
      raw = (await res.json()) as unknown;
    } catch (e) {
      if (e instanceof AssetError) throw e;
      throw new AssetError({
        code: 'asset-fetch-failed',
        expected: `fetch(${relativeUrl}) to succeed`,
        hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
      });
    }
    // Shape guard: the dev-server / preview / 404 fallback can return
    // index.html or an unrelated JSON body that satisfies res.ok but lacks
    // the ParsedPackFile contract. Without this guard the downstream
    // `packFile.assets.find` raises TypeError outside any AssetError
    // branch, escapes as a process-level Unhandled Rejection, and drives
    // vitest browser-project exit=1 even when every onerror-gate test
    // assertion passes (feat-20260611 step-implement F-4).
    if (
      raw === null ||
      typeof raw !== 'object' ||
      !Array.isArray((raw as { assets?: unknown }).assets)
    ) {
      throw new AssetError({
        code: 'asset-fetch-failed',
        expected: `pack-file body at ${relativeUrl} to be { assets: [...] }`,
        hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
      });
    }
    return raw as ParsedPackFile;
  })();

  registry.packFileInFlight.set(relativeUrl, fetchPromise);

  try {
    const packFile = await fetchPromise;
    registry.packFileCache.set(relativeUrl, packFile);
    registry.packFileInFlight.delete(relativeUrl);

    const assetEntry = packFile.assets.find((a) => a.guid.toLowerCase() === guidKey.toLowerCase());
    if (assetEntry === undefined) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `GUID ${guidKey} present in pack file ${relativeUrl}`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      );
    }
    return parseAndReturnAsset(registry, assetEntry);
  } catch (e) {
    registry.packFileInFlight.delete(relativeUrl);
    if (e instanceof AssetError) {
      return err(e);
    }
    throw e;
  }
}

/**
 * Reconstruct a typed `Asset` from a raw payload object.
 *
 * @param kind The asset kind discriminant (matches the pack entry or
 *   dev-register dispatch).
 * @param payload The serialised asset payload (keys mirror the asset
 *   interface field names).
 * @param refs Pack-file refs array for Handle fields — when a field
 *   value is `number` it resolves to `refs[N]` (glTF-style index).
 *   Optional to preserve compatibility with callers outside the pack
 *   ingestion path (e.g., direct `registerWithGuid`).
 */
export function parseAssetPayload(
  registry: AssetRegistry,
  kind: string,
  payload: Record<string, unknown>,
  refs?: string[],
):
  | Asset
  | Record<string, unknown>
  | undefined
  | { readonly ok: false; readonly error: ParseErrorDetail } {
  // feat-20260603-asset-import-loader-injection M1 / w4: dispatch on
  // `kind` through the injected LoaderRegistry instead of a hardcoded
  // `if (kind === ...)` chain (D-1 / AC-01). The seven inline pack-payload
  // loaders parse synchronously; texture / font live on the upstream
  // loadByGuidProd branch (w6) and are never reached here.
  // feat-20260623 M2 / w5: unknown kinds pass through the raw payload so
  // host-registered loaders can parse their own kind. The engine does not
  // parse payloads it cannot match; parse responsibility is explicit on the
  // missing loader (charter P3).
  const loader = registry.loaders.get(kind);
  if (loader === undefined) return { ...payload, kind };
  const out = loader.load(payload, refs, makeLoadContext(registry));
  // The inline pack-payload loaders are synchronous (`Asset | undefined`);
  // the async texture / font loaders are dispatched from loadByGuidProd, not
  // here. A Promise here would mean a misregistered loader -> treat as a
  // parse miss rather than leaking a thenable into the sync return.
  if (out !== undefined && typeof (out as { then?: unknown }).then === 'function') {
    return undefined;
  }
  // F21: the scene loader returns { ok: false, error: ParseErrorDetail } for
  // structured parse errors. Pass the error arm straight through the return
  // value so the caller constructs a precise AssetError -- no instance slot.
  if (out !== undefined && out !== null && typeof out === 'object' && 'ok' in out) {
    return out as { readonly ok: false; readonly error: ParseErrorDetail };
  }
  return out as Asset | undefined;
}

/**
 * Build the {@link LoadContext} passed to a loader's `load`.
 * `fetchBinary` / `resolveRef` / `device` are wired for the async texture /
 * font loaders (w6).
 */
export function makeLoadContext(registry: AssetRegistry): LoadContext {
  return {
    /**
     * feat-20260706 M3 / w19: fetchBinary signature extended per D-2.
     * `opts?.compression` triggers the single decompression gate (AC-02).
     * 'zstd' → lazy-init codec decompressZstd · 'none' / undefined → pass-through.
     * On decompression failure, the codec error is nested in asset-fetch-failed
     * detail (D-8: runtime error union NOT extended).
     */
    fetchBinary: async (url: string, opts?: { readonly compression?: AssetCompression }) => {
      try {
        const res = await globalThis.fetch(url);
        if (!res.ok) {
          return {
            ok: false as const,
            error: new AssetError({
              code: 'asset-fetch-failed',
              expected: `fetch(${url}) to return ok`,
              hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
            }),
          };
        }
        const buf = await res.arrayBuffer();
        let bytes: Uint8Array = new Uint8Array(buf);

        // --- Decompression gate (AC-02: single gate inside fetchBinary) ---
        if (opts?.compression === 'zstd') {
          const { decompressZstd } = await import('@forgeax/engine-codec');
          const decRes = await decompressZstd(bytes);
          if (!decRes.ok) {
            return {
              ok: false as const,
              error: new AssetError({
                code: 'asset-parse-failed',
                expected: `zstd decompression for ${url}`,
                hint: `[${decRes.error.code}] ${decRes.error.hint}`,
                detail: { sourcePath: url },
              }),
            };
          }
          bytes = new Uint8Array(
            decRes.value.buffer,
            decRes.value.byteOffset,
            decRes.value.byteLength,
          );
        }
        // compression === 'none' / undefined → E1 pass-through

        return { ok: true as const, value: bytes };
      } catch {
        return {
          ok: false as const,
          error: new AssetError({
            code: 'asset-fetch-failed',
            expected: `fetch(${url}) to succeed`,
            hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
          }),
        };
      }
    },
    resolveRef: async (guid: string) => {
      const parsed = AssetGuid.parse(guid);
      if (!parsed.ok) {
        return { ok: false as const, error: parsed.error };
      }
      const r = await loadByGuid(registry, parsed.value);
      if (!r.ok) return { ok: false as const, error: r.error };
      // feat-20260614 M8 (D-19): resolveRef ensures the sub-asset is
      // catalogued (recursive load). The numeric value is vestigial -- the
      // registry mints no handles; callers store the GUID, not this number.
      return { ok: true as const, value: 0 };
    },
    // feat-20260613-material-paramschema-driven-binding M4 / w22 (D-5 graceful):
    // expose the registered shader's derive(paramSchema).textureFieldNames to
    // the materialLoader so it can decide which paramValues fields carry
    // refs[] indices without a hardcoded texture-field allowlist Set
    // (AC-03). Returns `undefined` when the shader is not registered (cross-
    // worktree shader-late-register, plan R-4) — the loader then falls back
    // to a graceful "try every int paramValue" walk.
    getMaterialShaderTextureFieldNames: (shaderId: string) => {
      const lookup = registry.shaderRegistry.lookupMaterialShader(shaderId);
      if (!lookup.ok) return undefined;
      return derive(lookup.value.paramSchema).textureFieldNames;
    },
    transcodeCaps: registry.transcodeCaps,
    device: undefined,
  };
}

/**
 * Return a runtime snapshot of every catalogued asset. Each entry exposes
 * `{ guid, kind, name }` where `kind` is the asset discriminant string
 * from `payload.kind`. feat-20260614 M8 (D-15): the registry holds no
 * handles -- entries are keyed by GUID (the catalogue key).
 *
 * AI-user narrowing flow (AC-11 + plan-strategy §7.4):
 * ```ts
 * for (const e of registry.inspect().assets) {
 *   if (e.kind === 'texture') {
 *     // re-query via registry.lookup(e.guid) to get the typed Asset value.
 *   }
 * }
 * ```
 */
