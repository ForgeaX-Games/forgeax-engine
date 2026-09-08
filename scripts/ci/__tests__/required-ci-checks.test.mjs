import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyRequiredContextAdmission,
  REQUIRED_CHECK_NAMES,
  REQUIRED_CONTEXT_ADMISSION_STATUSES,
} from '../required-ci-checks.mjs';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../required-ci-checks.json', import.meta.url)), 'utf8'),
);

test('lists the exact direct CI contexts selected for fallback evidence', () => {
  assert.deepEqual(REQUIRED_CHECK_NAMES, manifest);
  assert.equal(new Set(manifest).size, manifest.length);
});

test('keeps the authoritative required roster at the exact 21 logical contexts', () => {
  assert.deepEqual(REQUIRED_CHECK_NAMES, [
    'build-artifacts',
    'primary-pnpm',
    'coverage-pnpm',
    'coverage-perf',
    'vitest-browser',
    'shared-inputs-browser',
    'smoke-fleet',
    'smoke-fleet-0',
    'smoke-fleet-1',
    'smoke-fleet-2',
    'bevy-smoke-fleet',
    'bevy-smoke-fleet-0',
    'bevy-smoke-fleet-1',
    'bevy-smoke-fleet-2',
    'vitest-dawn',
    'webkit-fallback',
    'portability-bun',
    'metrics-validate-browser',
    'metrics-validate-runtime',
    'metrics-validate',
    'collectathon-boot-e2e',
  ]);
  assert.equal(REQUIRED_CHECK_NAMES.length, 21);
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

test('admits non-required producer jobs alongside a complete required roster', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture(),
    jobs: [
      jobFixture('core-build'),
      jobFixture('shared-app-inputs'),
      jobFixture('app-shard-0'),
      ...completeRoster(),
    ],
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

test('keeps every queued API run nonterminal and fail-closed', () => {
  for (const status of ['queued', 'requested', 'waiting']) {
    const result = classifyRequiredContextAdmission({
      run: runFixture({ status }),
    });
    assert.equal(result.status, 'normal-ci-run', status);
    assert.equal(result.terminal, false, status);
    assert.equal(result.complete, false, status);
    assert.equal(result.fallbackEligible, false, status);
    assert.deepEqual(result.reasonCodes, ['run-not-terminal'], status);
  }
});

test('keeps an unknown run status out of terminal reconciliation', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture({ status: 'reconciling' }),
  });
  assert.equal(result.status, 'api-error');
  assert.equal(result.terminal, false);
  assert.equal(result.complete, false);
  assert.equal(result.fallbackEligible, false);
  assert.deepEqual(result.reasonCodes, ['run-status-unknown']);
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

test('emits a deterministic simultaneous coverage and browser failure packet', () => {
  const result = classifyRequiredContextAdmission({
    run: runFixture(),
    jobs: completeRoster()
      .map((job) =>
        job.name === 'coverage-pnpm' || job.name === 'vitest-browser'
          ? { ...job, conclusion: 'failure' }
          : job,
      )
      .reverse(),
  });
  assert.equal(REQUIRED_CHECK_NAMES.length, 21);
  assert.equal(result.status, 'genuine-failure');
  assert.equal(result.actionable, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.failedContexts, ['coverage-pnpm', 'vitest-browser']);
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
    21,
    'REQUIRED_CHECK_NAMES must include the legacy smoke aggregates and matrix gates',
  );
});
