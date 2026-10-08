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
//   - local clone divergence                    -> warn and skip by default;
//     FORGEAX_HARNESS_STRICT=1 opts into a loud exit 1 for maintenance/CI
//     callers that require a reconciled clone.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { shareHarness } from './lib/shared-harness.mjs';

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

const sparseDocs = process.env.FORGEAX_HARNESS_SPARSE_DOCS === '1';
const sparseDocsPaths = process.env.FORGEAX_HARNESS_SPARSE_DOCS_PATHS;
const strictDivergence = process.env.FORGEAX_HARNESS_STRICT === '1';

try {
  if (!sparseDocs && shareHarness(root)) {
    process.stdout.write('[harness:sync] shared primary .forgeax-harness (no clone)\n');
    if (!strictDivergence) process.exit(0);
  }
} catch (error) {
  warnExit0(`cannot mount the primary Harness: ${error.message}`);
}
const token = resolveToken();

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
    // Routine sync keeps capture/dataset pointers; hydrate an explicit path
    // later with git lfs pull instead of downloading every historical payload.
    env: { ...process.env, ...extraEnv, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
  });
}

function warnExit0(msg) {
  process.stderr.write(`[harness:sync] warning: ${msg} — continuing\n`);
  process.exit(0);
}

function failLoud(msg) {
  process.stderr.write(`[harness:sync] FORGEAX_HARNESS_DIVERGED: ${msg}\n`);
  process.exit(1);
}

function materializeSparseDocs(commit) {
  if (sparseDocsPaths === undefined) return;
  if (!sparseDocs) {
    failLoud('FORGEAX_HARNESS_SPARSE_DOCS_PATHS requires FORGEAX_HARNESS_SPARSE_DOCS=1');
  }

  let paths;
  try {
    paths = JSON.parse(sparseDocsPaths);
  } catch {
    failLoud('FORGEAX_HARNESS_SPARSE_DOCS_PATHS must be a JSON array');
  }
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.some(
      (path) =>
        typeof path !== 'string' ||
        !path.startsWith('docs/') ||
        path.includes('\\') ||
        path.split('/').some((part) => part === '' || part === '.' || part === '..'),
    )
  ) {
    failLoud('FORGEAX_HARNESS_SPARSE_DOCS_PATHS must contain safe docs-relative paths');
  }

  const harnessRoot = resolve(DIR);
  const harnessPrefix = `${harnessRoot}${sep}`;
  for (const path of paths) {
    const blob = git(['show', `${commit}:${path}`], { cwd: DIR, maxBuffer: 16 * 1024 * 1024 });
    if (blob.status !== 0) {
      warnExit0(
        `requested documentation blob is unavailable at ${commit}:${path}: ${(blob.stderr || '').trim()}`,
      );
    }
    const destination = resolve(DIR, path);
    if (!destination.startsWith(harnessPrefix)) {
      failLoud(`sparse documentation path escapes the harness checkout: ${path}`);
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, blob.stdout, 'utf8');
  }
  process.stdout.write(
    `[harness:sync] materialized ${paths.length} requested documentation file(s)\n`,
  );
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
    // Git checks out before a later sparse-checkout command; skip that first
    // checkout so Windows never materializes an invalid harness path.
    ...(sparseDocs ? ['--filter=blob:none', '--sparse', '--no-checkout'] : []),
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
  if (sparseDocs && sparseDocsPaths === undefined) {
    const sparse = git(['sparse-checkout', 'set', 'docs'], { cwd: DIR });
    if (sparse.status !== 0) {
      warnExit0(
        `sparse docs checkout failed; .forgeax-harness not fully materialised:\n${(sparse.stderr || '').trim()}`,
      );
    }
    const checkout = git(['read-tree', '-mu', 'HEAD'], { cwd: DIR });
    if (checkout.status !== 0) {
      warnExit0(
        `sparse docs checkout failed; .forgeax-harness not fully materialised:\n${(checkout.stderr || '').trim()}`,
      );
    }
  }
  materializeSparseDocs('HEAD');
  process.stdout.write('[harness:sync] cloned forgeax-engine-harness\n');
  process.exit(0);
}

// Existing clone: fast-forward to origin/main while keeping managed shallow
// clones at one commit. Never clobber local divergence; legacy full clones are
// preserved because they may carry local branches or loop-state history.
const fetch = git(['fetch', '--quiet', '--depth=1', 'origin', 'main'], { cwd: DIR });
if (fetch.status !== 0) {
  warnExit0(
    `fetch failed (offline?); leaving .forgeax-harness as-is:\n${(fetch.stderr || '').trim()}`,
  );
}

if (sparseDocsPaths !== undefined) {
  materializeSparseDocs('FETCH_HEAD');
  process.stdout.write('[harness:sync] refreshed requested documentation from origin/main\n');
  process.exit(0);
}

const ff = git(['merge', '--ff-only', 'origin/main'], { cwd: DIR });
if (ff.status === 0) {
  materializeSparseDocs('HEAD');
  process.stdout.write('[harness:sync] fast-forwarded .forgeax-harness to origin/main\n');
  process.exit(0);
}

// ff-only refused. Distinguish "local has un-pushed commits" (loud, real risk)
// from a transient/no-op state (graceful).
const ahead = git(['rev-list', '--count', 'origin/main..HEAD'], { cwd: DIR });
const aheadN = Number.parseInt((ahead.stdout || '0').trim(), 10) || 0;
if (aheadN > 0) {
  const detail =
    `local .forgeax-harness has ${aheadN} commit(s) not on origin/main; ` +
    'leaving it untouched and skipping synchronization. Reconcile manually:\n' +
    '  git -C .forgeax-harness push   # or: git -C .forgeax-harness log origin/main..HEAD';
  if (strictDivergence) failLoud(`${detail}\n  (strict mode: FORGEAX_HARNESS_STRICT=1)`);
  warnExit0(
    `FORGEAX_HARNESS_DIVERGED: ${detail}\n` +
      'Set FORGEAX_HARNESS_STRICT=1 to make divergence fatal.',
  );
}
warnExit0(
  `ff-only no-op (already up to date or detached); leaving as-is:\n${(ff.stderr || '').trim()}`,
);
