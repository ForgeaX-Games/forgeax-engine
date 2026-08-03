import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DdcEntryStore } from './entry-store.js';

export type DdcLifecycleState = 'missing' | 'cooking' | 'current' | 'stale' | 'failed';

export interface DdcLease {
  readonly guid: string;
  readonly desiredKey: string;
  readonly attempt: string;
}

export interface DdcHead {
  readonly guid: string;
  readonly desiredKey: string;
  readonly state: DdcLifecycleState;
  readonly currentKey: string | undefined;
  readonly lastKnownGoodKey: string | undefined;
  readonly failure?: { readonly code: string; readonly detail: string };
}

export interface DdcCommitResult {
  readonly result: 'current' | 'stale' | 'lease-lost' | 'invalid';
  readonly key: string;
}

interface HeadRecord {
  readonly guid: string;
  readonly desiredKey: string;
  readonly currentKey?: string;
  readonly lastKnownGoodKey?: string;
  readonly active?: DdcLease;
  readonly supersededAttempts?: readonly string[];
  readonly stale?: boolean;
  readonly failure?: {
    readonly desiredKey: string;
    readonly code: string;
    readonly detail: string;
  };
}

function headFile(heads: string, guid: string): string {
  return join(heads, `${encodeURIComponent(guid)}.json`);
}

function optionalKeys(record: HeadRecord): Pick<DdcHead, 'currentKey' | 'lastKnownGoodKey'> {
  return {
    currentKey: record.currentKey,
    lastKnownGoodKey: record.lastKnownGoodKey,
  };
}

export class DdcLifecycle {
  private readonly heads: string;
  private readonly entries: DdcEntryStore;

  public constructor(root: string) {
    this.heads = join(root, 'heads');
    this.entries = new DdcEntryStore(root);
  }

  public async inspect(guid: string, desiredKey: string): Promise<DdcHead> {
    const record = await this.read(guid);
    if (record === null) {
      return {
        guid,
        desiredKey,
        state: 'missing',
        currentKey: undefined,
        lastKnownGoodKey: undefined,
      };
    }
    const failure =
      record.failure?.desiredKey === desiredKey
        ? { code: record.failure.code, detail: record.failure.detail }
        : undefined;
    const currentEntry =
      record.currentKey === undefined ? null : await this.entries.read(record.currentKey);
    const state: DdcLifecycleState =
      failure !== undefined
        ? 'failed'
        : record.currentKey === desiredKey && currentEntry?.guid === guid
          ? 'current'
          : record.stale === true
            ? 'stale'
            : record.active?.desiredKey === desiredKey
              ? 'cooking'
              : 'stale';
    return {
      guid,
      desiredKey,
      state,
      ...optionalKeys(record),
      ...(failure === undefined ? {} : { failure }),
    };
  }

  public async begin(guid: string, desiredKey: string): Promise<DdcLease> {
    const previous = await this.read(guid);
    const lease: DdcLease = { guid, desiredKey, attempt: randomUUID() };
    const lastKnownGoodKey =
      previous?.currentKey !== undefined && previous.currentKey !== desiredKey
        ? previous.currentKey
        : previous?.lastKnownGoodKey;
    const supersededAttempts = [
      ...(previous?.supersededAttempts ?? []),
      ...(previous?.active === undefined ? [] : [previous.active.attempt]),
    ];
    await this.write({
      guid,
      desiredKey,
      active: lease,
      ...(supersededAttempts.length === 0 ? {} : { supersededAttempts }),
      ...(lastKnownGoodKey === undefined ? {} : { lastKnownGoodKey }),
    });
    return lease;
  }

  public async commit(lease: DdcLease, validatedKey: string): Promise<DdcCommitResult> {
    const current = await this.read(lease.guid);
    if (current?.active?.attempt !== lease.attempt) {
      if (current?.supersededAttempts?.includes(lease.attempt)) {
        await this.write({ ...current, stale: true });
        return { result: 'stale', key: validatedKey };
      }
      return { result: 'lease-lost', key: validatedKey };
    }
    if (current.desiredKey !== lease.desiredKey || validatedKey !== lease.desiredKey) {
      await this.write({ ...current, stale: true });
      return { result: 'stale', key: validatedKey };
    }
    const entry = await this.entries.read(validatedKey);
    if (entry === null || entry.guid !== lease.guid || entry.receipt.key !== validatedKey) {
      await this.write({
        guid: lease.guid,
        desiredKey: lease.desiredKey,
        ...(current.lastKnownGoodKey === undefined
          ? {}
          : { lastKnownGoodKey: current.lastKnownGoodKey }),
        failure: {
          desiredKey: lease.desiredKey,
          code: 'entry-invalid',
          detail: 'validated DDC key has no readable entry for this asset',
        },
      });
      return { result: 'invalid', key: validatedKey };
    }
    const lastKnownGoodKey =
      current.currentKey !== undefined && current.currentKey !== validatedKey
        ? current.currentKey
        : current.lastKnownGoodKey;
    await this.write({
      guid: lease.guid,
      desiredKey: lease.desiredKey,
      currentKey: validatedKey,
      stale: false,
      ...(current.supersededAttempts === undefined
        ? {}
        : { supersededAttempts: current.supersededAttempts }),
      ...(lastKnownGoodKey === undefined ? {} : { lastKnownGoodKey }),
    });
    return { result: 'current', key: validatedKey };
  }

  public async fail(
    lease: DdcLease,
    failure: { readonly code: string; readonly detail: string },
  ): Promise<void> {
    const current = await this.read(lease.guid);
    if (current?.active?.attempt !== lease.attempt) return;
    await this.write({
      guid: lease.guid,
      desiredKey: lease.desiredKey,
      ...(current.lastKnownGoodKey === undefined
        ? {}
        : { lastKnownGoodKey: current.lastKnownGoodKey }),
      failure: { desiredKey: lease.desiredKey, ...failure },
    });
  }

  public async revoke(lease: DdcLease): Promise<void> {
    const current = await this.read(lease.guid);
    if (current?.active?.attempt !== lease.attempt) return;
    await this.write({
      guid: lease.guid,
      desiredKey: lease.desiredKey,
      ...(current.lastKnownGoodKey === undefined
        ? {}
        : { lastKnownGoodKey: current.lastKnownGoodKey }),
      failure: {
        desiredKey: lease.desiredKey,
        code: 'lease-lost',
        detail: 'cook lease was revoked before validation',
      },
    });
  }

  public async recover(guid: string, desiredKey: string): Promise<DdcHead> {
    const current = await this.read(guid);
    if (current?.active?.desiredKey === desiredKey) {
      await this.write({
        guid,
        desiredKey,
        ...(current.lastKnownGoodKey === undefined
          ? {}
          : { lastKnownGoodKey: current.lastKnownGoodKey }),
        failure: {
          desiredKey,
          code: 'writer-crashed',
          detail: 'active cook attempt was recovered after process interruption',
        },
      });
    }
    return this.inspect(guid, desiredKey);
  }

  private async read(guid: string): Promise<HeadRecord | null> {
    try {
      return JSON.parse(await readFile(headFile(this.heads, guid), 'utf8')) as HeadRecord;
    } catch {
      return null;
    }
  }

  private async write(record: HeadRecord): Promise<void> {
    await mkdir(this.heads, { recursive: true });
    const path = headFile(this.heads, record.guid);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record));
    await rename(temporary, path);
  }
}
