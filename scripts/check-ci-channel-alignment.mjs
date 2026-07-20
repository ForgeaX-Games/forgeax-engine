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
// Zero npm deps; stdlib only. Inline `--self-test` fixtures falsify the
// alignment and ownership contracts. Uses a hand-rolled minimal YAML scan and
// fails fast with structured hints on stderr.

import { readdirSync, readFileSync } from 'node:fs';
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

// --- ownership checks (D-5) -------------------------------------------------

const W5_PATH = 'packages/ecs/src/__tests__/query-trs-flat-column-ratio.perf.test.ts';
const W6_PATH = 'packages/ecs/src/__tests__/query-light-extract-flat-column-ratio.perf.test.ts';
const EXPECTED_PERF_PATHS = [W5_PATH, W6_PATH].sort();

function extractRootEcsPerfInclude(rootConfigText) {
  const idx = rootConfigText.indexOf("name: 'ecs-perf'");
  if (idx < 0) return null;
  const after = rootConfigText.substring(idx);
  const m = after.match(/include:\s*\[([^\]]*)\]/);
  if (!m) return null;
  const globs = [];
  const re = /'([^']+)'/g;
  for (const g of m[1].matchAll(re)) globs.push(g[1]);
  return globs;
}

function globMatcher(glob) {
  let pattern = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char !== '*') {
      pattern += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
      continue;
    }
    if (glob[i + 1] === '*') {
      i += 1;
      if (glob[i + 1] === '/') {
        i += 1;
        pattern += '(?:.*/)?';
      } else {
        pattern += '.*';
      }
    } else {
      pattern += '[^/]*';
    }
  }
  return new RegExp(`^${pattern}$`);
}

function resolvePerfFiles(rootDir, includeGlobs) {
  const matches = includeGlobs.map(globMatcher);
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', '.git', '.worktrees'].includes(entry.name)) walk(full);
      } else if (entry.name.endsWith('.perf.test.ts')) {
        const file = path.relative(rootDir, full);
        if (matches.some((match) => match.test(file))) files.push(file);
      }
    }
  }
  walk(rootDir);
  return files;
}

function runOwnershipCheck({
  ciYamlText,
  rootDir,
  _ecsConfigText,
  _rootConfigText,
  _pkgJsonText,
  _perfFiles,
}) {
  const issues = [];
  const ecsConf =
    _ecsConfigText ?? readFileSync(path.join(rootDir, 'packages/ecs/vitest.config.ts'), 'utf8');
  const rootConf = _rootConfigText ?? readFileSync(path.join(rootDir, 'vitest.config.ts'), 'utf8');
  const pkgJson = JSON.parse(
    _pkgJsonText ?? readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
  );

  // (a) ecs config contains **/*.perf.test.ts exclude
  if (!ecsConf.includes('**/*.perf.test.ts')) {
    issues.push(
      `[ownership] FAIL: @forgeax/engine-ecs does not exclude '**/*.perf.test.ts' (channel: primary-pnpm, portability-bun)\n` +
        `  Project: ecs-perf\n` +
        `  W5 (${W5_PATH}) and W6 (${W6_PATH}) would re-enter normal ECS selection.\n` +
        `  Expected: exclude array in packages/ecs/vitest.config.ts contains '**/*.perf.test.ts'`,
    );
  }

  // (b) root config registers ecs-perf whose include globs all end in .perf.test.ts
  const incGlobs = extractRootEcsPerfInclude(rootConf);
  if (!incGlobs) {
    issues.push(
      `[ownership] FAIL: ecs-perf project not found in root vitest.config.ts (channel: primary-pnpm)\n` +
        `  Project: ecs-perf\n` +
        `  W5 (${W5_PATH}) and W6 (${W6_PATH}) have no named performance owner.\n` +
        `  Expected: named project 'ecs-perf' with include globs ending in '.perf.test.ts'`,
    );
  } else {
    const nonPerf = incGlobs.filter((g) => !g.endsWith('.perf.test.ts'));
    if (nonPerf.length > 0) {
      issues.push(
        `[ownership] FAIL: ecs-perf include globs not all '*.perf.test.ts' (channel: primary-pnpm)\n` +
          `  Project: ecs-perf\n` +
          `  W5: ${W5_PATH}\n` +
          `  W6: ${W6_PATH}\n` +
          `  Non-perf globs: ${nonPerf.join(', ')}\n` +
          `  Expected: all include globs end in '.perf.test.ts' — ordinary ECS unit tests would enter ecs-perf`,
      );
    }
  }

  // (c) ecs-perf's include globs resolve exactly W5/W6
  const perfFiles = _perfFiles ?? (incGlobs ? resolvePerfFiles(rootDir, incGlobs) : []);
  const sorted = [...perfFiles].sort();
  const eq =
    sorted.length === EXPECTED_PERF_PATHS.length &&
    sorted.every((f, i) => f === EXPECTED_PERF_PATHS[i]);
  if (!eq) {
    const missing = EXPECTED_PERF_PATHS.filter((f) => !sorted.includes(f));
    const extra = sorted.filter((f) => !EXPECTED_PERF_PATHS.includes(f));
    const parts = [];
    if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
    if (extra.length) parts.push(`extra: ${extra.join(', ')}`);
    issues.push(
      `[ownership] FAIL: ecs-perf include population mismatch (channel: primary-pnpm)\n` +
        `  Project: ecs-perf\n` +
        `  W5: ${W5_PATH}\n` +
        `  W6: ${W6_PATH}\n` +
        `  Includes: ${incGlobs?.join(', ') || '(missing project)'}\n` +
        `  ${parts.join('; ')}\n` +
        `  Expected exactly: ${EXPECTED_PERF_PATHS.join(', ')}`,
    );
  }

  // (d) package.json#test:portability does not select ecs-perf
  const portScript = pkgJson.scripts?.['test:portability'] || '';
  if (portScript.includes('ecs-perf')) {
    issues.push(
      `[ownership] FAIL: portability-bun selects ecs-perf project (channel: portability-bun)\n` +
        `  test:portability = ${JSON.stringify(portScript)}\n` +
        `  Expected: no 'ecs-perf' in test:portability — Bun canary must not discover W5/W6`,
    );
  }

  // (e) both primary run literals contain --project=ecs-perf
  const priBlock = extractJobBlock(ciYamlText, PRIMARY_JOB);
  if (priBlock) {
    const steps = extractStepRuns(priBlock);
    const vitestSteps = steps.filter(
      (s) => s.run.includes('vitest run') && s.run.includes('--typecheck'),
    );
    if (vitestSteps.length !== 2) {
      issues.push(
        `[ownership] FAIL: primary-pnpm has ${vitestSteps.length} vitest+typecheck command(s), expected exactly 2 (channel: primary-pnpm)\n` +
          `  Project: primary-pnpm\n` +
          `  W5: ${W5_PATH}\n` +
          `  W6: ${W6_PATH}\n` +
          `  Expected: 2 vitest run --typecheck commands (fork PR unit + same-repo coverage) — ` +
          `deleting or rewriting both would silently drop W5/W6 from the primary channel`,
      );
    }
    for (const s of vitestSteps) {
      if (!s.run.includes('--project=ecs-perf')) {
        issues.push(
          `[ownership] FAIL: primary-pnpm vitest command missing --project=ecs-perf (channel: primary-pnpm)\n` +
            `  Project: primary-pnpm\n` +
            `  Step: ${s.name}\n` +
            `  W5: ${W5_PATH}\n` +
            `  W6: ${W6_PATH}\n` +
            `  Expected: contains '--project=ecs-perf' — W5/W6 would leave the primary channel`,
        );
      }
    }
  }

  // (f) portability job contains no perf-project or .perf.test.ts literal
  const portBlock = extractJobBlock(ciYamlText, PORTABILITY_JOB);
  if (portBlock) {
    const steps = extractStepRuns(portBlock);
    for (const s of steps) {
      if (s.run.includes('ecs-perf')) {
        issues.push(
          `[ownership] FAIL: portability-bun contains 'ecs-perf' (channel: portability-bun)\n` +
            `  Step: ${s.name}\n` +
            `  Expected: no 'ecs-perf' in portability job — W5/W6 would re-enter Bun selection`,
        );
      }
      if (s.run.includes('.perf.test.ts')) {
        issues.push(
          `[ownership] FAIL: portability-bun contains '.perf.test.ts' (channel: portability-bun)\n` +
            `  Step: ${s.name}\n` +
            `  Expected: no '.perf.test.ts' in portability job — W5/W6 would re-enter Bun selection`,
        );
      }
    }
  }

  return issues;
}

// --- fixtures + self-test mode --------------------------------------------

function runSelfTest() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ciText = readFileSync(path.join(rootDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  const cases = [
    { id: 'aligned', text: ciText, expectIssues: false },
    {
      id: 'missing-in-portability',
      text: ciText.replace(
        / {6}- name: R12 Lint \(descriptor mirror\)\n {8}run: bun run r12-lint\n/,
        '',
      ),
      expectIssues: true,
      expectMatch: 'r12-lint',
    },
    { id: 'primary-only-allowlist', text: ciText, expectIssues: false },
  ];
  let failed = 0;
  for (const c of cases) {
    const issues = runAlignmentCheck(c.text, null);
    const ok = c.expectIssues
      ? issues.length > 0 && (!c.expectMatch || issues.join('\n').includes(c.expectMatch))
      : issues.length === 0;
    process.stdout.write(`[self-test] case=${c.id} ${ok ? 'PASS' : 'FAIL'}\n`);
    if (!ok) {
      failed += 1;
      for (const issue of issues) process.stdout.write(`  issue: ${issue}\n`);
    }
  }
  process.stdout.write(`[self-test] ${failed === 0 ? 'all PASS' : `${failed} FAIL`}\n`);
  return failed === 0 ? 0 : 1;
}

// --- ownership self-test fixtures (D-5) ------------------------------------

function runOwnershipSelfTest() {
  let failed = 0;
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ciText = readFileSync(path.join(rootDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  const rootConf = readFileSync(path.join(rootDir, 'vitest.config.ts'), 'utf8');
  const ecsConf = readFileSync(path.join(rootDir, 'packages/ecs/vitest.config.ts'), 'utf8');
  const pkgText = readFileSync(path.join(rootDir, 'package.json'), 'utf8');
  const primaryWithoutPerf = ciText.replace(/ --project=ecs-perf/g, '');
  // Remove BOTH vitest run --typecheck commands from primary-pnpm to exercise the
  // zero-candidate guard (F-1: silently green when all primary ownership commands
  // are deleted).
  const zeroVitestTypecheck = ciText.replace(
    /pnpm exec vitest run --typecheck /g,
    'pnpm exec vitest run --no-typecheck ',
  );
  const portabilityMarker = 'run: bun run test:portability';
  const portabilityWithProject = ciText.replace(
    portabilityMarker,
    `${portabilityMarker} --project=ecs-perf`,
  );
  const portabilityWithPath = ciText.replace(portabilityMarker, `${portabilityMarker} ${W5_PATH}`);
  const cases = [
    ['ownership-aligned', { ciYamlText: ciText, rootDir }, false],
    [
      'ownership-ecs-no-exclude',
      {
        ciYamlText: ciText,
        rootDir,
        _ecsConfigText: ecsConf.replace(
          "exclude: [...configDefaults.exclude, '**/*.perf.test.ts'],\n",
          '',
        ),
      },
      true,
      '**/*.perf.test.ts',
    ],
    [
      'ownership-ecs-perf-nonperf-glob',
      {
        ciYamlText: ciText,
        rootDir,
        _rootConfigText: rootConf.replace('**/*.perf.test.ts', '**/*.test.ts'),
      },
      true,
      'not all',
    ],
    [
      'ownership-ecs-perf-unmatched-glob',
      {
        ciYamlText: ciText,
        rootDir,
        _rootConfigText: rootConf.replace('**/*.perf.test.ts', 'nope/**/*.perf.test.ts'),
      },
      true,
      'include population mismatch',
    ],
    [
      'ownership-ecs-perf-not-found',
      {
        ciYamlText: ciText,
        rootDir,
        _rootConfigText: rootConf.replace("name: 'ecs-perf'", "name: 'not-ecs-perf'"),
      },
      true,
      'ecs-perf project not found',
    ],
    [
      'ownership-perf-population-mismatch',
      {
        ciYamlText: ciText,
        rootDir,
        _perfFiles: [...EXPECTED_PERF_PATHS, 'packages/ecs/src/__tests__/extra.perf.test.ts'],
      },
      true,
      'mismatch',
    ],
    [
      'ownership-portability-selects-ecs-perf',
      {
        ciYamlText: ciText,
        rootDir,
        _pkgJsonText: pkgText.replace(
          "'@forgeax/engine-ecs'",
          "'@forgeax/engine-ecs' --project=ecs-perf",
        ),
      },
      true,
      'ecs-perf',
    ],
    [
      'ownership-primary-missing-ecs-perf',
      { ciYamlText: primaryWithoutPerf, rootDir },
      true,
      '--project=ecs-perf',
    ],
    [
      'ownership-primary-zero-vitest-typecheck',
      { ciYamlText: zeroVitestTypecheck, rootDir },
      true,
      'expected exactly 2',
    ],
    [
      'ownership-portability-contains-ecs-perf',
      { ciYamlText: portabilityWithProject, rootDir },
      true,
      'ecs-perf',
    ],
    [
      'ownership-portability-contains-perf-test-ts',
      { ciYamlText: portabilityWithPath, rootDir },
      true,
      '.perf.test.ts',
    ],
  ];

  for (const [id, params, expectIssues, expectMatch] of cases) {
    const issues = runOwnershipCheck(params);
    const ok = expectIssues
      ? issues.length > 0 && (!expectMatch || issues.join('\n').includes(expectMatch))
      : issues.length === 0;
    process.stdout.write(`[self-test] case=${id} ${ok ? 'PASS' : 'FAIL'}\n`);
    if (!ok) {
      failed += 1;
      for (const issue of issues) process.stdout.write(`  issue: ${issue}\n`);
    }
  }
  process.stdout.write(`[self-test] ownership ${failed === 0 ? 'all PASS' : `${failed} FAIL`}\n`);
  return failed === 0 ? 0 : 1;
}

// --- entry ----------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    const rc1 = runSelfTest();
    const rc2 = runOwnershipSelfTest();
    process.exit(rc1 || rc2);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(here, '..');
  const ciPath = path.join(rootDir, '.github', 'workflows', 'ci.yml');
  const text = readFileSync(ciPath, 'utf8');
  const issues = runAlignmentCheck(text, rootDir);
  const ownershipIssues = runOwnershipCheck({ ciYamlText: text, rootDir });
  const allIssues = [...issues, ...ownershipIssues];
  if (allIssues.length) {
    process.stderr.write('[ci-align-check] FAIL:\n');
    for (const i of allIssues) process.stderr.write(`${i}\n`);
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
