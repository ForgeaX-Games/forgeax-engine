import { dirname, posix, resolve } from 'node:path';
import type { Result } from '@forgeax/engine-types';
import { PACK_ERROR_HINTS, err as resultErr, ok as resultOk } from '@forgeax/engine-types';
import { PackError } from './errors.js';

function baseName(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function deriveSourceName(metaFileName: string): string {
  return metaFileName.replace(/\.meta\.json$/, '');
}

const PATH_REF_RE = /^@([^/]+)\/(.+)$/;

function isPathEscape(pathDir: string, resolved: string): boolean {
  const rel = posix.relative(pathDir, resolved);
  return rel.startsWith('..') || posix.isAbsolute(rel);
}

export function resolveAssetSource(
  metaPath: string,
  source: string | undefined,
  paths: Record<string, string>,
): Result<string, PackError> {
  if (source === undefined) {
    const metaDir = dirname(metaPath);
    const metaName = baseName(metaPath);
    const derived = deriveSourceName(metaName);
    return resultOk(resolve(metaDir, derived));
  }

  if (source.startsWith('@')) {
    const match = source.match(PATH_REF_RE);
    if (!match) {
      return resultErr(
        new PackError({
          code: 'pack-malformed-path-ref',
          expected: 'source in format @<name>/<rest>',
          hint: PACK_ERROR_HINTS['pack-malformed-path-ref'],
          detail: {
            code: 'pack-malformed-path-ref',
            reason: 'format',
            rawSource: source,
            expectedFormat: '@<name>/<rest>',
          },
        }),
      );
    }

    const [, name, rest] = match as [string, string, string];
    const pathDir = paths[name];

    if (pathDir === undefined) {
      return resultErr(
        new PackError({
          code: 'pack-unknown-path',
          expected: 'path name found in package.json#forgeax.assets.paths',
          hint: PACK_ERROR_HINTS['pack-unknown-path'],
          detail: {
            code: 'pack-unknown-path',
            pathName: name,
            knownNames: Object.keys(paths),
          },
        }),
      );
    }

    const resolved = resolve(pathDir, rest);

    if (isPathEscape(pathDir, resolved)) {
      return resultErr(
        new PackError({
          code: 'pack-malformed-path-ref',
          expected: 'rest path must not escape the declared path directory',
          hint: PACK_ERROR_HINTS['pack-malformed-path-ref'],
          detail: {
            code: 'pack-malformed-path-ref',
            reason: 'escape',
            rawSource: source,
            expectedFormat: '@<name>/<rest>',
          },
        }),
      );
    }

    return resultOk(resolved);
  }

  return resultOk(resolve(dirname(metaPath), source));
}
