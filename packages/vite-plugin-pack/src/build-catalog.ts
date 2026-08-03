// build-catalog - extracted catalog builder for the forgeax engine
// asset package system Vite plugin
// (feat-20260517-vite-plugin-image-build-time-cook M1 w3;
//  feat-20260521-unify-sidecar-meta-dispatch-by-content unified sidecar dispatch).
//
// Two arms; image / gltf / audio / font split keyed on top-level `importer` field
// inside the .meta.json (not on filename form; sidecars are uniformly
// `<source>.meta.json`). `importer` is the open string key the
// @forgeax/engine-import runner dispatches on (feat-20260603-asset-import-loader-injection
// M2; replaces the former closed `assetType` enum, one-cut migration):
//   - `*.pack.json`  -- self-contained `internal-text-package` arm, emits one
//      PackIndexEntry per `assets[]` row (4-field, no `metadata`).
//   - `*.meta.json`  -- `external-asset-package` arm. Reads `meta.importer`.
//      The catalog knows how to fold four importer keys: 'image' emits a
//      5-field row per `subAssets[]` of `kind: 'texture'` or `kind: 'equirect'`.
//      'gltf' emits a 4-field row per `subAssets[]` of kind 'mesh' / 'material' /
//      'scene' + a 5-field row per 'texture' with ImageMetadata defaults
//      (linear colorSpace / no mipmap -- enriched at import time, M4 AC-16).
//      'audio' emits a 4-field row per `subAssets[]` of kind 'audio'
//      with no catalog-side artifact facts (feat-20260527-audio-system M4 w32). 'font'
//      emits a 5-field atlas texture row + a thin font row. The reserved
//      'shader' key never reaches here. Authored MaterialAsset packages are
//      ordinary `*.pack.json` internal-text-package entries and are projected
//      into the catalog by the first arm above.
//
// The `mipmap` token mapping (`'auto'` -> `true` / `'none'` -> `false`)
// happens here in one place so runtime is unaware of the string form
// (D-5 SSOT). `colorSpace` flows through verbatim. `format` is derived
// from `colorSpace` (`'srgb'` -> `'rgba8unorm-srgb'` / `'linear'` ->
// `'rgba8unorm'`) so the catalog row carries the GPU-side format
// literal directly; runtime narrows on `entry.metadata.format` without
// re-deriving.
//
// Other importSettings fields (`addressMode`, `filterMode`) intentionally
// stay outside `metadata`: those are sampler-side properties that flow
// through `MaterialAsset.sampler` not through the texture POD.
//
// `width` / `height` are deliberately omitted in dev-mode rows: the
// catalog builder reads JSON only; the JPG decode that produces pixel
// dimensions happens at runtime parseAssetPayload (`parseImage`). The
// build-mode (import) path will fill them in M4 (out of scope here).
//
// Schema note: `meta.schema.json#$defs/subAsset.kind.enum` was extended
// with `'image'` in the same M1 w3 commit so the upstream `scan()` step
// admits image sidecars instead of returning `pack-malformed-meta`.

import { readFile } from 'node:fs/promises';
import { posix, relative } from 'node:path';
import { loadAssetConfig } from '@forgeax/engine-pack/config';
import { deriveAssetName } from '@forgeax/engine-pack/name';
import { resolveAssetSource } from '@forgeax/engine-pack/resolve';
import { scan } from '@forgeax/engine-pack/scanner';
import { validateMeta } from '@forgeax/engine-pack/schema';
import type {
  AssetAuthoringCapability,
  AssetRelation,
  CatalogDiagnostic,
  PackIndexEntry,
  ProviderProvenance,
  ResourceRevision,
} from '@forgeax/engine-types';
import { catalogOperationsFor } from '@forgeax/engine-types';

function projectionFor(
  subject: 'internal-asset' | 'imported-output',
  execution: 'direct' | 'cooked',
  lifecycle: 'missing' | 'cooking' | 'current' | 'stale' | 'failed',
) {
  return {
    subject,
    execution,
    lifecycle,
    operations: catalogOperationsFor({ subject, execution, lifecycle }),
  } as const;
}

export function projectPackageCatalog(
  entries: readonly Pick<
    PackIndexEntry,
    'guid' | 'kind' | 'sourcePath' | 'name' | 'refs' | 'authoring' | 'execution'
  >[],
  packageUrl: string,
): PackIndexEntry[] {
  return entries.map((entry) => ({
    guid: entry.guid,
    kind: entry.kind,
    sourcePath: entry.sourcePath,
    packageUrl: packageUrl,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(entry.refs === undefined ? {} : { refs: entry.refs }),
    ...(entry.authoring === undefined ? {} : { authoring: entry.authoring }),
    subject: 'internal-asset',
    execution: entry.execution ?? 'direct',
    lifecycle: entry.execution === 'cooked' ? 'missing' : 'current',
    projection: projectionFor(
      'internal-asset',
      entry.execution ?? 'direct',
      entry.execution === 'cooked' ? 'missing' : 'current',
    ),
  }));
}

interface PackJson {
  readonly schemaVersion?: string;
  readonly packageId?: string;
  readonly provenance?: ProviderProvenance;
  readonly revision?: ResourceRevision;
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly assets?: ReadonlyArray<{
    readonly guid: string;
    readonly kind: string;
    /** Optional display name (D-6 add-only). */
    readonly name?: string;
    /** Outgoing dependency GUIDs (pack.schema.json assets[].refs). */
    readonly refs?: readonly string[];
    readonly execution?: 'direct' | 'cooked';
    readonly sourceKey?: string;
    readonly sourceIndex?: number;
    readonly relations?: PackIndexEntry['relations'];
    readonly authoring?: AssetAuthoringCapability;
  }>;
}

// Prefix a root-absolute source path with the Vite `base`. The runtime fetches
// each catalog `packageUrl` verbatim from the page origin, so when the engine
// is hosted under a non-root base (e.g. forgeax-studio mounts the engine at
// `base: '/preview/'` and the interface dev server only proxies `/preview/*`),
// the catalog URL MUST carry that prefix — otherwise the fetch falls through to
// the host SPA, returns index.html, and loadByGuid fails with
// `asset-fetch-failed`. Default base `'/'` (engine's own apps at vite root)
// is a no-op, so existing `/.forgeax/...` / `/<rel>` URLs are unchanged.
function withBase(base: string, sourceRel: string): string {
  const rootAbs = posix.resolve('/', sourceRel);
  const prefix = base.replace(/\/$/, ''); // '/preview/' -> '/preview', '/' -> ''
  return prefix ? `${prefix}${rootAbs}` : rootAbs;
}

function metaPackageUrl(base: string, firstGuid: string | undefined): string {
  const packageName = firstGuid === undefined ? 'pack' : firstGuid.toLowerCase();
  return withBase(base, `__forgeax-ddc/${packageName}.pack.json`);
}

interface ExternalAssetMetaJson {
  readonly schemaVersion: string | number;
  readonly kind: 'external-asset-package';
  readonly packageId?: string;
  readonly provenance?: ProviderProvenance;
  readonly revision?: ResourceRevision;
  readonly diagnostics?: readonly CatalogDiagnostic[];
  // P2 (feat-20260629 D-4): the importer key is an open string. The catalog
  // dispatches the engine-built-in arms (image / gltf / fbx / audio / font) on
  // literal comparisons below; any other key is a host importer, folded via
  // the registered-key set or reported as a structured provider conflict when
  // unregistered. There is no closed whitelist of foldable keys.
  readonly importer: string;
  readonly source?: string;
  readonly importSettings: {
    readonly colorSpace?: 'srgb' | 'linear';
    readonly mipmap?: 'auto' | 'none';
    readonly downscaleMaxDimension?: number;
  };
  readonly subAssets: ReadonlyArray<{
    readonly guid: string;
    readonly sourceIndex: number;
    readonly kind: string;
    readonly authoring?: AssetAuthoringCapability;
    readonly sourceKey?: string;
    /** Optional display name from the source (e.g. glTF image.name / mesh.name). */
    readonly name?: string;
  }>;
}

function referenceRelations(
  guid: string,
  refs: readonly string[] | undefined,
  provenance: ProviderProvenance,
): readonly AssetRelation[] | undefined {
  if (refs === undefined || refs.length === 0) return undefined;
  return refs.map((ref) => ({
    from: { type: 'asset', id: guid } as const,
    to: { type: 'asset', id: ref } as const,
    type: 'references' as const,
    policy: { strength: 'required' as const },
    provenance,
  }));
}

function producerFields(
  producer: {
    readonly packageId?: string;
    readonly provenance?: ProviderProvenance;
    readonly revision?: ResourceRevision;
    readonly diagnostics?: readonly CatalogDiagnostic[];
    readonly provider?: string;
    readonly importer?: string;
    readonly schemaVersion: string | number;
  },
  output?: {
    readonly guid: string;
    readonly kind: string;
    readonly sourceKey?: string;
    readonly sourceIndex?: number;
    readonly relations?: PackIndexEntry['relations'];
    readonly authoring?: AssetAuthoringCapability;
  },
  refs?: readonly string[],
): Pick<
  PackIndexEntry,
  | 'packageId'
  | 'provenance'
  | 'revision'
  | 'sourceKey'
  | 'sourceIndex'
  | 'relations'
  | 'diagnostics'
  | 'subject'
  | 'execution'
  | 'lifecycle'
  | 'projection'
> {
  const provenance =
    producer.provenance ??
    ({
      provider: producer.provider ?? producer.importer ?? 'engine',
      version: String(producer.schemaVersion),
    } satisfies ProviderProvenance);
  const relations = output?.relations ?? referenceRelations(output?.guid ?? '', refs, provenance);
  return {
    provenance,
    ...(producer.packageId !== undefined ? { packageId: producer.packageId } : {}),
    ...(producer.revision !== undefined ? { revision: producer.revision } : {}),
    ...(output?.sourceKey !== undefined ? { sourceKey: output.sourceKey } : {}),
    ...(output?.sourceIndex !== undefined ? { sourceIndex: output.sourceIndex } : {}),
    ...(output === undefined
      ? {}
      : {
          ...(output.authoring === undefined ? {} : { authoring: output.authoring }),
        }),
    ...(relations !== undefined ? { relations } : {}),
    ...(producer.diagnostics !== undefined ? { diagnostics: producer.diagnostics } : {}),
    subject: 'imported-output',
    execution: 'cooked',
    lifecycle: 'missing',
    projection: projectionFor('imported-output', 'cooked', 'missing'),
  };
}

/**
 * Structured failure surface returned by `buildCatalog` when a sidecar
 * fails validation (e.g. missing top-level `importer`,
 * illegal enum value). Carries the failing path + ajv error list so
 * the Vite plugin and the catalog scanner can fail-fast with a
 * machine-readable diagnostic instead of silently skipping.
 */
export interface CatalogBuildError {
  readonly code:
    | 'catalog-meta-missing-importer'
    | 'catalog-meta-schema-invalid'
    | 'catalog-scan-failed'
    | 'catalog-provider-unregistered'
    | 'catalog-raw-source-unsupported'
    // P2 (feat-20260629 D-7): a registered host importer declared a sub.kind
    // that collides with an engine-owned kind. Reported, never silently
    // shadowing the engine kind.
    | 'catalog-host-kind-conflict';
  readonly path: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly hint?: string;
  readonly subjects?: readonly string[];
}

export type CatalogAuthority = 'authoritative' | 'degraded';

/** One canonical snapshot plus its authority and machine-readable diagnostics. */
export interface CatalogBuildResult {
  readonly entries: readonly PackIndexEntry[];
  readonly authority: CatalogAuthority;
  readonly diagnostics: readonly CatalogBuildError[];
}

/**
 * Versioned compatibility projection for legacy catalog consumers.
 *
 * The rows remain derived from the canonical result, but authority and
 * diagnostics travel with the projection. A degraded first-seen snapshot is
 * therefore never observable as an unmarked identity-bearing array.
 */
export interface CatalogLegacyProjection {
  readonly schemaVersion: 'catalog-legacy-v1';
  readonly entries: readonly PackIndexEntry[];
  readonly authority: CatalogAuthority;
  readonly diagnostics: readonly CatalogBuildError[];
}

/**
 * Project the canonical catalog result for a versioned legacy consumer.
 *
 * This is the only compatibility boundary for the old array-shaped response;
 * the canonical result remains the schema SSOT and is never reconstructed from
 * the projection.
 */
export function projectLegacyCatalog(result: CatalogBuildResult): CatalogLegacyProjection {
  return {
    schemaVersion: 'catalog-legacy-v1',
    entries: [...result.entries],
    authority: result.authority,
    diagnostics: [...result.diagnostics],
  };
}

// The importer keys the catalog folds via dedicated, hard-coded arms below.
// Any other key is a host importer: folded via default passthrough when the
// host registered it (`pluginPack({ importers })`), or reported as a
// structured provider conflict when unregistered (P2 / feat-20260629 D-3/D-4).
const ENGINE_BUILTIN_IMPORTER_KEYS: ReadonlySet<string> = new Set([
  'image',
  'gltf',
  'fbx',
  'audio',
  'font',
  // Shader sidecars are consumed by vite-plugin-shader. They are scanned
  // alongside pack roots, but must never become runtime catalog rows.
  'shader',
]);

// The pack-index `kind` values the engine's own arms + runtime loaders own. A
// registered host importer must NOT pass one of these through as its sub.kind
// (it would shadow the engine loader). D-7: the fold layer reports the conflict
// rather than silently overriding the engine kind.
const ENGINE_BUILTIN_KINDS: ReadonlySet<string> = new Set([
  'texture',
  'equirect',
  'mesh',
  'material',
  'scene',
  'sampler',
  'skeleton',
  'skin',
  'animation-clip',
  'audio',
  'font',
]);

/**
 * D-7 host-kind conflict check: a registered host importer must not declare a
 * sub.kind the engine already owns. Returns the first conflicting
 * `CatalogBuildError`, or `null` when all sub.kinds are host-namespaced.
 */
function findHostKindConflict(
  meta: ExternalAssetMetaJson,
  rawPath: string,
): CatalogBuildError | null {
  for (const sub of meta.subAssets) {
    if (ENGINE_BUILTIN_KINDS.has(sub.kind)) {
      return {
        code: 'catalog-host-kind-conflict',
        path: rawPath,
        message: `host importer ${JSON.stringify(meta.importer)} declares sub.kind ${JSON.stringify(sub.kind)}, which collides with an engine-owned kind; rename the host kind (engine-owned: ${[...ENGINE_BUILTIN_KINDS].join(', ')})`,
        expected: 'host importer kinds must not use engine-owned kinds',
        actual: sub.kind,
        hint: 'rename the host kind to a provider-owned namespace before rebuilding',
        subjects: [rawPath],
      };
    }
  }
  return null;
}

/**
 * Shared processor for a single `*.meta.json` sidecar -- reads the file,
 * runs the fail-fast validation (parse -> importer field -> full schema),
 * and on success emits image-arm catalog rows by appending to `out`.
 *
 * Returns a `CatalogBuildError` on the first failure encountered, or
 * `null` on success (including the `importer === 'gltf'` skip case,
 * which contributes no catalog rows).
 *
 * Called by both `buildCatalog` (which warns to stderr) and
 * `buildCatalogStrict` (which collects errors structurally) so the
 * sidecar validation contract has exactly one source of truth.
 */
async function processMetaSidecar(
  rawPath: string,
  cwd: string,
  out: PackIndexEntry[],
  base: string,
  paths: Record<string, string>,
  registeredImporterKeys: ReadonlySet<string>,
): Promise<CatalogBuildError | null> {
  let metaRaw: unknown;
  try {
    const content = await readFile(rawPath, 'utf-8');
    metaRaw = JSON.parse(content);
  } catch (e) {
    return {
      code: 'catalog-meta-schema-invalid',
      path: rawPath,
      message: `failed to read or parse sidecar: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Fail-fast validation: meta.importer is a required non-empty string
  // (feat-20260603-asset-import-loader-injection M2; replaces the former
  // closed `assetType` enum). P2 (feat-20260629 D-4) removed the closed
  // 5-key whitelist wall that used to reject any other importer key with
  // `catalog-meta-unfoldable-importer`: fold is now driven by the registered
  // importer set, not a hard-coded key list. A non-engine-built-in key is a
  // host importer -- folded via default passthrough when registered, or
  // reported as a structured provider conflict when unregistered (see the
  // host-importer arm below).
  const metaObj = (metaRaw ?? {}) as Record<string, unknown>;
  if (typeof metaObj.importer !== 'string' || metaObj.importer.length === 0) {
    return {
      code: 'catalog-meta-missing-importer',
      path: rawPath,
      message: "sidecar missing required top-level non-empty 'importer' field",
    };
  }
  const valid = validateMeta(metaRaw);
  if (!valid) {
    const ajvErrs = (validateMeta.errors ?? []).map(
      (e) => `${e.instancePath ?? '/'} ${e.message ?? ''}`,
    );
    return {
      code: 'catalog-meta-schema-invalid',
      path: rawPath,
      message: `sidecar fails meta.schema.json validation: ${ajvErrs.join('; ')}`,
    };
  }

  const meta = metaRaw as ExternalAssetMetaJson;

  if (meta.importer === 'shader') {
    return {
      code: 'catalog-raw-source-unsupported',
      path: rawPath,
      message:
        'shader sidecars are not runtime catalog assets; publish cooked shader output before cataloging',
      expected: 'shader source to be consumed by vite-plugin-shader and published as cooked output',
      actual: 'shader',
      hint: 'remove shader source from the pack catalog roots or publish its cooked runtime module',
      subjects: [rawPath],
    };
  }

  // Compute the source file path once for deriveAssetName. The source file is
  // the "package" for the meta.json arm: each subAsset is an artifact produced
  // from that source (e.g. a glTF file produces mesh/material/scene/texture
  // sub-assets). deriveAssetName uses this path + the sub-asset count to apply
  // the same XOR name-resolution rule as the .pack.json arm (D-6 SSOT).
  const sourceResolved = resolveAssetSource(rawPath, meta.source, paths);
  if (!sourceResolved.ok) {
    return {
      code: 'catalog-meta-schema-invalid',
      path: rawPath,
      message: `source resolution failed: ${sourceResolved.error.code} - ${sourceResolved.error.hint}`,
    };
  }
  const sourceAbsPath = sourceResolved.value;
  const subAssetCount = meta.subAssets.length;

  function subName(sub: { readonly name?: string }): string {
    return deriveAssetName(sourceAbsPath, subAssetCount, sub.name);
  }

  if (meta.importer === 'image') {
    const sourceRel = relative(cwd, sourceAbsPath).replace(/\\/g, '/');
    // Normalize `..` segments so the URL resolves against the Vite
    // root, then prefix the configured base.  Use posix.resolve so Windows
    // does not produce a drive-prefixed backslash path (issue #191).
    const normalizedUrl = metaPackageUrl(base, meta.subAssets[0]?.guid);
    for (const sub of meta.subAssets) {
      if (sub.kind === 'equirect') {
        // feat-20260630: an .hdr equirect sub-asset folds to a kind:'equirect'
        // row carrying rgba16float ImageMetadata. The runtime equirectLoader
        // (Pack artifact loader set, derived) fetches cooked artifact bytes; the
        // cube-to-cube IBL projection is a GPU-side pass driven by the record
        // arm (no build-time face cook, no cubeFaceSize / specularMipLevels).
        out.push({
          guid: sub.guid,
          packageUrl: normalizedUrl,
          kind: 'equirect',
          sourcePath: sourceRel,
          ...producerFields(meta, sub),
          name: subName(sub),
        });
      } else {
        // P1: default passthrough — sub.kind (e.g. 'texture') becomes the
        // pack-index kind. The former 'image'→'texture' hard-coded remap
        // (sub.kind === 'image' gate) is removed; sidecars now declare
        // the real kind directly.
        out.push({
          guid: sub.guid,
          packageUrl: normalizedUrl,
          kind: sub.kind,
          sourcePath: sourceRel,
          ...producerFields(meta, sub),
          name: subName(sub),
        });
      }
    }
  }

  // importer === 'audio': fold each subAsset of kind 'audio' into a thin
  // 4-field PackIndexEntry (guid / packageUrl / kind='audio' / sourcePath).
  // metadata is intentionally undefined -- audio clips have no image metadata
  // (no width/height/format/colorSpace/mipmap per plan-strategy D-8).
  // (feat-20260527-audio-system M4 w32).
  if (meta.importer === 'audio') {
    const sourceRel = relative(cwd, sourceAbsPath).replace(/\\/g, '/');
    const normalizedUrl = metaPackageUrl(base, meta.subAssets[0]?.guid);

    for (const sub of meta.subAssets) {
      if (sub.kind === 'audio') {
        out.push({
          guid: sub.guid,
          packageUrl: normalizedUrl,
          kind: 'audio',
          sourcePath: sourceRel,
          ...producerFields(meta, sub),
          name: subName(sub),
        });
      }
    }
  }

  // importer === 'gltf': fold each subAsset of kind 'mesh' / 'material' /
  // 'scene' / 'sampler' / 'texture' into PackIndexEntry rows. 'mesh' / 'material' /
  // 'scene' are thin 4-field rows (metadata undefined) that the runtime
  // loader resolves via parseGltfFromFile / parseGlbFromFile at consumption
  // time (feat-20260523-vite-plugin-pack-dev-path-gltf-subasset-support).
  //
  // 'texture' rows carry 5-field ImageMetadata (kind / format / colorSpace /
  // mipmap; width / height are optional and filled after import at
  // generateBundle time -- feat-20260608 M4 AC-16). The defaults are
  // 'linear' colorSpace + no mipmap: the catalog builder reads JSON only,
  // so per-texture colour intent (sRGB vs linear inferred from material
  // channel) is not available without decoding the glTF doc. The safe
  // default ('linear') is overridden by the importer at build-time import.
  //
  // sub.kind values flow through verbatim (no remap) per requirements AC-03.
  if (meta.importer === 'gltf') {
    const sourceRel = relative(cwd, sourceAbsPath).replace(/\\/g, '/');
    const normalizedUrl = metaPackageUrl(base, meta.subAssets[0]?.guid);

    // Build a memoized metadata for texture rows in this sidecar. The gltf
    // sidecar does not carry per-texture colorSpace / mipmap, so we default
    // to linear + no mipmap; the importer enriches these at import time.
    for (const sub of meta.subAssets) {
      // tweak-20260611 M6: skeleton / skin / animation-clip are emitted by
      // gltfImporter (M4) alongside the existing mesh / material / scene
      // rows; they carry the same 4-field thin shape (metadata undefined)
      // because the runtime loader resolves them via parseGlbFromFile at
      // consumption time, same as mesh/material/scene.
      if (
        sub.kind === 'mesh' ||
        sub.kind === 'material' ||
        sub.kind === 'scene' ||
        sub.kind === 'sampler' ||
        sub.kind === 'skeleton' ||
        sub.kind === 'skin' ||
        sub.kind === 'animation-clip'
      ) {
        out.push({
          guid: sub.guid,
          packageUrl: normalizedUrl,
          kind: sub.kind,
          sourcePath: sourceRel,
          ...producerFields(meta, sub),
          name: subName(sub),
        });
      } else if (sub.kind === 'texture') {
        out.push({
          guid: sub.guid,
          packageUrl: normalizedUrl,
          kind: 'texture',
          sourcePath: sourceRel,
          ...producerFields(meta, sub),
          name: subName(sub),
        });
      }
    }
  }

  // importer === 'fbx': fold each sub-asset kind (mesh / material / scene /
  // sampler / texture / skeleton / skin / animation-clip) into a thin 4-field row
  // (metadata undefined). Mirrors the 'gltf' arm since fbxImporter emits the
  // same 7 sub-asset POD families resolved at runtime via the dev-server
  // POST /__import/:guid route. The native binding is Node.js-only, so the
  // import runs at build time / dev-server time only — never in browser.
  // (feat-20260615-fbx-importer-via-sdk M3-M5).
  if (meta.importer === 'fbx') {
    const sourceRel = relative(cwd, sourceAbsPath).replace(/\\/g, '/');
    const normalizedUrl = metaPackageUrl(base, meta.subAssets[0]?.guid);

    for (const sub of meta.subAssets) {
      if (
        sub.kind === 'mesh' ||
        sub.kind === 'material' ||
        sub.kind === 'scene' ||
        sub.kind === 'sampler' ||
        sub.kind === 'skeleton' ||
        sub.kind === 'skin' ||
        sub.kind === 'animation-clip'
      ) {
        out.push({
          guid: sub.guid,
          packageUrl: normalizedUrl,
          kind: sub.kind,
          sourcePath: sourceRel,
          ...producerFields(meta, sub),
          name: subName(sub),
        });
      } else if (sub.kind === 'texture') {
        out.push({
          guid: sub.guid,
          packageUrl: normalizedUrl,
          kind: 'texture',
          sourcePath: sourceRel,
          ...producerFields(meta, sub),
          name: subName(sub),
        });
      }
    }
  }

  // importer === 'font': the engine-font bake path emits a sidecar whose
  // subAssets carry the MSDF atlas (kind='texture') alongside the glyph-metrics
  // FontAsset (kind='font'). The atlas folds into a 5-field texture row with
  // ImageMetadata (mirroring the image arm: the atlas PNG is sampled like any
  // other texture; distanceRange / atlas dimensions live in the FontAsset
  // .common block loaded from the font .pack.json payload, not in the texture
  // metadata). The glyph-metrics row is a thin 4-field PackIndexEntry with
  // metadata=undefined -- the runtime loadByGuid font arm resolves the atlas /
  // sampler handles + glyph metrics at consumption time (plan-strategy D-10).
  if (meta.importer === 'font') {
    const sourceRel = relative(cwd, sourceAbsPath).replace(/\\/g, '/');
    const normalizedUrl = metaPackageUrl(base, meta.subAssets[0]?.guid);
    for (const sub of meta.subAssets) {
      if (sub.kind === 'texture') {
        out.push({
          guid: sub.guid,
          packageUrl: normalizedUrl,
          kind: 'texture',
          sourcePath: sourceRel,
          ...producerFields(meta, sub),
          name: subName(sub),
        });
      } else if (sub.kind === 'font') {
        out.push({
          guid: sub.guid,
          packageUrl: normalizedUrl,
          kind: 'font',
          sourcePath: sourceRel,
          ...producerFields(meta, sub),
          name: subName(sub),
        });
      }
    }
  }

  // importer === 'ui': UI author sources are imported lazily in dev and
  // emitted as finalized JSON assets in builds. Keep each declared UiAsset
  // discoverable in the catalog so the runtime can resolve its GUID and the
  // dev transport can upgrade the row after POST /__import/:guid.
  if (meta.importer === 'ui') {
    const sourceRel = relative(cwd, sourceAbsPath).replace(/\\/g, '/');
    const normalizedUrl = metaPackageUrl(base, meta.subAssets[0]?.guid);
    for (const sub of meta.subAssets) {
      if (sub.kind !== 'ui') continue;
      out.push({
        guid: sub.guid,
        packageUrl: normalizedUrl,
        kind: 'ui',
        sourcePath: sourceRel,
        ...producerFields(meta, sub),
        name: subName(sub),
      });
    }
  }

  // Host importer arm (P2 / feat-20260629 D-3/D-4): any importer key that is
  // not an engine built-in is a host importer. Fold is registry-driven --
  //   - registered (host wired it via `pluginPack({ importers })`): default
  //     passthrough, emitting one row per subAsset with `sub.kind` carried
  //     through verbatim as the pack-index kind (no engine remap).
  //   - unregistered: return a structured provider conflict and emit no rows;
  //     an incomplete provider projection cannot be authoritative (AC-08).
  // Engine built-in arms above own their keys; this arm never runs for them.
  if (!ENGINE_BUILTIN_IMPORTER_KEYS.has(meta.importer)) {
    const sourceRel = relative(cwd, sourceAbsPath).replace(/\\/g, '/');
    const isRegistered = registeredImporterKeys.has(meta.importer);
    // Registered providers own a real cook path. Publish the deterministic
    // Pack v2 URL up front so the runtime can fetch the authored package
    // through the same catalog contract as engine-owned assets; the dev
    // server fills this body on the first GET via the provider importer.
    const normalizedUrl = isRegistered
      ? metaPackageUrl(base, meta.subAssets[0]?.guid)
      : withBase(base, sourceRel);

    if (isRegistered) {
      // D-7: a registered host importer must not pass through a kind the engine
      // already owns (that would silently shadow the engine loader). Report the
      // conflict instead of folding the row.
      const conflict = findHostKindConflict(meta, rawPath);
      if (conflict) return conflict;
    } else {
      return {
        code: 'catalog-raw-source-unsupported',
        path: rawPath,
        message: `sidecar importer ${JSON.stringify(meta.importer)} is not registered; provide a cooked package before publishing catalog navigation`,
        expected: 'the sidecar importer must be present in the registered provider set',
        actual: meta.importer,
        hint: 'wire the provider through pluginPack({ importers }) and rebuild',
        subjects: [rawPath],
      };
    }

    for (const sub of meta.subAssets) {
      out.push({
        guid: sub.guid,
        packageUrl: normalizedUrl,
        kind: sub.kind,
        sourcePath: sourceRel,
        ...producerFields(meta, sub),
        name: subName(sub),
      });
    }
  }

  return null;
}

/**
 * Fold a flat list of scanned sidecar paths into catalog rows. Shared SSOT
 * for both `buildCatalog` (warns errors to stderr) and `buildCatalogStrict`
 * (returns errors structurally) so the two-arm dispatch + pack.json parse
 * lives in exactly one place.
 *
 * Two-arm dispatch on extension:
 *   - `.pack.json` -- self-contained rows from `assets[]`
 *   - `.meta.json` -- 5-field rows (4 core + `metadata`) from `subAssets[]`
 */
async function foldPaths(
  rawPaths: readonly string[],
  cwd: string,
  base: string,
  assetPaths: Record<string, string>,
  registeredImporterKeys: ReadonlySet<string>,
): Promise<{ catalog: PackIndexEntry[]; errors: CatalogBuildError[] }> {
  const catalog: PackIndexEntry[] = [];
  const errors: CatalogBuildError[] = [];
  for (const rawPath of rawPaths) {
    if (rawPath.endsWith('.meta.json') && !rawPath.endsWith('.pack.json')) {
      const err = await processMetaSidecar(
        rawPath,
        cwd,
        catalog,
        base,
        assetPaths,
        registeredImporterKeys,
      );
      if (err) errors.push(err);
      continue;
    }
    if (!rawPath.endsWith('.pack.json')) continue;
    try {
      const content = await readFile(rawPath, 'utf-8');
      const parsed = JSON.parse(content) as PackJson;
      const rel = relative(cwd, rawPath).replace(/\\/g, '/');
      const normalizedUrl = withBase(base, rel);
      const assetList = parsed.assets ?? [];
      const packagePath = rawPath;
      const assetCount = assetList.length;
      const packProducer = {
        ...(parsed.packageId !== undefined ? { packageId: parsed.packageId } : {}),
        ...(parsed.provenance !== undefined ? { provenance: parsed.provenance } : {}),
        ...(parsed.revision !== undefined ? { revision: parsed.revision } : {}),
        ...(parsed.diagnostics !== undefined ? { diagnostics: parsed.diagnostics } : {}),
        provider: 'pack' as const,
        schemaVersion: parsed.schemaVersion ?? 'legacy',
      };
      for (const [sourceIndex, asset] of assetList.entries()) {
        catalog.push({
          guid: asset.guid,
          packageUrl: normalizedUrl,
          kind: asset.kind,
          sourcePath: rel,
          ...producerFields(
            packProducer,
            { ...asset, sourceIndex: asset.sourceIndex ?? sourceIndex },
            asset.refs,
          ),
          name: deriveAssetName(packagePath, assetCount, asset.name),
          ...(asset.refs !== undefined ? { refs: asset.refs } : {}),
          subject: 'internal-asset',
          execution: asset.execution ?? 'direct',
          lifecycle: asset.execution === 'cooked' ? 'missing' : 'current',
          projection: projectionFor(
            'internal-asset',
            asset.execution ?? 'direct',
            asset.execution === 'cooked' ? 'missing' : 'current',
          ),
        });
      }
    } catch (e) {
      errors.push({
        code: 'catalog-meta-schema-invalid',
        path: rawPath,
        message: `failed to parse pack.json: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return { catalog, errors };
}

/**
 * Build a flat pack-index catalog by scanning roots.
 *
 * Fast path: `scan(roots)` over all roots at once (cross-root GUID collision
 * detection intact).
 *
 * Resilience (downstream template integration #3): `scan` is fail-fast and
 * returns `Err` on the FIRST GUID collision anywhere across all roots.
 * Collapsing the whole catalog to `[]` on that error meant one game's
 * collision blanked EVERY game's assets on a shared dev server (game A's
 * duplicate GUID turned game B's character into the fallback primitive). Two
 * independently-authored games may legitimately reuse a GUID, which a single
 * global index cannot represent. So on scan failure we degrade to per-root
 * scans: each root is scanned alone (intra-root collisions still fail that
 * one root, fail-fast preserved within a game), rows are de-duped by GUID
 * across roots (keep first), and only the offending root drops out instead
 * of the entire catalog.
 */
export async function buildCatalogResult(
  roots: readonly string[],
  base = '/',
  registeredImporterKeys: ReadonlySet<string> = new Set(),
): Promise<CatalogBuildResult> {
  if (roots.length === 0) {
    return { entries: [], authority: 'authoritative', diagnostics: [] };
  }

  const cwd = process.cwd();
  const { paths: assetPaths } = loadAssetConfig(cwd);
  const result = await scan(roots);

  const warnErrors = (errors: readonly CatalogBuildError[]): void => {
    for (const e of errors) {
      console.warn(`[forgeax-pack] catalog meta error ${e.code} @ ${e.path}: ${e.message}`);
    }
  };

  if (result.ok) {
    const { catalog, errors } = await foldPaths(
      result.value,
      cwd,
      base,
      assetPaths,
      registeredImporterKeys,
    );
    warnErrors(errors);
    return {
      entries: catalog,
      authority: errors.length === 0 ? 'authoritative' : 'degraded',
      diagnostics: errors,
    };
  }

  // Global scan failed (e.g. cross-root GUID collision). Degrade per-root
  // instead of collapsing the whole catalog.
  console.warn(
    `[forgeax-pack] scan error: ${result.error.message} — falling back to per-root scan`,
  );
  const catalog: PackIndexEntry[] = [];
  const seen = new Set<string>();
  const errors: CatalogBuildError[] = [];
  for (const root of roots) {
    const r = await scan([root]);
    if (!r.ok) {
      console.warn(
        `[forgeax-pack] per-root scan error @ ${root}: ${r.error.message} — dropping this root`,
      );
      errors.push({
        code: 'catalog-scan-failed',
        path: root,
        message: r.error.message,
        expected: 'the root to pass pack/meta scanning',
        actual: r.error.message,
        hint: 'repair this root before treating its catalog rows as authoritative',
        subjects: [root],
      });
      continue;
    }
    const folded = await foldPaths(r.value, cwd, base, assetPaths, registeredImporterKeys);
    errors.push(...folded.errors);
    for (const row of folded.catalog) {
      const key = row.guid.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      catalog.push(row);
    }
  }
  if (errors.length === 0 && roots.length > 1) {
    errors.push({
      code: 'catalog-scan-failed',
      path: '<scan>',
      message: result.error.message,
      expected: 'all catalog roots to pass pack/meta scanning',
      actual: result.error.message,
      hint: 'repair the affected roots and rebuild the authoritative catalog before applying identity changes',
      subjects: [...roots],
    });
  }
  warnErrors(errors);
  return { entries: catalog, authority: 'degraded', diagnostics: errors };
}

/** Legacy array API derived from the canonical build result. */
export async function buildCatalogProjection(
  roots: readonly string[],
  base = '/',
  registeredImporterKeys: ReadonlySet<string> = new Set(),
): Promise<CatalogLegacyProjection> {
  return projectLegacyCatalog(await buildCatalogResult(roots, base, registeredImporterKeys));
}

/**
 * Legacy array API. A degraded result fails closed instead of exposing its
 * first-seen rows as an unmarked identity-bearing array. Callers that need
 * authority and diagnostics must consume buildCatalogProjection.
 */
export async function buildCatalog(
  roots: readonly string[],
  base = '/',
  registeredImporterKeys: ReadonlySet<string> = new Set(),
): Promise<PackIndexEntry[]> {
  const projection = await buildCatalogProjection(roots, base, registeredImporterKeys);
  return projection.authority === 'authoritative' ? [...projection.entries] : [];
}

/**
 * Variant that returns both catalog rows and structured errors instead
 * of warning to stderr. Used by unit tests / scanner integration to
 * fail-fast on schema breaches (feat-20260521 AC-08).
 */
export async function buildCatalogStrict(
  roots: readonly string[],
  base = '/',
  registeredImporterKeys: ReadonlySet<string> = new Set(),
): Promise<{
  catalog: PackIndexEntry[];
  errors: CatalogBuildError[];
  projection: CatalogLegacyProjection;
}> {
  const result = await buildCatalogResult(roots, base, registeredImporterKeys);
  return {
    catalog: [...result.entries],
    errors: [...result.diagnostics],
    projection: projectLegacyCatalog(result),
  };
}
