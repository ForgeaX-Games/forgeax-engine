#!/usr/bin/env bun
// ForgeaX Engine developer command entry.
//
// Usage:
//   bun fx <command> [args...]
//
// Commands:
//   setup                 First-time bootstrap: init submodules + install deps
//   update [--dry-run]    Pull root, update submodules, fast-forward the harness
//   clean  [--deep|-x]    Restore a fully-clean git status (keeps .forgeax-harness)
//   help                  Show this text
//
// This is the FIRST bun + TypeScript dev script in the engine (every other
// script under scripts/ is a node .mjs). Accepted exception: fx is
// developer-facing orchestration where studio parity + typed, unit-tested
// command routing earn the bun dependency. Keep it importable under plain Node
// for unit tests: no top-level side effects (guarded main() at the bottom) and
// no runtime Bun.* calls (use node:* + process.execPath; bun types are
// type-only and erased at compile time).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The harness floating clone is never a submodule and must never be deleted by
// clean; it holds unpushed closed-loop state. Also whitelisted from orphan scan.
const HARNESS_DIR = '.forgeax-harness';

// ── types ────────────────────────────────────────────────────────────────────

type InternalPlan = { type: 'internal'; command: string; args: string[] };
type UnknownPlan = { type: 'unknown'; command: string; args: string[] };
export type CommandPlan = InternalPlan | UnknownPlan;

export type StepScope = 'root' | 'submodule' | 'harness' | 'orphan';
export type StepStatus = 'ok' | 'failed' | 'skipped' | 'planned';
export type StepResult = {
  scope: StepScope;
  name: string;
  result: StepStatus;
  detail?: string;
};

type RunGitOptions = { dryRun?: boolean; inherit?: boolean };

const BUILTIN_COMMANDS = new Set(['setup', 'update', 'clean', 'help', '--help', '-h']);

// ── pure helpers (exported, unit-tested) ─────────────────────────────────────

export function resolveCommand(argv: string[]): CommandPlan {
  const [cmd = 'help', ...args] = argv;
  if (BUILTIN_COMMANDS.has(cmd)) return { type: 'internal', command: cmd, args };
  return { type: 'unknown', command: cmd, args };
}

/** Parse `git config --file .gitmodules --get-regexp path` output. */
export function parseSubmodulePaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((p): p is string => Boolean(p));
}

export function submoduleUpdateArgs(path: string): string[] {
  return ['submodule', 'update', '--init', '--recursive', '--', path];
}

export function updateStashMessage(iso: string): string {
  return `forgeax pre-update ${iso}`;
}

export function updateShouldStash(args: string[]): boolean {
  return !args.includes('--no-stash');
}

export function didCreateStash(before: string, after: string): boolean {
  return after !== '' && after !== before;
}

export function stashPopArgsForRef(ref: string): string[] {
  return ['stash', 'pop', ref];
}

export type CleanFlags = {
  dryRun: boolean;
  deepRoot: boolean;
  rootCleanFlags: string;
  subForeachCmd: string;
};

export function cleanFlagsFor(args: string[]): CleanFlags {
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const deepRoot = args.includes('--deep') || args.includes('-x');
  return {
    dryRun,
    deepRoot,
    // Root stays conservative by default (keeps gitignored artefacts:
    // node_modules / dist / wasm). --deep/-x wipes those too.
    rootCleanFlags: deepRoot ? '-fdx' : '-fd',
    // Submodule interiors are always deep-cleaned; -ff descends into nested git
    // dirs (uninitialised nested submodules) instead of skipping them.
    subForeachCmd: dryRun
      ? 'git reset --hard -q && git clean -ffndx'
      : 'git reset --hard -q && git clean -ffdx',
  };
}

/**
 * Directories that look like leftover submodules: present on disk with their own
 * `.git`, but no longer declared in `.gitmodules`. `registeredDirs` is the set of
 * top-level entries that contain a `.git` marker; `declaredPaths` is the current
 * `.gitmodules` path set. Whitelisted names (harness, live submodules) are never
 * returned. Pure so the IO (readdir / .git probe) can be tested separately.
 */
export function findOrphanSubmoduleDirs(
  registeredDirs: string[],
  declaredPaths: string[],
  whitelist: string[],
): string[] {
  const declared = new Set(declaredPaths);
  const kept = new Set(whitelist);
  return registeredDirs.filter((dir) => !declared.has(dir) && !kept.has(dir)).sort();
}

/** Actionable hints derived from failed steps; empty when everything passed. */
export function troubleshootHints(results: StepResult[]): string[] {
  const hints: string[] = [];
  const failed = (scope: StepScope) =>
    results.some((r) => r.scope === scope && r.result === 'failed');
  if (failed('root')) {
    hints.push(
      'root update failed: your branch may have diverged from origin/main or hit a conflict. ' +
        'Inspect with `git status`; if a rebase is in progress run `git rebase --abort`, then retry `bun fx update`.',
    );
  }
  if (failed('submodule')) {
    hints.push(
      'submodule update failed: check network/access, then retry ' +
        '`git submodule update --init --recursive --force`.',
    );
  }
  if (failed('harness')) {
    hints.push(
      `${HARNESS_DIR} sync failed: it likely has unpushed commits (FORGEAX_HARNESS_DIVERGED). ` +
        `Push them (\`git -C ${HARNESS_DIR} push\`) or inspect (\`git -C ${HARNESS_DIR} log origin/main..HEAD\`).`,
    );
  }
  if (results.some((r) => r.scope === 'root' && r.name === 'stash-pop' && r.result === 'failed')) {
    hints.push(
      'stash restore failed: your changes are safe in the stash. ' +
        'Run `git stash list`, then `git stash pop` and resolve conflicts manually.',
    );
  }
  return hints;
}

// ── report table (ported from studio formatUpdateReport) ─────────────────────

function cleanTableCell(value: string): string {
  return value.replace(/\r?\n/g, ' ');
}

function colorResult(result: string): string {
  if (process.env.NO_COLOR) return result;
  if (result === 'OK') return `\x1b[32m${result}\x1b[0m`;
  if (result === 'FAILED') return `\x1b[31m${result}\x1b[0m`;
  return result;
}

export function formatStepReport(rows: StepResult[]): string {
  const tableRows = rows.map((row) => [
    row.result.toUpperCase(),
    row.scope,
    row.name,
    row.detail ?? '',
  ]);
  const header = ['RESULT', 'SCOPE', 'NAME', 'DETAIL'];
  const widths = header.map((title, i) =>
    Math.max(title.length, ...tableRows.map((row) => cleanTableCell(row[i] ?? '').length)),
  );
  const formatRow = (row: string[], color = false): string =>
    row
      .map((cell, i) => {
        const text = cleanTableCell(cell ?? '').padEnd(widths[i] ?? 0);
        return color && i === 0 ? colorResult(text) : text;
      })
      .join('  ')
      .trimEnd();
  return [
    formatRow(header),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...tableRows.map((row) => formatRow(row, true)),
  ].join('\n');
}

// ── impure helpers (spawn git / fs) ──────────────────────────────────────────

function runGit(args: string[], opts: RunGitOptions = {}): string {
  if (opts.dryRun) {
    console.log(`[dry-run] git ${args.join(' ')}`);
    return '';
  }
  return (
    execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: opts.inherit ? 'inherit' : 'pipe',
    })?.trim() ?? ''
  );
}

function gitOut(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function isDirty(): boolean {
  return gitOut(['status', '--porcelain']) !== '';
}

function stashTopOid(): string {
  return gitOut(['rev-parse', '--verify', 'stash@{0}']);
}

function submodulePaths(): string[] {
  return parseSubmodulePaths(gitOut(['config', '--file', '.gitmodules', '--get-regexp', 'path']));
}

/** Top-level directories that carry their own `.git` (nested repos/submodules). */
function nestedGitDirs(): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git') continue;
    if (existsSync(resolve(ROOT, name, '.git'))) out.push(name);
  }
  return out;
}

/** Orphan submodule dirs on disk (declared-in-.gitmodules + harness are kept). */
function listOrphanSubmoduleDirs(): string[] {
  return findOrphanSubmoduleDirs(nestedGitDirs(), submodulePaths(), [HARNESS_DIR]);
}

function runGitStep(
  scope: StepScope,
  name: string,
  args: string[],
  dryRun: boolean,
  okDetail: string,
): StepResult {
  if (dryRun) {
    console.log(`[dry-run] git ${args.join(' ')}`);
    return { scope, name, result: 'planned', detail: `git ${args.join(' ')}` };
  }
  console.log(`[fx] git ${args.join(' ')}`);
  const r = spawnSync('git', args, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) {
    return { scope, name, result: 'failed', detail: `cannot run git: ${r.error.message}` };
  }
  const status = r.status ?? 1;
  if (status === 0) return { scope, name, result: 'ok', detail: okDetail };
  return { scope, name, result: 'failed', detail: `git ${args.join(' ')} exited ${status}` };
}

function restoreStashResult(ref: string, dryRun: boolean): StepResult {
  const args = stashPopArgsForRef(ref);
  if (dryRun) {
    console.log(`[dry-run] git ${args.join(' ')}`);
    return { scope: 'root', name: 'stash-pop', result: 'planned', detail: `git ${args.join(' ')}` };
  }
  const r = spawnSync('git', args, { cwd: ROOT, stdio: 'inherit' });
  const status = r.status ?? 1;
  if (status === 0)
    return { scope: 'root', name: 'stash-pop', result: 'ok', detail: 'restored pre-update stash' };
  return {
    scope: 'root',
    name: 'stash-pop',
    result: 'failed',
    detail: `stash pop exited ${status}`,
  };
}

// Fast-forward .forgeax-harness through its SSOT script (scripts/sync-harness.mjs)
// rather than reimplementing the clone/ff/divergence logic. Direct node call
// matches how postinstall runs it and preserves its exit codes (0 offline/skip,
// 1 only on real divergence) so the report row is accurate.
function harnessSyncStep(dryRun: boolean): StepResult {
  const cmd = 'node scripts/sync-harness.mjs';
  if (dryRun) {
    console.log(`[dry-run] ${cmd}`);
    return { scope: 'harness', name: HARNESS_DIR, result: 'planned', detail: cmd };
  }
  console.log(`[fx] ${cmd}`);
  const r = spawnSync('node', ['scripts/sync-harness.mjs'], { cwd: ROOT, stdio: 'inherit' });
  if (r.error) {
    return {
      scope: 'harness',
      name: HARNESS_DIR,
      result: 'failed',
      detail: `cannot run node: ${r.error.message}`,
    };
  }
  const status = r.status ?? 1;
  if (status === 0)
    return {
      scope: 'harness',
      name: HARNESS_DIR,
      result: 'ok',
      detail: 'fast-forwarded / up to date',
    };
  return {
    scope: 'harness',
    name: HARNESS_DIR,
    result: 'failed',
    detail: `sync-harness exited ${status}`,
  };
}

// ── commands ─────────────────────────────────────────────────────────────────

function finish(results: StepResult[], hintScopes = false): never {
  console.log(`\n${formatStepReport(results)}`);
  if (hintScopes) {
    const hints = troubleshootHints(results);
    if (hints.length > 0) {
      console.error('\n[fx] hints:');
      for (const h of hints) console.error(`  - ${h}`);
    }
  }
  process.exit(results.some((r) => r.result === 'failed') ? 1 : 0);
}

// setup — first-time bootstrap. Idempotent; safe to re-run.
function setup(args: string[]): never {
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const results: StepResult[] = [];
  console.log('[fx] setup: initialising submodules + installing dependencies');

  results.push(
    runGitStep(
      'submodule',
      '(all)',
      ['submodule', 'update', '--init', '--recursive'],
      dryRun,
      'submodules initialised',
    ),
  );

  // pnpm install runs postinstall (scripts/sync-harness.mjs) which materialises
  // .forgeax-harness, honouring FORGEAX_SKIP_HARNESS_SYNC.
  if (dryRun) {
    console.log('[dry-run] pnpm install');
    results.push({ scope: 'root', name: '.', result: 'planned', detail: 'pnpm install' });
  } else {
    console.log('[fx] pnpm install');
    const r = spawnSync('pnpm', ['install'], { cwd: ROOT, stdio: 'inherit' });
    if (r.error) {
      results.push({
        scope: 'root',
        name: '.',
        result: 'failed',
        detail: `cannot run pnpm: ${r.error.message}`,
      });
    } else {
      const status = r.status ?? 1;
      results.push({
        scope: 'root',
        name: '.',
        result: status === 0 ? 'ok' : 'failed',
        detail: status === 0 ? 'dependencies installed' : `pnpm install exited ${status}`,
      });
    }
  }
  finish(results, true);
}

// update — pull root, update the assets submodule, fast-forward the harness.
function update(args: string[]): never {
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const stash = updateShouldStash(args);
  const results: StepResult[] = [];
  let stashedRef = '';

  console.log('[fx] update: checking working tree');
  if (isDirty()) {
    if (!stash) {
      console.error(
        '[fx] local changes detected. Commit/stash them, or drop --no-stash to auto-stash.',
      );
      process.exit(2);
    }
    const before = dryRun ? '' : stashTopOid();
    const iso = dryRun ? '<now>' : new Date().toISOString();
    runGit(['stash', 'push', '-u', '-m', updateStashMessage(iso)], { dryRun, inherit: true });
    const after = dryRun ? 'planned' : stashTopOid();
    if (didCreateStash(before, after)) {
      stashedRef = dryRun ? 'planned' : 'stash@{0}';
    } else {
      console.log('[fx] no stash created (submodule-only changes); leaving them in place');
    }
  } else {
    console.log('[fx] working tree clean');
  }

  console.log('[fx] update: root repository');
  const up = gitOut(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up) {
    results.push(
      runGitStep(
        'root',
        '.',
        ['pull', '--ff-only', '--no-recurse-submodules'],
        dryRun,
        'pulled latest root',
      ),
    );
  } else {
    console.log('[fx] no upstream; fetching origin/main and rebasing');
    const fetched = runGitStep(
      'root',
      '.',
      ['fetch', '--no-recurse-submodules', 'origin', 'main'],
      dryRun,
      'fetched origin/main',
    );
    results.push(fetched);
    if (fetched.result !== 'failed') {
      results.push(
        runGitStep('root', '.', ['rebase', 'origin/main'], dryRun, 'rebased onto origin/main'),
      );
    }
  }

  const rootOk = !results.some((r) => r.scope === 'root' && r.result === 'failed');

  if (rootOk) {
    console.log('[fx] update: submodules');
    const paths = submodulePaths();
    if (paths.length === 0) {
      results.push({
        scope: 'submodule',
        name: '(none)',
        result: 'skipped',
        detail: 'no submodules configured',
      });
    } else {
      for (const p of paths) {
        results.push(
          runGitStep('submodule', p, submoduleUpdateArgs(p), dryRun, 'synced to recorded pin'),
        );
      }
    }
    console.log(`[fx] update: ${HARNESS_DIR}`);
    results.push(harnessSyncStep(dryRun));
  } else {
    results.push({
      scope: 'submodule',
      name: '(all)',
      result: 'skipped',
      detail: 'root update failed',
    });
    results.push({
      scope: 'harness',
      name: HARNESS_DIR,
      result: 'skipped',
      detail: 'root update failed',
    });
  }

  if (stashedRef) {
    console.log('[fx] restoring pre-update stash');
    results.push(restoreStashResult(stashedRef, dryRun));
  }

  finish(results, true);
}

// clean — restore a fully-clean git status; keep .forgeax-harness always.
function clean(args: string[]): never {
  const { dryRun, deepRoot, rootCleanFlags, subForeachCmd } = cleanFlagsFor(args);
  const results: StepResult[] = [];

  const step = (scope: StepScope, name: string, gitArgs: string[], okDetail: string): void => {
    results.push(runGitStep(scope, name, gitArgs, dryRun, okDetail));
  };

  console.log(
    `[fx] clean · root: ${deepRoot ? 'deep (wipes gitignored artefacts — re-run bun fx setup after)' : 'standard (keeps node_modules/dist)'}` +
      ` · submodules: always deep${dryRun ? ' · DRY RUN' : ''}`,
  );

  // 1. discard tracked edits + reset submodule pointers to recorded pins.
  step('root', '.', ['reset', '--hard'], 'reset tracked changes');
  // 2. sync submodule checkouts to pins (init any missing / nested).
  step(
    'submodule',
    '(all)',
    ['submodule', 'update', '--init', '--recursive', '--force'],
    'checkouts synced to pins',
  );
  // 3. scrub every submodule tree to bare pin state so none reports "modified" upward.
  step(
    'submodule',
    '(all)',
    ['submodule', 'foreach', '--recursive', subForeachCmd],
    'submodule trees scrubbed',
  );

  // 4. remove orphan submodule dirs (registered in git but dropped from
  //    .gitmodules). Whitelisted names (harness / live submodules) never match.
  for (const orphan of listOrphanSubmoduleDirs()) {
    if (dryRun) {
      console.log(`[dry-run] rm -rf ${orphan} && rm -rf .git/modules/${orphan}`);
      results.push({
        scope: 'orphan',
        name: orphan,
        result: 'planned',
        detail: `remove orphan submodule dir + .git/modules/${orphan}`,
      });
      continue;
    }
    console.log(`[fx] removing orphan submodule dir: ${orphan}`);
    try {
      rmSync(resolve(ROOT, orphan), { recursive: true, force: true });
      rmSync(resolve(ROOT, '.git', 'modules', orphan), { recursive: true, force: true });
      results.push({
        scope: 'orphan',
        name: orphan,
        result: 'ok',
        detail: 'orphan submodule dir removed',
      });
    } catch (err) {
      results.push({
        scope: 'orphan',
        name: orphan,
        result: 'failed',
        detail: `remove failed: ${(err as Error).message}`,
      });
    }
  }

  // 5. remove root untracked files, always preserving the harness floating clone.
  step(
    'root',
    '.',
    ['clean', rootCleanFlags, '-e', HARNESS_DIR, ...(dryRun ? ['-n'] : [])],
    'root untracked removed',
  );

  console.log(`\n${formatStepReport(results)}`);

  if (!dryRun) {
    const stillDirty = gitOut(['status', '--porcelain']);
    if (stillDirty === '') {
      console.log('\n[fx] working tree is now completely clean');
    } else {
      console.log('\n[fx] remaining after clean (inspect manually):');
      console.log(stillDirty);
    }
  }

  const hints = troubleshootHints(results);
  if (hints.length > 0) {
    console.error('\n[fx] hints:');
    for (const h of hints) console.error(`  - ${h}`);
  }
  process.exit(results.some((r) => r.result === 'failed') ? 1 : 0);
}

function usage(): void {
  console.log(`ForgeaX Engine developer CLI

Usage:
  bun fx <command> [args...]

Commands:
  setup                 First-time bootstrap: git submodule update --init
                        --recursive, then pnpm install (postinstall materialises
                        ${HARNESS_DIR}). Idempotent — safe to re-run.
  update [flags]        Pull root (ff-only), update submodules to their pins, and
                        fast-forward the ${HARNESS_DIR} floating clone.
                        --dry-run/-n   preview without changing anything
                        --no-stash     fail instead of auto-stashing a dirty tree
  clean  [flags]        Restore a fully-clean git status. Discards uncommitted
                        edits, scrubs submodule interiors to pin state, removes
                        orphan submodule dirs, and cleans root untracked files.
                        Always keeps ${HARNESS_DIR}.
                        --deep/-x      also wipe root gitignored artefacts
                                       (node_modules/dist) — re-run setup after
                        --dry-run/-n   preview without deleting anything
  help                  Show this text

Examples:
  bun fx setup
  bun fx update --dry-run
  bun fx clean --dry-run
  bun fx clean --deep
`);
}

function main(): void {
  const plan = resolveCommand(process.argv.slice(2));
  if (plan.type === 'unknown') {
    console.error(`[fx] unknown command: ${plan.command}`);
    usage();
    process.exit(2);
  }
  try {
    switch (plan.command) {
      case 'help':
      case '--help':
      case '-h':
        usage();
        break;
      case 'setup':
        setup(plan.args);
        break;
      case 'update':
        update(plan.args);
        break;
      case 'clean':
        clean(plan.args);
        break;
      default:
        console.error(`[fx] unhandled command: ${plan.command}`);
        process.exit(2);
    }
  } catch (err) {
    console.error(`[fx] unexpected error: ${(err as Error).message}`);
    console.error("  run 'bun fx help', or report this if it persists.");
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
