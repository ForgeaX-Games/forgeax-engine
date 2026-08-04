import { DdcEntryStore, type DdcHead, DdcLifecycle, ddcOutputDigest } from '@forgeax/engine-ddc';
import type {
  CatalogDelta,
  CatalogEntry,
  CatalogProjection,
  CatalogRevisionWindow,
  ResourceRevision,
} from '@forgeax/engine-types';
import { calculateCatalogDelta } from '../catalog-watch.js';

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
  readonly code: 'ddc-publication-failed' | 'ddc-publication-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: string;
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

function failure(code: ImportPublicationError['code'], detail: string): ImportPublicationError {
  return {
    code,
    expected: 'a complete validated DDC entry before Catalog current publication',
    hint: 'keep the prior current/LKG entry and retry the explicit rebuild after correcting the failure',
    detail,
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
  const lifecycle = new DdcLifecycle(input.root);
  const lease = await lifecycle.begin(input.guid, input.desiredKey);
  try {
    const store = new DdcEntryStore(input.root);
    const entry = {
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
        outputDigest: '',
      },
    };
    await store.write({
      ...entry,
      receipt: { ...entry.receipt, outputDigest: ddcOutputDigest(entry) },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await lifecycle.fail(lease, { code: 'ddc-publication-failed', detail });
    return {
      ok: false,
      error: failure('ddc-publication-failed', detail),
      head: await lifecycle.inspect(input.guid, input.desiredKey),
    };
  }

  const commit = await lifecycle.commit(lease, input.desiredKey);
  if (commit.result !== 'current') {
    return {
      ok: false,
      error: failure('ddc-publication-invalid', `lifecycle commit returned ${commit.result}`),
      head: await lifecycle.inspect(input.guid, input.desiredKey),
    };
  }
  const head = await lifecycle.inspect(input.guid, input.desiredKey);
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
