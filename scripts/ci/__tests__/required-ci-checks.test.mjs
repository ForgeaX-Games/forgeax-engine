import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyRequiredContextAdmission,
  pickLatestPullRequestRun,
  REQUIRED_CHECK_NAMES,
  REQUIRED_CONTEXT_ADMISSION_STATUSES,
} from '../required-ci-checks.mjs';

const scriptPath = fileURLToPath(new URL('../required-ci-checks.mjs', import.meta.url));
const workflowPath = resolve(
  fileURLToPath(new URL('../../..', import.meta.url)),
  '.github/workflows/required-ci-checks.yml',
);
const manifest = JSON.parse(
  readFileSync(
    resolve(fileURLToPath(new URL('../required-ci-checks.json', import.meta.url))),
    'utf8',
  ),
);

const run = (values) => ({
  event: 'pull_request',
  createdAt: '2026-07-15T00:00:00Z',
  ...values,
});

test('lists the exact direct CI contexts selected for the ruleset', () => {
  assert.deepEqual(REQUIRED_CHECK_NAMES, manifest);
  assert.equal(new Set(manifest).size, manifest.length);
});

test('required-context workflow projects the manifest count instead of a stale list', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /same 19 contexts/);
  assert.doesNotMatch(workflow, /same nine contexts/);
});

test('returns null when ci.yml has no pull request run for the head SHA', () => {
  assert.equal(pickLatestPullRequestRun([]), null);
  assert.equal(pickLatestPullRequestRun(undefined), null);
  assert.equal(pickLatestPullRequestRun([run({ event: 'push' })]), null);
});

function runFixture(values = {}) {
  return {
    id: 42,
    event: 'pull_request',
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    ...values,
  };
}

function jobFixture(name, values = {}) {
  return {
    id: `${name}-job`,
    name,
    conclusion: 'success',
    ...values,
  };
}

function completeRoster() {
  return REQUIRED_CHECK_NAMES.map((name) => jobFixture(name));
}

test('exposes the closed admission-status vocabulary', () => {
  assert.deepEqual(REQUIRED_CONTEXT_ADMISSION_STATUSES, [
    'path-filtered',
    'ordinary-push-main',
    'normal-ci-run',
    'operational-skip',
    'zero-job',
    'api-error',
    'partial-roster',
    'genuine-failure',
  ]);
});

test('permits fallback only when path-filter evidence is explicit', () => {
  const proven = classifyRequiredContextAdmission({ pathFiltered: true });
  assert.equal(proven.status, 'path-filtered');
  assert.equal(proven.fallbackEligible, true);
  assert.equal(proven.pathFilteredProven, true);

  const unproven = classifyRequiredContextAdmission({});
  assert.equal(unproven.status, 'path-filtered');
  assert.equal(unproven.fallbackEligible, false);
  assert.equal(unproven.pathFilteredProven, false);
  assert.deepEqual(unproven.reasonCodes, ['path-filtered-unproven']);
});

test('admits a complete terminal ci.yml roster as normal-ci-run without fallback', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture(),
    jobs: completeRoster(),
  });
  assert.equal(result.status, 'normal-ci-run');
  assert.equal(result.terminal, true);
  assert.equal(result.complete, true);
  assert.equal(result.fallbackEligible, false);
  assert.deepEqual(result.observedContexts, REQUIRED_CHECK_NAMES);
});

test('keeps an in-progress ci.yml run authoritative without treating its roster as terminal', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture({ status: 'in_progress' }),
  });
  assert.equal(result.status, 'normal-ci-run');
  assert.equal(result.terminal, false);
  assert.equal(result.complete, false);
  assert.equal(result.fallbackEligible, false);
  assert.deepEqual(result.reasonCodes, ['run-not-terminal']);
});

test('keeps a pending ci.yml run authoritative while GitHub is scheduling it', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture({ status: 'pending' }),
  });
  assert.equal(result.status, 'normal-ci-run');
  assert.equal(result.terminal, false);
  assert.equal(result.complete, false);
  assert.equal(result.fallbackEligible, false);
  assert.deepEqual(result.reasonCodes, ['run-not-terminal']);
});

test('keeps ordinary push/main evidence outside PR required-context fallback', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture({ event: 'push' }),
    jobs: completeRoster(),
  });
  assert.equal(result.status, 'ordinary-push-main');
  assert.equal(result.event, 'push');
  assert.equal(result.fallbackEligible, false);
});

test('normalizes API-shaped event names before separating ordinary push/main evidence', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture({ event: undefined, event_name: 'PUSH' }),
    jobs: completeRoster(),
  });
  assert.equal(result.status, 'ordinary-push-main');
  assert.equal(result.event, 'push');
  assert.equal(result.actionable, true);
});

test('keeps an operational incident skip fail-closed and actionable', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture({ event: 'push', operationalContext: 'GitHub incident operational' }),
    jobs: completeRoster().map((job) => ({ ...job, conclusion: 'skipped' })),
  });
  assert.equal(result.status, 'operational-skip');
  assert.equal(result.fallbackEligible, false);
  assert.equal(result.actionable, true);
  assert.deepEqual(result.reasonCodes, ['incident-skip']);
  assert.equal(result.operationalMarker, 'github incident operational');
});

test('distinguishes the required-context skip and evidence-admission matrix', () => {
  const cases = [
    ['operational-skip', { run: runFixture({ conclusion: 'skipped' }) }],
    ['zero-job', { run: runFixture(), jobs: [] }],
    ['api-error', { apiError: new Error('fixture transport failure') }],
    ['partial-roster', { run: runFixture(), jobs: completeRoster().slice(0, -1) }],
    [
      'partial-roster',
      { run: runFixture(), jobs: [...completeRoster(), jobFixture(REQUIRED_CHECK_NAMES[0])] },
    ],
    [
      'genuine-failure',
      {
        run: runFixture(),
        jobs: completeRoster().map((job, index) =>
          index === 0 ? { ...job, conclusion: 'failure' } : job,
        ),
      },
    ],
  ];
  for (const [expectedStatus, input] of cases) {
    const result = classifyRequiredContextAdmission(input);
    assert.equal(result.status, expectedStatus);
    assert.equal(result.fallbackEligible, false, expectedStatus);
    assert.equal(result.actionable, expectedStatus !== 'normal-ci-run', expectedStatus);
    assert.equal(result.terminal, expectedStatus !== 'api-error' || input.run !== undefined);
  }
});

test('retains duplicate required contexts as a partial roster instead of treating the set as complete', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture(),
    jobs: [...completeRoster(), jobFixture(REQUIRED_CHECK_NAMES[0])],
  });
  assert.equal(result.status, 'partial-roster');
  assert.deepEqual(result.missingContexts, []);
  assert.deepEqual(result.duplicateContexts, [REQUIRED_CHECK_NAMES[0]]);
  assert.deepEqual(result.reasonCodes, ['duplicate-context']);
  assert.equal(result.actionable, true);
});

test('rejects malformed job entries as partial and actionable roster evidence', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture(),
    jobs: [...completeRoster(), { id: 'malformed', conclusion: 'success' }],
  });
  assert.equal(result.status, 'partial-roster');
  assert.deepEqual(result.malformedJobs, [completeRoster().length]);
  assert.deepEqual(result.reasonCodes, ['malformed-roster']);
  assert.equal(result.actionable, true);
});

test('classifies unknown terminal conclusions as API errors rather than synthetic success', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture({ conclusion: 'neutral' }),
  });
  assert.equal(result.status, 'api-error');
  assert.deepEqual(result.reasonCodes, ['run-conclusion-unknown']);
  assert.equal(result.fallbackEligible, false);
  assert.equal(result.actionable, true);
});

test('classifies an explicit terminal run failure before looking for a roster', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture({ conclusion: 'failure' }),
  });
  assert.equal(result.status, 'genuine-failure');
  assert.deepEqual(result.reasonCodes, ['run-failed']);
  assert.equal(result.terminal, true);
  assert.equal(result.actionable, true);
});

test('isolates simultaneous metrics and WebKit failures in the exact required roster', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture(),
    jobs: completeRoster().map((job) =>
      job.name === 'metrics-validate' || job.name === 'webkit-fallback'
        ? { ...job, conclusion: 'failure' }
        : job,
    ),
  });
  assert.equal(result.status, 'genuine-failure');
  assert.equal(result.terminal, true);
  assert.equal(result.complete, false);
  assert.equal(result.fallbackEligible, false);
  assert.equal(result.actionable, true);
  assert.deepEqual(result.failedContexts, ['webkit-fallback', 'metrics-validate']);
  assert.deepEqual(result.reasonCodes, ['required-context-failed']);
});

test('keeps an incomplete required job out of terminal coverage evidence', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture(),
    jobs: completeRoster().map((job, index) =>
      index === 0 ? { ...job, conclusion: null, status: 'completed' } : job,
    ),
  });
  assert.equal(result.status, 'api-error');
  assert.equal(result.complete, false);
  assert.deepEqual(result.unknownContexts, [REQUIRED_CHECK_NAMES[0]]);
});

test('rejects a run whose event identity is missing', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture({ event: undefined }),
    jobs: completeRoster(),
  });
  assert.equal(result.status, 'api-error');
  assert.deepEqual(result.reasonCodes, ['run-event-missing']);
});

test('never admits a skipped required job as complete coverage', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture(),
    jobs: completeRoster().map((job, index) =>
      index === 0 ? { ...job, conclusion: 'skipped', runner_id: null, runner_name: null } : job,
    ),
  });
  assert.equal(result.status, 'operational-skip');
  assert.equal(result.complete, false);
  assert.deepEqual(result.skippedContexts, [REQUIRED_CHECK_NAMES[0]]);
});

test('does not convert an API error into a path-filtered success', () => {
  const result = classifyRequiredContextAdmission({ pathFiltered: true, apiError: 'rate limited' });
  assert.equal(result.status, 'api-error');
  assert.equal(result.fallbackEligible, false);
  assert.deepEqual(result.reasonCodes, ['api-error']);
});

test('selects the newest pull request ci.yml run', () => {
  const newest = run({ createdAt: '2026-07-15T00:01:00Z' });
  assert.equal(
    pickLatestPullRequestRun([run({ createdAt: '2026-07-15T00:00:00Z' }), newest]),
    newest,
  );
});

test('selects the newest API-shaped run using created_at', () => {
  const oldest = run({ createdAt: undefined, created_at: '2026-07-15T00:00:00Z' });
  const newest = run({ createdAt: undefined, created_at: '2026-07-15T00:01:00Z' });
  assert.equal(pickLatestPullRequestRun([oldest, newest]), newest);
});

function runWithFakeGitHub(runs, extraEnvironment = {}) {
  const root = mkdtempSync(join(tmpdir(), 'required-ci-checks-'));
  const callLog = join(root, 'calls');
  const fakeGh = join(root, 'gh');
  writeFileSync(
    fakeGh,
    [
      '#!/bin/sh',
      'case " $* " in *" --repo "*) exit 1;; esac',
      'if [ "$1" = "api" ] && [ "$3" = "GET" ]; then case "$4" in */attempts/*) printf "{\\"jobs\\":%s}" "$GH_JOB_LIST_JSON";; *) printf "{\\"workflow_runs\\":%s}" "$GH_RUN_LIST_JSON";; esac; exit 0; fi',
      'printf "unexpected GitHub mutation: %s\\n" "$*" >> "$GH_CALL_LOG"; exit 99;',
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  try {
    execFileSync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        CI_RUN_APPEAR_MS: '0',
        GH_CALL_LOG: callLog,
        GH_JOB_LIST_JSON: '[]',
        GH_RUN_LIST_JSON: JSON.stringify(runs),
        GITHUB_REPOSITORY: 'ForgeaX-Games/forgeax-engine',
        PATH: `${root}:${process.env.PATH}`,
        PR_HEAD_SHA: 'deadbeef',
        ...extraEnvironment,
      },
      stdio: 'pipe',
    });
    try {
      return readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

test('does not create fallback checks when a run is absent without path-filter proof', () => {
  assert.throws(
    () => runWithFakeGitHub([]),
    (error) => {
      assert.equal(error.status, 2);
      assert.match(error.stderr.toString(), /path-filtered-unproven/);
      return true;
    },
  );
});

test('keeps a complete terminal run as the owner without mutating checks', () => {
  assert.deepEqual(
    runWithFakeGitHub([runFixture()], {
      GH_JOB_LIST_JSON: JSON.stringify(completeRoster()),
    }),
    [],
  );
});

test('rejects a terminal zero-job run before any fallback mutation', () => {
  assert.throws(
    () => runWithFakeGitHub([runFixture()], { GH_JOB_LIST_JSON: '[]' }),
    (error) => {
      assert.equal(error.status, 2);
      assert.match(error.stderr.toString(), /zero-job/);
      return true;
    },
  );
});

test('rejects an operationally skipped run without requesting or mutating checks', () => {
  assert.throws(
    () => runWithFakeGitHub([runFixture({ conclusion: 'skipped' })]),
    (error) => {
      assert.equal(error.status, 2);
      assert.match(error.stderr.toString(), /operational-skip/);
      return true;
    },
  );
});

test('installs the reporter prerequisites before running the required-context reporter', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const setupNode = workflow.indexOf('uses: actions/setup-node@v5');
  const setupPnpm = workflow.indexOf('uses: pnpm/action-setup@v5');
  const installGh = workflow.indexOf('command -v gh >/dev/null');
  const reporter = workflow.indexOf('run: node scripts/ci/required-ci-checks.mjs');

  assert.equal(setupPnpm, -1, 'required-ci-checks must not install unused pnpm');
  assert.ok(setupNode >= 0, 'required-ci-checks must install Node explicitly');
  assert.ok(installGh >= 0, 'required-ci-checks must ensure gh is available explicitly');
  assert.ok(reporter >= 0, 'required-ci-checks must run the reporter script');
  assert.ok(setupNode < reporter, 'Node setup must precede the reporter script');
  assert.ok(installGh < reporter, 'gh setup must precede the reporter script');
  assert.match(
    workflow,
    /uses: actions\/setup-node@v5\s+with:\s+node-version-file: \.nvmrc\s+package-manager-cache: false/,
    'the reporter-only Node setup must not save an unused pnpm cache',
  );
});

test('validates PR-head workflows with pinned actionlint before synthetic passes', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const checkoutHead = workflow.indexOf('name: Checkout PR-head workflow definitions');
  const installActionlint = workflow.indexOf('name: Install pinned actionlint');
  const runActionlint = workflow.indexOf('name: Validate PR-head workflow definitions');
  const verifyRuleset = workflow.indexOf('name: Verify required-check ruleset');
  const reporter = workflow.indexOf('run: node scripts/ci/required-ci-checks.mjs');

  assert.ok(checkoutHead >= 0, 'admission must read workflow definitions from the PR head');
  assert.match(
    workflow,
    /repository: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/,
  );
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /path: pr-head/);
  assert.match(
    workflow,
    /sparse-checkout:\s+\|\s+\.github\/workflows\s+\.github\/actionlint\.yaml/,
  );
  assert.ok(
    installActionlint > checkoutHead,
    'pinned actionlint installs after the isolated checkout',
  );
  assert.match(workflow, /rhysd\/actionlint[^\n]*v1\.7\.12/);
  assert.ok(runActionlint > installActionlint, 'actionlint runs after its pinned install');
  assert.ok(
    verifyRuleset > runActionlint,
    'ruleset drift must be checked after workflow validation',
  );
  assert.match(
    workflow,
    /name: Verify required-check ruleset[\s\S]*?GH_TOKEN: \$\{\{ github\.token \}\}[\s\S]*?GITHUB_REPOSITORY: \$\{\{ github\.repository \}\}[\s\S]*?run: node scripts\/ci\/audit-required-checks-ruleset\.mjs/,
  );
  assert.ok(
    reporter > verifyRuleset,
    'synthetic required passes are impossible before workflow and ruleset validation',
  );
  assert.match(workflow, /working-directory: pr-head/);
});

// t7: don't-break — build-artifacts remains a required context name after M2
test('t7: REQUIRED_CHECK_NAMES includes build-artifacts as required context', () => {
  assert.ok(
    REQUIRED_CHECK_NAMES.includes('build-artifacts'),
    'build-artifacts must be in REQUIRED_CHECK_NAMES after M2 workflow split',
  );
});

test('t7: REQUIRED_CHECK_NAMES includes every direct CI gate', () => {
  assert.strictEqual(
    REQUIRED_CHECK_NAMES.length,
    19,
    'REQUIRED_CHECK_NAMES must include the legacy smoke aggregates and matrix gates',
  );
});
