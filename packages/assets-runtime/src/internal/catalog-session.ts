import type {
  CatalogDelta,
  CatalogDiagnostic,
  CatalogEntry,
  ResourceRevision,
} from '@forgeax/engine-types';
import { type AssetLoadError, err, ok, type Result } from '@forgeax/engine-types';
import type { CatalogSource } from '../catalog-source.js';
import { type RuntimeCatalogRow, validateRuntimeRow } from './validate-runtime-row.js';

export interface CatalogSessionOptions {
  readonly scopeId?: string;
  readonly generation?: number;
}

export interface CatalogSessionSnapshot {
  readonly scopeId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly revision?: ResourceRevision;
  readonly entries: readonly RuntimeCatalogRow[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly diagnostics: readonly CatalogDiagnostic[];
  readonly listenerFailures: number;
  readonly stale: boolean;
}

type SessionResult = Result<CatalogSessionSnapshot, AssetLoadError>;
type SessionListener = (snapshot: CatalogSessionSnapshot) => void;

function runtimeError(
  code: AssetLoadError['code'],
  guid: string,
  detail: Record<string, unknown>,
): AssetLoadError {
  if (code === 'catalog-discontinuous') {
    return {
      code,
      expected: 'an ordered catalog revision window',
      hint: 'reconcile the current Catalog before consuming this delta',
      detail: {
        scopeId: String(detail.scopeId ?? 'unknown'),
        expectedGeneration: Number(detail.expectedGeneration ?? 0),
        actualGeneration: Number(detail.actualGeneration ?? 0),
      },
    };
  }
  return {
    code: 'asset-package-invalid',
    expected: 'a verified Catalog source',
    hint: 'repair the producer Catalog and retry with the current publication',
    detail: { guid, reason: String(detail.reason ?? 'catalog source failed') },
  };
}

function freezeSnapshot(snapshot: CatalogSessionSnapshot): CatalogSessionSnapshot {
  return Object.freeze({
    ...snapshot,
    entries: Object.freeze([...snapshot.entries]),
    changed: Object.freeze([...snapshot.changed]),
    removed: Object.freeze([...snapshot.removed]),
    diagnostics: Object.freeze([...snapshot.diagnostics]),
  });
}

function sameEntry(left: CatalogEntry, right: CatalogEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function key(guid: string): string {
  return guid.toLowerCase();
}

export class CatalogSession {
  private readonly source: CatalogSource;
  private readonly scopeId: string;
  private readonly generation: number;
  private readonly entries = new Map<string, RuntimeCatalogRow>();
  private readonly listeners = new Set<SessionListener>();
  private unsubscribe: (() => void) | undefined;
  private baselinePromise: Promise<SessionResult> | undefined;
  private reconcilePromise: Promise<SessionResult> | undefined;
  private pending: CatalogDelta[] = [];
  private currentSnapshot: CatalogSessionSnapshot;
  private revision: ResourceRevision | undefined;
  private diagnostics: CatalogDiagnostic[] = [];
  private listenerFailures = 0;
  private changed = new Set<string>();
  private removed = new Set<string>();
  private epoch = 0;
  private stale = false;
  private staleGeneration = 0;
  private started = false;
  private disposed = false;

  constructor(source: CatalogSource, options: CatalogSessionOptions = {}) {
    this.source = source;
    this.scopeId = options.scopeId ?? source.expectedScope?.scopeId ?? 'asset-runtime';
    this.generation = options.generation ?? source.expectedScope?.generation ?? 0;
    this.currentSnapshot = freezeSnapshot({
      scopeId: this.scopeId,
      generation: this.generation,
      epoch: 0,
      entries: [],
      changed: [],
      removed: [],
      diagnostics: [],
      listenerFailures: 0,
      stale: false,
    });
  }

  start(): Promise<SessionResult> {
    if (this.baselinePromise !== undefined) return this.baselinePromise;
    if (this.disposed) return Promise.resolve(err(this.disposedError()));
    this.unsubscribe = this.source.subscribe((delta) => this.receive(delta));
    const promise = this.source
      .enumerate()
      .then((result) => {
        if (!result.ok) {
          this.markStale();
          this.publish();
          return err(runtimeError('asset-package-invalid', '', { reason: result.error.code }));
        }
        this.entries.clear();
        for (const entry of result.value) {
          const validated = validateRuntimeRow(entry);
          if (!validated.ok) {
            this.markStale();
            this.publish();
            return err(validated.error);
          }
          this.entries.set(key(validated.value.guid), validated.value);
        }
        this.started = true;
        this.stale = false;
        this.staleGeneration = this.generation;
        this.diagnostics = [];
        for (const delta of this.pending) this.fold(delta, false);
        this.pending = [];
        this.publish();
        return ok(this.currentSnapshot);
      })
      .catch((cause: unknown) => {
        this.markStale();
        this.addDiagnostic('catalog-degraded-rows', 'Catalog enumeration must resolve a Result');
        this.publish();
        return err(
          runtimeError('asset-package-invalid', '', {
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      });
    this.baselinePromise = promise;
    void promise.then(
      (result) => {
        if (!result.ok) this.baselinePromise = undefined;
      },
      () => {
        this.baselinePromise = undefined;
      },
    );
    return promise;
  }

  reconcile(): Promise<SessionResult> {
    if (this.disposed) return Promise.resolve(err(this.disposedError()));
    if (this.reconcilePromise !== undefined) return this.reconcilePromise;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.started = false;
    this.pending = [];
    this.baselinePromise = undefined;
    this.epoch += 1;
    const promise = this.start();
    this.reconcilePromise = promise;
    void promise.then(
      () => {
        if (this.reconcilePromise === promise) this.reconcilePromise = undefined;
      },
      () => {
        if (this.reconcilePromise === promise) this.reconcilePromise = undefined;
      },
    );
    return promise;
  }

  current(guid: string): RuntimeCatalogRow | undefined {
    return this.entries.get(key(guid));
  }

  snapshot(): CatalogSessionSnapshot {
    return this.currentSnapshot;
  }

  discontinuity(): AssetLoadError | undefined {
    if (!this.stale) return undefined;
    return {
      code: 'catalog-discontinuous',
      expected: 'an ordered, authoritative catalog revision window',
      hint: 'reconcile the Catalog source and retry the current publication',
      detail: {
        scopeId: this.scopeId,
        expectedGeneration: this.generation,
        actualGeneration: this.staleGeneration,
      },
    };
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.pending = [];
    this.listeners.clear();
  }

  private receive(delta: CatalogDelta): void {
    if (this.disposed) return;
    if (!this.started) {
      this.pending.push(delta);
      return;
    }
    this.fold(delta, true);
  }

  private fold(delta: CatalogDelta, publish: boolean): void {
    if (
      (delta.scopeId !== undefined && delta.scopeId !== this.scopeId) ||
      (delta.generation !== undefined && delta.generation !== this.generation)
    ) {
      this.markStale(delta.generation);
      this.addDiagnostic('catalog-scope-mismatch', 'delta scope does not match the session');
      if (publish) this.publish();
      return;
    }
    if (delta.authority === 'degraded') {
      this.markStale(delta.generation);
      this.addDiagnostic('catalog-degraded-rows', 'degraded rows are not identity-bearing');
      if (publish) this.publish();
      return;
    }
    if (delta.revisions !== undefined) {
      const baseline = delta.revisions.baseline;
      const current = delta.revisions.current;
      const valid =
        baseline.length === current.length &&
        current.every((point) => {
          const prior = baseline.find((item) => item.rootId === point.rootId);
          return prior !== undefined && point.revision === prior.revision + 1;
        });
      if (!valid) {
        this.markStale(delta.generation);
        this.addDiagnostic('catalog-gap', 'delta revision window is not contiguous');
        if (publish) this.publish();
        return;
      }
    }
    let changed = false;
    for (const entry of [...delta.added, ...delta.changed]) {
      const validated = validateRuntimeRow(entry);
      if (!validated.ok) {
        this.markStale(delta.generation);
        this.addDiagnostic('catalog-degraded-rows', 'delta contains an invalid runtime row');
        if (publish) this.publish();
        return;
      }
      const entryKey = key(validated.value.guid);
      const prior = this.entries.get(entryKey);
      if (prior === undefined || !sameEntry(prior, validated.value)) {
        this.entries.set(entryKey, validated.value);
        this.changed.add(entryKey);
        changed = true;
        if (validated.value.revision !== undefined) this.revision = validated.value.revision;
      }
    }
    for (const guid of delta.removed) {
      const entryKey = key(guid);
      if (this.entries.delete(entryKey)) {
        this.removed.add(entryKey);
        changed = true;
      }
    }
    if (changed) this.epoch += 1;
    if (publish) this.publish();
  }

  private addDiagnostic(code: CatalogDiagnostic['code'], expected: string): void {
    if (this.diagnostics.some((diagnostic) => diagnostic.code === code)) return;
    this.diagnostics.push({
      code,
      severity: 'blocking',
      expected,
      hint: 'reconcile the Catalog before loading the affected publication',
      authority: 'catalog',
    });
  }

  private markStale(actualGeneration = this.generation): void {
    this.stale = true;
    this.staleGeneration = actualGeneration;
    this.epoch += 1;
  }

  private publish(): void {
    this.currentSnapshot = freezeSnapshot({
      scopeId: this.scopeId,
      generation: this.generation,
      epoch: this.epoch,
      ...(this.revision === undefined ? {} : { revision: this.revision }),
      entries: [...this.entries.values()].sort((left, right) =>
        key(left.guid).localeCompare(key(right.guid)),
      ),
      changed: [...this.changed].sort(),
      removed: [...this.removed].sort(),
      diagnostics: this.diagnostics,
      listenerFailures: this.listenerFailures,
      stale: this.stale,
    });
    this.changed.clear();
    this.removed.clear();
    for (const listener of [...this.listeners]) {
      try {
        listener(this.currentSnapshot);
      } catch {
        this.listenerFailures = Math.min(1024, this.listenerFailures + 1);
        this.currentSnapshot = freezeSnapshot({
          ...this.currentSnapshot,
          listenerFailures: this.listenerFailures,
        });
      }
    }
  }

  private disposedError(): AssetLoadError {
    return runtimeError('asset-runtime-disposed', '', { scopeId: this.scopeId });
  }
}
