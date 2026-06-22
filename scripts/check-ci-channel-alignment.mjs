#!/usr/bin/env node
// CI channel alignment drift gate — primary-pnpm ↔ portability-bun
// (feat-20260512 M5 / AC-09 / AC-10 / AC-16).
//
// Parses .github/workflows/ci.yml and asserts:
//   (1) The aligned base gates (count from ALIGNED_GATES below) each appear in
//       BOTH jobs.primary-pnpm.steps[].run and jobs.portability-bun.steps[].run
//       (matched by a canonical token set — the two channels use different
//       binaries but the same semantic gate).
//   (2) No forbidden literal from AC-02 sneaks into jobs.portability-bun
//       (pnpm-only smoke / browser / dawn / coverage / metrics:check / grep
//       gates / inspector are reserved for the primary-pnpm channel).
//   (3) `.pnpm-version` content matches `package.json#packageManager`
//       (AC-03 merged into this gate for single-entry SSOT enforcement).
//
// Job IDs are the SSOT anchors here: `primary-pnpm` is the full-CI source of
// truth, `portability-bun` is the package-manager-drift verifier. See AGENTS.md
// "Conventions > Dual lockfile".
//
// Zero npm deps; stdlib only. ≤ 200 LOC including the inline `--self-test`
// fixtures. Designed to mirror scripts/check-workspaces-equivalence.mjs:
// hand-rolled minimal YAML scan, fail-fast with structured hint on stderr.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PRIMARY_JOB = 'primary-pnpm';
const PORTABILITY_JOB = 'portability-bun';

// Token set per aligned gate — at least one of `runMatchers` must hit on a
// step's `run:` literal for the gate to count as "present in this job".
//
// feat-small-20260518-ci-cost-and-parallel-trims D-5: `typecheck` (tsc -b) and
// `tsup-build` (pnpm -r build / `bun run --filter './packages/*' build`)
// were removed from this set when build-artifacts started owning both phases.
// Two channels can no longer drift on a step they neither run; re-adding
// these gates would yield a false positive on the very topology that fixed
// the redundancy (channel-alignment invariant: aligned ⇒ shared between the
// two downstream channels).
const ALIGNED_GATES = [
  { id: 'install', runMatchers: ['install --frozen-lockfile --ignore-scripts'] },
  { id: 'sync-check', runMatchers: ['sync:check'] },
  { id: 'biome', runMatchers: ['biome ci', 'pnpm run lint'] },
  { id: 'english-only', runMatchers: ['check_english_only.py --code'] },
  { id: 'r12-lint', runMatchers: ['r12-lint'] },
  {
    id: 'vitest-unit',
    runMatchers: ['pnpm run test:type', 'bun run test:portability', '--typecheck --coverage'],
  },
  // tweak-20260521-bun-portability-script-gates-expansion w1: 16 portability
  // gates folded in (4 non-grep + 12 grep:*). Each runMatcher is the full
  // package.json#scripts name so a single substring hits all three literal
  // forms used across primary-pnpm + portability-bun:
  //   `pnpm <name>` / `pnpm run <name>` (primary)
  //   `bun run <name>` (portability — added by w3)
  //   `node <script-path>` (primary multi-line `run: |` blocks)
  // The non-grep ids drop the colon (`lint-internal` <-> script `lint:internal`)
  // per plan-strategy 8 naming-convention; substring still uniquely hits.
  { id: 'lint-internal', runMatchers: ['lint:internal'] },
  { id: 'check-engine-no-console-dep', runMatchers: ['check-engine-no-console-dep'] },
  { id: 'check-console-not-in-engine-bundle', runMatchers: ['check-console-not-in-engine-bundle'] },
  { id: 'ci-paths-check', runMatchers: ['ci:paths-check'] },
  { id: 'grep-single-exit', runMatchers: ['grep:single-exit'] },
  {
    id: 'grep-asset-registry-instanced-removed',
    runMatchers: ['grep:asset-registry-instanced-removed'],
  },
  { id: 'grep-no-entity-array-literal', runMatchers: ['grep:no-entity-array-literal'] },
  { id: 'grep-readme-array-vocab-mentioned', runMatchers: ['grep:readme-array-vocab-mentioned'] },
  { id: 'grep-readme-string-vocab-mentioned', runMatchers: ['grep:readme-string-vocab-mentioned'] },
  { id: 'grep-no-managed-array-view-import', runMatchers: ['grep:no-managed-array-view-import'] },
  { id: 'grep-no-array-stride-option', runMatchers: ['grep:no-array-stride-option'] },
  { id: 'grep-no-buffer-colon-keyword', runMatchers: ['grep:no-buffer-colon-keyword'] },
  { id: 'grep-no-managed-array-error-code', runMatchers: ['grep:no-managed-array-error-code'] },
  { id: 'grep-no-result-reproject-cast', runMatchers: ['grep:no-result-reproject-cast'] },
  { id: 'grep-no-string-view-import', runMatchers: ['grep:no-string-view-import'] },
  { id: 'grep-no-set-managed-ref-store', runMatchers: ['grep:no-set-managed-ref-store'] },
  { id: 'grep-no-binary-assets', runMatchers: ['grep:no-binary-assets'] },
];

// Forbidden literals in jobs.portability-bun (AC-02). Substring match on raw
// run literal. These steps live exclusively in the primary-pnpm channel.
// `jscpd` / `dup-check` added by feat-20260514-ci-jscpd-duplication-gate
// M5 T-021 (AC-08): the duplication gate is a pnpm-side wrapper invocation
// (root scripts.dup-check); portability-bun stays scoped to the 8 aligned
// base gates and must never grow a jscpd literal.
const FORBIDDEN_IN_PORTABILITY = [
  'smoke',
  'browser',
  'dawn',
  'coverage',
  'metrics:check',
  'metrics:run',
  'inspector',
  'ac-08-grep-gate',
  'check-shader-',
  'jscpd',
  'dup-check',
];

function extractJobBlock(text, jobName) {
  // Match `^  <jobName>:` and consume lines until the next top-level job
  // declaration (2-space indent + identifier + ':' on its own line).
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`  ${jobName}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[a-z][a-zA-Z0-9_-]*:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function extractStepRuns(block) {
  // Walk the block line by line. A step starts at `      - name: <name>`. The
  // `run:` field may be a single-line scalar or a `|`-block continuation.
  const lines = block.split(/\r?\n/);
  const steps = [];
  let cur = null;
  let inRunBlock = false;
  let runIndent = 0;
  for (const raw of lines) {
    const stripped = raw.replace(/\s+$/, '');
    const stepStart = /^ {6}-\s+name:\s*(.+)$/.exec(stripped);
    if (stepStart) {
      if (cur) steps.push(cur);
      cur = { name: stepStart[1].trim(), runLines: [] };
      inRunBlock = false;
      continue;
    }
    if (!cur) continue;
    if (inRunBlock) {
      // Continue collecting until indent drops below runIndent or new step starts.
      if (stripped === '' || /^\s/.test(raw)) {
        const leading = /^(\s*)/.exec(raw)[1].length;
        if (leading >= runIndent || stripped === '') {
          cur.runLines.push(stripped.replace(/^\s+/, ''));
          continue;
        }
      }
      inRunBlock = false;
      // fall through to single-line scan
    }
    const runSingle = /^\s+run:\s*(\S.*)$/.exec(stripped);
    if (runSingle) {
      const val = runSingle[1].trim();
      if (val === '|' || val === '|-' || val === '>' || val === '>-') {
        inRunBlock = true;
        const lead = /^(\s+)run:/.exec(stripped)[1].length;
        runIndent = lead + 2;
      } else {
        cur.runLines.push(val);
      }
    }
  }
  if (cur) steps.push(cur);
  return steps.map((s) => ({ name: s.name, run: s.runLines.join('\n') }));
}

function gateMatchesJob(gate, steps) {
  for (const s of steps) {
    for (const m of gate.runMatchers) {
      if (s.run.includes(m)) return true;
    }
  }
  return false;
}

function findForbidden(portabilitySteps) {
  const hits = [];
  for (const s of portabilitySteps) {
    for (const f of FORBIDDEN_IN_PORTABILITY) {
      if (s.run.includes(f)) hits.push({ stepName: s.name, literal: f });
    }
  }
  return hits;
}

function checkPnpmVersionFile(rootDir) {
  const filePath = path.join(rootDir, '.pnpm-version');
  const pkgPath = path.join(rootDir, 'package.json');
  let pv;
  try {
    pv = readFileSync(filePath, 'utf8').trim();
  } catch {
    return { ok: false, msg: `[ci-align-check] FAIL: .pnpm-version file missing at ${filePath}` };
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const pmField = pkg.packageManager || '';
  const m = /^pnpm@(.+)$/.exec(pmField);
  if (!m) {
    return {
      ok: false,
      msg: `[ci-align-check] FAIL: package.json#packageManager (${JSON.stringify(pmField)}) is not 'pnpm@<version>'`,
    };
  }
  if (pv !== m[1]) {
    return {
      ok: false,
      msg: `[ci-align-check] FAIL: .pnpm-version (${pv}) != package.json#packageManager pnpm version (${m[1]})\n  Hint: sync both files; both must declare the same pnpm version.`,
    };
  }
  return { ok: true };
}

function runAlignmentCheck(ciYamlText, rootDir) {
  const issues = [];
  const primaryBlock = extractJobBlock(ciYamlText, PRIMARY_JOB);
  const portabilityBlock = extractJobBlock(ciYamlText, PORTABILITY_JOB);
  if (!primaryBlock) issues.push(`jobs.${PRIMARY_JOB} block not found in ci.yml`);
  if (!portabilityBlock) issues.push(`jobs.${PORTABILITY_JOB} block not found in ci.yml`);
  if (issues.length) return issues;
  const primarySteps = extractStepRuns(primaryBlock);
  const portabilitySteps = extractStepRuns(portabilityBlock);
  const missingInPortability = [];
  const missingInPrimary = [];
  for (const gate of ALIGNED_GATES) {
    if (!gateMatchesJob(gate, portabilitySteps)) missingInPortability.push(gate.id);
    if (!gateMatchesJob(gate, primarySteps)) missingInPrimary.push(gate.id);
  }
  const forbidden = findForbidden(portabilitySteps);
  if (missingInPortability.length) {
    issues.push(
      `Missing in jobs.${PORTABILITY_JOB} (expected per AC-01 alignment): ${missingInPortability.join(', ')}`,
    );
  }
  if (missingInPrimary.length) {
    issues.push(
      `Missing in jobs.${PRIMARY_JOB} (expected per AC-01 alignment): ${missingInPrimary.join(', ')}`,
    );
  }
  if (forbidden.length) {
    issues.push(
      `Forbidden literals in jobs.${PORTABILITY_JOB} (AC-02 primary-pnpm-only):\n${forbidden
        .map((h) => `  - step ${JSON.stringify(h.stepName)} contains ${JSON.stringify(h.literal)}`)
        .join('\n')}`,
    );
  }
  if (rootDir) {
    const pv = checkPnpmVersionFile(rootDir);
    if (!pv.ok) issues.push(pv.msg);
  }
  return issues;
}

// --- fixtures + self-test mode --------------------------------------------

const FIX_ALIGNED = `name: ci
on: [push]
jobs:
  primary-pnpm:
    runs-on: ubuntu-latest
    steps:
      - name: Install (frozen)
        run: pnpm install --frozen-lockfile --ignore-scripts
      - name: Workspaces equivalence guard
        run: pnpm run sync:check
      - name: Biome ci
        run: pnpm run lint
      - name: English-only check
        run: python scripts/forgeax/check_english_only.py --code packages/*/src
      - name: R12 Lint (descriptor mirror)
        run: pnpm r12-lint
      - name: Vitest (unit + typecheck)
        run: pnpm run test:type
      - name: lint:internal
        run: pnpm lint:internal
      - name: check-engine-no-console-dep
        run: node packages/console/scripts/check-engine-no-console-dep.mjs
      - name: check-console-not-in-engine-bundle
        run: node packages/console/scripts/check-console-not-in-engine-bundle.mjs
      - name: ci:paths-check
        run: pnpm ci:paths-check
      - name: grep:single-exit
        run: pnpm grep:single-exit
      - name: grep:asset-registry-instanced-removed
        run: pnpm grep:asset-registry-instanced-removed
      - name: grep:no-entity-array-literal
        run: pnpm grep:no-entity-array-literal
      - name: grep:readme-array-vocab-mentioned
        run: pnpm grep:readme-array-vocab-mentioned
      - name: grep:readme-string-vocab-mentioned
        run: pnpm grep:readme-string-vocab-mentioned
      - name: grep:no-managed-array-view-import
        run: pnpm grep:no-managed-array-view-import
      - name: grep:no-array-stride-option
        run: pnpm grep:no-array-stride-option
      - name: grep:no-buffer-colon-keyword
        run: pnpm grep:no-buffer-colon-keyword
      - name: grep:no-managed-array-error-code
        run: pnpm grep:no-managed-array-error-code
      - name: grep:no-result-reproject-cast
        run: pnpm grep:no-result-reproject-cast
      - name: grep:no-string-view-import
        run: pnpm grep:no-string-view-import
      - name: grep:no-set-managed-ref-store
        run: pnpm grep:no-set-managed-ref-store
      - name: grep:no-binary-assets
        run: pnpm grep:no-binary-assets
      - name: Pnpm workspace build (mirror)
        run: pnpm run --filter './packages/*' build
      - name: Pnpm dist artefact probe (mirror)
        run: |
          for pkg in runtime types ecs vite-plugin-shader vite-plugin-pack; do
            test -f "packages/$pkg/dist/index.mjs" || (echo "missing: $pkg" && exit 1)
          done
      - name: Pnpm dev server probe (mirror)
        run: |
          pnpm run --filter @forgeax/hello-room dev &
          PID=$!
          sleep 15
          if curl --fail --max-time 5 http://localhost:5173/; then
            rc=0
          else
            echo "dev server probe failed @ 5173"
            rc=1
          fi
          kill $PID 2>/dev/null || true
          exit $rc
      - name: Hello-triangle headless smoke
        run: pnpm --filter @forgeax/hello-triangle smoke
  portability-bun:
    runs-on: ubuntu-latest
    steps:
      - name: Install (frozen)
        run: bun install --frozen-lockfile --ignore-scripts
      - name: Workspaces equivalence guard
        run: bun run sync:check
      - name: Biome ci
        run: bunx biome ci .
      - name: English-only check
        run: python scripts/forgeax/check_english_only.py --code packages/*/src
      - name: R12 Lint (descriptor mirror)
        run: bun run r12-lint
      - name: Vitest (via bun run test:portability)
        run: bun run test:portability
      - name: lint:internal
        run: bun run lint:internal
      - name: check-engine-no-console-dep
        run: bun run check-engine-no-console-dep
      - name: check-console-not-in-engine-bundle
        run: bun run check-console-not-in-engine-bundle
      - name: ci:paths-check
        run: bun run ci:paths-check
      - name: grep:single-exit
        run: bun run grep:single-exit
      - name: grep:asset-registry-instanced-removed
        run: bun run grep:asset-registry-instanced-removed
      - name: grep:no-entity-array-literal
        run: bun run grep:no-entity-array-literal
      - name: grep:readme-array-vocab-mentioned
        run: bun run grep:readme-array-vocab-mentioned
      - name: grep:readme-string-vocab-mentioned
        run: bun run grep:readme-string-vocab-mentioned
      - name: grep:no-managed-array-view-import
        run: bun run grep:no-managed-array-view-import
      - name: grep:no-array-stride-option
        run: bun run grep:no-array-stride-option
      - name: grep:no-buffer-colon-keyword
        run: bun run grep:no-buffer-colon-keyword
      - name: grep:no-managed-array-error-code
        run: bun run grep:no-managed-array-error-code
      - name: grep:no-result-reproject-cast
        run: bun run grep:no-result-reproject-cast
      - name: grep:no-string-view-import
        run: bun run grep:no-string-view-import
      - name: grep:no-set-managed-ref-store
        run: bun run grep:no-set-managed-ref-store
      - name: grep:no-binary-assets
        run: bun run grep:no-binary-assets
      - name: Bun workspace build
        run: bun run --filter './packages/*' build
      - name: Bun dist artefact probe
        run: |
          for pkg in runtime types ecs vite-plugin-shader vite-plugin-pack; do
            test -f "packages/$pkg/dist/index.mjs" || (echo "missing: $pkg" && exit 1)
          done
      - name: Bun dev server probe
        run: |
          bun run --cwd apps/hello/room dev &
          PID=$!
          sleep 15
          if curl --fail --max-time 5 http://localhost:5173/; then
            rc=0
          else
            echo "dev server probe failed @ 5173"
            rc=1
          fi
          kill $PID 2>/dev/null || true
          exit $rc
`;
const FIX_MISSING_PORTABILITY_R12 = FIX_ALIGNED.replace(
  / {6}- name: R12 Lint \(descriptor mirror\)\n {8}run: bun run r12-lint\n/,
  '',
);
const FIX_PRIMARY_ONLY_OK = FIX_ALIGNED; // primary-only smoke step already in aligned fixture

function runSelfTest() {
  let failed = 0;
  const cases = [
    {
      id: 'aligned',
      text: FIX_ALIGNED,
      expectIssues: false,
    },
    {
      id: 'missing-in-portability',
      text: FIX_MISSING_PORTABILITY_R12,
      expectIssues: true,
      expectMatch: 'r12-lint',
    },
    {
      id: 'primary-only-allowlist',
      text: FIX_PRIMARY_ONLY_OK,
      expectIssues: false,
    },
  ];
  for (const c of cases) {
    const issues = runAlignmentCheck(c.text, null);
    const hasIssues = issues.length > 0;
    const ok = c.expectIssues
      ? hasIssues && (!c.expectMatch || issues.join('\n').includes(c.expectMatch))
      : !hasIssues;
    process.stdout.write(
      `[self-test] case=${c.id} expectIssues=${c.expectIssues} actualIssues=${hasIssues} ${
        ok ? 'PASS' : 'FAIL'
      }\n`,
    );
    if (!ok) {
      failed += 1;
      for (const i of issues) process.stdout.write(`  issue: ${i}\n`);
    }
  }
  process.stdout.write(`[self-test] ${failed === 0 ? 'all PASS' : `${failed} FAIL`}\n`);
  return failed === 0 ? 0 : 1;
}

// --- entry ----------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    process.exit(runSelfTest());
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(here, '..');
  const ciPath = path.join(rootDir, '.github', 'workflows', 'ci.yml');
  const text = readFileSync(ciPath, 'utf8');
  const issues = runAlignmentCheck(text, rootDir);
  if (issues.length) {
    process.stderr.write('[ci-align-check] FAIL:\n');
    for (const i of issues) process.stderr.write(`${i}\n`);
    process.stderr.write(
      '\n  Hint: add the missing step to the offending job (mirror the other-channel form),\n' +
        '        or update ALIGNED_GATES / FORBIDDEN_IN_PORTABILITY in scripts/check-ci-channel-alignment.mjs.\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    `[ci-align-check] OK: jobs.${PRIMARY_JOB} and jobs.${PORTABILITY_JOB} are aligned on the ${ALIGNED_GATES.length} base gates\n`,
  );
}

main();
