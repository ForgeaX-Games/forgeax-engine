import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalDdcJson } from './key.js';

export interface DdcArtifact {
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface DdcReceipt {
  readonly guid: string;
  readonly key: string;
  readonly producer: string;
  readonly inputFingerprint: string;
  readonly outputDigest: string;
}

export interface DdcEntry {
  readonly key: string;
  readonly guid: string;
  readonly payload: unknown;
  readonly refs: readonly string[];
  readonly artifacts: Readonly<Record<string, DdcArtifact>>;
  readonly receipt: DdcReceipt;
}

export interface StagedDdcEntry {
  readonly key: string;
  readonly path: string;
}

export interface PublishDdcEntryResult {
  readonly result: 'published' | 'existing' | 'conflict';
  readonly key: string;
}

export class DdcStoreError extends Error {
  public readonly code: 'ddc-entry-incomplete' | 'ddc-entry-invalid' | 'ddc-entry-conflict';
  public readonly detail: string;
  public readonly expected: string;
  public readonly hint: string;

  public constructor(code: DdcStoreError['code'], detail: string) {
    super(detail);
    this.name = 'DdcStoreError';
    this.code = code;
    this.detail = detail;
    this.expected = 'a complete DDC entry whose receipt and integrity digests validate';
    this.hint =
      code === 'ddc-entry-incomplete'
        ? 'discard the partial entry and cold-cook from author authority'
        : code === 'ddc-entry-conflict'
          ? 'keep the verified entry and reject the competing publication'
          : 'discard the invalid entry, preview last-known-good, then cold-cook';
  }
}

interface ArtifactIntegrity {
  readonly mediaType: string;
  readonly byteLength: number;
  readonly digest: string;
}

interface EntryIntegrity {
  readonly payload: string;
  readonly refs: string;
  readonly receipt: string;
  readonly artifacts: Readonly<Record<string, ArtifactIntegrity>>;
  readonly entry: string;
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function artifactFile(key: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(key)) return key;
  return Buffer.from(key, 'utf8').toString('base64url');
}

function validateKey(key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw new DdcStoreError('ddc-entry-invalid', `invalid semantic key: ${key}`);
  }
}

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function sortedArtifacts(entry: DdcEntry): readonly [string, DdcArtifact][] {
  return Object.entries(entry.artifacts).sort(([left], [right]) => left.localeCompare(right));
}

/** The one output identity shared by receipt validation and DDC publication. */
export function ddcOutputDigest(
  entry: Pick<DdcEntry, 'guid' | 'payload' | 'refs' | 'artifacts'>,
): string {
  return `sha256:${digest(
    canonicalDdcJson({
      guid: entry.guid,
      payload: entry.payload,
      refs: entry.refs,
      artifacts: Object.fromEntries(
        sortedArtifacts(entry as DdcEntry).map(([key, artifact]) => [
          key,
          {
            mediaType: artifact.mediaType,
            bytes: artifact.bytes,
          },
        ]),
      ),
    }),
  )}`;
}

function existingResult(
  existing: DdcEntry,
  candidate: DdcEntry,
  key: string,
): PublishDdcEntryResult {
  return canonicalDdcJson(existing) === canonicalDdcJson(candidate)
    ? { result: 'existing', key }
    : { result: 'conflict', key };
}

function entryShape(entry: DdcEntry): Record<string, unknown> {
  return {
    key: entry.key,
    guid: entry.guid,
    payload: entry.payload,
    refs: entry.refs,
    receipt: entry.receipt,
    artifacts: Object.fromEntries(
      sortedArtifacts(entry).map(([key, artifact]) => [
        key,
        { mediaType: artifact.mediaType, byteLength: artifact.bytes.byteLength },
      ]),
    ),
  };
}

function integrityFor(entry: DdcEntry): EntryIntegrity {
  const artifacts = Object.fromEntries(
    sortedArtifacts(entry).map(([key, artifact]) => [
      key,
      {
        mediaType: artifact.mediaType,
        byteLength: artifact.bytes.byteLength,
        digest: digest(artifact.bytes),
      },
    ]),
  );
  return {
    payload: digest(canonicalDdcJson(entry.payload)),
    refs: digest(canonicalDdcJson(entry.refs)),
    receipt: digest(canonicalDdcJson(entry.receipt)),
    artifacts,
    entry: digest(canonicalDdcJson(entryShape(entry))),
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export class DdcEntryStore {
  private readonly entries: string;
  private readonly staging: string;

  public constructor(root: string) {
    this.entries = join(root, 'entries');
    this.staging = join(root, 'staging');
  }

  public async stage(entry: DdcEntry): Promise<StagedDdcEntry> {
    validateKey(entry.key);
    if (entry.receipt.key !== entry.key || entry.receipt.guid !== entry.guid) {
      throw new DdcStoreError('ddc-entry-invalid', 'receipt identity does not match entry');
    }
    if (entry.receipt.outputDigest !== ddcOutputDigest(entry)) {
      throw new DdcStoreError('ddc-entry-invalid', 'receipt output digest does not match entry');
    }
    const path = join(this.staging, `${entry.key}-${randomUUID()}`);
    await mkdir(join(path, 'artifacts'), { recursive: true });
    await writeFile(join(path, 'payload.json'), canonicalDdcJson(entry.payload));
    await writeFile(join(path, 'refs.json'), canonicalDdcJson(entry.refs));
    await writeFile(join(path, 'receipt.json'), canonicalDdcJson(entry.receipt));
    const artifacts: Record<string, { mediaType: string; file: string }> = {};
    for (const [key, artifact] of sortedArtifacts(entry)) {
      const file = artifactFile(key);
      artifacts[key] = { mediaType: artifact.mediaType, file };
      await writeFile(join(path, 'artifacts', `${file}.bin`), artifact.bytes);
    }
    await writeFile(join(path, 'artifacts.json'), canonicalDdcJson(artifacts));
    await writeFile(join(path, 'integrity.json'), canonicalDdcJson(integrityFor(entry)));
    return { key: entry.key, path };
  }

  public async publish(staged: StagedDdcEntry): Promise<PublishDdcEntryResult> {
    validateKey(staged.key);
    const candidate = await this.readDirectory(staged.path, true);
    const target = join(this.entries, staged.key);
    await mkdir(this.entries, { recursive: true });
    try {
      await stat(target);
      const existing = await this.readDirectory(target, false);
      await rm(staged.path, { recursive: true, force: true });
      return existingResult(existing, candidate, staged.key);
    } catch (error) {
      if (error instanceof DdcStoreError) throw error;
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    try {
      await rename(staged.path, target);
      return { result: 'published', key: staged.key };
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EISDIR'].includes(errorCode(error) ?? '')) throw error;
      const existing = await this.readDirectory(target, false);
      await rm(staged.path, { recursive: true, force: true });
      return existingResult(existing, candidate, staged.key);
    }
  }

  public async write(entry: DdcEntry): Promise<PublishDdcEntryResult> {
    const staged = await this.stage(entry);
    return this.publish(staged);
  }

  public async read(key: string): Promise<DdcEntry | null> {
    try {
      validateKey(key);
      return await this.readDirectory(join(this.entries, key), false);
    } catch {
      return null;
    }
  }

  /** Read with a machine-readable corruption result for recovery tooling. */
  public async readChecked(
    key: string,
  ): Promise<
    | { readonly ok: true; readonly value: DdcEntry | null }
    | { readonly ok: false; readonly error: DdcStoreError }
  > {
    try {
      validateKey(key);
      try {
        await stat(join(this.entries, key));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return { ok: true, value: null };
        throw error;
      }
      try {
        return { ok: true, value: await this.readDirectory(join(this.entries, key), false) };
      } catch (error) {
        if (error instanceof DdcStoreError && error.code === 'ddc-entry-incomplete') {
          return { ok: true, value: null };
        }
        throw error;
      }
    } catch (error) {
      const normalized =
        error instanceof DdcStoreError
          ? error
          : new DdcStoreError('ddc-entry-invalid', 'entry is unreadable');
      return { ok: false, error: normalized };
    }
  }

  private async readDirectory(path: string, incompleteIsError: boolean): Promise<DdcEntry> {
    try {
      const payload = await readJson<unknown>(join(path, 'payload.json'));
      const refs = await readJson<readonly string[]>(join(path, 'refs.json'));
      const receipt = await readJson<DdcReceipt>(join(path, 'receipt.json'));
      const manifest = await readJson<
        Readonly<Record<string, { mediaType: string; file: string }>>
      >(join(path, 'artifacts.json'));
      const integrity = await readJson<EntryIntegrity>(join(path, 'integrity.json'));
      const artifacts: Record<string, DdcArtifact> = {};
      for (const [key, descriptor] of Object.entries(manifest).sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        const bytes = new Uint8Array(
          await readFile(join(path, 'artifacts', `${descriptor.file}.bin`)),
        );
        artifacts[key] = { mediaType: descriptor.mediaType, bytes };
      }
      const entry = { key: receipt.key, guid: receipt.guid, payload, refs, artifacts, receipt };
      if (entry.receipt.outputDigest !== ddcOutputDigest(entry)) {
        throw new DdcStoreError('ddc-entry-invalid', 'receipt output digest does not match entry');
      }
      const actual = integrityFor(entry);
      if (canonicalDdcJson(actual) !== canonicalDdcJson(integrity)) {
        throw new DdcStoreError('ddc-entry-invalid', 'entry integrity mismatch');
      }
      return entry;
    } catch (error) {
      if (incompleteIsError) {
        if (error instanceof DdcStoreError) throw error;
        throw new DdcStoreError('ddc-entry-incomplete', 'staged entry is incomplete');
      }
      if (error instanceof DdcStoreError) throw error;
      throw new DdcStoreError('ddc-entry-invalid', 'entry is unreadable');
    }
  }
}
