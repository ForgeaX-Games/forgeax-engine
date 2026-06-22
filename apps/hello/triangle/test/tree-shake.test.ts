// hello-triangle tree-shake test (feat-20260615-debug-draw M4 / w27)
//
// Proves AC-12: production build of @forgeax/hello-triangle (which does NOT
// import @forgeax/engine-debug-draw) contains zero 'DebugDraw' literals in
// the dist JS bundle.
//
// Precondition: `pnpm -F @forgeax/hello-triangle build` must have been run.

import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const TRIANGLE_DIR = new URL('..', import.meta.url).pathname;

describe('w27: tree-shake (AC-12)', () => {
  it('hello-triangle dist contains zero DebugDraw symbols when not imported', () => {
    // Verify the source does not import debug-draw
    try {
      const r = execSync('grep -rl "engine-debug-draw" src/ 2>/dev/null || true', {
        cwd: TRIANGLE_DIR,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      if (r.trim()) {
        throw new Error(
          `hello-triangle imports @forgeax/engine-debug-draw in: ${r.trim()}. ` +
            'This violates AC-12 precondition.',
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('imports @forgeax/engine-debug-draw')) {
        throw err;
      }
      throw new Error(`grep error: ${String(err)}`);
    }

    // Grep the built dist for 'DebugDraw' symbols
    try {
      const r = execSync('grep -rl "DebugDraw" dist/ 2>/dev/null || true', {
        cwd: TRIANGLE_DIR,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      if (r.trim()) {
        throw new Error(
          `Tree-shake FAILED: 'DebugDraw' found in files:\n${r.trim()}\n\n` +
            'AC-12: debug-draw symbols must be tree-shaken from bundles that do not import them.',
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('Tree-shake FAILED')) {
        throw err;
      }
      throw new Error(`grep on dist/ failed: ${String(err)}`);
    }
  });
});