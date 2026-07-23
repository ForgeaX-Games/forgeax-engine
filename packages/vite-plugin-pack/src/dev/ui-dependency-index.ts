export interface UiDependencyDiagnosticLocation {
  readonly sourcePath: string;
}

export interface UiDependencyFailure {
  readonly guid: string;
  readonly sourcePath: string;
  readonly diagnostics: readonly UiDependencyDiagnosticLocation[];
  readonly revision: number;
}

export interface UiDependencyChange {
  readonly guids: readonly string[];
  readonly sourcePath: string;
  readonly revision: number;
}

function normalize(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function sameSourcePath(left: string, right: string): boolean {
  if (left === right) return true;
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

export interface UiDependencyIndex {
  recordSuccess(guid: string, sourceDependencies: readonly string[]): void;
  recordFailure(failure: UiDependencyFailure): void;
  guidsForSource(sourcePath: string): readonly string[];
  change(sourcePath: string, revision: number): UiDependencyChange;
}

/** Ephemeral reverse projection of importer provenance for dev refresh only. */
export function createUiDependencyIndex(): UiDependencyIndex {
  const bySource = new Map<string, Set<string>>();
  const byGuid = new Map<string, Set<string>>();
  const add = (guid: string, path: string): void => {
    const key = normalize(path);
    if (key.length === 0) return;
    const guidSet = bySource.get(key) ?? new Set<string>();
    guidSet.add(guid);
    bySource.set(key, guidSet);
    const sourceSet = byGuid.get(guid) ?? new Set<string>();
    sourceSet.add(key);
    byGuid.set(guid, sourceSet);
  };
  return {
    recordSuccess(guid, sourceDependencies) {
      const normalizedGuid = guid.toLowerCase();
      for (const path of byGuid.get(normalizedGuid) ?? []) {
        const guids = bySource.get(path);
        guids?.delete(normalizedGuid);
        if (guids?.size === 0) bySource.delete(path);
      }
      byGuid.delete(normalizedGuid);
      for (const path of sourceDependencies) add(normalizedGuid, path);
    },
    recordFailure(failure) {
      const guid = failure.guid.toLowerCase();
      add(guid, failure.sourcePath);
      for (const diagnostic of failure.diagnostics) add(guid, diagnostic.sourcePath);
    },
    guidsForSource(sourcePath) {
      const wanted = normalize(sourcePath);
      const guids = new Set<string>();
      for (const [knownPath, knownGuids] of bySource) {
        if (!sameSourcePath(knownPath, wanted)) continue;
        for (const guid of knownGuids) guids.add(guid);
      }
      return [...guids].sort();
    },
    change(sourcePath, revision) {
      return {
        guids: [...this.guidsForSource(sourcePath)],
        sourcePath,
        revision,
      };
    },
  };
}
