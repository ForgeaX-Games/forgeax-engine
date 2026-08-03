import { ok, type Result } from '@forgeax/engine-rhi';
import type {
  AssetError,
  CatalogDelta,
  CatalogDiagnostic,
  CatalogEntry,
  CatalogRevisionWindow,
  ResourceRevision,
} from '@forgeax/engine-types';
import type { CatalogSource } from '../catalog-source';

export interface CatalogReplicaSnapshot {
  readonly version: number;
  readonly entries: readonly CatalogEntry[];
  readonly stale: boolean;
  readonly diagnostics: readonly CatalogDiagnostic[];
}

type SnapshotResult = Result<CatalogReplicaSnapshot, AssetError>;
type CatalogDeltaListener = (delta: CatalogDelta) => void;

function guidKey(guid: string): string {
  return guid.toLowerCase();
}

function freezeEntry(entry: CatalogEntry): CatalogEntry {
  return Object.freeze({ ...entry });
}

function freezeSnapshot(snapshot: CatalogReplicaSnapshot): CatalogReplicaSnapshot {
  return Object.freeze({
    ...snapshot,
    entries: Object.freeze(snapshot.entries.map(freezeEntry)),
    diagnostics: Object.freeze([...snapshot.diagnostics]),
  });
}

function revisionIsOlder(
  incoming: ResourceRevision | undefined,
  current: ResourceRevision | undefined,
): boolean {
  return (
    incoming !== undefined && current !== undefined && incoming.observedAt < current.observedAt
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasRevisionGap(revisions: CatalogRevisionWindow | undefined): boolean {
  if (revisions === undefined) return false;
  const baseline = new Map(revisions.baseline.map((point) => [point.rootId, point.revision]));
  return revisions.current.some(
    (point) => (baseline.get(point.rootId) ?? point.revision) + 1 < point.revision,
  );
}

function diagnosticForGap(): CatalogDiagnostic {
  return {
    code: 'catalog-gap',
    severity: 'blocking',
    expected: 'a contiguous producer revision window',
    hint: 'reconcile the catalog before consuming incremental changes',
    authority: 'catalog',
  };
}

function appendDiagnostic(
  diagnostics: readonly CatalogDiagnostic[],
  incoming: readonly CatalogDiagnostic[] | undefined,
): readonly CatalogDiagnostic[] {
  const next = [...diagnostics];
  for (const diagnostic of incoming ?? []) {
    if (!next.some((existing) => existing.code === diagnostic.code)) next.push(diagnostic);
  }
  return next;
}

/**
 * One authoritative catalog read model owned by AssetRegistry.
 *
 * The source subscription is installed before the first enumeration. Deltas
 * observed during that baseline read are buffered and folded afterwards, so
 * an early publication cannot disappear between the two operations.
 */
export class CatalogReplica {
  private readonly source: CatalogSource;
  private readonly listeners = new Set<CatalogDeltaListener>();
  private readonly entries = new Map<string, CatalogEntry>();
  private pendingBeforeBaseline: CatalogDelta[] = [];
  private pendingDuringReconcile: CatalogDelta[] | undefined;
  private unsubscribe: (() => void) | undefined;
  private startPromise: Promise<SnapshotResult> | undefined;
  private baselineReady = false;
  private version = 0;
  private stale = false;
  private diagnostics: readonly CatalogDiagnostic[] = [];
  private currentSnapshot: CatalogReplicaSnapshot;

  constructor(source: CatalogSource) {
    this.source = source;
    this.currentSnapshot = freezeSnapshot({
      version: 0,
      entries: [],
      stale: false,
      diagnostics: [],
    });
  }

  subscribe(listener: CatalogDeltaListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): CatalogReplicaSnapshot {
    return this.currentSnapshot;
  }

  async start(): Promise<SnapshotResult> {
    if (this.startPromise !== undefined) return this.startPromise;
    if (this.unsubscribe === undefined) {
      this.unsubscribe = this.source.subscribe((delta) => this.receive(delta));
    }
    const promise = this.loadBaseline(false);
    this.startPromise = promise;
    void promise.then((result) => {
      if (!result.ok) this.startPromise = undefined;
    });
    return promise;
  }

  async reconcile(): Promise<SnapshotResult> {
    if (this.unsubscribe === undefined) {
      this.unsubscribe = this.source.subscribe((delta) => this.receive(delta));
    }
    this.pendingDuringReconcile = [];
    return this.loadBaseline(true);
  }

  private async loadBaseline(isReconcile: boolean): Promise<SnapshotResult> {
    const result = await this.source.enumerate();
    if (!result.ok) {
      this.stale = true;
      this.currentSnapshot = this.makeSnapshot();
      if (!isReconcile) this.pendingBeforeBaseline = [];
      this.pendingDuringReconcile = undefined;
      return result;
    }

    this.entries.clear();
    for (const entry of result.value) this.entries.set(guidKey(entry.guid), freezeEntry(entry));
    this.stale = false;
    this.diagnostics = [];
    this.baselineReady = true;
    const pending = isReconcile ? (this.pendingDuringReconcile ?? []) : this.pendingBeforeBaseline;
    this.pendingBeforeBaseline = [];
    this.pendingDuringReconcile = undefined;
    for (const delta of pending) this.fold(delta, false);
    this.currentSnapshot = this.makeSnapshot();
    return ok(this.currentSnapshot);
  }

  private receive(delta: CatalogDelta): void {
    if (!this.baselineReady) {
      if (this.pendingDuringReconcile !== undefined) this.pendingDuringReconcile.push(delta);
      else this.pendingBeforeBaseline.push(delta);
      this.publish(delta);
      return;
    }
    if (this.pendingDuringReconcile !== undefined) {
      this.pendingDuringReconcile.push(delta);
      this.publish(delta);
      return;
    }
    this.fold(delta, true);
  }

  private fold(delta: CatalogDelta, publish: boolean): void {
    const gap = hasRevisionGap(delta.revisions);
    const degraded = delta.authority === 'degraded' || gap;
    this.stale = this.stale || degraded;
    this.diagnostics = appendDiagnostic(
      this.diagnostics,
      gap ? [...(delta.diagnostics ?? []), diagnosticForGap()] : delta.diagnostics,
    );

    if (!degraded) {
      let changed = false;
      for (const entry of [...delta.added, ...delta.changed]) {
        const key = guidKey(entry.guid);
        const prior = this.entries.get(key);
        if (revisionIsOlder(entry.revision, prior?.revision)) continue;
        if (prior !== undefined && sameValue(prior, entry)) continue;
        this.entries.set(key, freezeEntry(entry));
        changed = true;
      }
      for (const guid of delta.removed) {
        if (this.entries.delete(guidKey(guid))) changed = true;
      }
      if (changed) this.version += 1;
    }

    this.currentSnapshot = this.makeSnapshot();
    if (publish) {
      this.publish(delta);
    }
  }

  private publish(delta: CatalogDelta): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(delta);
      } catch {
        // One observer cannot prevent the remaining catalog observers from seeing a fact.
      }
    }
  }

  private makeSnapshot(): CatalogReplicaSnapshot {
    const entries = [...this.entries.values()].sort((left, right) =>
      guidKey(left.guid).localeCompare(guidKey(right.guid)),
    );
    this.currentSnapshot = freezeSnapshot({
      version: this.version,
      entries,
      stale: this.stale,
      diagnostics: this.diagnostics,
    });
    return this.currentSnapshot;
  }
}
