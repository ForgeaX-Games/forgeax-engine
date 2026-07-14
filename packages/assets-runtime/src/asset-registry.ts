// @forgeax/engine-assets-runtime - AssetRegistry v2 (feat-20260513-guid-asset-package-system).
//
// Entrypoints (feat-20260614 M8 de-handle cut, D-15/D-17/D-19): the registry
// is a GUID->payload catalogue. It no longer mints or maps handles -- column
// handles are minted on the World via `world.allocSharedRef('Kind', payload)`,
// and resolved through the two-tier `resolveAssetHandle` (BuiltinAssetRegistry
// process-static slots [1,1024) + per-World `world.sharedRefs` slots >=1024).
//
//   - catalog<T extends Asset>(guid, asset): Result<T, AssetError>
//       stores the GUID->payload entry loadByGuid resolves (dev/inline path)
//   - parseGuid(guidStr): AssetGuid
//   - lookup(guid): Asset | undefined          (catalogued payload, no fetch)
//   - loadByGuid<T extends Asset>(guid): Promise<Result<T, AssetError | ImageError | RhiError>>
//       returns the PAYLOAD T (never a handle, D-17)
//       dev/fallback: synchronous catalogue lookup wrapped in Promise
//       prod: fetch(packIndexUrl) -> parse catalog -> fetch entry -> parse Asset
//   - instantiate<T extends SceneAsset>(handle, world, parent?): Result<EntityHandle, ...>
//       handle is a `world.allocSharedRef('SceneAsset', payload)` column handle
//   - inspect(): InspectSnapshot
//
// v1 load(url) removed in feat-20260513-guid-asset-package-system (w12).
// loadByGuid is the replacement; M4/w23 adds real fetch-from-pack-index.
//
// feat-20260514-ecs-children-instances-managed-buffer-array M3 / w15: the
// `createInstancedBuffer` / `updateInstancedBuffer` / `getInstancedGpuBuffer`
// triplet is removed alongside the `InstancedBufferAsset` POD; per-entity
// instance transforms are now stored inside the ECS via the `Instances {
// transforms: 'array<f32>' }` component (the RenderSystem record stage owns
// the GPU storage buffer + dirty-version upload). Asset closed-union narrows
// 5 -> 4; the registry surface loses the optional `RhiDevice` constructor
// argument (no remaining device consumer).
//
// Dual-backend audited: the registry is engine-agnostic (no @webgpu/types
// imports + no rhi-webgpu / rhi-wgpu references); the same instance drives
// both dual-impl shim backends through the @forgeax/engine-rhi interface
// SSOT at the consumer site.

import type { EcsError, EntityHandle, World } from '@forgeax/engine-ecs';
import type { PackError } from '@forgeax/engine-pack/errors';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { deriveAssetName } from '@forgeax/engine-pack/name';
import { err, ok, type Result, type RhiError } from '@forgeax/engine-rhi';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import {
  ASSET_ERROR_HINTS,
  type Asset,
  type AssetCompression,
  type AssetEnvelope,
  AssetError,
  type AssetRef,
  type EngineMetrics,
  type Handle,
  handleSlot,
  type ImageError,
  type ImageMetadata,
  type ImportTransport,
  type InspectEntry,
  type InspectSnapshot,
  type Loader,
  type MaterialAsset,
  type Package,
  type ParseErrorDetail,
  type SceneAsset,
  type SceneEntity,
  type TagOf,
  type TilesetAsset,
  type TranscodeCaps,
  type MeshAsset as TypesMeshAsset,
  unwrapHandle,
} from '@forgeax/engine-types';
import {
  BUILTIN_CUBE,
  BUILTIN_CYLINDER,
  BUILTIN_NINESLICE_QUAD,
  BUILTIN_QUAD,
  BUILTIN_SPHERE,
  BUILTIN_TRIANGLE,
} from './builtin-asset-registry';
import type { LoaderRegistry } from './loader-registry';
import { createDefaultLoaderRegistry } from './wire-default-loaders';

/**
 * Strip readonly from all fields of T. Used to mutate the MeshAsset.aabb slot
 * after mesh validation passes (the interface is readonly but register-time
 * computation writes the real AABB into the caller's placeholder).
 */

// feat-20260705-runtime-tier2-decomposition M1 / w4 (D-4 F1): the pre-class
// constants, loaders, scene-payload / payload-validate / aabb helpers were
// straight-cut into sibling modules. The thin class value-imports only what its
// method bodies still reference; the full public consumer face (barrel + tests)
// is preserved via the `export ... from` re-export block below (pre-w14 shim,
// removed when consumers repoint in w14/w15).
import { withMeshAabb } from './aabb';
import {
  BUILTIN_MESH_GUIDS,
  HANDLE_CUBE,
  HANDLE_CYLINDER,
  HANDLE_NINESLICE_QUAD,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
} from './handles';
import { inferAtlasExtent, validateMeshPayload, validateTilesetPayload } from './payload-validate';
import {
  instantiateFlat as instantiateFlatImpl,
  instantiate as instantiateImpl,
  type PostSpawnHook,
  resolveHandleGuid,
  resolveMountsRec,
} from './registry/instantiate';
import {
  fetchPackIndex,
  loadByGuid as loadByGuidImpl,
  parseAndReturnAsset as parseAndReturnAssetImpl,
  parseAssetPayload as parseAssetPayloadImpl,
  registerPackagesFromIndex,
} from './registry/load-by-guid';
import {
  detectTileNeedsRepeatSampler,
  materialShaderTextureFieldNames as materialShaderTextureFieldNamesImpl,
  validateMaterialPasses,
  validateSpriteSlices,
} from './registry/validate-material';
import { extractSceneEntityHandleGuids } from './scene-handle-fields';

// Public re-export surface (pre-w14 consumer face preservation): the extracted
// modules are the new SSOT; asset-registry re-exports them until w14/w15 repoint
// every consumer to the sibling modules / the new package.
export {
  HANDLE_CUBE,
  HANDLE_CYLINDER,
  HANDLE_NINESLICE_QUAD,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
} from './handles';
export {
  animationClipLoader,
  INLINE_PACK_LOADERS,
  materialLoader,
  meshLoader,
  sceneLoader,
  skeletonLoader,
  skinLoader,
} from './loaders/inline-pack';
export {
  equirectLoader,
  fontLoader,
  textureLoader,
  UPSTREAM_ENTRY_LOADERS,
} from './loaders/upstream-entry';
export { type TilesetValidateOptions, validateTilesetPayload } from './payload-validate';

// ─── Re-exports for engine-runtime-local consumers ──────────────────────────
//
// Legacy re-exports: `Asset` widens to the 4-variant engine-types union;
// `MeshAsset` keeps the engine-types shape (with `attributes`). Consumers
// that previously imported from `./asset-registry` keep working through
// the type alias re-exports below.

export type { Asset, TypesMeshAsset as MeshAsset };

// D-15: the five BUILTIN_* mesh payloads + BUILTIN_FLOATS_PER_VERTEX moved to
// builtin-asset-registry.ts (the process-static vertex-layout + payload SSOT);
// imported at the top of this file. The constructor still pre-populates the
// handle->payload map from those imports (the map itself retires in w49).

// feat-20260618-asset-and-pack-name-fields M3 (D-1 / D-3): the mutable runtime
// package object every GUID of the same import path shares. `assetGuids` grows
// as `registerPackage` adds GUIDs; `assetCount` (the engine-types `Package`
// view) is derived from `assetGuids.size`, never stored (#2 Derive). The public
// `packageOf(guid)` projects this to the readonly `Package` interface.
interface MutablePackage {
  path: string;
  readonly assetGuids: Set<string>;
}

// ─── Runtime brand helper ──────────────────────────────────────────────────
//
// AC-11 inspect() `.brand` is a 4-member string literal union mirroring the
// engine-types Asset discriminated union. Map a stored Asset value to its
// brand via the `.kind` discriminator (+ `.shadingModel` refinement for
// `MaterialAsset`, preserved for forward compatibility though the runtime
// brand stays at the asset-kind level per AC-11 spec).
//
// feat-20260514 M3 / w15: the `'InstancedBufferAsset'` brand is retired
// alongside the deleted POD + 3 registry methods; the runtime brand union
// shrinks 5 -> 4 to mirror the Asset closed-union shape.
// feat-20260514 w3: re-extends to 5 with the addition of the `'SceneAsset'`
// brand mirroring the new `'scene'` kind in the Asset discriminated union.
// feat-20260618-asset-and-pack-name-fields M1 / w3: AssetBrand moved to
// @forgeax/engine-types (public, single-entry discoverability per charter F1).
// feat-20260608-tilemap-object-layer-rendering M0: AssetBrand union grows
// 13 -> 14 with `'TilesetAsset'` in @forgeax/engine-types.

// feat-20260622 D-4/D-8: the 14-arm assetBrand switch and ASSET_BRAND Record
// table are both retired (PR #496 eliminated the brand concept entirely).
// New Asset union members no longer need a brand mapping; the closed union
// exhaustive switch in test-d files is the sole type-level guard.

// ─── Schema-driven material parse result (feat-20260523 M4-T01) ──────────
// ─── AssetRegistry class ────────────────────────────────────────────────────

/**
 * Asset registry (instance-per-engine; `engine.assets: AssetRegistry | null`).
 *
 * The builtin meshes (`HANDLE_CUBE` / `HANDLE_TRIANGLE` / ...) are served by
 * the process-static `BuiltinAssetRegistry`, so AI users see usable handles in
 * the very first frame without registration ceremony (charter proposition 1).
 *
 * @example Catalogue a texture by GUID, load its payload, and bind a material:
 * ```ts
 * const guid = engine.assets.parseGuid('00000000-0000-7000-8000-000000000001');
 * engine.assets.catalog(guid, myTexture);                       // GUID -> payload
 * const res = await engine.assets.loadByGuid(guid);             // payload (D-17)
 * if (!res.ok) {
 *   switch (res.error.code) {
 *     case 'asset-not-found':  // guid not catalogued
 *   }
 *   return;
 * }
 * const material = world.allocSharedRef('MaterialAsset', {       // mint column handle
 *   kind: 'material',
 *   passes: [{ name: 'Forward', shader: 'forgeax::default-standard-pbr', tags: { LightMode: 'Forward' }, queue: 2000 }],
 *   paramValues: { baseColorTexture: res.value },
 * });
 * world.spawn({ component: MeshRenderer, data: { materials: [material] } });
 * ```
 */

// bug-20260610 Fix B: parsed pack-file body stored in the fetchPackFile
// in-memory cache + in-flight dedup maps (D-4). Only the raw JSON shape is
// cached -- parseAssetPayload still runs per-call to look up the per-GUID
// entry (CON-2 register-before-recurse cycle safety).
export interface ParsedPackFile {
  assets: Array<{
    guid: string;
    kind: string;
    payload: Record<string, unknown>;
    refs?: string[];
  }>;
}

export class AssetRegistry {
  // feat-20260614 M8 (D-15 / D-17 / D-19): the registry is a GUID -> payload
  // catalogue. It holds NO handle concept -- it cannot mint a column handle
  // (it has no World). `loadByGuid` returns the PAYLOAD; column minting
  // (`world.allocSharedRef`) is the caller's job on the ECS/render side.
  // Sub-asset refs embedded in a payload stay as GUID strings (AssetGuid /
  // dash-form), never minted at load time. Keyed by lowercased GUID string.
  // feat-20260705-runtime-tier2-decomposition M1 / w5 (D-4): public so the
  // extracted `./registry/validate-material` free functions (detectTileNeeds-
  // RepeatSampler) can read it. No underscore + genuinely public is the
  // lint-compliant exposure (D-internal R-internal-C ties `@internal` to `_`).
  readonly assetCatalog: Map<string, AssetEnvelope<Asset>> = new Map();

  // feat-20260618-asset-and-pack-name-fields M3 (D-1): the package index that
  // backs the two-segment asset identity `<packagePath>.<name>`. `packages`
  // maps a lowercased GUID key to its `MutablePackage` (a shared object every
  // GUID of the same import path points at), or `null` for assets with no
  // package (catalog() inline + builtin, D-5). All three registration entry
  // points (catalog / loadByGuid / builtin) funnel through the single
  // `registerPackage` primitive so the XOR name invariant lands once (#1 SSOT).
  private readonly packages: Map<string, MutablePackage | null> = new Map();

  // Secondary index path -> shared MutablePackage so every GUID of the same
  // import path points at one object (the 1->N promotion + assetCount derive
  // depend on this sharing). Not a duplicate of `packages` (#2): `packages` is
  // the per-GUID lookup; this is the per-path dedup used only inside
  // registerPackage to find-or-create the shared object.
  private readonly packageByPath: Map<string, MutablePackage> = new Map();

  // Per-GUID stored display names now live on the asset envelope's `name` field
  // (the single home, replacing the retired storedNameOf side table; D-6).
  // resolveName reads `assetCatalog.get(key)?.name` as the `storedName` argument
  // of deriveAssetName. `pendingNames` bridges the one ordering where a name is
  // known before its envelope exists: the prod disk path registers the package
  // (entry names) during resolveCatalogEntry, then catalogues the body later --
  // catalog() drains the pending name into the new envelope, so nothing persists
  // here once the envelope is in place.
  private readonly pendingNames: Map<string, string> = new Map();

  // ─── Prod pack-index fetch state (M4/w23) ──────────────────────────────
  // When packIndexUrl is configured, loadByGuid fetches pack-index.json on
  // first call, caches the parsed catalog in packIndexCache, then fetches
  // the individual resource file and registers the asset.
  packIndexUrl: string | undefined = undefined;
  packIndexCache:
    | Map<
        string,
        {
          relativeUrl: string;
          kind: string;
          name?: string;
          metadata?: ImageMetadata | undefined;
          refs?: readonly string[];
          compression?: AssetCompression;
        }
      >
    | undefined = undefined;

  // tweak-20260609 M1: in-flight Map for recursive loadByGuid dedup + cycle
  // prevention (D-5 / B-10). Maps guidKey → Promise<Result<Handle, ...>> so
  // concurrent calls for the same GUID share the same fetch + register chain,
  // and cycles (A→B→A) terminate when the second visit hits the in-flight
  // entry for A instead of re-entering fetch.
  readonly inFlight: Map<string, Promise<Result<unknown, AssetError | ImageError | RhiError>>> =
    new Map();

  // bug-20260610 Fix B (M3 / D-4): per-instance pack-file cache keyed by
  // relativeUrl (the .pack.json URL). `packFileInFlight` de-duplicates
  // concurrent fetches; `packFileCache` stores resolved bodies so the
  // same URL is fetched at most once per AssetRegistry lifetime (CON-6).
  readonly packFileCache: Map<string, ParsedPackFile> = new Map();
  readonly packFileInFlight: Map<string, Promise<ParsedPackFile>> = new Map();

  // feat-20260621-asset-registry-robustness-invalidate-inflight-cach F17c:
  // per-GUID generation counter incremented on each invalidate(guid) call.
  // loadByGuid captures this value at Promise creation and discards the
  // result (returning asset-invalidated) if the generation has changed by
  // the time the fetch completes.
  // F22: invalidateAll increments a single globalGeneration counter instead,
  // which invalidates every in-flight Promise regardless of GUID.
  readonly generations: Map<string, number> = new Map();
  globalGeneration: number = 0;

  // F20: per-cache Promise queue to serialise packIndexCache write operations
  // in transportOrFail. The "check -> new Map() -> set" three-step block is
  // not atomic across concurrent transportOrFail calls; chaining through a
  // single queue Promise ensures each patch completes before the next starts.
  packIndexCachePatchQueue: Promise<void> = Promise.resolve();

  // feat-20260527-sprite-nineslice M4 / w16 + w18 (D-5 + D-9): per-Renderer
  // EngineMetrics shared with the runtime so register-time soft-warns
  // (`nineslice.tile-needs-repeat-sampler` for sliceMode=1 + sampler not
  // 'repeat') and runtime soft-warns (`nineslice.scale-too-small`) increment
  // the SAME counter map. `createRenderer.ts` calls `assets.setMetrics(metrics)`
  // immediately after constructing the registry; standalone test fixtures
  // that do not go through `createRenderer` may leave this null and the
  // soft-warn paths simply no-op (charter P9 graceful degradation: the
  // structured fail-fast branches still fire; only the metric is dropped).
  // feat-20260705-runtime-tier2-decomposition M1 / w5 (D-4): public so the
  // extracted `./registry/validate-material` free functions (detectTileNeeds-
  // RepeatSampler) can read + increment it. No underscore + genuinely public
  // is the lint-compliant exposure (D-internal R-internal-C ties `@internal`
  // to `_`).
  metrics: EngineMetrics | null = null;

  // feat-20260707 M5 / w33 (D-11): device texture-compression caps the Basis
  // texture / equirect arms feed to `selectTranscodeTarget`. `createRenderer`
  // projects `RhiCaps` -> `TranscodeCaps` and calls `setTranscodeCaps` right
  // after construction (D-8 one-line projection). A standalone registry (test /
  // headless) keeps the all-false default, which drives the uncompressed
  // fallback path (section 8 P3, AC-04) rather than a hard failure.
  transcodeCaps: TranscodeCaps = { bc: false, etc2: false, astc: false };

  // feat-20260703-collect-nested-sceneinstance-to-mount-roundtrip M1 (D-1):
  // origin reverse-index: a payload object -> its catalog GUID, for payloads
  // that are NOT the current catalog identity. WeakMap so entries auto-GC when
  // the world despawns and the object is no longer held by sharedRefs.
  // _guidForAsset consults it after the catalog identity scan MISSes.
  // SSOT for the "payload-to-GUID provenance" fact (architecture-principles #1).
  //
  // Two writers populate it:
  //   1. instantiate (registry/instantiate.ts): the resolved SceneAsset copy ->
  //      its original catalog GUID (the deep-copied envelope is never the catalog
  //      identity).
  //   2. feat-20260713 M4 / w15 (D-6, root cause a): catalog() records the
  //      SUPERSEDED payload here when re-cataloguing a GUID with a fresh object.
  //      A handle minted before the override still points at the old object; this
  //      keeps that object reverse-lookupable so save/collect resolves its GUID
  //      instead of failing with a GUID-unresolved error (the 2026-07-06 crash).
  //
  // Key type is `object` (not `SceneAsset`) because both material and scene
  // payloads are recorded (material payloads flow through writer 2).
  /** @internal */
  _originIndex: WeakMap<object, string> = new WeakMap();

  /**
   * Construct a fresh registry pre-populated with the builtin cube + triangle
   * mesh handles (`HANDLE_CUBE` / `HANDLE_TRIANGLE`).
   *
   * feat-20260514 M3 / w15: the previous optional `RhiDevice` constructor
   * argument (consumed by the now-deleted `createInstancedBuffer` triplet)
   * is removed; the registry surface is engine-agnostic again. Per-entity
   * instance transforms now live inside the ECS `Instances { transforms:
   * 'array<f32>' }` component; the RenderSystem record stage owns GPU
   * storage buffer allocation + cap-gate.
   */
  // feat-20260603-asset-import-loader-injection M1 / w5 (D-7): the registry
  // dispatches `parseAssetPayload` / the texture+font upstream branches through
  // this `LoaderRegistry`. feat-20260623 M3 / w9: the loader registry is now
  // internally built by `createDefaultLoaderRegistry()` (public readonly field)
  // so host apps can reach `engine.assets.loaders.register(...)` without a
  // constructor-injection slot or a phantom passthrough wrapper.
  // feat-20260705-runtime-tier2-decomposition M3 / w32 (D-2 terminal): the loader
  // set is wired at construction from the 10 engine-owned defaults (incl.
  // videoLoader, statically imported from @forgeax/engine-graphics-extras) plus
  // the caller's `extraLoaders` (createRenderer injects [audioLoaderPlaceholder]
  // to complete the 11-kind set). Assigned in the constructor so the optional
  // `extraLoaders` option threads through to createDefaultLoaderRegistry.
  readonly loaders: LoaderRegistry;

  // feat-20260603-asset-import-loader-injection M4 / w31 (AC-19 / AC-22):
  // the optional `ImportTransport` is the *only* difference between the studio
  // form (transport injected, dev DDC miss triggers lazy import) and the shipped
  // form (transport absent, DDC miss fails fast with `asset-not-imported`).
  // The load path AFTER a successful DDC fetch is identical in both forms --
  // zero branching on transport (AC-23 key invariant). Set at construction (no
  // setter, no illegal intermediate state), same D-7 stance as LoaderRegistry.
  readonly importTransport: ImportTransport | undefined;

  // feat-20260705-runtime-tier2-decomposition M1 / w9 (D-1): optional post-spawn
  // hook invoked by `instantiate` after the scene subtree spawns. The shipped
  // implementation is runtime's `postSpawnResolveJoints` (auto-wire Skin.joints),
  // injected at the sole production assembly point (createRenderer, w10). When
  // absent (standalone / test registries), instantiate skips joint wiring
  // silently. Public so the extracted `./registry/instantiate` free function can
  // read it (D-internal R-internal-C ties `@internal` to a `_` prefix;
  // genuinely-public is the lint-compliant exposure).
  readonly postSpawnHook: PostSpawnHook | undefined;

  /** @internal Stored for M2 validation; TS suppressor reference */
  constructor(
    // feat-20260705-runtime-tier2-decomposition M1 / w5 (D-4): public so the
    // extracted `./registry/validate-material` free functions can read it. No
    // underscore + genuinely public is the lint-compliant exposure (an
    // `@internal` tag would require a `_` prefix per D-internal R-internal-C).
    readonly shaderRegistry: ShaderRegistry,
    importTransport?: ImportTransport | undefined,
    // feat-20260705-runtime-tier2-decomposition M3 / w32 (D-2 terminal):
    // caller-supplied loaders appended after the 10 engine defaults (createRenderer
    // passes the audio placeholder; videoLoader is now an engine default wired
    // from graphics-extras; standalone/test registries omit extraLoaders and get
    // the 10-kind default set).
    extraLoaders?: readonly Loader[] | undefined,
    // feat-20260705-runtime-tier2-decomposition M1 / w9 (D-1): optional
    // post-spawn hook; createRenderer injects `postSpawnResolveJoints`.
    postSpawnHook?: PostSpawnHook | undefined,
  ) {
    void this.shaderRegistry;
    this.importTransport = importTransport;
    this.postSpawnHook = postSpawnHook;
    this.loaders = createDefaultLoaderRegistry(extraLoaders);
    // feat-20260614 M8 (D-15): builtins are GUID-addressable catalogue rows.
    // The builtin payloads also live process-static in BuiltinAssetRegistry
    // (slot < BUILTIN_BASE) for handle-tier resolution; here they are
    // catalogued by GUID so loadByGuid(builtinGuid) returns the payload and
    // scene refs[] pointing at a builtin GUID resolve without a hand-
    // maintained table (docs/feedbacks/2026-06-03 §6.2 Tier 0).
    const builtinByHandle = new Map<number, Asset>([
      [handleSlot(HANDLE_CUBE), BUILTIN_CUBE],
      [handleSlot(HANDLE_TRIANGLE), BUILTIN_TRIANGLE],
      [handleSlot(HANDLE_QUAD), BUILTIN_QUAD],
      [handleSlot(HANDLE_SPHERE), BUILTIN_SPHERE],
      [handleSlot(HANDLE_NINESLICE_QUAD), BUILTIN_NINESLICE_QUAD],
      [handleSlot(HANDLE_CYLINDER), BUILTIN_CYLINDER],
    ]);
    for (const [handle, guidStr] of BUILTIN_MESH_GUIDS) {
      const parsed = AssetGuid.parse(guidStr);
      if (!parsed.ok) {
        throw new Error(`[asset-registry] builtin GUID ${guidStr} is not a valid UUID`);
      }
      const payload = builtinByHandle.get(handleSlot(handle));
      if (payload !== undefined)
        this.assetCatalog.set(guidStr.toLowerCase(), {
          guid: guidStr,
          kind: payload.kind,
          payload,
          refs: [],
        });
    }
    // D-5: builtin meshes have no import path and no source name -- register
    // them with a null package so resolveName returns '' (the detectable
    // "genuinely no name" signal). They are deliberately NOT given a synthetic
    // package + derived name (memory builtin-guid-preregister-collides).
    this._registerPackage(
      null,
      BUILTIN_MESH_GUIDS.map(([, guidStr]) => guidStr),
    );
  }

  /**
   * feat-20260527-sprite-nineslice M4 / w16 prep + w18 (D-5 + D-9): inject the
   * per-Renderer `EngineMetrics` so register-time soft-warns can bump the same
   * counter map the runtime reads through `renderer.metrics.snapshot()`. Called
   * by `createRenderer` after constructing both the registry and the metrics
   * instance; safe to skip in standalone tests (the soft-warn arms simply do
   * not record).
   */
  setMetrics(metrics: EngineMetrics): void {
    this.metrics = metrics;
  }

  /**
   * feat-20260707 M5 / w33 (D-11): wire the device compression caps used by the
   * Basis texture / equirect transcode arms. `createRenderer` calls this right
   * after construction with `RhiCaps` projected to `TranscodeCaps` (D-8). Left
   * at the all-false default, the loaders transcode to the uncompressed
   * `rgba8unorm` / `rgba16float` fallback (AC-04, section 8 P3).
   */
  setTranscodeCaps(caps: TranscodeCaps): void {
    this.transcodeCaps = caps;
  }

  /**
   * @internal — read the metrics handle for register-time soft-warn paths.
   * Returns `null` when no `createRenderer` wired the registry to a renderer
   * (the standalone-test path; the structured fail-fast branches still fire).
   */
  _getMetrics(): EngineMetrics | null {
    return this.metrics;
  }

  /**
   * @internal — reverse-lookup: find the GUID key for a catalogued asset
   * payload by identity comparison (===). Returns the GUID string if found,
   * `undefined` otherwise. This is the SSOT for the inline identity scan
   * idiom that previously existed in two places (instantiate sceneGuidKey
   * lookup and resolveSkinAsset skeleton match).
   *
   * Linear scan of the assetCatalog (Map<string, AssetEnvelope>). The O(n)
   * cost is acceptable for save-path frequencies (OOS-2).
   */
  _guidForAsset(asset: Asset): string | undefined {
    for (const [key, envelope] of this.assetCatalog) {
      if (envelope.payload === asset) {
        return key;
      }
    }
    // feat-20260703 M1 (D-1): fallback to the origin reverse-index. Covers two
    // MISS cases the catalog identity scan cannot: (1) _resolveSceneGuids deep
    // copies — the copy is never the catalogued original; (2) feat-20260713 M4
    // (D-6): a payload superseded by a catalog override, still live behind a
    // handle minted before the override.
    return this._originIndex.get(asset as object);
  }

  /**
   * Configure the production pack-index URL for `loadByGuid`.
   *
   * Call this once during engine initialization with the URL where
   * `pack-index.json` is served (emitted by `@forgeax/engine-vite-plugin-pack`
   * during `vite build`). After configuration, `loadByGuid` will fetch
   * the catalog on its first invocation and cache it for subsequent calls.
   *
   * @example
   * ```ts
   * engine.assets.configurePackIndex('/pack-index.json');
   * const payloadRes = await engine.assets.loadByGuid(guid); // payload, not a handle (D-17)
   * ```
   */
  configurePackIndex(url: string): void {
    this.packIndexUrl = url;
    this.packIndexCache = undefined; // reset cache if URL changes
  }

  /**
   * feat-20260621 F17c: invalidate a single cached asset by GUID so the next
   * `loadByGuid` performs a genuinely fresh fetch. Clears, for this GUID only:
   * the catalogue entry, the in-flight dedup entry, the cached pack-file body
   * (keyed by the index entry's relativeUrl), and the pack-index entry. Then
   * increments the per-GUID generation counter so any still in-flight Promise
   * for this GUID discards its result (returns `asset-invalidated`). The body +
   * index clears are targeted (other GUIDs' cached bodies and index entries
   * survive); deleting the index entry forces `resolveCatalogEntry` to re-fetch
   * the pack-index on the next load, re-resolving the relativeUrl whose body
   * cache was just dropped. No-op when the GUID is not catalogued.
   *
   * Does NOT touch `packages` (a re-load's registerPackage overwrites them; D-8)
   * and does NOT trigger GPU resource release (OOS-1,
   * q1 boundary: the asset is CPU-only; GPU resources follow the ECS).
   *
   * @param guid - Case-insensitive GUID string or AssetGuid.
   */
  invalidate(guid: string): void {
    const guidKey = guid.toLowerCase();
    // D-6: the stored name lives on the envelope; preserve it across the delete
    // (the `packages` mapping survives, so resolveName must still see the name
    // until a re-load's registerPackage overwrites it) by parking it on
    // pendingNames -- the next catalog() of this GUID drains it back.
    const survivingName = this.assetCatalog.get(guidKey)?.name;
    if (survivingName !== undefined) this.pendingNames.set(guidKey, survivingName);
    this.assetCatalog.delete(guidKey);
    // R-1 hard fix (research-decisions.md): delete inFlight entry so the
    // next loadByGuid does not hit the old Promise whose generation no
    // longer matches (AC-04 requires a fresh fetch, not asset-invalidated).
    this.inFlight.delete(guidKey);
    // Round-2 M-A: widen the clear so a COMPLETED reload re-fetches fresh
    // bytes instead of serving the stale cached body. Ordering is load-bearing:
    // read relativeUrl from the index entry FIRST, then delete the body, then
    // delete the index entry. Targeted delete (not wholesale undefined) keeps
    // other GUIDs' cached bodies/index entries intact (per-GUID precision).
    const entry = this.packIndexCache?.get(guidKey);
    if (entry !== undefined) this.packFileCache.delete(entry.relativeUrl);
    this.packIndexCache?.delete(guidKey);
    this.generations.set(guidKey, (this.generations.get(guidKey) ?? 0) + 1);
  }

  /**
   * feat-20260621 F17c: invalidate ALL cached assets so the next `loadByGuid`
   * re-fetches both the pack-index and the asset body. Clears assetCatalog,
   * inFlight, and packFileCache (wholesale), and resets packIndexCache to
   * `undefined` (NOT `.clear()` -- an empty Map would short-circuit
   * `resolveCatalogEntry`'s `=== undefined` re-fetch guard and serve
   * asset-not-imported for every later load; undefined forces a fresh
   * fetchPackIndex). Then increments a single globalGeneration counter so every
   * in-flight Promise (regardless of GUID) discards its result. Returns the
   * number of assets that were catalogued before the call.
   *
   * Idempotent: second call on an already-empty catalogue returns clearedCount 0
   * (AC-06). Does NOT trigger GPU resource release (OOS-1).
   */
  invalidateAll(): { clearedCount: number } {
    const count = this.assetCatalog.size;
    this.assetCatalog.clear();
    this.inFlight.clear();
    this.globalGeneration++;
    // Round-2 M-A: wholesale clear of the shared body cache, and reset the
    // index cache to UNDEFINED (R2-1) -- NOT .clear(). packFileCache uses
    // .clear() because fetchPackFile checks `.get(relativeUrl)` per URL, so an
    // empty Map correctly misses and re-fetches. packIndexCache uses =undefined
    // because resolveCatalogEntry's re-fetch guard tests `=== undefined`; an
    // empty Map would short-circuit it and serve asset-not-imported for every
    // later load -- the exact F17b pollution this feat fixes. The asymmetry is
    // intentional; do not normalise the two operations.
    this.packFileCache.clear();
    this.packIndexCache = undefined;
    return { clearedCount: count };
  }

  /**
   * Force a re-fetch of the configured pack-index NOW and repopulate the cache,
   * so a synchronous `listCatalog()` immediately reflects assets added on disk
   * since boot (a freshly imported GLB's sub-assets). `loadByGuid`'s lazy
   * re-fetch only fires on a per-GUID miss and `invalidateAll()` merely clears
   * the cache (leaving `listCatalog()` empty until the next load), so neither
   * makes a Content Browser or `loadByGuid`-driven "Add to Scene" see a new
   * asset without a page reload. This does.
   *
   * No-op (returns false) when no pack-index URL is configured (dev inline
   * catalogue path) or the fetch fails — callers keep the stale cache rather
   * than blanking it. Returns true when the cache was repopulated.
   */
  async refreshCatalog(): Promise<boolean> {
    if (this.packIndexUrl === undefined) return false;
    const result = await fetchPackIndex(this);
    if (!result.ok) return false;
    this.packIndexCache = result.value;
    registerPackagesFromIndex(this, this.packIndexCache);
    return true;
  }

  /**
   * Materialise a `SceneAsset` into an existing `World` and return the
   * synthetic root `Entity` (feat-20260514 w31 sugar wrapper; AC-03 +
   * requirements §IN-3; M3: returns Entity not SceneInstanceId).
   *
   * Before spawning, handle-type component fields (e.g. `assetHandle`,
   * `material`, `skeleton`) containing GUID strings are resolved to fresh
   * user-tier `Handle` numbers via `world.allocSharedRef` (feat-20260614 M8
   * D-19 instantiate-time GUID->handle mint; supersedes the pre-D-17
   * `resolveGuid` map). GUIDs that fail to parse or are not catalogued return
   * `AssetError(code='asset-not-found')` with a hint containing the GUID,
   * node localId, and field name.
   *
   * Errors propagate verbatim through the closed
   * `AssetError | PackError | EcsError` union so AI users that already
   * narrow `loadByGuid<SceneAsset>` results reuse the same `switch
   * (err.code)` exhaustively (charter proposition 3 machine-readable
   * union; plan-strategy §3.3 closed-union transparency).
   *
   * @example
   * ```ts
   * const sceneRes = await engine.assets.loadByGuid<SceneAsset>(roomGuid); // payload (D-17)
   * if (!sceneRes.ok) return;
   * const handle = world.allocSharedRef('SceneAsset', sceneRes.value);     // mint column handle
   * const r = engine.assets.instantiate(handle, world);
   * if (!r.ok) {
   *   switch (r.error.code) {
   *     case 'asset-not-found':
   *     case 'pack-cyclic-reference':
   *     // ... AssetErrorCode | PackErrorCode | EcsErrorCode exhaustive
   *   }
   * }
   * ```
   */
  instantiate<T extends SceneAsset>(
    handle: Handle<TagOf<T>, 'shared'>,
    world: World,
    parent?: EntityHandle,
  ): Result<EntityHandle, AssetError | PackError | EcsError> {
    return instantiateImpl(this, handle, world, parent);
  }

  /**
   * Materialise a `SceneAsset` FLAT into an existing `World` — the "open a scene
   * for authoring" registry entry (#655): NO synthetic SceneInstance root, NO
   * forced `ChildOf` on top-level members. Returns the top-level entity handles.
   * Nested prefabs (`mounts[]`) still materialise as their own SceneInstance
   * anchors. Use {@link instantiate} (anchor) at runtime / Play and for nested
   * prefabs.
   */
  instantiateFlat<T extends SceneAsset>(
    handle: Handle<TagOf<T>, 'shared'>,
    world: World,
  ): Result<EntityHandle[], AssetError | PackError | EcsError> {
    return instantiateFlatImpl(this, handle, world);
  }

  /**
   * @internal
   * Transform a SceneAsset whose handle-type component fields hold GUID
   * strings (post-parseScenePayload intermediate state) into a copy whose
   * handle fields hold resolved Handle numbers.
   *
   * Schema-driven field detection (plan-strategy D-4): for each component
   * field whose Component.schema fieldType starts with `shared\<`, the
   * value is treated as a GUID string and resolved via `AssetGuid.parse` +
   * catalogue lookup + `world.allocSharedRef` (feat-20260614 M8 D-15/D-17;
   * the registry mints nothing). Unknown component names are silently passed
   * through (the ecs layer's additionalProperties check will catch unknowns at
   * spawn if appropriate).
   *
   * Stop-on-first-error (AC-08): the first unresolvable GUID aborts
   * iteration and returns `AssetError(code='asset-not-found')` with a hint
   * containing the GUID string, node localId, and field name for AI-user
   * debuggability (P3).
   */
  _resolveSceneGuids(
    scene: SceneAsset,
    world: World,
    sceneGuidKey?: string,
    _visitedMountGuids?: Set<string>,
  ): Result<SceneAsset, AssetError> {
    // feat-20260622 M3 / w8: reverse-decode from envelope.refs edges when
    // sceneGuidKey is provided and the catalog holds an envelope for this
    // scene. Each edge with sceneEntityId+sourceField.componentName carries
    // the (entityLocalId, componentName, fieldName, arrayIndex) triple —
    // no need to walk entities with resolveComponent reflection.
    // D-15/D-17 dedup contract: the same catalogued GUID referenced from
    // multiple nodes must resolve to ONE user-tier handle (one allocSharedRef
    // per unique payload), so cross-node references share a single ref-counted
    // slot. Mint once per GUID, reuse for every later occurrence.
    const resolvedMap = new Map<string, number>();
    const guidToHandle = new Map<string, number>();
    const sceneEnvelope =
      sceneGuidKey !== undefined ? this.assetCatalog.get(sceneGuidKey) : undefined;
    // Did the structured-edge branch actually resolve anything? Prod-loaded
    // packs catalogue refs[] as GUID-only edges (sourceField / sceneEntityId
    // stripped at the w7 D-10 serialization boundary), so the rich-edge loop
    // below `continue`-skips every ref and resolves nothing. When that happens
    // we MUST fall through to the entity-walk fallback — otherwise the handle
    // fields keep their GUID strings and `spawn` writes the sentinel 0 while
    // `retainSharedScalarHandle(GUID)` routes `shared-ref-released` (the on-disk
    // game-scene instantiate crash: enemy MeshFilter.assetHandle).
    let resolvedFromEdges = false;
    if (
      sceneEnvelope !== undefined &&
      sceneEnvelope.refs !== undefined &&
      sceneEnvelope.refs.length > 0
    ) {
      for (const ref of sceneEnvelope.refs) {
        const { sceneEntityId, sourceField } = ref;
        if (sceneEntityId === undefined || sourceField === undefined) continue;
        const { componentName, fieldName, arrayIndex } = sourceField;
        if (componentName === undefined || fieldName === undefined) continue;

        const fieldPath = `${componentName}.${fieldName}${arrayIndex !== undefined ? `[${arrayIndex}]` : ''}`;

        const envelope = this.assetCatalog.get(ref.guid.toLowerCase());
        if (envelope === undefined) {
          return err(
            new AssetError({
              code: 'asset-not-found',
              expected: `GUID ${ref.guid} catalogued in AssetRegistry`,
              hint:
                `GUID ${ref.guid} not catalogued; ` +
                `call loadByGuid('${ref.guid}') before instantiate; ` +
                `at node localId=${sceneEntityId}, field=${fieldPath}`,
            }),
          );
        }
        const payload = envelope.payload;
        const guidKey = ref.guid.toLowerCase();
        let resolvedSlot = guidToHandle.get(guidKey);
        if (resolvedSlot === undefined) {
          resolvedSlot = unwrapHandle(world.allocSharedRef(payload.kind, payload));
          guidToHandle.set(guidKey, resolvedSlot);
        }

        const key =
          `${sceneEntityId}|${componentName}|${fieldName}` +
          (arrayIndex !== undefined ? `|${arrayIndex}` : '|');
        resolvedMap.set(key, resolvedSlot);
        resolvedFromEdges = true;
      }
    }
    if (!resolvedFromEdges) {
      // Fallback: positive extraction via extractSceneEntityHandleGuids when
      // the structured edges resolved nothing — either the scene envelope is
      // absent (unit tests that build a SceneAsset without cataloguing it) OR
      // the catalogued refs[] are GUID-only with no per-entity metadata (the
      // prod on-disk pack path). The entity-component walk recovers the
      // (localId, componentName, fieldName, arrayIndex) triple the bare edge
      // dropped, so GUID strings resolve to live handles before spawn.
      const entries = extractSceneEntityHandleGuids(
        scene.entities as unknown as ReadonlyArray<{
          readonly localId: number;
          readonly components: Record<string, Record<string, unknown>>;
        }>,
      );

      for (const entry of entries) {
        const fieldPath =
          `${entry.componentName}.${entry.fieldName}` +
          (entry.arrayIndex !== undefined ? `[${entry.arrayIndex}]` : '');
        const resolvedSlot = resolveHandleGuid(
          this,
          world,
          entry.guidString,
          guidToHandle,
          fieldPath,
          `node localId=${entry.entityLocalId}`,
        );
        if (!resolvedSlot.ok) return resolvedSlot;

        const key =
          `${entry.entityLocalId}|${entry.componentName}|${entry.fieldName}` +
          (entry.arrayIndex !== undefined ? `|${entry.arrayIndex}` : '|');
        resolvedMap.set(key, resolvedSlot.value);
      }
    }

    // Build the resolved copy. Handle-type fields (detected above) are
    // reconstructed from the resolvedMap; all other fields pass through as-is.
    const resolvedNodes: SceneEntity[] = [];
    for (const node of scene.entities) {
      const rawComponents = node.components as Record<string, Record<string, unknown>>;
      const resolvedComponents: Record<string, Record<string, unknown>> = {};

      for (const compName of Object.keys(rawComponents)) {
        const rawFields = rawComponents[compName];
        if (!rawFields) {
          resolvedComponents[compName] = {};
          continue;
        }
        const resolvedFields: Record<string, unknown> = {};
        for (const fieldName of Object.keys(rawFields)) {
          const value = rawFields[fieldName];
          const plainKey = `${node.localId}|${compName}|${fieldName}|`;
          const plainResolved = resolvedMap.get(plainKey);
          if (plainResolved !== undefined) {
            resolvedFields[fieldName] = plainResolved;
          } else if (Array.isArray(value)) {
            const resolvedArr: number[] = [];
            let hasAnyResolved = false;
            for (let i = 0; i < value.length; i++) {
              const arrKey = `${node.localId}|${compName}|${fieldName}|${i}`;
              const arrResolved = resolvedMap.get(arrKey);
              if (arrResolved !== undefined) {
                resolvedArr.push(arrResolved);
                hasAnyResolved = true;
              } else if (typeof value[i] === 'number') {
                resolvedArr.push(value[i]);
              }
            }
            resolvedFields[fieldName] = hasAnyResolved ? resolvedArr : value;
          } else {
            resolvedFields[fieldName] = value;
          }
        }
        resolvedComponents[compName] = resolvedFields;
      }
      resolvedNodes.push({
        localId: node.localId,
        components: resolvedComponents,
      });
    }

    // ── m3-i2 / m3-i3: Resolve mounts recursively (breakpoint B fix) ──
    // For each mount.source (GUID string), look up the child scene in
    // assetCatalog, recursively resolve its GUIDs, allocSharedRef the
    // resolved child copy, register it in originIndex (D-7), and produce
    // a resolved mount with source as the live handle number.
    // Cycle detection via visited GUID set (R-9): re-entry =>
    // pack-cyclic-reference / mount-asset, cast through the return type
    // as world.ts does for its PackError exits.
    const mountVisited = _visitedMountGuids ?? new Set<string>();
    if (sceneGuidKey !== undefined) mountVisited.add(sceneGuidKey.toLowerCase());
    if (scene.mounts !== undefined && scene.mounts.length > 0) {
      // feat-20260713 M3 / w13: share the entity-field dedup map so an override
      // value GUID that also appears as an entity field mints one handle (D-15/D-17).
      const resolvedMounts = resolveMountsRec(
        this,
        scene.mounts,
        world,
        mountVisited,
        guidToHandle,
      );
      if (sceneGuidKey !== undefined) mountVisited.delete(sceneGuidKey.toLowerCase());
      if (!resolvedMounts.ok) {
        // Cycle or child-resolution error: cast through as AssetError
        // (same pattern as world.ts PackError-as-EcsError casts).
        return resolvedMounts as unknown as Result<SceneAsset, AssetError>;
      }
      return ok({
        kind: 'scene',
        entities: resolvedNodes,
        mounts: resolvedMounts.value,
      } as SceneAsset);
    }
    if (sceneGuidKey !== undefined) mountVisited.delete(sceneGuidKey.toLowerCase());
    return ok({ kind: 'scene', entities: resolvedNodes });
  }

  /**
   * Register an asset and return a fresh
   * `Result<Handle<TagOf<T>, 'shared'>, AssetError>`. The brand `target`
   * tag is derived from the Asset's `kind` discriminator via `AssetTagMap`
   * (charter F1 single-entry indexability). The runtime representation is
   * an auto-incrementing u32 starting at 1024 (builtins reserve 1-2).
   *
   * feat-20260526 M4: `shadingModel` field is retired in favour of
   * pass-based MaterialAsset. This generic surface covers the full
   * `Asset` closed union (mesh / texture / sampler / scene / equirect
   * / material).
   */
  /**
   * feat-20260614 M8 (D-15 / D-17): catalogue a payload under its GUID.
   * Replaces the old `register` / `registerWithGuid` mint pair -- the registry
   * stores the PAYLOAD and never produces a handle (it owns no World).
   * Column minting is the caller's job via `world.allocSharedRef`.
   *
   * Validates mesh stride + material passes / sprite slices at catalogue entry
   * (same fail-fast surface as the old register path). Returns
   * `Result.err(AssetError)` on validation failure; `Result.ok(payload)` with
   * the stored payload (mesh payloads gain an `aabb`) on success.
   */
  catalog<T = Asset>(
    guid: AssetGuid | string,
    asset: T,
    refs?: readonly AssetRef[],
  ): Result<T, AssetError> {
    // D-5: narrow T to Asset for kind-discriminate branches. The runtime
    // catalog only accepts Asset-kind payloads (host custom kinds enter
    // through loadByGuid + registerParsedAsset, not catalog directly).
    const a: Asset = asset as unknown as Asset;
    const meshValidation = validateMeshPayload(a);
    if (meshValidation !== null) return err(meshValidation);

    // feat-20260608 M0 baseline rebuild: tileset payload fail-fast gate at
    // register entry — region rectangle bounds-check uses the implicit atlas
    // extent (columns * tileWidth x rows * tileHeight) when the caller did
    // not supply an explicit one (charter P3 explicit failure).
    if (a.kind === 'tileset') {
      const tilesetAsset = a as TilesetAsset;
      const tilesetValidation = validateTilesetPayload(
        tilesetAsset,
        inferAtlasExtent(tilesetAsset),
      );
      if (tilesetValidation !== null) return err(tilesetValidation);
    }

    // feat-20260527 M2 / w6: material validation with union paramSchema
    // semantics across all passes (plan-strategy D-2, D-5).
    if (a.kind === 'material') {
      const matValidation = validateMaterialPasses(this, a as MaterialAsset);
      if (matValidation !== null) return err(matValidation);
      const sliceValidation = validateSpriteSlices(this, a as MaterialAsset);
      if (sliceValidation !== null) return err(sliceValidation);
      detectTileNeedsRepeatSampler(this, a as MaterialAsset);
    }

    let stored: Asset = a;
    if (a.kind === 'mesh') {
      stored = withMeshAabb(a as TypesMeshAsset);
    }
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    const kind = a.kind;
    // Drain any name recorded by an earlier _registerPackage call whose body had
    // not yet been catalogued (prod disk path; D-6). Preserve a name already on
    // a prior envelope for this key (re-catalog of the same GUID).
    const pendingName = this.pendingNames.get(key);
    const priorEnvelope = this.assetCatalog.get(key);
    const priorName = priorEnvelope?.name;
    const name = pendingName ?? priorName;
    this.pendingNames.delete(key);
    // feat-20260713 M4 / w15 (D-6, root cause a): when this GUID is being
    // re-catalogued with a DIFFERENT payload object, the prior object may still
    // be live behind a handle minted before the override (asset-registry.ts:513
    // identity scan would then MISS it). Record the superseded object -> GUID in
    // the origin reverse-index so `_guidForAsset` keeps resolving it — save/
    // collect of an owned entity holding that handle no longer fails with a
    // GUID-unresolved error (the 2026-07-06 crash). Structurally-modified copies
    // (a fresh object never catalogued) stay uncatalogued and correctly surface a
    // structured error at collect (requirements edge case "modified payload judged
    // as a new asset, not silently zeroed").
    if (priorEnvelope !== undefined && priorEnvelope.payload !== stored) {
      this._originIndex.set(priorEnvelope.payload, key);
    }
    this.assetCatalog.set(key, {
      guid: key,
      kind,
      ...(name !== undefined ? { name } : {}),
      payload: stored,
      refs: refs ?? [],
    });
    // D-1: catalog() inline path defaults every GUID to the no-package state
    // (null). loadByGuid + builtin override via their own registerPackage calls
    // before / after this so the package mapping is populated for all assets
    // through the single primitive (#1 SSOT). Do not clobber a package mapping
    // a prior registerPackage already established for this GUID.
    if (!this.packages.has(key)) this.packages.set(key, null);
    return ok(stored as T);
  }

  /**
   * @internal feat-20260618-asset-and-pack-name-fields M3 (D-1): the single
   * package-mapping write primitive. All three registration entry points funnel
   * here so the XOR name invariant is implemented once (#1 SSOT):
   *   - catalog() inline path -> registerPackage(null, [guid])          (no package)
   *   - loadByGuid disk path  -> registerPackage(relativeUrl, [g1,g2,...], names)
   *   - constructor builtin    -> registerPackage(null, [...guids])      (D-5 null)
   *
   * `path === null` registers the GUIDs with no package (resolveName reads their
   * storedName or returns ''). A non-null `path` finds-or-creates the shared
   * MutablePackage for that path and adds the GUIDs to it; per-GUID entry names
   * (D-2: name flows entry -> Package, never the payload) are taken from
   * `names`. The 1->N promotion branch (D-3) is added by w11. Never throws --
   * it only writes maps; resolution + validation happen in resolveName / rename.
   */
  _registerPackage(
    path: string | null,
    guids: readonly string[],
    names?: Map<string, string>,
  ): void {
    if (path === null) {
      for (const g of guids) {
        const key = g.toLowerCase();
        this.packages.set(key, null);
        const n = names?.get(g) ?? names?.get(key);
        if (n !== undefined) this.setStoredName(key, n);
      }
      return;
    }

    const pkg = this.packageByPath.get(path) ?? { path, assetGuids: new Set<string>() };
    this.packageByPath.set(path, pkg);

    // D-3: 1->N promotion. When this path already holds exactly one asset and a
    // new member is arriving, freeze the original asset's derived basename as its
    // stored name so it joins the multi-asset branch with a stable name. The
    // freeze is idempotent: an original that already carries a stored name (the
    // abnormal single-asset-with-name state, D-4) is left untouched and the
    // soft-violation counter records it (charter P3 machine-readable signal).
    const addsNewMember = guids.some((g) => !pkg.assetGuids.has(g.toLowerCase()));
    if (pkg.assetGuids.size === 1 && addsNewMember) {
      const [originalKey] = pkg.assetGuids;
      if (originalKey !== undefined) {
        if (this.hasStoredName(originalKey)) {
          this.metrics?.increment('package.xor-invariant-violated');
        } else {
          this.setStoredName(originalKey, deriveAssetName(pkg.path, 1));
        }
      }
    }

    for (const g of guids) {
      const key = g.toLowerCase();
      pkg.assetGuids.add(key);
      this.packages.set(key, pkg);
      const n = names?.get(g) ?? names?.get(key);
      if (n !== undefined) this.setStoredName(key, n);
    }
  }

  /**
   * Read the per-GUID stored display name (D-6 home: the envelope's `name`
   * field, with `pendingNames` covering the prod-disk ordering where the name is
   * known before the body is catalogued). Single read point for resolveName /
   * the 1->N promotion XOR check.
   */
  private storedNameFor(key: string): string | undefined {
    return this.assetCatalog.get(key)?.name ?? this.pendingNames.get(key);
  }

  private hasStoredName(key: string): boolean {
    return this.storedNameFor(key) !== undefined;
  }

  /**
   * Write the per-GUID stored display name. When the envelope exists, replace it
   * with one carrying the new `name` (the envelope is immutable; D-6 keeps the
   * payload free of the name). Before the envelope is catalogued (prod disk
   * path), stash on `pendingNames` so catalog() can drain it into the new
   * envelope. `name === undefined` clears the name in both homes.
   */
  private setStoredName(key: string, name: string | undefined): void {
    const envelope = this.assetCatalog.get(key);
    if (envelope !== undefined) {
      const { name: _drop, ...rest } = envelope;
      this.assetCatalog.set(key, name === undefined ? rest : { ...rest, name });
      this.pendingNames.delete(key);
      return;
    }
    if (name === undefined) this.pendingNames.delete(key);
    else this.pendingNames.set(key, name);
  }

  /**
   * Return the `Package` this GUID belongs to, or `null` when the asset has no
   * package (catalog() inline + builtin, D-5), or `undefined` when the GUID was
   * never registered. The returned `Package` is a readonly snapshot whose
   * `assetCount` is derived from the live member set (#2 Derive).
   */
  packageOf(guid: AssetGuid | string): Package | null | undefined {
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    const pkg = this.packages.get(key);
    if (pkg === undefined) return undefined;
    if (pkg === null) return null;
    return { path: pkg.path, assetGuids: pkg.assetGuids, assetCount: pkg.assetGuids.size };
  }

  /**
   * Resolve an asset's human-readable display name -- the single source of truth
   * for the two-segment identity's `name` segment (D-6). Every name consumer
   * (inspect / catalog builder / CLI) reads this or the same `deriveAssetName`
   * pure function it delegates to (AC-04); no consumer re-implements the XOR
   * rule. Returns a deterministic fallback rather than throwing on a missing
   * name (AC-15): `basename(path)` for a multi-asset entry that lacks a stored
   * name, or `''` for a no-package asset with no self name (the detectable
   * "genuinely no name" signal, charter P3). An unregistered GUID is treated as
   * the no-package branch.
   */
  resolveName(guid: AssetGuid | string): string {
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    const pkg = this.packages.get(key);
    const storedName = this.storedNameFor(key);
    const path = pkg == null ? null : pkg.path;
    const assetCount = pkg == null ? 0 : pkg.assetGuids.size;
    return deriveAssetName(path, assetCount, storedName);
  }

  /**
   * Rename an asset's display name in memory (D-4). Three classes by package
   * shape:
   *   - no-package asset      -> set the stored self name
   *   - multi-asset package   -> set the entry stored name
   *   - single-asset package  -> rewrite the package path's leaf segment so the
   *                              derived basename becomes `newName` (the package
   *                              stays single-asset; the leaf IS the name)
   *
   * In-memory only (OOS-1: no disk write-back). Returns structured failures via
   * the closed `AssetErrorCode` union with no new members (D-4): a name that
   * collides with another member of the same package -> `asset-invalid-value`;
   * an unregistered GUID -> `asset-not-found`. AI users consume `.code` through
   * a `switch`, not by parsing `.message` (charter P3).
   */
  rename(guid: AssetGuid | string, newName: string): Result<void, AssetError> {
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    if (!this.packages.has(key)) {
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `a registered asset for GUID ${key}`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      );
    }

    const pkg = this.packages.get(key) ?? null;

    const collision = pkg !== null ? this.nameCollisionIn(pkg, key, newName) : null;
    if (collision !== null) return err(collision);

    if (pkg !== null && pkg.assetGuids.size === 1) {
      // Single-asset package: the leaf segment IS the derived name; rewrite it so
      // basename(path) === newName. Keep the directory prefix intact.
      const slash = pkg.path.lastIndexOf('/');
      const oldPath = pkg.path;
      pkg.path = slash >= 0 ? `${pkg.path.slice(0, slash + 1)}${newName}` : newName;
      this.packageByPath.delete(oldPath);
      this.packageByPath.set(pkg.path, pkg);
      this.setStoredName(key, undefined);
      return ok(undefined);
    }

    this.setStoredName(key, newName);
    return ok(undefined);
  }

  /**
   * Return an `asset-invalid-value` AssetError if another member of `pkg`
   * already resolves to `newName`, else null. Extracted from `rename` to keep
   * the collision-detection control flow flat (D-4 reuses the closed error code;
   * the detail narrows via the `{ field, value, reason }` union variant).
   */
  private nameCollisionIn(
    pkg: MutablePackage,
    selfKey: string,
    newName: string,
  ): AssetError | null {
    for (const memberKey of pkg.assetGuids) {
      if (memberKey !== selfKey && this.resolveName(memberKey) === newName) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected: `a name unique within package "${pkg.path}"`,
          hint: `another asset in "${pkg.path}" is already named "${newName}"; choose a distinct name`,
          detail: {
            field: 'name',
            value: newName,
            reason: `duplicate name within package ${pkg.path}`,
          },
        });
      }
    }
    return null;
  }

  /**
   * Parse a dash-form GUID string into an `AssetGuid`. Thin convenience over
   * `AssetGuid.parse` for the `loadByGuid` / `catalog` call sites; throws
   * `AssetError` on a malformed GUID (caller-error, mirrors `parseInt`-style
   * eager validation -- the GUID literal is author-supplied, not user data).
   */
  parseGuid(guidStr: string): AssetGuid {
    const parsed = AssetGuid.parse(guidStr);
    if (!parsed.ok) {
      throw new AssetError({
        code: 'asset-parse-failed',
        expected: `valid dash-form GUID, got "${guidStr}"`,
        hint: ASSET_ERROR_HINTS['asset-parse-failed'],
      });
    }
    return parsed.value;
  }

  /**
   * Look up a catalogued payload by GUID, or `undefined` on miss. Used by the
   * ECS/render side (e.g. `walkMaterialParents` in `resolve-asset-handle.ts`)
   * to resolve a payload's embedded sub-asset GUIDs (D-19) without minting.
   */
  lookup<T = Asset>(guid: AssetGuid | string): T | undefined {
    const key =
      typeof guid === 'string' ? guid.toLowerCase() : AssetGuid.format(guid).toLowerCase();
    return this.assetCatalog.get(key)?.payload as T | undefined;
  }

  /**
   * feat-20260613-material-paramschema-driven-binding M4 / w23 (D-5 graceful):
   * Return the texture-field name set for the given material-shader id,
   * derived from the registered shader's paramSchema via `derive(paramSchema)
   * .textureFieldNames`. Returns `undefined` when the shader is not yet
   * registered (cross-worktree shader-late-register, plan R-4).
   *
   * Used by `extractFrame` to know which paramValues fields the shader
   * declares as texture handles; the extract layer validates handle-vs-
   * scalar typing and drops misclassified slots so the record stage's
   * MISSING_TEXTURE_HANDLE fallback can take over (white default texture)
   * rather than letting a stray handle reach `device.createBindGroup`.
   *
   * feat-20260705-runtime-tier2-decomposition M1 / w5 (D-4): delegates to the
   * extracted `./registry/validate-material` free function (signature stable).
   */
  materialShaderTextureFieldNames(shaderId: string): ReadonlySet<string> | undefined {
    return materialShaderTextureFieldNamesImpl(this, shaderId);
  }

  /**
   * Load an asset and all its transitively referenced sub-assets by GUID.
   * Delegates to the load-by-guid collaboration module (w7 / D-4); see
   * registry/load-by-guid.ts for the full DDC / pack-fetch pipeline.
   */
  async loadByGuid<T = Asset>(
    guid: AssetGuid,
    parentContext?: {
      sceneEntityId?: number;
      componentField?: string;
    },
  ): Promise<Result<T, AssetError | ImageError | RhiError>> {
    return loadByGuidImpl<T>(this, guid, parentContext);
  }

  /**
   * Dispatch a pack payload through the injected LoaderRegistry. Delegates to
   * the load-by-guid collaboration module (w7 / D-4). Kept as a class method so
   * existing structural-cast test access keeps resolving.
   */
  parseAssetPayload(
    kind: string,
    payload: Record<string, unknown>,
    refs?: string[],
  ):
    | Asset
    | Record<string, unknown>
    | undefined
    | { readonly ok: false; readonly error: ParseErrorDetail } {
    return parseAssetPayloadImpl(this, kind, payload, refs);
  }

  /**
   * Parse a pack asset entry and return the payload + refs. Delegates to the
   * load-by-guid collaboration module (w7 / D-4). Kept as a class method so
   * existing structural-cast test access keeps resolving.
   */
  parseAndReturnAsset(assetEntry: {
    kind: string;
    payload: Record<string, unknown>;
    refs?: string[];
  }): Result<{ asset: Asset; refs: readonly string[] }, AssetError> {
    return parseAndReturnAssetImpl(this, assetEntry);
  }
  inspect(): InspectSnapshot {
    const assets: InspectEntry[] = [];
    for (const [guid, envelope] of this.assetCatalog) {
      assets.push({
        guid,
        kind: envelope.payload.kind,
        name: this.resolveName(guid),
      });
    }
    return { assets };
  }

  /**
   * Return a readonly snapshot of all catalogued assets (inlined + pack-index)
   * for enumeration by asset panels (AC-03 single source of truth).
   *
   * Merges entries from the private `packIndexCache` (prod path, carries
   * `relativeUrl`) and `assetCatalog` (inlined / dev path, no URL). Each
   * GUID appears exactly once. Returns a fresh array on every call — the
   * internal Maps are never exposed (charter P4 consistent abstraction).
   *
   * plan-strategy section 2 D1; requirements AC-03; research Finding 5.
   *
   * @example
   * ```ts
   * for (const e of registry.listCatalog()) {
   *   console.log(e.guid, e.kind, e.name, e.relativeUrl);
   * }
   * ```
   */
  listCatalog(): readonly {
    guid: string;
    kind: string;
    name?: string;
    relativeUrl: string;
    refs?: readonly string[];
    /** Build-time compression strategy. `undefined` for legacy / uncompressed rows. */
    compression?: AssetCompression;
  }[] {
    const seen = new Set<string>();
    const result: {
      guid: string;
      kind: string;
      name?: string;
      relativeUrl: string;
      refs?: readonly string[];
      compression?: AssetCompression;
    }[] = [];

    // Prod entries: packIndexCache carries relativeUrl + optional name + refs.
    if (this.packIndexCache) {
      for (const [guidKey, entry] of this.packIndexCache) {
        seen.add(guidKey);
        result.push({
          guid: guidKey,
          kind: entry.kind,
          name: entry.name ?? '',
          relativeUrl: entry.relativeUrl,
          ...(entry.refs !== undefined ? { refs: entry.refs } : {}),
          ...(entry.compression !== undefined ? { compression: entry.compression } : {}),
        });
      }
    }

    // Inlined / dev-path entries: assetCatalog, no pack-index URL. The envelope
    // holds the authoritative AssetRef[] graph; flatten it to plain GUID edges
    // so both catalog paths expose the same refs: readonly string[] shape.
    for (const [guidKey, envelope] of this.assetCatalog) {
      if (!seen.has(guidKey)) {
        const name = envelope.name ?? this.resolveName(guidKey);
        result.push({
          guid: guidKey,
          kind: envelope.payload.kind,
          name,
          relativeUrl: '',
          ...(envelope.refs.length > 0 ? { refs: envelope.refs.map((r) => r.guid) } : {}),
        });
      }
    }

    return result;
  }
}
