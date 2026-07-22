import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadAssetConfig } from '@forgeax/engine-pack/config';
import type { PackIndexEntry } from '@forgeax/engine-types';

export interface PackBuildInputOptions {
  readonly roots?: readonly string[] | undefined;
  readonly base?: string | undefined;
}

export const SHARED_ASSET_PACK_CLASS = 'shared-asset-pack';
export const SHARED_ASSET_PACK_CATALOG = 'shared-app-inputs/assets/catalog.json';

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

export function projectPackIndexUrl(basePrefix: string, relativeUrl: string): string {
  return `${basePrefix}/${relativeUrl.replace(/^\/+/, '')}`;
}

export function projectSharedPackCatalog(
  catalog: readonly PackIndexEntry[],
  base: string | undefined,
): PackIndexEntry[] {
  const basePrefix = normalizeBasePrefix(base);
  return catalog.map((entry) => ({
    ...entry,
    relativeUrl: projectPackIndexUrl(basePrefix, entry.relativeUrl.replace(/^\/+/, '')),
  }));
}

export function loadSharedPackInput(manifestPath: string): {
  readonly catalog: readonly PackIndexEntry[];
  readonly payloadRoot: string | undefined;
} {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    readonly payload?: { readonly assetCatalog?: string; readonly assetPayloadRoot?: string };
  };
  const assetCatalog = manifest.payload?.assetCatalog;
  const assetPayloadRoot = manifest.payload?.assetPayloadRoot;
  if (assetCatalog === undefined) {
    throw new Error(`shared pack manifest lacks asset catalog: ${manifestPath}`);
  }
  const artifactRoot = dirname(manifestPath);
  const repositoryRoot = dirname(artifactRoot);
  return {
    catalog: JSON.parse(
      readFileSync(resolve(repositoryRoot, assetCatalog), 'utf8'),
    ) as PackIndexEntry[],
    payloadRoot:
      assetPayloadRoot === undefined ? undefined : resolve(repositoryRoot, assetPayloadRoot),
  };
}
