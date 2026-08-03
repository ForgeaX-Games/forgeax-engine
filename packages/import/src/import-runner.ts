// @forgeax/engine-import - import runner (feat-20260603-asset-import-loader-injection M2 / w15).
//
// The build-time orchestration that turns one parsed `*.meta.json` sidecar
// into the logical Pack v2 package. It is the consumer side of
// the ImporterRegistry: it reads `meta.importer`, looks up the registered
// Importer, calls `importer.import(ctx)`, enforces the GUID import-stable iron
// law against the produced asset set, then folds the produced PODs into
// logical `assets[]` rows. Artifact bytes stay with their owning asset;
// final paths and integrity belong to M3.
//
// Error model (charter P3, ImportErrorCode 5 closed members):
//   - importer-not-registered  : registry.get(meta.importer) === undefined
//   - source-read-failed       : ctx.readSource() failed
//   - import-internal-error    : importer.import threw (never bare-throws out)
//   - guid-mismatch            : produced a GUID not declared in subAssets[]
//   - import-produced-no-assets: produced [], or omitted a declared GUID
//
// The reserved key `importer: 'shader'` is skipped (plan-strategy D-4 /
// research Finding 10): shader sidecars are consumed by the orthogonal
// `@forgeax/engine-vite-plugin-shader` transform pipeline, never by asset
// import. `runImport` returns `{ ok: true, value: { skipped: 'shader' } }`
// for them so the caller can account for the sidecar without writing a DDC.

import type {
  AssetCodec,
  AssetRelation,
  CatalogDiagnostic,
  CookProduct,
  ImageError,
  ImportContext,
  ImportDiagnostic,
  ImportError as ImportErrorType,
  ImportedArtifactBody,
  ImportProduct,
  ProviderProvenance,
  ResourceRevision,
  TextureAsset,
} from '@forgeax/engine-types';
import { IMPORT_ERROR_HINTS, ImportError } from '@forgeax/engine-types';
import { finalizeImportProducts } from './import-product.js';
import type { ImporterRegistry } from './importer-registry.js';

/** Reserved `meta.importer` key consumed by vite-plugin-shader, not the import runner. */
export const SHADER_RESERVED_IMPORTER_KEY = 'shader';

/**
 * Classify an importer throw as a build-time module-LOAD failure (the importer
 * module / native addon could not be imported) vs a conversion THROW (the
 * loaded importer ran and threw). feat-20260629 D-5: both keep the
 * `import-internal-error` code, but a load failure surfaces `.detail.loadError`
 * so AI users distinguish "my importer is not loadable / not built" from "my
 * importer ran and crashed" without parsing `.message`.
 *
 * Node signals a module-load failure via `err.code` (`MODULE_NOT_FOUND` for
 * CJS `require`, `ERR_MODULE_NOT_FOUND` for ESM `import()`, `ERR_DLOPEN_FAILED`
 * for a broken native `.node` addon) or a recognizable message. Native FBX-style
 * bindings throw a plain Error whose message names the missing addon.
 */
function isModuleLoadFailure(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  if (
    code === 'MODULE_NOT_FOUND' ||
    code === 'ERR_MODULE_NOT_FOUND' ||
    code === 'ERR_DLOPEN_FAILED'
  ) {
    return true;
  }
  const msg = e.message;
  return (
    msg.includes('Cannot find module') || msg.includes('native addon') || msg.includes('.node')
  );
}

/**
 * bug-20260610-pack-typed-array-roundtrip: normalise a value tree so every
 * typed-array becomes a plain `number[]`. The DDC pack is serialised via
 * `JSON.stringify`; left as-is, a `Float32Array` round-trips to an indexed
 * object (`{ "0": v0, ... }`) and the runtime mesh / animation-clip loaders
 * reject it with `asset-parse-failed`. Walking the tree once at the importer
 * boundary keeps every downstream consumer (build emitFile, dev startMetaImport,
 * and any future pack-cache tool) aligned on the same on-disk shape.
 */
export function normaliseForPack(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (
    value instanceof Float32Array ||
    value instanceof Float64Array ||
    value instanceof Uint8Array ||
    value instanceof Uint16Array ||
    value instanceof Uint32Array ||
    value instanceof Int8Array ||
    value instanceof Int16Array ||
    value instanceof Int32Array
  ) {
    return Array.from(value as ArrayLike<number>);
  }
  if (Array.isArray(value)) {
    return value.map(normaliseForPack);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normaliseForPack(v);
    }
    return out;
  }
  return value;
}

/** Result envelope returned by {@link runImport} (mirrors the engine `Result<T,E>` shape). */
export type RunImportResult =
  | { readonly ok: true; readonly value: RunImportOk }
  | { readonly ok: false; readonly error: ImportErrorType };

export type RunImportProductResult =
  | {
      readonly ok: true;
      readonly value:
        | { readonly skipped: 'shader' }
        | {
            readonly product: ImportProduct;
            readonly cookProducts: readonly CookProduct[];
          };
    }
  | { readonly ok: false; readonly error: ImportErrorType };

/**
 * Success payload. `skipped: 'shader'` marks a reserved shader sidecar the
 * runner intentionally did not import (no DDC written); otherwise `pack` is the
 * logical Pack v2 document. Artifact bytes remain owned by each asset.
 */
export type RunImportOk =
  | { readonly skipped: 'shader' }
  | {
      readonly product: ImportProduct;
      readonly cookProducts: readonly CookProduct[];
      readonly pack: DdcPack;
    };

/** The logical Pack v2 document consumed by the shared finalizer. */
export interface DdcPack {
  readonly schemaVersion: '2.0.0';
  readonly kind: 'internal-text-package';
  readonly packageId?: string;
  readonly provenance?: ProviderProvenance;
  readonly revision?: ResourceRevision;
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly assets: ReadonlyArray<{
    readonly guid: string;
    readonly kind: string;
    readonly name?: string;
    readonly sourceKey?: string;
    readonly sourceIndex?: number;
    readonly relations?: readonly AssetRelation[];
    readonly payload: Record<string, unknown>;
    readonly refs: readonly string[];
    readonly artifacts: Readonly<Record<string, ImportedArtifactBody>>;
  }>;
}

/** Minimal parsed-meta shape the runner reads (a superset of the sidecar). */
export interface RunImportMeta {
  readonly importer: string;
  readonly source: string;
  readonly packageId?: string;
  readonly provenance?: ProviderProvenance;
  readonly revision?: ResourceRevision;
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly importSettings?: Readonly<Record<string, unknown>>;
  /** Skip the normalized DDC pack when a downstream finalizer owns publication. */
  readonly buildPack?: boolean;
  readonly subAssets: ReadonlyArray<{
    readonly guid: string;
    readonly sourceIndex: number;
    readonly kind: string;
    readonly sourceKey?: string;
    readonly relations?: readonly AssetRelation[];
  }>;
}

function declarationFields(
  declaration: RunImportMeta['subAssets'][number] | undefined,
): Pick<DdcPack['assets'][number], 'sourceKey' | 'sourceIndex' | 'relations'> {
  if (declaration === undefined) return {};
  return {
    sourceIndex: declaration.sourceIndex,
    ...(declaration.sourceKey !== undefined ? { sourceKey: declaration.sourceKey } : {}),
    ...(declaration.relations !== undefined ? { relations: declaration.relations } : {}),
  };
}

/** Filesystem + decode capabilities the runner needs to drive an importer.
 *
 * `readSource` reads the primary source bytes addressed by `meta.source`.
 * `readSibling` reads a co-located file (e.g. an external `.bin` / `.png`
 * referenced from a `.gltf` via relative URI). Optional today so existing
 * callers stay green; importers that depend on it (gltfImporter texture
 * external-uri path) gate on its presence and surface a structured
 * `'source-read-failed'` ImportError when the host did not wire it.
 *
 * `decodeImage` is the M3 D-1 seam: gltfImporter funnels all three image
 * sources (bufferView / data-uri / external-uri) through one callback so
 * `@forgeax/engine-gltf` carries no `from '@forgeax/engine-image'` edge
 * (the grep gate `packages/gltf/scripts/check-no-image-import.mjs` enforces
 * this). The concrete decode lives in `@forgeax/engine-image/image-importer`;
 * the build-time orchestrator binds the callback when constructing this
 * `ImportRunnerFs`.
 */
export interface ImportRunnerFs {
  readSource(
    sourcePath: string,
  ): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: unknown }
  >;
  readSibling?(
    sourcePath: string,
    uri: string,
  ): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: unknown }
  >;
  decodeImage?(
    bytes: Uint8Array,
    mimeType: 'image/png' | 'image/jpeg',
    importSettings: Readonly<Record<string, unknown>>,
  ): Promise<
    | {
        readonly ok: true;
        readonly value: {
          readonly texture: TextureAsset;
          readonly bytes: Uint8Array;
          readonly mediaType?: string;
          readonly assetCodec?: AssetCodec;
        };
      }
    | { readonly ok: false; readonly error: ImageError }
  >;
}

/**
 * Resolve an `images[].uri` (or any sibling reference) against the directory
 * of `meta.source`. Pure path arithmetic — no I/O. Used as the default
 * `readSibling` fallback when the host did not wire one explicitly.
 */
function joinSiblingPath(sourcePath: string, uri: string): string {
  const slash = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\'));
  const dir = slash >= 0 ? sourcePath.slice(0, slash + 1) : '';
  return `${dir}${uri}`;
}

function normalizeDependencyPath(path: string): string {
  const slash = path.replaceAll('\\', '/');
  const parts: string[] = [];
  for (const part of slash.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function errResult(error: ImportErrorType): {
  readonly ok: false;
  readonly error: ImportErrorType;
} {
  return { ok: false, error };
}

function sourceKeyActual(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'missing';
  return typeof value;
}

/**
 * Validate producer identity before source work or DDC product finalization.
 * Multi-output declarations cannot recover identity from sourceIndex, array
 * order, or a path, so every row must carry one unique semantic sourceKey.
 * Single-output declarations may omit the key for legacy source compatibility;
 * producers that expose a semantic output should still declare it so Catalog
 * evidence remains stable when the output later gains siblings.
 */
function validateOutputSourceKeys(meta: RunImportMeta): ImportErrorType | undefined {
  if (meta.subAssets.length <= 1) return undefined;

  const diagnostics: ImportDiagnostic[] = [];
  const seen = new Map<string, number>();
  for (const [index, declaration] of meta.subAssets.entries()) {
    const sourcePath = `${meta.source}#subAssets[${index}]`;
    const sourceRange = { start: 0, end: 0, line: 1, column: 1 };
    const sourceKey = declaration.sourceKey;
    if (typeof sourceKey !== 'string' || sourceKey.trim().length === 0) {
      diagnostics.push({
        code: 'source-key-required',
        severity: 'error',
        sourcePath,
        sourceRange,
        rule: 'import-output-source-key',
        expected: 'a non-empty producer-owned sourceKey',
        actual: sourceKeyActual(sourceKey),
        hint: 'publish a stable semantic sourceKey; sourceIndex is only a locator',
      });
      continue;
    }
    const prior = seen.get(sourceKey);
    if (prior !== undefined) {
      diagnostics.push({
        code: 'duplicate-source-key',
        severity: 'error',
        sourcePath,
        sourceRange,
        rule: 'import-output-source-key-unique',
        expected: 'sourceKey to be unique within one imported package',
        actual: `${JSON.stringify(sourceKey)} duplicates subAssets[${prior}]`,
        hint: 'rename the duplicate semantic output before writing Meta',
      });
      continue;
    }
    seen.set(sourceKey, index);
  }
  if (diagnostics.length === 0) return undefined;
  return new ImportError({
    code: 'source-validation-failed',
    expected: 'every writable imported output to declare a unique non-empty sourceKey',
    hint: IMPORT_ERROR_HINTS['source-validation-failed'],
    detail: { diagnostics },
  });
}

/**
 * Run the importer for one parsed meta sidecar and produce its DDC.
 *
 * @param meta the parsed `*.meta.json` (importer + source + subAssets[]).
 * @param registry the wired {@link ImporterRegistry}.
 * @param fs the source-read capability (injected so the runner stays
 *   testable without touching real disk).
 */
export function runImport(
  meta: RunImportMeta & { readonly buildPack: false },
  registry: ImporterRegistry,
  fs: ImportRunnerFs,
): Promise<RunImportProductResult>;
export function runImport(
  meta: RunImportMeta,
  registry: ImporterRegistry,
  fs: ImportRunnerFs,
): Promise<RunImportResult>;
export async function runImport(
  meta: RunImportMeta,
  registry: ImporterRegistry,
  fs: ImportRunnerFs,
): Promise<RunImportResult | RunImportProductResult> {
  // Reserved shader key: orthogonal vite-plugin-shader pipeline owns these.
  if (meta.importer === SHADER_RESERVED_IMPORTER_KEY) {
    return { ok: true, value: { skipped: 'shader' } };
  }

  const sourceKeyError = validateOutputSourceKeys(meta);
  if (sourceKeyError !== undefined) return errResult(sourceKeyError);

  const importer = registry.get(meta.importer);
  if (importer === undefined) {
    return errResult(
      new ImportError({
        code: 'importer-not-registered',
        expected: `an importer registered for meta.importer "${meta.importer}"`,
        hint: IMPORT_ERROR_HINTS['importer-not-registered'],
        detail: {
          importer: meta.importer,
          registeredImporters: registry.registeredImporters(),
        },
      }),
    );
  }

  const dependencies = new Set<string>();
  const readSource = async (sourcePath: string) => {
    dependencies.add(normalizeDependencyPath(sourcePath));
    return fs.readSource(sourcePath);
  };

  const readSibling = async (
    uri: string,
  ): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: ImportErrorType }
  > => {
    let inner:
      | { readonly ok: true; readonly value: Uint8Array }
      | { readonly ok: false; readonly error: unknown }
      | { readonly ok: false; readonly error: ImportErrorType };
    if (fs.readSibling) {
      dependencies.add(normalizeDependencyPath(joinSiblingPath(meta.source, uri)));
      inner = await fs.readSibling(meta.source, uri);
    } else {
      inner = await readSource(joinSiblingPath(meta.source, uri));
    }
    if (inner.ok) {
      return { ok: true, value: inner.value };
    }
    return {
      ok: false,
      error: new ImportError({
        code: 'source-read-failed',
        expected: `readable sibling file "${uri}" co-located with meta.source "${meta.source}"`,
        hint: IMPORT_ERROR_HINTS['source-read-failed'],
        detail: {
          source: uri,
          reason: inner.error instanceof Error ? inner.error.message : String(inner.error),
        },
      }),
    };
  };

  const decodeImage = fs.decodeImage
    ? fs.decodeImage
    : async (
        _bytes: Uint8Array,
        _mimeType: 'image/png' | 'image/jpeg',
        _importSettings: Readonly<Record<string, unknown>>,
      ): Promise<
        | {
            readonly ok: true;
            readonly value: {
              readonly texture: TextureAsset;
              readonly bytes: Uint8Array;
              readonly mediaType?: string;
              readonly assetCodec?: AssetCodec;
            };
          }
        | { readonly ok: false; readonly error: ImageError }
      > => {
        throw new Error(
          'ImportRunnerFs.decodeImage was not provided; gltfImporter texture extraction requires the host (vite-plugin-pack / cli-gltf / test) to bind decodeImage when constructing the ImportRunnerFs',
        );
      };

  const ctx: ImportContext = {
    source: meta.source,
    readSource: () => readSource(meta.source),
    readSibling,
    decodeImage,
    subAssets: meta.subAssets,
    importSettings: meta.importSettings ?? {},
  };

  // Probe the source once up-front so a missing/unreadable source surfaces as
  // source-read-failed rather than as an opaque import-internal-error inside
  // the importer (charter P3 precise attribution).
  const sourceProbe = await readSource(meta.source);
  if (!sourceProbe.ok) {
    return errResult(
      new ImportError({
        code: 'source-read-failed',
        expected: `readable source file at meta.source "${meta.source}"`,
        hint: IMPORT_ERROR_HINTS['source-read-failed'],
        detail: {
          source: meta.source,
          reason:
            sourceProbe.error instanceof Error
              ? sourceProbe.error.message
              : String(sourceProbe.error),
        },
      }),
    );
  }

  let product: ImportProduct;
  try {
    const imported = (await importer.import(ctx)) as
      | { readonly ok: boolean; readonly value?: ImportProduct; readonly error?: ImportErrorType }
      | undefined;
    if (
      imported === undefined ||
      imported === null ||
      typeof imported !== 'object' ||
      !('ok' in imported)
    ) {
      throw new Error(
        'importer returned a legacy or malformed result; expected ImportResult<ImportProduct>',
      );
    } else {
      if (!imported.ok) {
        if (imported.error === undefined)
          throw new Error('importer returned an invalid failure result');
        if (imported.error instanceof ImportError) return errResult(imported.error);
        return errResult(
          new ImportError({
            code: 'import-internal-error',
            expected: `importer "${meta.importer}" to return a structured ImportError`,
            hint: IMPORT_ERROR_HINTS['import-internal-error'],
            detail: { reason: String(imported.error) },
          }),
        );
      }
      if (imported.value === undefined)
        throw new Error('importer returned an invalid success result');
      const value = imported.value;
      if (
        value === undefined ||
        !Array.isArray(value.assets) ||
        !Array.isArray(value.sourceDependencies) ||
        'artifacts' in value
      ) {
        throw new Error('importer returned an invalid ImportProduct');
      }
      for (const asset of value.assets) {
        if (
          asset === null ||
          typeof asset !== 'object' ||
          !('artifacts' in asset) ||
          asset.artifacts === null ||
          typeof asset.artifacts !== 'object' ||
          Array.isArray(asset.artifacts)
        ) {
          throw new Error('importer returned an asset without local artifacts');
        }
      }
      product = value;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // D-5: a module-LOAD failure rides `.detail.loadError`; a conversion THROW
    // rides `.detail.reason`. Same `import-internal-error` code (no new closed
    // union member); AI users branch on the `.detail` shape.
    if (isModuleLoadFailure(e)) {
      return errResult(
        new ImportError({
          code: 'import-internal-error',
          expected: `importer module "${meta.importer}" to load (module + native addon present)`,
          hint: IMPORT_ERROR_HINTS['import-internal-error'],
          detail: { loadError: message },
        }),
      );
    }
    return errResult(
      new ImportError({
        code: 'import-internal-error',
        expected: `importer "${meta.importer}" to convert the source without throwing`,
        hint: IMPORT_ERROR_HINTS['import-internal-error'],
        detail: { reason: message },
      }),
    );
  }

  const produced = product.assets;

  // GUID import-stable iron law: the produced GUID set must be a superset of
  // the declared set, and must not contain any GUID the meta never declared.
  const declared = new Set(meta.subAssets.map((s) => s.guid));
  const producedGuids = new Set(produced.map((a) => a.guid));

  const unexpectedGuids = [...producedGuids].filter((g) => !declared.has(g));
  if (unexpectedGuids.length > 0) {
    return errResult(
      new ImportError({
        code: 'guid-mismatch',
        expected: 'every produced GUID to be declared in meta.subAssets[]',
        hint: IMPORT_ERROR_HINTS['guid-mismatch'],
        detail: { unexpectedGuids },
      }),
    );
  }

  const missingGuids = [...declared].filter((g) => !producedGuids.has(g));
  if (produced.length === 0 || missingGuids.length > 0) {
    return errResult(
      new ImportError({
        code: 'import-produced-no-assets',
        expected:
          produced.length === 0
            ? 'the importer to produce at least one ImportedAsset'
            : 'the produced GUID set to be a superset of meta.subAssets[]',
        hint: IMPORT_ERROR_HINTS['import-produced-no-assets'],
        detail: { missingGuids },
      }),
    );
  }

  const declarations = new Map(
    meta.subAssets.map((declaration) => [declaration.guid, declaration]),
  );
  const productWithDependencies = {
    ...product,
    sourceDependencies: [...dependencies],
  };
  const inputFingerprint = `source:${[...dependencies].sort().join('|')}`;
  const cookProducts = await finalizeImportProducts(productWithDependencies, inputFingerprint);
  if (meta.buildPack === false) {
    return {
      ok: true,
      value: { product: productWithDependencies, cookProducts },
    };
  }

  const assets = produced.map((a) => {
    const outputFields = declarationFields(declarations.get(a.guid));
    return {
      guid: a.guid,
      kind: a.kind,
      ...outputFields,
      ...(a.name !== undefined ? { name: a.name } : {}),
      // bug-20260610: mesh / scene / animation-clip payloads carry Float32Array
      // / Uint16Array / Uint32Array fields. JSON.stringify on a typed array
      // serialises to `{ "0": v0, "1": v1, ... }` (a plain object), which the
      // runtime mesh / animation loaders reject (`vertexData instanceof
      // Float32Array` and `Array.isArray(vertexData)` both fail). Convert
      // every typed-array field to a plain Array here so the pack is JSON-
      // roundtrip safe end-to-end.  This matches the convention every
      // existing pack-fixture test uses (`vertices: Array.from(...)`).
      payload: normaliseForPack(a.payload as unknown) as Record<string, unknown>,
      refs: a.refs.map((r) => r.guid),
      artifacts: a.artifacts,
    };
  });

  const pack: DdcPack = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    ...(meta.packageId !== undefined ? { packageId: meta.packageId } : {}),
    ...(meta.provenance !== undefined ? { provenance: meta.provenance } : {}),
    ...(meta.revision !== undefined ? { revision: meta.revision } : {}),
    ...(meta.diagnostics !== undefined ? { diagnostics: meta.diagnostics } : {}),
    assets,
  };

  return {
    ok: true,
    value: {
      product: {
        ...productWithDependencies,
      },
      cookProducts,
      pack,
    },
  };
}
