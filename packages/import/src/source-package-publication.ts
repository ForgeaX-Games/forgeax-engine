import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type DdcEntry,
  type DdcGenerationEntryCandidate,
  DdcGenerationSession,
  type DdcHead,
  DdcLifecycle,
  ddcOutputDigest,
} from '@forgeax/engine-ddc';
import {
  type CatalogEntry,
  err,
  ok,
  type ResourceRevision,
  type Result,
} from '@forgeax/engine-types';
import {
  type SourcePackageError,
  type SourcePackageErrorContext,
  sourcePackageError,
} from './source-package-errors.js';

interface SourcePackageDdcEntryInput {
  readonly root: string;
  readonly entry: DdcEntry;
  readonly context: SourcePackageErrorContext;
}

interface StagedSourcePackageDdc extends DdcGenerationEntryCandidate {
  readonly root: string;
  readonly session: DdcGenerationSession;
  readonly context: SourcePackageErrorContext;
}

export interface ImportPublicationInput {
  readonly root: string;
  readonly guid: string;
  readonly desiredKey: string;
  readonly pack: unknown;
  readonly previousCatalog: readonly CatalogEntry[];
  readonly nextCatalog: readonly CatalogEntry[];
  readonly publishedGuids: readonly string[];
  readonly transport?: {
    readonly path: string;
    readonly body: string;
  };
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
      readonly transportPersisted: boolean;
    }
  | { readonly ok: false; readonly error: ImportPublicationError; readonly head: DdcHead };

export interface StagedImportPublication {
  readonly input: ImportPublicationInput;
  readonly ddc: StagedSourcePackageDdc;
  readonly key: string;
  readonly head: DdcHead;
  readonly catalog: readonly CatalogEntry[];
  readonly revision: ResourceRevision;
}

export type StagedImportPublicationResult =
  | { readonly ok: true; readonly candidate: StagedImportPublication }
  | { readonly ok: false; readonly error: ImportPublicationError; readonly head: DdcHead };

function inspectHead(root: string, guid: string, desiredKey: string): Promise<DdcHead> {
  return new DdcLifecycle(root).inspect(guid, desiredKey);
}

const PUBLICATION_SETTLE_TIMEOUT_MS = 5_000;
const PUBLICATION_SETTLE_POLL_MS = 10;

async function inspectAfterSupersededCommit(candidate: StagedSourcePackageDdc): Promise<DdcHead> {
  let head = await inspectHead(candidate.root, candidate.lease.guid, candidate.lease.desiredKey);
  if (head.state === 'current' && head.currentKey === candidate.lease.desiredKey) return head;

  // A newer owner may already have superseded this lease while it is still
  // cooking.  The strict DDC CAS correctly returns `stale` to this candidate;
  // wait for that owner to publish before turning an equivalent publication
  // into a user-visible import failure.  The wait is bounded so a crashed
  // owner never leaves the caller hanging and a different desired key still
  // fails closed.
  const deadline = Date.now() + PUBLICATION_SETTLE_TIMEOUT_MS;
  while (
    Date.now() < deadline &&
    head.activeLease !== undefined &&
    head.activeLease.attempt !== candidate.lease.attempt &&
    head.activeLease.desiredKey === candidate.lease.desiredKey
  ) {
    await new Promise((resolve) => setTimeout(resolve, PUBLICATION_SETTLE_POLL_MS));
    head = await inspectHead(candidate.root, candidate.lease.guid, candidate.lease.desiredKey);
    if (head.state === 'current' && head.currentKey === candidate.lease.desiredKey) return head;
  }
  return head;
}

async function stageSourcePackageDdc(
  input: SourcePackageDdcEntryInput,
): Promise<Result<StagedSourcePackageDdc, SourcePackageError>> {
  const session = new DdcGenerationSession(input.root, { generation: 1 });
  try {
    const candidate = await session.stageEntry(input.entry);
    return ok({ ...candidate, root: input.root, session, context: input.context });
  } catch (error) {
    return err(
      sourcePackageError('source-package-ddc-failed', input.context, {
        stage: 'ddc',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function commitSourcePackageDdc(
  candidate: StagedSourcePackageDdc,
): Promise<Result<DdcHead, SourcePackageError>> {
  try {
    const commit = await candidate.session.commitEntry(candidate, candidate.lease.desiredKey);
    if (commit.result !== 'current') {
      const head = await inspectAfterSupersededCommit(candidate);
      if (head.state === 'current' && head.currentKey === candidate.lease.desiredKey) {
        return ok(head);
      }
      return err(
        sourcePackageError('source-package-ddc-failed', candidate.context, {
          stage: 'ddc',
          reason: `DDC lifecycle commit returned ${commit.result}`,
        }),
      );
    }
    return ok(await inspectHead(candidate.root, candidate.lease.guid, candidate.lease.desiredKey));
  } catch (error) {
    return err(
      sourcePackageError('source-package-ddc-failed', candidate.context, {
        stage: 'ddc',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function persistTransport(transport: ImportPublicationInput['transport']): Promise<boolean> {
  if (transport === undefined) return true;
  const directory = dirname(transport.path);
  const temporary = `${transport.path}.tmp`;
  try {
    await mkdir(directory, { recursive: true });
    if (((await stat(directory)).mode & 0o222) === 0) {
      throw new Error('transport directory is read-only');
    }
    await writeFile(temporary, transport.body);
    await rename(temporary, transport.path);
    return true;
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    return false;
  }
}

function importPublicationFailure(error: SourcePackageError): ImportPublicationError {
  return {
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail.reason ?? error.detail.stage,
    diagnostic: error,
  };
}

function projectImportPublication(
  input: ImportPublicationInput,
  head: DdcHead,
  observedAt: number,
): { readonly catalog: readonly CatalogEntry[]; readonly revision: ResourceRevision } {
  const digest = head.currentKey ?? input.desiredKey;
  const revision: ResourceRevision = { digest, observedAt, rootId: input.root };
  const published = new Set(input.publishedGuids.map((guid) => guid.toLowerCase()));
  const catalog = input.nextCatalog.map((row) => {
    if (!published.has(row.guid.toLowerCase())) return row;
    const previousLkg =
      head.lastKnownGoodKey === undefined
        ? undefined
        : input.previousCatalog.find(
            (candidate) =>
              candidate.guid.toLowerCase() === row.guid.toLowerCase() &&
              candidate.revision?.digest === head.lastKnownGoodKey,
          );
    const projection =
      row.projection === undefined
        ? undefined
        : (() => {
            const { lastKnownGood: _staleLastKnownGood, ...withoutLastKnownGood } = row.projection;
            return previousLkg?.packageUrl === undefined
              ? withoutLastKnownGood
              : { ...withoutLastKnownGood, lastKnownGood: { packageUrl: previousLkg.packageUrl } };
          })();
    return {
      ...row,
      revision,
      ...(projection === undefined ? {} : { projection }),
    };
  });
  return { catalog, revision };
}

export async function publishImportPublication(
  input: ImportPublicationInput,
): Promise<ImportPublicationResult> {
  const staged = await stageImportPublication(input);
  if (!staged.ok) return staged;
  return commitImportPublication(staged.candidate);
}

export async function stageImportPublication(
  input: ImportPublicationInput,
): Promise<StagedImportPublicationResult> {
  const staged = await stageSourcePackageDdc({
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
        producer: 'engine-import/source-package-publication',
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
      sourceMeta: '<import-publication>',
      anchorGuid: input.guid,
      affectedGuids: input.publishedGuids,
      producer: 'source-package/import-publication',
      importer: 'import-publication',
    },
  });
  if (!staged.ok) {
    return {
      ok: false,
      error: importPublicationFailure(staged.error),
      head: await inspectHead(input.root, input.guid, input.desiredKey),
    };
  }
  const lastKnownGoodKey =
    staged.value.previousHead.currentKey !== undefined &&
    staged.value.previousHead.currentKey !== input.desiredKey
      ? staged.value.previousHead.currentKey
      : staged.value.previousHead.lastKnownGoodKey;
  const projectedHead: DdcHead = {
    ...staged.value.previousHead,
    state: 'cooking',
    currentKey: input.desiredKey,
    ...(lastKnownGoodKey === undefined ? {} : { lastKnownGoodKey }),
  };
  const projected = projectImportPublication(input, projectedHead, Date.now());
  return {
    ok: true,
    candidate: {
      input,
      ddc: staged.value,
      key: input.desiredKey,
      head: projectedHead,
      catalog: projected.catalog,
      revision: projected.revision,
    },
  };
}

export async function commitImportPublication(
  candidate: StagedImportPublication,
): Promise<ImportPublicationResult> {
  const publication = await commitSourcePackageDdc(candidate.ddc);
  if (!publication.ok) {
    return {
      ok: false,
      error: importPublicationFailure(publication.error),
      head: await inspectHead(
        candidate.input.root,
        candidate.input.guid,
        candidate.input.desiredKey,
      ),
    };
  }
  const projected = projectImportPublication(candidate.input, publication.value, Date.now());
  return {
    ok: true,
    key: candidate.input.desiredKey,
    head: publication.value,
    catalog: projected.catalog,
    revision: projected.revision,
    transportPersisted: await persistTransport(candidate.input.transport),
  };
}

export async function discardImportPublication(candidate: StagedImportPublication): Promise<void> {
  await candidate.ddc.session.discardEntry(candidate.ddc);
}

export async function restoreImportPublication(candidate: StagedImportPublication): Promise<void> {
  await candidate.ddc.session.restoreEntry(candidate.ddc);
}
