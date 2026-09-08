import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const preflight = resolve(import.meta.dirname, '..', 'typecheck-output-preflight.mjs');

test('retries a failed cold declaration build only after the missing inventory shrinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-types-preflight-'));
  const bin = join(root, 'bin');
  const state = join(root, 'invocations');
  try {
    for (const name of ['alpha', 'beta']) {
      const src = join(root, 'packages', name, 'src');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'index.ts'), `export const ${name} = true;\n`);
      writeFileSync(
        join(root, 'packages', name, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { declaration: true, outDir: 'dist' } }),
      );
    }
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'pnpm'),
      `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const state = process.env.FORGEAX_PREFLIGHT_STATE;
const count = state && existsSync(state) ? Number(readFileSync(state, 'utf8')) : 0;
const next = count + 1;
if (state) writeFileSync(state, String(next));
if (next === 1) {
  const output = join(process.env.FORGEAX_REPO_ROOT, 'packages', 'alpha', 'dist', 'index.d.ts');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, 'export declare const alpha: true;\\n');
  process.exit(1);
}
const output = join(process.env.FORGEAX_REPO_ROOT, 'packages', 'beta', 'dist', 'index.d.ts');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, 'export declare const beta: true;\\n');
process.exit(0);
`,
    );
    chmodSync(join(bin, 'pnpm'), 0o755);

    const result = spawnSync(process.execPath, [preflight], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FORGEAX_REPO_ROOT: root,
        FORGEAX_PREFLIGHT_STATE: state,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(state, 'utf8'), '2');
    assert.ok(existsSync(join(root, 'packages', 'alpha', 'dist', 'index.d.ts')));
    assert.ok(existsSync(join(root, 'packages', 'beta', 'dist', 'index.d.ts')));
    assert.match(result.stderr, /cold build produced 1 declaration project\(s\); retrying/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
