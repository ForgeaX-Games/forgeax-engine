import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { err, ok, type Result } from '@forgeax/engine-types';
import ts from 'typescript';
import type { PackAuthoringError } from './pack-authoring.js';
import type { ScriptablePackSourceClosureEntry } from './scriptable-pack.js';
import { relativeScriptableImportCandidates } from './scriptable-pack-relative-import.js';

export type ScriptablePackImportResolver = (
  importer: string,
  specifier: string,
) => Promise<string | undefined>;

export interface ScriptablePackSourceSnapshot {
  inventory(
    sourcePath: string,
    sourceText?: string,
    resolveImport?: ScriptablePackImportResolver,
  ): Promise<readonly ScriptablePackSourceClosureEntry[]>;
  readText(path: string): Promise<string>;
  digest(path: string): Promise<string>;
  moduleSources(sourcePath: string): Promise<Record<string, string>>;
  verify(): Promise<Result<void, PackAuthoringError>>;
}

interface SourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

function contentDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function conflict(path: string, reason: string): PackAuthoringError {
  return {
    code: 'pack-source-revision-conflict',
    expected: 'the captured source and resolution inputs to remain current until publication',
    hint: 'discard this candidate and rebuild from the current source generation',
    detail: { sourcePath: path, reason },
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/** The build owner retains one snapshot; a later build always starts a new one. */
export function createScriptablePackSourceSnapshot(): ScriptablePackSourceSnapshot {
  const aliases = new Map<string, Promise<string>>();
  const files = new Map<string, Promise<SourceFile>>();
  const probes = new Map<string, Promise<boolean>>();
  const resolutions = new Map<
    ScriptablePackImportResolver,
    Map<
      string,
      {
        readonly importer: string;
        readonly specifier: string;
        readonly result: Promise<string | undefined>;
      }
    >
  >();
  const canonical = (path: string): Promise<string> => {
    const absolute = resolve(path);
    let pending = aliases.get(absolute);
    if (pending === undefined) {
      pending = realpath(absolute);
      aliases.set(absolute, pending);
    }
    return pending;
  };
  const read = async (path: string, sourceText?: string): Promise<SourceFile> => {
    const identity = await canonical(path);
    let pending = files.get(identity);
    if (pending === undefined) {
      pending = (async () => {
        const bytes =
          sourceText === undefined
            ? await readFile(identity)
            : new TextEncoder().encode(sourceText);
        return { path: identity, bytes, digest: contentDigest(bytes) };
      })();
      files.set(identity, pending);
    }
    const file = await pending;
    if (
      sourceText !== undefined &&
      contentDigest(new TextEncoder().encode(sourceText)) !== file.digest
    )
      throw conflict(identity, 'conflicting source text in one generation');
    return file;
  };
  const resolveRelative: ScriptablePackImportResolver = async (importer, specifier) => {
    for (const candidate of relativeScriptableImportCandidates(importer, specifier)) {
      let probe = probes.get(candidate);
      if (probe === undefined) {
        probe = isFile(candidate);
        probes.set(candidate, probe);
      }
      if (await probe) return candidate;
    }
    return undefined;
  };
  const resolveOnce = (
    importer: string,
    specifier: string,
    resolver: ScriptablePackImportResolver,
  ) => {
    let entries = resolutions.get(resolver);
    if (entries === undefined) {
      entries = new Map();
      resolutions.set(resolver, entries);
    }
    const key = JSON.stringify([importer, specifier]);
    let observation = entries.get(key);
    if (observation === undefined) {
      const result = resolver(importer, specifier).then((path) =>
        path === undefined ? undefined : canonical(path),
      );
      observation = { importer, specifier, result };
      entries.set(key, observation);
    }
    return observation.result;
  };
  const snapshot: ScriptablePackSourceSnapshot = {
    async inventory(sourcePath, sourceText, resolver = resolveRelative) {
      const root = await canonical(sourcePath);
      const pending = [root],
        seen = new Set<string>();
      const entries: ScriptablePackSourceClosureEntry[] = [];
      while (pending.length > 0) {
        const path = pending.pop();
        if (path === undefined || seen.has(path)) continue;
        seen.add(path);
        const file = await read(path, path === root ? sourceText : undefined);
        entries.push(Object.freeze({ path: file.path, digest: file.digest }));
        for (const specifier of sourceImports(file.bytes, file.digest)) {
          const target = await resolveOnce(path, specifier, resolver);
          if (target !== undefined) pending.push(target);
        }
      }
      return Object.freeze(entries.sort((a, b) => a.path.localeCompare(b.path)));
    },
    async readText(path) {
      return new TextDecoder().decode((await read(path)).bytes);
    },
    async digest(path) {
      return (await read(path)).digest;
    },
    async moduleSources(sourcePath) {
      const entries = await snapshot.inventory(sourcePath);
      const sources: Record<string, string> = {};
      for (const entry of entries) sources[entry.path] = await snapshot.readText(entry.path);
      // Worker resolution must preserve aliases without consulting a changed filesystem.
      for (const [alias, target] of aliases) {
        const identity = await target;
        if (sources[identity] !== undefined) sources[alias] = sources[identity];
      }
      return sources;
    },
    async verify() {
      const checks: Array<() => Promise<PackAuthoringError | undefined>> = [];
      for (const [alias, expected] of aliases)
        checks.push(async () => {
          try {
            if ((await realpath(alias)) === (await expected)) return undefined;
          } catch {}
          return conflict(alias, 'source path changed or disappeared');
        });
      for (const [path, expected] of files)
        checks.push(async () => {
          try {
            if (contentDigest(await readFile(path)) === (await expected).digest) return undefined;
          } catch {}
          return conflict(path, 'source content changed or disappeared');
        });
      for (const [path, expected] of probes)
        checks.push(async () => {
          try {
            if ((await isFile(path)) === (await expected)) return undefined;
          } catch {}
          return conflict(path, 'import resolution candidate changed');
        });
      for (const [resolver, observations] of resolutions) {
        if (resolver === resolveRelative) continue;
        for (const observation of observations.values())
          checks.push(async () => {
            try {
              const target = await resolver(observation.importer, observation.specifier);
              const actual = target === undefined ? undefined : await realpath(target);
              if (actual === (await observation.result)) return undefined;
            } catch {}
            return conflict(observation.importer, `resolution changed: ${observation.specifier}`);
          });
      }
      let next = 0;
      let failure: PackAuthoringError | undefined;
      await Promise.all(
        Array.from({ length: Math.min(16, checks.length) }, async () => {
          while (failure === undefined) {
            const check = checks[next++];
            if (check === undefined) return;
            const result = await check();
            if (result !== undefined) failure ??= result;
          }
        }),
      );
      return failure === undefined ? ok(undefined) : err(failure);
    },
  };
  return snapshot;
}

// Syntax alone is reusable across generations. IO and resolution belong to the snapshot.
const importsByDigest = new Map<
  string,
  { readonly imports: readonly string[]; readonly size: number }
>();
let retainedSourceBytes = 0;
function sourceImports(bytes: Uint8Array, digest: string): readonly string[] {
  const cached = importsByDigest.get(digest);
  if (cached !== undefined) {
    importsByDigest.delete(digest);
    importsByDigest.set(digest, cached);
    return cached.imports;
  }
  const imports = ts
    .preProcessFile(new TextDecoder().decode(bytes), true, true)
    .importedFiles.map((entry) => entry.fileName);
  const maxSourceBytes = 16 * 1024 * 1024;
  if (bytes.byteLength > maxSourceBytes) return imports;
  while (importsByDigest.size >= 512 || retainedSourceBytes + bytes.byteLength > maxSourceBytes) {
    const oldest = importsByDigest.entries().next().value;
    if (oldest === undefined) break;
    importsByDigest.delete(oldest[0]);
    retainedSourceBytes -= oldest[1].size;
  }
  importsByDigest.set(digest, { imports, size: bytes.byteLength });
  retainedSourceBytes += bytes.byteLength;
  return imports;
}
