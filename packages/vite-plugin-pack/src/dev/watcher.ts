import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { resolve } from 'node:path';

export interface WatchedChange {
  readonly filename: string;
}

export interface WatchBatch {
  readonly sidecars: readonly WatchedChange[];
  readonly sources: readonly WatchedChange[];
}

export interface DevWatcherOptions {
  readonly roots: readonly string[];
  readonly debounceMs?: number;
  readonly onBatch: (batch: WatchBatch) => void | Promise<void>;
  readonly onError?: (
    error: unknown,
    context: { readonly phase: 'watcher' | 'flush' | 'missing-root'; readonly root?: string },
  ) => void | Promise<void>;
}

export interface DevWatchClassification {
  readonly kind: 'sidecar' | 'source';
}

export function classifyWatchedPath(filename: string): DevWatchClassification {
  const isSidecar =
    filename.endsWith('.meta.json') ||
    filename.endsWith('.pack.json') ||
    filename.endsWith('.pack.ts');
  return { kind: isSidecar ? 'sidecar' : 'source' };
}

export function watchDevRoots(options: DevWatcherOptions): () => void {
  const pendingSidecars = new Map<string, WatchedChange>();
  const pendingSources = new Map<string, WatchedChange>();
  const watchers: FSWatcher[] = [];
  const debounceMs = options.debounceMs ?? 150;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const report = (
    error: unknown,
    context: { readonly phase: 'watcher' | 'flush' | 'missing-root'; readonly root?: string },
  ): void => {
    if (options.onError === undefined) {
      console.error('[forgeax-pack] dev watcher failure', error);
      return;
    }
    try {
      const result = options.onError(error, context);
      if (result !== undefined) result.catch((nested) => console.error(nested));
    } catch (nested) {
      console.error(nested);
    }
  };

  const flush = async (): Promise<void> => {
    if (disposed) return;
    const sidecars = [...pendingSidecars.values()];
    const sources = [...pendingSources.values()];
    pendingSidecars.clear();
    pendingSources.clear();
    if (disposed) return;
    if (sidecars.length === 0 && sources.length === 0) return;
    try {
      await options.onBatch({ sidecars, sources });
    } catch (error) {
      report(error, { phase: 'flush' });
    }
  };

  const schedule = (): void => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flush().catch((error: unknown) => report(error, { phase: 'flush' }));
    }, debounceMs);
    flushTimer.unref();
  };

  for (const root of options.roots) {
    try {
      const watcher = fsWatch(root, { recursive: true }, (_eventType, rawFilename) => {
        if (rawFilename === null) return;
        const filename = String(rawFilename);
        const classification = classifyWatchedPath(filename);
        const change = { filename };
        const abs = resolve(root, filename);
        if (classification.kind === 'sidecar') pendingSidecars.set(abs, change);
        else pendingSources.set(abs, change);
        schedule();
      });
      watcher.unref();
      watcher.on('error', (error) => report(error, { phase: 'watcher', root }));
      watchers.push(watcher);
    } catch (error) {
      // A missing root is created later by the host; no watcher is installed.
      report(error, { phase: 'missing-root', root });
    }
  }

  return () => {
    disposed = true;
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    for (const watcher of watchers) watcher.close();
    pendingSidecars.clear();
    pendingSources.clear();
  };
}
