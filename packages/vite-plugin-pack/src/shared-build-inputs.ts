import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadAssetConfig } from '@forgeax/engine-pack/config';
import type { PackIndexEntry } from '@forgeax/engine-types';
import { type SemanticDdcInput, semanticDdcKey } from './ddc-cache.js';

export interface PackBuildInputOptions {
  readonly roots?: readonly string[] | undefined;
  readonly base?: string | undefined;
}

export const SHARED_ASSET_PACK_CLASS = 'shared-asset-pack';
export const SHARED_ASSET_PACK_CATALOG = 'shared-app-inputs/assets/catalog.json';

export function sharedSemanticDdcKey(input: SemanticDdcInput): string {
  return semanticDdcKey(input);
}

function normalizeBasePrefix(base: string | undefined): string {
  return (base ?? '/').replace(/\/$/, '');
}

/**
 * App-neutral pack inputs. The Vite plugin owns hook timing; this adapter owns
 * the configured source boundary and the app-local URL projection rule.
 */
export function resolvePackBuildInputs(options: PackBuildInputOptions): {
  readonly roots: readonly string[];
  readonly basePrefix: string;
} {
  const cwd = process.cwd();
  const roots =
    options.roots === undefined
      ? loadAssetConfig(cwd).roots
      : options.roots.map((root) => (resolve(root) === root ? root : join(cwd, root)));
  return { roots, basePrefix: normalizeBasePrefix(options.base) };
}

export function projectPackIndexUrl(basePrefix: string, packageUrl: string): string {
  return `${basePrefix}/${packageUrl.replace(/^\/+/, '')}`;
}

export function projectSharedPackCatalog(
  catalog: readonly PackIndexEntry[],
  base: string | undefined,
): PackIndexEntry[] {
  const basePrefix = normalizeBasePrefix(base);
  return catalog.map((entry) => ({
    ...entry,
    packageUrl: projectPackIndexUrl(basePrefix, entry.packageUrl.replace(/^\/+/, '')),
  }));
}

export function loadSharedPackInput(manifestPath: string): {
  readonly catalog: readonly PackIndexEntry[] | undefined;
  readonly payloadRoot: string | undefined;
} {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    readonly schemaVersion?: number;
    readonly producer?: string;
    readonly inventory?: readonly string[];
    readonly payload?: { readonly assetCatalog?: string; readonly assetPayloadRoot?: string };
  };
  const assetCatalog = manifest.payload?.assetCatalog;
  const assetPayloadRoot = manifest.payload?.assetPayloadRoot;
  const artifactRoot = dirname(manifestPath);
  const repositoryRoot = dirname(artifactRoot);
  if (manifest.schemaVersion === 2) {
    if (manifest.producer !== 'repo-build-inputs') {
      throw new Error(`shared build manifest has unexpected producer: ${manifestPath}`);
    }
    if (!Array.isArray(manifest.inventory)) {
      throw new Error(`shared build manifest lacks inventory: ${manifestPath}`);
    }
    for (const path of manifest.inventory) {
      if (!existsSync(resolve(repositoryRoot, path))) {
        throw new Error(`shared build manifest inventory is missing ${path}: ${manifestPath}`);
      }
    }
    if (assetCatalog !== undefined && !manifest.inventory.includes(assetCatalog)) {
      throw new Error(`shared build manifest omits declared asset catalog: ${manifestPath}`);
    }
    if (assetPayloadRoot !== undefined && !existsSync(resolve(repositoryRoot, assetPayloadRoot))) {
      throw new Error(`shared build manifest payload root is missing: ${manifestPath}`);
    }
  }
  return {
    catalog:
      assetCatalog === undefined
        ? undefined
        : (JSON.parse(
            readFileSync(resolve(repositoryRoot, assetCatalog), 'utf8'),
          ) as PackIndexEntry[]),
    payloadRoot:
      assetPayloadRoot === undefined ? undefined : resolve(repositoryRoot, assetPayloadRoot),
  };
}
