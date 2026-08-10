import { type DdcHead, DdcLifecycle, ddcOutputDigest } from '@forgeax/engine-ddc';
import type {
  CatalogDelta,
  CatalogEntry,
  CatalogProjection,
  CatalogRevisionWindow,
  ResourceRevision,
} from '@forgeax/engine-types';
import { calculateCatalogDelta } from '../catalog-watch.js';
import type { SourcePackageError } from '../producer/source-package-errors.js';
import { publishSourcePackageDdc } from '../producer/source-package-publication.js';

export interface ImportPublicationInput {
  readonly root: string;
  readonly guid: string;
  readonly desiredKey: string;
  readonly pack: unknown;
  readonly previousCatalog: readonly CatalogEntry[];
  readonly nextCatalog: readonly CatalogEntry[];
  readonly publishedGuids: readonly string[];
  readonly revisions?: CatalogRevisionWindow;
  readonly onDelta?: (delta: CatalogDelta) => void;
}

export interface ImportPublicationError {
  readonly code: SourcePackageError['code'];
  readonly expected: string;
  readonly hint: string;
  readonly detail: string;
  readonly diagnostic: SourcePackageError;
}

export type ImportPublicationResult =
  | {
      readonly ok: true;
      readonly key: string;
      readonly head: DdcHead;
      readonly catalog: readonly CatalogEntry[];
      readonly revision: ResourceRevision;
      readonly delta?: CatalogDelta;
    }
  | { readonly ok: false; readonly error: ImportPublicationError; readonly head: DdcHead };

function failure(error: SourcePackageError): ImportPublicationError {
  return {
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail.reason ?? error.detail.stage,
    diagnostic: error,
  };
}

export function projectPublishedCatalog(
  input: ImportPublicationInput,
  head: DdcHead,
  observedAt: number,
): { readonly catalog: readonly CatalogEntry[]; readonly revision: ResourceRevision } {
  const digest = head.currentKey ?? input.desiredKey;
  const revision: ResourceRevision = { digest, observedAt, rootId: input.root };
  const published = new Set(input.publishedGuids.map((guid) => guid.toLowerCase()));
  const previousByGuid = new Map(input.previousCatalog.map((row) => [row.guid.toLowerCase(), row]));
  const catalog = input.nextCatalog.map((row) => {
    if (!published.has(row.guid.toLowerCase())) return row;
    const previous = previousByGuid.get(row.guid.toLowerCase());
    const previousLkg =
      head.lastKnownGoodKey === undefined
        ? undefined
        : input.previousCatalog.find(
            (candidate) =>
              candidate.guid.toLowerCase() === row.guid.toLowerCase() &&
              candidate.revision?.digest === head.lastKnownGoodKey,
          );
    const lastKnownGoodPackageUrl =
      previousLkg?.packageUrl ??
      previous?.projection?.lastKnownGood?.packageUrl ??
      previous?.packageUrl;
    const projection: CatalogProjection | undefined =
      row.projection === undefined
        ? undefined
        : {
            ...row.projection,
            lastKnownGood: { packageUrl: lastKnownGoodPackageUrl ?? row.packageUrl },
          };
    return {
      ...row,
      revision,
      ...(projection === undefined ? {} : { projection }),
    };
  });
  return { catalog, revision };
}

/** Publish one validated import through DdcLifecycle before announcing Catalog current. */
export async function publishImportPublication(
  input: ImportPublicationInput,
): Promise<ImportPublicationResult> {
  const publication = await publishSourcePackageDdc({
    root: input.root,
    entry: {
      key: input.desiredKey,
      guid: input.guid,
      payload: input.pack,
      refs: [],
      artifacts: {},
      receipt: {
        guid: input.guid,
        key: input.desiredKey,
        producer: 'vite-plugin-pack/import-publication',
        inputFingerprint: input.desiredKey,
        outputDigest: ddcOutputDigest({
          guid: input.guid,
          payload: input.pack,
          refs: [],
          artifacts: {},
        }),
      },
    },
    context: {
      sourceMeta: '<legacy-import-publication>',
      anchorGuid: input.guid,
      affectedGuids: input.publishedGuids,
      producer: 'source-package/legacy-import-publication',
      importer: 'legacy-import-publication',
    },
  });
  if (!publication.ok) {
    return {
      ok: false,
      error: failure(publication.error),
      head: await inspectHead(input),
    };
  }
  const head = publication.head;
  const observedAt = Date.now();
  const projected = projectPublishedCatalog(input, head, observedAt);
  const delta = calculateCatalogDelta(input.previousCatalog, projected.catalog, input.revisions);
  if (delta !== undefined) input.onDelta?.(delta);
  return {
    ok: true,
    key: input.desiredKey,
    head,
    catalog: projected.catalog,
    revision: projected.revision,
    ...(delta === undefined ? {} : { delta }),
  };
}

async function inspectHead(input: ImportPublicationInput): Promise<DdcHead> {
  return new DdcLifecycle(input.root).inspect(input.guid, input.desiredKey);
}
