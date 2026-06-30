// @forgeax/engine-import - import runner (feat-20260603-asset-import-loader-injection M2 / w15).
//
// The build-time orchestration that turns one parsed `*.meta.json` sidecar
// into the DDC (`.pack.json` + optional `.bin`). It is the consumer side of
// the ImporterRegistry: it reads `meta.importer`, looks up the registered
// Importer, calls `importer.import(ctx)`, enforces the GUID import-stable iron
// law against the produced asset set, then folds the produced PODs into the
// DDC `.pack.json` `assets[]` rows (one ImportedAsset -> one
// `{ guid, kind, payload, refs }` row, reusing the existing
// internal-text-package shape - no new format is invented; requirements
// constraint).
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
  ImageError,
  ImportContext,
  ImportError as ImportErrorType,
  ImportedAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { IMPORT_ERROR_HINTS, ImportError } from '@forgeax/engine-types';
import type { ImporterRegistry } from './importer-registry.js';
import { packMeshBin } from './mesh-bin.js';

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
function normaliseForPack(value: unknown): unknown {
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

/**
 * Success payload. `skipped: 'shader'` marks a reserved shader sidecar the
 * runner intentionally did not import (no DDC written); otherwise `pack` is the
 * built DDC `.pack.json` document and `bins` the optional binary blobs keyed by
 * lowercased sub-asset GUID.
 */
export type RunImportOk =
  | { readonly skipped: 'shader' }
  | {
      readonly pack: DdcPack;
      readonly bins?: ReadonlyMap<string, Uint8Array>;
    };

/** The `internal-text-package` DDC document the runner produces (reused, not invented). */
export interface DdcPack {
  readonly schemaVersion: string;
  readonly kind: 'internal-text-package';
  readonly assets: ReadonlyArray<{
    readonly guid: string;
    readonly kind: string;
    readonly name?: string;
    readonly payload: Record<string, unknown>;
    readonly refs: readonly string[];
  }>;
}

/** Minimal parsed-meta shape the runner reads (a superset of the sidecar). */
export interface RunImportMeta {
  readonly importer: string;
  readonly source: string;
  readonly importSettings?: Readonly<Record<string, unknown>>;
  readonly subAssets: ReadonlyArray<{
    readonly guid: string;
    readonly sourceIndex: number;
    readonly kind: string;
  }>;
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
        readonly value: { readonly texture: TextureAsset; readonly bytes: Uint8Array };
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

function errResult(error: ImportErrorType): {
  readonly ok: false;
  readonly error: ImportErrorType;
} {
  return { ok: false, error };
}

/**
 * Run the importer for one parsed meta sidecar and produce its DDC.
 *
 * @param meta the parsed `*.meta.json` (importer + source + subAssets[]).
 * @param registry the wired {@link ImporterRegistry}.
 * @param fs the source-read capability (injected so the runner stays
 *   testable without touching real disk).
 */
export async function runImport(
  meta: RunImportMeta,
  registry: ImporterRegistry,
  fs: ImportRunnerFs,
): Promise<RunImportResult> {
  // Reserved shader key: orthogonal vite-plugin-shader pipeline owns these.
  if (meta.importer === SHADER_RESERVED_IMPORTER_KEY) {
    return { ok: true, value: { skipped: 'shader' } };
  }

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

  const readSibling = async (
    uri: string,
  ): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: ImportErrorType }
  > => {
    const inner = fs.readSibling
      ? await fs.readSibling(meta.source, uri)
      : await fs.readSource(joinSiblingPath(meta.source, uri));
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
            readonly value: { readonly texture: TextureAsset; readonly bytes: Uint8Array };
          }
        | { readonly ok: false; readonly error: ImageError }
      > => {
        throw new Error(
          'ImportRunnerFs.decodeImage was not provided; gltfImporter texture extraction requires the host (vite-plugin-pack / cli-gltf / test) to bind decodeImage when constructing the ImportRunnerFs',
        );
      };

  const ctx: ImportContext = {
    source: meta.source,
    readSource: () => fs.readSource(meta.source),
    readSibling,
    decodeImage,
    subAssets: meta.subAssets,
    importSettings: meta.importSettings ?? {},
  };

  // Probe the source once up-front so a missing/unreadable source surfaces as
  // source-read-failed rather than as an opaque import-internal-error inside
  // the importer (charter P3 precise attribution).
  const sourceProbe = await fs.readSource(meta.source);
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

  let produced: readonly ImportedAsset[];
  try {
    produced = await importer.import(ctx);
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

  // M2 / w7: extract texture bytes into bins and strip data from pack payload.
  // TextureAsset.data carries raw RGBA bytes; the runner moves them into
  // RunImportOk.bins (keyed by lowercased GUID) so the pack payload carries
  // only metadata (width/height/format/colorSpace).
  const bins = new Map<string, Uint8Array>();
  const assets = produced.map((a) => {
    const payload = a.payload as unknown as Record<string, unknown>;
    if (
      a.kind === 'texture' &&
      'data' in payload &&
      payload.data instanceof Uint8Array &&
      payload.data.length > 0
    ) {
      bins.set(a.guid.toLowerCase(), payload.data);
      // bug-20260610: even after we strip the texture's RGBA bytes into bins,
      // the rest of the payload may still hold typed arrays (e.g. SH coeffs
      // on a CubeTextureAsset). Normalise the auxiliary fields so
      // JSON.stringify -> JSON.parse roundtrips into shapes the runtime
      // loaders accept; preserve `data` as `Uint8Array(0)` (the in-memory
      // contract: data lives in bins, payload.data is a zero-length sentinel
      // typed-array, not a plain array).
      const auxNormalised = normaliseForPack(payload) as Record<string, unknown>;
      return {
        guid: a.guid,
        kind: a.kind,
        ...(a.name !== undefined ? { name: a.name } : {}),
        payload: { ...auxNormalised, data: new Uint8Array(0) },
        refs: a.refs.map((r) => r.guid),
      };
    }
    if (a.kind === 'mesh') {
      // bug-20260610 Fix A: mesh vertices/indices (typed arrays) move out of
      // the JSON pack body into a sibling `<guid>.bin` sidecar. Submeshes,
      // attributes, and aabb travel as a UTF-8 JSON tail in the same .bin so
      // the catalog row's relativeUrl can point straight at the .bin (D-3) and
      // the runtime never needs a second `.pack.json` round-trip for mesh.
      // The pack-body payload becomes the empty sentinel (vertices=[],
      // indices=[], data=Uint8Array(0)) -- the meshLoader's inline-array path
      // (CON-7) still sees a parseable empty array and refuses gracefully when
      // a stray legacy fetch lands on this entry.
      bins.set(a.guid.toLowerCase(), packMeshBin(payload));
      return {
        guid: a.guid,
        kind: a.kind,
        ...(a.name !== undefined ? { name: a.name } : {}),
        payload: {
          vertices: [],
          indices: [],
          data: new Uint8Array(0),
        },
        refs: a.refs.map((r) => r.guid),
      };
    }
    return {
      guid: a.guid,
      kind: a.kind,
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
    };
  });

  const pack: DdcPack = {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets,
  };

  return {
    ok: true,
    value: {
      pack,
      ...(bins.size > 0 ? { bins } : {}),
    },
  };
}
