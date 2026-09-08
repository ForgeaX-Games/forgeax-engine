// hello-triangle tree-shake test (feat-20260615-debug-draw M4 / w27)
//
// Proves AC-12: production build of @forgeax/hello-triangle (which does NOT
// import @forgeax/engine-debug-draw) contains zero 'DebugDraw' literals in
// the dist JS bundle.
//
// Precondition: `pnpm -F @forgeax/hello-triangle build` must have been run.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const TRIANGLE_DIR = new URL('..', import.meta.url).pathname;

function filesContaining(root: string, needle: string): string[] {
  const matches: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && readFileSync(path, 'utf8').includes(needle)) {
        matches.push(relative(root, path));
      }
    }
  };
  visit(root);
  return matches;
}

describe('w27: tree-shake (AC-12)', () => {
  it('hello-triangle dist contains zero DebugDraw symbols when not imported', () => {
    const sourceMatches = filesContaining(join(TRIANGLE_DIR, 'src'), 'engine-debug-draw');
    if (sourceMatches.length > 0) {
      throw new Error(
        `hello-triangle imports @forgeax/engine-debug-draw in: ${sourceMatches.join(', ')}. ` +
          'This violates AC-12 precondition.',
      );
    }

    const distMatches = filesContaining(join(TRIANGLE_DIR, 'dist'), 'DebugDraw');
    if (distMatches.length > 0) {
      throw new Error(
        `Tree-shake FAILED: 'DebugDraw' found in files:\n${distMatches.join('\n')}\n\n` +
          'AC-12: debug-draw symbols must be tree-shaken from bundles that do not import them.',
      );
    }
  });
});
