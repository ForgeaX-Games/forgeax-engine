import type { DdcEntry, StagedDdcEntry } from './entry-store.js';
import { DdcEntryStore } from './entry-store.js';
import type {
  DdcCommitResult,
  DdcHead,
  DdcLease,
  DdcRestoreFence,
  DdcRestoreResult,
  DdcRollbackSnapshot,
} from './lifecycle.js';
import { DdcLifecycle } from './lifecycle.js';

export interface DdcSessionOptions {
  readonly generation: number;
  readonly leaseTtlMs?: number;
}

export interface DdcGenerationCandidate {
  readonly generation: number;
  readonly lease: DdcLease;
  readonly previousHead: DdcRollbackSnapshot;
}

export interface DdcGenerationEntryCandidate extends DdcGenerationCandidate {
  readonly staged: StagedDdcEntry;
}

export interface DdcSessionMetrics {
  readonly hitCount: number;
  readonly missCount: number;
  readonly corruptCount: number;
  readonly writeFailureCount: number;
}

type MutableDdcGenerationCandidate = Omit<DdcGenerationCandidate, 'lease'> & {
  lease: DdcLease;
};

type MutableDdcGenerationEntryCandidate = Omit<DdcGenerationEntryCandidate, 'lease'> & {
  lease: DdcLease;
};

type HeartbeatTimer = ReturnType<typeof setTimeout>;

interface MutableMetrics {
  hitCount: number;
  missCount: number;
  corruptCount: number;
  writeFailureCount: number;
}

export class DdcGenerationSession {
  public readonly generation: number;
  private readonly lifecycle: DdcLifecycle;
  private readonly entries: DdcEntryStore;
  private readonly candidates = new Map<string, MutableDdcGenerationCandidate>();
  private readonly restoreFences = new WeakMap<DdcGenerationCandidate, DdcRestoreFence>();
  private readonly heartbeatTimers = new Map<string, HeartbeatTimer>();
  private readonly counters: MutableMetrics = {
    hitCount: 0,
    missCount: 0,
    corruptCount: 0,
    writeFailureCount: 0,
  };
  private accepting = true;

  public constructor(root: string, options: DdcSessionOptions) {
    if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
      throw new TypeError('DDC generation must be a positive safe integer');
    }
    this.generation = options.generation;
    this.lifecycle = new DdcLifecycle(
      root,
      options.leaseTtlMs === undefined ? undefined : { leaseTtlMs: options.leaseTtlMs },
    );
    this.entries = new DdcEntryStore(root);
  }

  public async beginCandidate(guid: string, desiredKey: string): Promise<DdcGenerationCandidate> {
    this.assertOpen();
    const { lease, previousHead } = await this.lifecycle.beginWithSnapshot(guid, desiredKey);
    if (previousHead.state === 'current') this.counters.hitCount += 1;
    else this.counters.missCount += 1;
    const candidate: MutableDdcGenerationCandidate = {
      generation: this.generation,
      lease,
      previousHead,
    };
    this.candidates.set(lease.attempt, candidate);
    this.scheduleHeartbeat(candidate);
    return candidate;
  }

  public async stageEntry(entry: DdcEntry): Promise<DdcGenerationEntryCandidate> {
    this.assertOpen();
    const candidate = (await this.beginCandidate(
      entry.guid,
      entry.key,
    )) as MutableDdcGenerationCandidate;
    try {
      const staged = await this.entries.stage(entry);
      const entryCandidate: MutableDdcGenerationEntryCandidate = Object.assign(candidate, {
        staged,
      });
      this.candidates.set(candidate.lease.attempt, entryCandidate);
      return entryCandidate;
    } catch (error) {
      const fence = await this.lifecycle.fail(candidate.lease, {
        code: 'ddc-entry-stage-failed',
        detail: error instanceof Error ? error.message : String(error),
      });
      if (fence !== undefined) this.restoreFences.set(candidate, fence);
      this.stopHeartbeat(candidate);
      this.candidates.delete(candidate.lease.attempt);
      this.counters.writeFailureCount += 1;
      throw error;
    }
  }

  public async inspect(guid: string, desiredKey: string): Promise<DdcHead> {
    this.assertOpen();
    const head = await this.lifecycle.inspect(guid, desiredKey);
    if (head.state === 'current') this.counters.hitCount += 1;
    else this.counters.missCount += 1;
    return head;
  }

  public async commitCandidate(
    candidate: DdcGenerationCandidate,
    validatedKey: string,
  ): Promise<DdcCommitResult> {
    const registered = this.assertCandidate(candidate);
    try {
      const result = await this.lifecycle.commit(registered.lease, validatedKey);
      if (result.restoreFence !== undefined)
        this.restoreFences.set(registered, result.restoreFence);
      if (result.result === 'invalid') this.counters.corruptCount += 1;
      this.stopHeartbeat(registered);
      this.candidates.delete(registered.lease.attempt);
      return result;
    } catch (error) {
      this.stopHeartbeat(registered);
      this.counters.writeFailureCount += 1;
      throw error;
    }
  }

  public async commitEntry(
    candidate: DdcGenerationEntryCandidate,
    validatedKey: string,
  ): Promise<DdcCommitResult> {
    const registered = this.assertCandidate(candidate);
    try {
      await this.entries.publish(candidate.staged);
      const result = await this.lifecycle.commit(registered.lease, validatedKey);
      if (result.restoreFence !== undefined)
        this.restoreFences.set(registered, result.restoreFence);
      this.stopHeartbeat(registered);
      this.candidates.delete(registered.lease.attempt);
      return result;
    } catch (error) {
      this.stopHeartbeat(registered);
      const fence = await this.lifecycle.fail(registered.lease, {
        code: 'ddc-entry-publish-failed',
        detail: error instanceof Error ? error.message : String(error),
      });
      if (fence !== undefined) this.restoreFences.set(registered, fence);
      await this.entries.discard(candidate.staged).catch(() => {});
      this.candidates.delete(registered.lease.attempt);
      this.counters.writeFailureCount += 1;
      throw error;
    }
  }

  public async discardCandidate(candidate: DdcGenerationCandidate): Promise<void> {
    const registered = this.candidates.get(candidate.lease.attempt);
    if (registered === undefined) return;
    try {
      this.stopHeartbeat(registered);
      await this.lifecycle.discard(registered.lease);
      this.candidates.delete(registered.lease.attempt);
    } catch (error) {
      this.counters.writeFailureCount += 1;
      throw error;
    }
  }

  public async discardEntry(candidate: DdcGenerationEntryCandidate): Promise<void> {
    await Promise.all([this.discardCandidate(candidate), this.entries.discard(candidate.staged)]);
  }

  public async restoreEntry(candidate: DdcGenerationEntryCandidate): Promise<DdcRestoreResult> {
    const registered = this.candidates.get(candidate.lease.attempt);
    const ownerLease = registered?.lease ?? candidate.lease;
    const fence = this.restoreFences.get(candidate);
    this.stopHeartbeat(ownerLease);
    let result: DdcRestoreResult = {
      result: 'not-owner',
      revision: candidate.previousHead.revision ?? 0,
      ...(candidate.previousHead.generation === undefined
        ? {}
        : { generation: candidate.previousHead.generation }),
    };
    let restoreError: unknown;
    try {
      result = await this.lifecycle.restoreIfCurrent(candidate.previousHead, ownerLease, fence);
    } catch (error) {
      restoreError = error;
    } finally {
      await this.entries.discard(candidate.staged).catch(() => {});
      if (registered !== undefined) {
        this.candidates.delete(registered.lease.attempt);
      }
    }
    if (restoreError !== undefined) throw restoreError;
    return result;
  }

  public metrics(): DdcSessionMetrics {
    return { ...this.counters };
  }

  public async close(): Promise<void> {
    if (!this.accepting) return;
    this.accepting = false;
    for (const timer of this.heartbeatTimers.values()) clearTimeout(timer);
    this.heartbeatTimers.clear();
    const pending = [...this.candidates.values()];
    for (const candidate of pending) {
      try {
        await this.lifecycle.discard(candidate.lease);
      } catch {
        this.counters.writeFailureCount += 1;
      }
    }
    this.candidates.clear();
  }

  private assertOpen(): void {
    if (!this.accepting) throw new Error('DDC generation session is closed');
  }

  private assertCandidate(candidate: DdcGenerationCandidate): MutableDdcGenerationCandidate {
    this.assertOpen();
    const registered = this.candidates.get(candidate.lease.attempt);
    if (candidate.generation !== this.generation || registered === undefined) {
      throw new Error('DDC candidate belongs to another generation session');
    }
    return registered;
  }

  private scheduleHeartbeat(candidate: MutableDdcGenerationCandidate): void {
    const attempt = candidate.lease.attempt;
    this.stopHeartbeat(candidate);
    const delay = Math.max(1, Math.floor((candidate.lease.expiresAt - Date.now()) / 2));
    const timer = setTimeout(() => {
      this.heartbeatTimers.delete(attempt);
      if (!this.accepting || this.candidates.get(attempt) !== candidate) return;
      void this.lifecycle
        .heartbeat(candidate.lease)
        .then((lease) => {
          if (!this.accepting || this.candidates.get(attempt) !== candidate) return;
          candidate.lease = lease;
          this.scheduleHeartbeat(candidate);
        })
        .catch(() => {
          this.stopHeartbeat(candidate);
        });
    }, delay);
    timer.unref?.();
    this.heartbeatTimers.set(attempt, timer);
  }

  private stopHeartbeat(candidate: DdcGenerationCandidate | DdcLease): void {
    const attempt = 'lease' in candidate ? candidate.lease.attempt : candidate.attempt;
    const timer = this.heartbeatTimers.get(attempt);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.heartbeatTimers.delete(attempt);
  }
}
