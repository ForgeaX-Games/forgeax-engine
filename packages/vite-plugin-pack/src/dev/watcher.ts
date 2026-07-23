import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { scan } from '@forgeax/engine-pack/scanner';
import type { PackIndexEntry } from '@forgeax/engine-types';

export interface WatchedChange {
  readonly filename: string;
  readonly eventType: string;
}

export interface WatchBatch {
  readonly sidecars: readonly WatchedChange[];
  readonly sources: readonly WatchedChange[];
}

export interface DevWatcherOptions {
  readonly roots: readonly string[];
  readonly debounceMs?: number;
  readonly onBatch: (batch: WatchBatch) => void | Promise<void>;
}

export function buildUrlToAbsolute(
  entries: readonly PackIndexEntry[],
  options: { readonly cwd: string; readonly ddcPath: (guid: string) => string },
): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    const guid = entry.guid.toLowerCase();
    const imported = entry.relativeUrl.endsWith(`.${guid}.bin`);
    map.set(
      entry.relativeUrl,
      imported ? options.ddcPath(guid) : resolve(options.cwd, entry.sourcePath),
    );
  }
  return map;
}

export async function buildGuidToMetaMap(roots: readonly string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const root of roots) {
    const result = await scan([root]);
    if (!result.ok) continue;
    for (const metaPath of result.value.filter((path) => path.endsWith('.meta.json'))) {
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as {
          subAssets?: ReadonlyArray<{ guid: string }>;
        };
        for (const sub of meta.subAssets ?? []) map.set(sub.guid.toLowerCase(), metaPath);
      } catch {
        // A malformed sidecar is surfaced by its importer; skip it in this index.
      }
    }
  }
  return map;
}

export interface DevWatchClassification {
  readonly kind: 'sidecar' | 'source';
  readonly catalog: boolean;
}

export function classifyWatchedPath(filename: string): DevWatchClassification {
  const isSidecar = filename.endsWith('.meta.json') || filename.endsWith('.pack.json');
  const isUi =
    filename.endsWith('.ui.html') ||
    filename.endsWith('.ui.css') ||
    filename.endsWith('.woff2') ||
    filename.endsWith('.woff') ||
    filename.endsWith('.webp') ||
    filename.endsWith('.svg');
  return { kind: isSidecar || isUi ? 'sidecar' : 'source', catalog: isSidecar };
}

export function watchDevRoots(options: DevWatcherOptions): () => void {
  const pendingSidecars = new Map<string, WatchedChange>();
  const pendingSources = new Map<string, WatchedChange>();
  const lastSidecarContent = new Map<string, string>();
  const lastSourceSig = new Map<string, string>();
  const watchers: FSWatcher[] = [];
  const debounceMs = options.debounceMs ?? 150;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const flush = async (): Promise<void> => {
    if (disposed) return;
    const sidecars = [...pendingSidecars.entries()];
    const sources = [...pendingSources.entries()];
    pendingSidecars.clear();
    pendingSources.clear();

    const changedSidecars: WatchedChange[] = [];
    for (const [abs, info] of sidecars) {
      let content: string;
      try {
        content = await readFile(abs, 'utf-8');
      } catch {
        lastSidecarContent.delete(abs);
        changedSidecars.push(info);
        continue;
      }
      if (lastSidecarContent.get(abs) === content) continue;
      lastSidecarContent.set(abs, content);
      changedSidecars.push(info);
    }

    const changedSources: WatchedChange[] = [];
    for (const [abs, info] of sources) {
      let signature: string;
      try {
        const file = await stat(abs);
        signature = `${file.mtimeMs}:${file.size}`;
      } catch {
        lastSourceSig.delete(abs);
        changedSources.push(info);
        continue;
      }
      if (lastSourceSig.get(abs) === signature) continue;
      lastSourceSig.set(abs, signature);
      changedSources.push(info);
    }
    if (changedSidecars.length === 0 && changedSources.length === 0) return;
    await options.onBatch({ sidecars: changedSidecars, sources: changedSources });
  };

  const schedule = (): void => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush();
    }, debounceMs);
    flushTimer.unref();
  };

  for (const root of options.roots) {
    try {
      const watcher = fsWatch(root, { recursive: true }, (eventType, rawFilename) => {
        if (rawFilename === null) return;
        const filename = String(rawFilename);
        const classification = classifyWatchedPath(filename);
        const change = { filename, eventType: String(eventType) };
        const abs = resolve(root, filename);
        if (classification.kind === 'sidecar') pendingSidecars.set(abs, change);
        else pendingSources.set(abs, change);
        schedule();
      });
      watcher.unref();
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch {
      // A missing root is created later by the host; no watcher is installed.
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
