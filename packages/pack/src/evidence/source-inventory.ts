import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { SourceDeclarationEvidence } from '@forgeax/engine-types';
import { SCANNER_BLACKLIST, scan } from '../scanner.js';
import { projectScriptablePackMeta } from '../scriptable-pack.js';
import { loadScriptablePack } from '../scriptable-pack-node.js';

/** Project root and GUID used to locate an authoritative source declaration. */
export interface SourceInventoryRequest {
  readonly projectRoot: string;
  readonly guid: string;
}

export interface ProducerSemanticIdentityInput {
  readonly producerRoot: string;
  readonly sourcePath: string;
  readonly sourceDigest: string;
  readonly schemaVersion: string;
  readonly importer: string;
  readonly codec: string;
  readonly settings: unknown;
  readonly producer: string;
  readonly profile: string;
  readonly declaredGuids?: readonly string[];
}

export interface ProducerRelativeDdcIdentity {
  readonly logicalPath: string;
  readonly sourceDigest: string;
  readonly key: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function producerRelativeLogicalPath(producerRoot: string, sourcePath: string): string {
  const root = resolve(producerRoot);
  const source = resolve(sourcePath);
  const path = relative(root, source);
  if (
    path.length === 0 ||
    path === '..' ||
    path.startsWith(`..${sep}`) ||
    resolve(root, path) !== source
  ) {
    throw new Error('producer source must be inside the injected producer root');
  }
  return path.split(sep).join('/');
}

export function producerRelativeDdcKey(input: ProducerSemanticIdentityInput): string {
  const logicalPath = producerRelativeLogicalPath(input.producerRoot, input.sourcePath);
  const semantic = {
    schemaVersion: input.schemaVersion,
    logicalPath,
    sourceDigest: input.sourceDigest,
    importer: input.importer,
    codec: input.codec,
    settings: stableValue(input.settings),
    producer: input.producer,
    profile: input.profile,
    declaredGuids: [...(input.declaredGuids ?? [])].sort(),
  };
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
}

export function producerRelativeDdcIdentity(
  input: ProducerSemanticIdentityInput,
): ProducerRelativeDdcIdentity {
  return {
    logicalPath: producerRelativeLogicalPath(input.producerRoot, input.sourcePath),
    sourceDigest: input.sourceDigest,
    key: producerRelativeDdcKey(input),
  };
}

function fingerprint(meta: string, source: Uint8Array | undefined): string {
  const hash = createHash('sha256').update(meta);
  if (source !== undefined) hash.update(source);
  return hash.digest('base64');
}

function sourceFromMeta(
  metaPath: string,
  meta: {
    readonly source?: unknown;
    readonly inputFingerprint?: unknown;
    readonly importSettings?: unknown;
    readonly subAssets?: readonly { readonly guid?: unknown }[];
  },
  guid: string,
  raw: string,
): SourceDeclarationEvidence | undefined {
  if (
    !meta.subAssets?.some(
      (asset) => typeof asset.guid === 'string' && asset.guid.toLowerCase() === guid.toLowerCase(),
    )
  ) {
    return undefined;
  }
  const source =
    typeof meta.source === 'string' ? meta.source : basename(metaPath).replace(/\.meta\.json$/, '');
  const sourcePath = resolve(dirname(metaPath), source);
  const inputFingerprint =
    typeof meta.inputFingerprint === 'string' ? meta.inputFingerprint : fingerprint(raw, undefined);
  return { origin: 'sourceMeta', sourcePath, inputFingerprint };
}

async function collectDeclarationPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCANNER_BLACKLIST.has(entry.name)) await visit(path);
        continue;
      }
      if (
        entry.isFile() &&
        (entry.name.endsWith('.meta.json') ||
          entry.name.endsWith('.pack.json') ||
          entry.name.endsWith('.pack.ts'))
      ) {
        paths.push(path);
      }
    }
  }
  await visit(root);
  return paths;
}

/** Read `.meta.json` or `.pack.json` source declarations without runtime imports. */
export async function readSourceInventory(
  request: SourceInventoryRequest,
): Promise<SourceDeclarationEvidence | undefined> {
  const result = await scan([request.projectRoot]);
  const paths = result.ok ? result.value : await collectDeclarationPaths(request.projectRoot);
  const guid = request.guid.toLowerCase();
  let authored: SourceDeclarationEvidence | undefined;
  for (const path of paths) {
    if (path.endsWith('.pack.ts')) {
      const loaded = await loadScriptablePack(path, { metadataOnly: true });
      if (!loaded.ok) continue;
      const meta = projectScriptablePackMeta(loaded.value, path);
      if (meta.subAssets.some((asset) => asset.guid.toLowerCase() === guid)) {
        return { origin: 'sourceMeta', sourcePath: path };
      }
      continue;
    }
    const raw = await readFile(path, 'utf8').catch(() => undefined);
    if (raw === undefined) continue;
    let parsed: {
      readonly assets?: readonly { readonly guid?: unknown }[];
      readonly source?: unknown;
      readonly inputFingerprint?: unknown;
      readonly importSettings?: unknown;
      readonly subAssets?: readonly { readonly guid?: unknown }[];
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      continue;
    }
    if (path.endsWith('.pack.json')) {
      if (
        parsed.assets?.some(
          (asset) =>
            typeof asset.guid === 'string' &&
            (asset.guid === request.guid || asset.guid.toLowerCase() === guid),
        )
      ) {
        authored = { origin: 'authoredPack', sourcePath: path };
      }
      continue;
    }
    if (path.endsWith('.meta.json')) {
      const source = sourceFromMeta(path, parsed, request.guid, raw);
      if (source !== undefined) return source;
    }
  }
  return authored;
}
