#!/usr/bin/env node
// AC-11 grep gate (feat-20260517-console-ecs-plugin-extraction / plan-strategy
// D-8): packages/console/src/** must contain 0 occurrences of the
// inspect-scripts.ts narrative tokens, and packages/console/src/sandbox.ts
// specifically must contain 0 quoted ECS-only mutating method literals.
//
// Source design (charter P3 machine-readable failure):
// - The 12 ECS-only mutation method names are derived at gate runtime from
//   `@forgeax/engine-ecs#ECS_MUTATING_METHODS` (15 names total minus the 3
//   shared with the generic JS-container blacklist: `set` / `push` / `pop`).
//   Deriving keeps this gate in lockstep with the ECS SSOT — no manual
//   mirror, no drift potential.
// - sandbox.ts is the only source file allowed to *mention* ECS-domain
//   mutation in narrative comments (since it is the file that consumes the
//   Registry-merged set at wrap-time); the gate checks for *quoted*
//   literals (`'spawn'` etc.) which would indicate the deleted hardcoded
//   17-name fixture has crept back.
// - The rest of console/src/** is checked for the historical
//   `INSPECT_TARGETS` and `inspect-scripts` symbols / paths so a future
//   refactor cannot silently re-introduce the `inspect <target>` built-in
//   subcommand surface that feat-20260517 deleted.
//
// Fail-fast behaviour (charter P4): if `@forgeax/engine-ecs` is not built
// (no dist/index.mjs), the gate exits 1 with a structured error pointing
// at the missing build target. Silent passing on missing artefacts would
// allow drift through the gate undetected.
//
// Test integration: `FORGEAX_ECS_BUILD_PATH` env var overrides the default
// build resolution; missing path -> exit 1 with the same structured error
// (used by the vitest test `check-no-ecs-literal-residue.test.ts`).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const consoleSrc = resolve(repoRoot, 'packages', 'console', 'src');
const sandboxFile = resolve(consoleSrc, 'sandbox.ts');

// === Step 1: derive ECS_ONLY 12-name slice from ECS_MUTATING_METHODS SSOT ===

const defaultEcsBuild = resolve(
  repoRoot,
  'packages',
  'ecs',
  'dist',
  'index.mjs',
);
const ecsBuildPath = process.env.FORGEAX_ECS_BUILD_PATH ?? defaultEcsBuild;

if (!existsSync(ecsBuildPath)) {
  process.stderr.write(
    `[reason] AC-11 fail-fast: cannot resolve ECS_MUTATING_METHODS SSOT\n` +
      `[rerun]  pnpm -F @forgeax/engine-ecs build && node packages/console/scripts/check-no-ecs-literal-residue.mjs\n` +
      `[hint]   gate must derive ECS_ONLY 12-name slice from @forgeax/engine-ecs#ECS_MUTATING_METHODS;\n` +
      `         tried: ${ecsBuildPath}\n` +
      `         set FORGEAX_ECS_BUILD_PATH if @forgeax/engine-ecs lives elsewhere in your tree\n`,
  );
  process.exit(1);
}

let ECS_MUTATING_METHODS;
try {
  const mod = await import(pathToFileURL(ecsBuildPath).href);
  ECS_MUTATING_METHODS = mod.ECS_MUTATING_METHODS;
} catch (e) {
  process.stderr.write(
    `[reason] AC-11 fail-fast: dynamic import of ECS_MUTATING_METHODS failed\n` +
      `[rerun]  pnpm -F @forgeax/engine-ecs build && node packages/console/scripts/check-no-ecs-literal-residue.mjs\n` +
      `[hint]   import target: ${ecsBuildPath}; underlying error: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
}

if (!(ECS_MUTATING_METHODS instanceof Set)) {
  process.stderr.write(
    `[reason] AC-11 fail-fast: ECS_MUTATING_METHODS is not a Set\n` +
      `[rerun]  rebuild @forgeax/engine-ecs; verify the named export\n` +
      `[hint]   expected ReadonlySet<string>; got ${typeof ECS_MUTATING_METHODS}\n`,
  );
  process.exit(1);
}

// 12 ECS-only names = 15 ECS_MUTATING_METHODS minus the 3 shared with the
// generic JS-container blacklist (set / push / pop). The static set lives
// in packages/console/src/sandbox.ts as MUTATION_BLACKLIST and its 3
// cross-vocabulary names overlap by design (charter P5 consistent
// vocabulary).
const SHARED_GENERIC_NAMES = new Set(['set', 'push', 'pop']);
const ECS_ONLY = [...ECS_MUTATING_METHODS].filter((m) => !SHARED_GENERIC_NAMES.has(m));

// === Step 2: scan packages/console/src/** for INSPECT_TARGETS / inspect-scripts ===

const HISTORICAL_RESIDUE = ['INSPECT_TARGETS', 'inspect-scripts'];
// Allow `LEGACY_INSPECT_TARGETS` (the cli.ts `did you mean` migration map
// scaffolding). The gate matches the deleted symbol via word boundary so
// the `LEGACY_` prefix shifts the residue hit out of the deny-list.
const RESIDUE_REGEXES = HISTORICAL_RESIDUE.map((token) => {
  // Tokens may contain '-' which is not a word char; use a manual prefix
  // boundary that requires the previous char (if any) to be neither a
  // word char nor an underscore.
  const escaped = token.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}`);
});
const SOURCE_EXTS = new Set(['.ts', '.mts', '.cts']);

function isCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

const failures = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      // Test files commonly reference the historical residue tokens for
      // assertions; skip __tests__ subtrees and adjacent .test.ts files.
      if (name === '__tests__') continue;
      walk(p);
      continue;
    }
    const ext = p.slice(p.lastIndexOf('.'));
    if (!SOURCE_EXTS.has(ext)) continue;
    if (p.endsWith('.d.ts') || p.endsWith('.d.mts') || p.endsWith('.d.cts')) continue;
    if (p.endsWith('.test.ts') || p.endsWith('.spec.ts')) continue;
    const text = readFileSync(p, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Allow comment lines to mention the symbol when narrating history;
      // only non-comment occurrences count as residue.
      if (isCommentLine(line)) continue;
      for (let r = 0; r < HISTORICAL_RESIDUE.length; r++) {
        const token = HISTORICAL_RESIDUE[r];
        const re = RESIDUE_REGEXES[r];
        if (re.test(line)) {
          failures.push({
            kind: 'historical-residue-hit',
            location: `${p}:${i + 1}`,
            token,
          });
        }
      }
    }
  }
}

walk(consoleSrc);

// === Step 3: scan sandbox.ts for quoted ECS_ONLY literals ===

if (existsSync(sandboxFile)) {
  const text = readFileSync(sandboxFile, 'utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Even comment lines are forbidden from carrying the quoted ECS-only
    // literals — narrating SSOT references is fine, but `'spawn'` etc.
    // would be the same string the deleted MUTATION_BLACKLIST line carried.
    for (const name of ECS_ONLY) {
      const quoted = `'${name}'`;
      if (line.includes(quoted)) {
        failures.push({
          kind: 'sandbox-quoted-ecs-literal',
          location: `${sandboxFile}:${i + 1}`,
          token: quoted,
        });
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `[reason] AC-11 FAIL: console source contains residue from the deleted inspect-subcommand surface\n`,
  );
  process.stderr.write(
    `[rerun]  node packages/console/scripts/check-no-ecs-literal-residue.mjs\n`,
  );
  process.stderr.write(
    `[hint]   feat-20260517 deleted the 17-name MUTATION_BLACKLIST + the inspect-scripts.ts module;\n` +
      `         ECS-domain mutating method names enter the sandbox via Registry.lookupMutatingMethods\n` +
      `         at wrap-time (research F6); INSPECT_TARGETS / inspect-scripts must stay 0-occurrence\n` +
      `         outside __tests__/ and historical comments. Hits:\n`,
  );
  for (const f of failures) {
    process.stderr.write(`  ${f.kind}: ${f.location}  -> '${f.token}'\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `[ok] AC-11: packages/console/src/** clean of INSPECT_TARGETS / inspect-scripts;` +
    ` packages/console/src/sandbox.ts clean of ECS_ONLY (${ECS_ONLY.length}) quoted literals\n`,
);
