import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LoadAssetConfigResult {
  readonly roots: readonly string[];
  readonly paths: Record<string, string>;
}

export function loadAssetConfig(cwd: string): LoadAssetConfigResult {
  let pkg: { forgeax?: { assets?: { roots?: unknown; paths?: unknown } } };
  try {
    pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
  } catch {
    return { roots: [join(cwd, 'assets')], paths: {} };
  }

  const assets = pkg.forgeax?.assets;

  const rawRoots = assets?.roots;
  const roots: readonly string[] =
    Array.isArray(rawRoots) && rawRoots.length > 0
      ? (rawRoots as string[]).map((r) => join(cwd, r))
      : [join(cwd, 'assets')];

  const rawPaths = assets?.paths;
  const paths: Record<string, string> = {};
  if (rawPaths !== undefined && rawPaths !== null && typeof rawPaths === 'object') {
    for (const [name, dir] of Object.entries(rawPaths as Record<string, unknown>)) {
      if (typeof dir === 'string') {
        paths[name] = join(cwd, dir);
      }
    }
  }

  return { roots, paths };
}
