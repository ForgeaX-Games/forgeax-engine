// gltf-error-migration.test.ts - M1 grep gate for GltfErrorCode migration.
//
// TDD red-green: written BEFORE migration (t6/t7/t8). Three grep assertions
// guard the DIP boundary: types must have zero gltf- literals, types must
// have zero GltfError* exports, and gltf/errors.ts must have >=1 GltfError*
// export. These are RED on first run (types still has GltfError*); they go
// GREEN after t6/t7/t8 complete the migration.
//
// Anchors:
// - requirements AC-28 (types grep GltfError = 0 hits)
// - requirements AC-27 (DIP three grep gates)
// - plan-strategy section 5.3 (DIP grep gate AC-27/AC-28)
// - charter P3 (explicit failure: grep gate fails-fast on drift)

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..', '..', '..', '..');
const TYPES_INDEX = resolve(REPO_ROOT, 'packages', 'types', 'src', 'index.ts');
const GLTF_ERRORS = resolve(REPO_ROOT, 'packages', 'gltf', 'src', 'errors.ts');

function grepCount(pattern: string, file: string): number {
  try {
    const out = execFileSync('rg', ['--count', '--regexp', pattern, file], { encoding: 'utf-8' });
    return Number.parseInt(out.trim(), 10);
  } catch (cause: unknown) {
    if ((cause as { status?: number }).status === 1) return 0;
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        const out = execFileSync('grep', ['-E', '-c', pattern, file], { encoding: 'utf-8' });
        return Number.parseInt(out.trim(), 10);
      } catch (fallbackCause: unknown) {
        if ((fallbackCause as { status?: number }).status === 1) return 0;
        throw fallbackCause;
      }
    }
    throw cause;
  }
}

function grepCountImportGltfErrorFromTypes(): number {
  try {
    const out = execFileSync(
      'rg',
      [
        '--files-with-matches',
        '--glob',
        '*.ts',
        '--glob',
        '!**/node_modules/**',
        '--glob',
        '!**/dist/**',
        '--glob',
        '!**/gltf-error-migration.test.ts',
        '--regexp',
        'import.*GltfError.*from.*@forgeax/engine-types',
        resolve(REPO_ROOT, 'packages'),
        resolve(REPO_ROOT, 'apps'),
      ],
      { encoding: 'utf-8' },
    );
    return out.trim().split('\n').filter(Boolean).length;
  } catch (cause: unknown) {
    if ((cause as { status?: number }).status === 1) return 0;
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        const out = execFileSync(
          'grep',
          [
            '-R',
            '-l',
            '-E',
            '--include=*.ts',
            '--exclude-dir=node_modules',
            '--exclude-dir=dist',
            'import.*GltfError.*from.*@forgeax/engine-types',
            resolve(REPO_ROOT, 'packages'),
            resolve(REPO_ROOT, 'apps'),
          ],
          { encoding: 'utf-8' },
        );
        return out
          .trim()
          .split('\n')
          .filter(
            (file) =>
              file && !file.endsWith('/packages/gltf/src/__tests__/gltf-error-migration.test.ts'),
          ).length;
      } catch (fallbackCause: unknown) {
        if ((fallbackCause as { status?: number }).status === 1) return 0;
        throw fallbackCause;
      }
    }
    throw cause;
  }
}

describe('M1 GltfErrorCode migration grep gate (AC-28)', () => {
  it("(a) types/src/index.ts contains zero 'gltf-' string literals", () => {
    const count = grepCount("'gltf-", TYPES_INDEX);
    expect(count).toBe(0);
  });

  it('(b) types/src/index.ts contains zero export type GltfError* exports', () => {
    const count = grepCount('export type GltfError', TYPES_INDEX);
    expect(count).toBe(0);
  });

  it('(c) gltf/errors.ts contains >=1 export type GltfError* exports', () => {
    const count = grepCount('export type GltfError', GLTF_ERRORS);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('(d) zero import GltfError from @forgeax/engine-types in all packages/apps', () => {
    const count = grepCountImportGltfErrorFromTypes();
    expect(count).toBe(0);
  });
});
