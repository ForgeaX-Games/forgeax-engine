#!/usr/bin/env node
// pre-commit guard: if either pnpm-lock.yaml or bun.lock is staged, the other
// MUST also be staged (K-5 dual-lockfile invariant). Merge commits compare the
// index with both parents because one lock can equal first-parent HEAD while
// still carrying the other parent's lockfile closure.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const runGit = (args) => spawnSync('git', args, { encoding: 'utf8' });
const r = runGit(['diff', '--cached', '--name-only']);
if (r.status !== 0) {
  process.stderr.write(`git diff --cached failed: ${r.stderr}\n`);
  process.exit(r.status ?? 1);
}
const staged = new Set(r.stdout.split(/\r?\n/).filter(Boolean));
const pnpmStaged = staged.has('pnpm-lock.yaml');
const bunStaged = staged.has('bun.lock');
if (pnpmStaged !== bunStaged) {
  let pnpmCovered = pnpmStaged;
  let bunCovered = bunStaged;
  const mergeHead = runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (mergeHead.status === 0) {
    const mergeDiff = runGit([
      'diff',
      '--cached',
      '--name-only',
      'MERGE_HEAD',
      '--',
      'pnpm-lock.yaml',
      'bun.lock',
    ]);
    if (mergeDiff.status === 0) {
      const changedAgainstMergeParent = new Set(mergeDiff.stdout.split(/\r?\n/).filter(Boolean));
      pnpmCovered ||= changedAgainstMergeParent.has('pnpm-lock.yaml');
      bunCovered ||= changedAgainstMergeParent.has('bun.lock');
    }
  }
  if (pnpmCovered && bunCovered) process.exit(0);
  const which = pnpmStaged
    ? 'pnpm-lock.yaml is staged but bun.lock is NOT'
    : 'bun.lock is staged but pnpm-lock.yaml is NOT';
  process.stderr.write(`[pre-commit] dual-lockfile drift: ${which}.\n`);
  process.stderr.write('[pre-commit] run `pnpm run sync` then stage both lockfiles together.\n');
  process.exit(1);
}
process.exit(0);
