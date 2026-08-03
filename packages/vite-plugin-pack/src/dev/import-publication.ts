import { DdcEntryStore, type DdcHead, DdcLifecycle, ddcOutputDigest } from '@forgeax/engine-ddc';
import type { CatalogDelta, CatalogEntry, CatalogRevisionWindow } from '@forgeax/engine-types';
import { calculateCatalogDelta } from '../catalog-watch.js';

export interface ImportPublicationInput {
  readonly root: string;
  readonly guid: string;
  readonly desiredKey: string;
  readonly pack: unknown;
  readonly previousCatalog: readonly CatalogEntry[];
  readonly nextCatalog: readonly CatalogEntry[];
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
  const delta = calculateCatalogDelta(input.previousCatalog, input.nextCatalog, input.revisions);
  if (delta !== undefined) input.onDelta?.(delta);
  return {
    ok: true,
    key: input.desiredKey,
    head: await lifecycle.inspect(input.guid, input.desiredKey),
    ...(delta === undefined ? {} : { delta }),
  };
}
