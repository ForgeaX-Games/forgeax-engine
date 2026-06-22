// pod-ssot-grep.test.ts - M1 grep gate for sub-asset POD SSOT (AC-26).
//
// TDD red-green: written BEFORE POD types are defined (t9) and BEFORE gltf
// IR types are aligned (t10). Three grep assertions guard the SSOT boundary:
// (a) types/src/index.ts has >=7 export type/interface *Pod;
// (b) packages/gltf/src/ has zero export type *Pod (only imports);
// (c) packages/fbx/src/ has zero export type *Pod (if the src dir exists).
//
// Assertion (c) uses fs.existsSync: in M1 the fbx package only has a binding
// and no src/ subdirectory, so the check is skipped. In M2+, when fbx/src/
// is created, the check activates.
//
// Anchors:
// - requirements AC-26 (sub-asset POD shared SSOT grep >=7 hits)
// - plan-strategy section 3.1 (component map: types receives 7 sub-asset POD SSOT)
// - plan-strategy section 5.3 (AC-26 is a key test point)

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..', '..', '..', '..');
const TYPES_INDEX = resolve(REPO_ROOT, 'packages', 'types', 'src', 'index.ts');
const GLTF_SRC = resolve(REPO_ROOT, 'packages', 'gltf', 'src');
const FBX_SRC = resolve(REPO_ROOT, 'packages', 'fbx', 'src');

const POD_PATTERN =
  'export (type|interface) (Mesh|Material|Scene|Texture|Skeleton|Skin|AnimationClip)Pod';

function grepCount(pattern: string, fileOrDir: string): number {
  try {
    // -c gives per-file counts; sum them
    const out = execSync(`grep -rnE '${pattern}' ${fileOrDir} --include='*.ts'`, {
      encoding: 'utf-8',
    });
    return out.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

describe('M1 sub-asset POD SSOT grep gate (AC-26)', () => {
  it('(a) types/src/index.ts has >=7 export type *Pod definitions', () => {
    const count = grepCount(POD_PATTERN, TYPES_INDEX);
    expect(count).toBeGreaterThanOrEqual(7);
  });

  it('(b) packages/gltf/src/ has zero export type *Pod (only imports)', () => {
    const count = grepCount(POD_PATTERN, GLTF_SRC);
    expect(count).toBe(0);
  });

  it('(c) packages/fbx/src/ has zero export type *Pod (if src dir exists)', () => {
    if (existsSync(FBX_SRC)) {
      const count = grepCount(POD_PATTERN, FBX_SRC);
      expect(count).toBe(0);
    }
    // If fbx/src/ does not exist (M1 state), test is trivially satisfied.
  });
});
