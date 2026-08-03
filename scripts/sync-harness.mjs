#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
// sync-harness.mjs — materialise the .forgeax-harness floating clone.
//
// .forgeax-harness is a standalone clone of forgeax-engine-harness, nested at
// <engine>/.forgeax-harness/ but gitignored + untracked by the engine (NOT a
// submodule as of 2026-06-06 — see
// docs/specs/2026-06-06-harness-desubmodule-floating-clone-design.md). This
// script clones it on first run and fast-forwards it on later runs, so fresh
// checkouts + CI get the harness without `git submodule`.
//
// Wired to `postinstall`; also runnable as `pnpm harness:sync`.
//
// Failure policy:
//   - FORGEAX_SKIP_HARNESS_SYNC set        -> exit 0 (engine build/test do not
//     need the harness; CI opts in only where required).
//   - offline / clone or fetch unreachable -> warn, exit 0 (graceful: a missing
//     harness must not break `pnpm install`).
//   - LOUD failure (exit 1) ONLY when a local clone has diverged from origin and
//     `pull --ff-only` would lose un-pushed loop state.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const DIR = resolve(root, '.forgeax-harness');
const REPO = 'https://github.com/ForgeaX-Games/forgeax-engine-harness.git';

function resolveToken() {
  const configured =
    process.env.FORGEAX_HARNESS_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (configured) return configured;

  // Local developers commonly authenticate through gh instead of exporting a
  // token. Keep that path optional so public/offline installs remain usable.
  const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  return gh.status === 0 ? gh.stdout.trim() || undefined : undefined;
}

if (existsSync(resolve(root, '.forgeax-public-distribution'))) {
  process.stdout.write('[harness:sync] public distribution — skipped\n');
  process.exit(0);
}

if (process.env.FORGEAX_SKIP_HARNESS_SYNC) {
  process.stdout.write('[harness:sync] FORGEAX_SKIP_HARNESS_SYNC set — skipped\n');
  process.exit(0);
}

const token = resolveToken();
const sparseDocs = process.env.FORGEAX_HARNESS_SPARSE_DOCS === '1';

function git(args, opts = {}) {
  // Git 2.34 on the self-hosted runner does not honor GIT_CONFIG_COUNT for
  // extra headers; scope the token to each Git invocation instead.
  const authArgs = token
    ? [
        '-c',
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
        ...args,
      ]
    : args;
  const { env: extraEnv, ...spawnOpts } = opts;
  return spawnSync('git', authArgs, {
    ...spawnOpts,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
}

function warnExit0(msg) {
  process.stdout.write(`[harness:sync] ${msg} — continuing\n`);
  process.exit(0);
}

function failLoud(msg) {
  process.stderr.write(`[harness:sync] FORGEAX_HARNESS_DIVERGED: ${msg}\n`);
  process.exit(1);
}

if (!existsSync(resolve(DIR, '.git'))) {
  // First run (or a fresh checkout): only the current main tree is needed.
  // Avoid transferring the harness history and tags: CI materializes docs,
  // while later syncs already advance the shallow clone with a normal fetch.
  // Offline → graceful skip.
  const cloneArgs = [
    'clone',
    '--quiet',
    '--depth=1',
    '--no-tags',
    '--single-branch',
    ...(sparseDocs ? ['--filter=blob:none', '--sparse'] : []),
    REPO,
    DIR,
  ];
  const r = git(cloneArgs, {
    cwd: root,
  });
  if (r.status !== 0) {
    warnExit0(
      `clone failed (offline?); .forgeax-harness not materialised:\n${(r.stderr || '').trim()}`,
    );
  }
  if (sparseDocs) {
    const sparse = git(['sparse-checkout', 'set', 'docs'], { cwd: DIR });
    if (sparse.status !== 0) {
      warnExit0(
        `sparse docs checkout failed; .forgeax-harness not fully materialised:\n${(sparse.stderr || '').trim()}`,
      );
    }
  }
  process.stdout.write('[harness:sync] cloned forgeax-engine-harness\n');
  process.exit(0);
}

// Existing clone: fast-forward to origin/main. Never clobber local divergence.
const fetch = git(['fetch', '--quiet', 'origin', 'main'], { cwd: DIR });
if (fetch.status !== 0) {
  warnExit0(
    `fetch failed (offline?); leaving .forgeax-harness as-is:\n${(fetch.stderr || '').trim()}`,
  );
}

const ff = git(['merge', '--ff-only', 'origin/main'], { cwd: DIR });
if (ff.status === 0) {
  process.stdout.write('[harness:sync] fast-forwarded .forgeax-harness to origin/main\n');
  process.exit(0);
}

// ff-only refused. Distinguish "local has un-pushed commits" (loud, real risk)
// from a transient/no-op state (graceful).
const ahead = git(['rev-list', '--count', 'origin/main..HEAD'], { cwd: DIR });
const aheadN = Number.parseInt((ahead.stdout || '0').trim(), 10) || 0;
if (aheadN > 0) {
  failLoud(
    `local .forgeax-harness has ${aheadN} commit(s) not on origin/main; ` +
      'refusing to fast-forward (would not lose them, but the tree has ' +
      'diverged). Push or reconcile manually:\n' +
      '  git -C .forgeax-harness push   # or: git -C .forgeax-harness log origin/main..HEAD',
  );
}
warnExit0(
  `ff-only no-op (already up to date or detached); leaving as-is:\n${(ff.stderr || '').trim()}`,
);
