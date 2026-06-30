#!/usr/bin/env node
// pre-commit guard: if either pnpm-lock.yaml or bun.lock is staged, the other
// MUST also be staged (K-5 dual-lockfile invariant). Exits 1 with a message if
// only one is staged. ≤ 30 LOC, no npm deps. Companion to check-workspaces-equivalence.mjs.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const r = spawnSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' });
if (r.status !== 0) {
  process.stderr.write(`git diff --cached failed: ${r.stderr}\n`);
  process.exit(r.status ?? 1);
}
const staged = new Set(r.stdout.split(/\r?\n/).filter(Boolean));
const pnpmStaged = staged.has('pnpm-lock.yaml');
const bunStaged = staged.has('bun.lock');
if (pnpmStaged !== bunStaged) {
  const which = pnpmStaged
    ? 'pnpm-lock.yaml is staged but bun.lock is NOT'
    : 'bun.lock is staged but pnpm-lock.yaml is NOT';
  process.stderr.write(`[pre-commit] dual-lockfile drift: ${which}.\n`);
  process.stderr.write('[pre-commit] run `pnpm run sync` then stage both lockfiles together.\n');
  process.exit(1);
}
process.exit(0);
