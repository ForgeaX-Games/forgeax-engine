import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { SourceDeclarationEvidence } from '@forgeax/engine-types';
import { SCANNER_BLACKLIST, scan } from '../scanner.js';

/** Project root and GUID used to locate an authoritative source declaration. */
export interface SourceInventoryRequest {
  readonly projectRoot: string;
  readonly guid: string;
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
        (entry.name.endsWith('.meta.json') || entry.name.endsWith('.pack.json'))
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
    const raw = await readFile(path, 'utf8').catch(() => undefined);
    if (raw === undefined) continue;
    const parsed = JSON.parse(raw) as {
      readonly assets?: readonly { readonly guid?: unknown }[];
      readonly source?: unknown;
      readonly inputFingerprint?: unknown;
      readonly importSettings?: unknown;
      readonly subAssets?: readonly { readonly guid?: unknown }[];
    };
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
