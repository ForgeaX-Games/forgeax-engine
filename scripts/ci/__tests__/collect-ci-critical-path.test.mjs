import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectCriticalPath } from '../collect-ci-critical-path.mjs';

const expected = {
  runId: 42,
  runAttempt: 1,
  headSha: 'a'.repeat(40),
  inputFingerprint: `sha256:${'b'.repeat(64)}`,
};
const roster = ['core-build', 'test-a', 'test-b'];

function job(name, start, end, conclusion = 'success', pool = 'standard') {
  const instant = (second) =>
    new Date(Date.parse('2026-08-12T00:00:00Z') + second * 1000).toISOString();
  return {
    name,
    runAttempt: 1,
    conclusion,
    runnerId: name === 'test-b' ? 204 : 201,
    runnerName: `${pool}-runner-${name}`,
    pool,
    createdAt: '2026-08-12T00:00:00Z',
    startedAt: instant(start),
    completedAt: instant(end),
    queueWaitSeconds: start,
    activeSeconds: end - start,
    totalSeconds: end,
    command: `pnpm ${name}`,
    workerCount: 1,
    resourceProbe: { source: 'cgroup', cpus: pool === 'heavy' ? 8 : 4, memoryGB: 8 },
  };
}

function fixture() {
  return {
    schemaVersion: 1,
    run: {
      ...expected,
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-08-12T00:00:00Z',
      completedAt: '2026-08-12T00:01:00Z',
    },
    wallClock: { requiredJobRoster: roster },
    jobs: [
      job('core-build', 0, 10),
      job('test-a', 10, 30, 'success', 'heavy'),
      job('test-b', 10, 40, 'success', 'heavy'),
      { ...job('cost-reporter', 40, 60), required: false },
    ],
  };
}

function clone(value) {
  return structuredClone(value);
}

test('projects full-run wall, queue/active/total, overlap, and reporting tail', () => {
  const result = projectCriticalPath(fixture());
  assert.equal(result.status, 'valid');
  assert.equal(result.admissible, true);
  assert.deepEqual(result.fullRunWall, {
    startAt: '2026-08-12T00:00:00Z',
    endAt: '2026-08-12T00:01:00Z',
    seconds: 60,
    source: 'run-boundary',
  });
  assert.deepEqual(result.totals.totals, {
    queueWaitSeconds: 60,
    activeSeconds: 80,
    totalSeconds: 140,
  });
  assert.equal(result.criticalPath.seconds, 40);
  assert.equal(result.criticalPath.unionSeconds, 40);
  assert.equal(result.criticalPath.overlapSeconds, 20);
  assert.equal(result.criticalPath.overlapRatio, 0.333333);
  assert.equal(result.postCriticalReportingTail.seconds, 20);
  assert.deepEqual(result.postCriticalReportingTail.jobs, ['cost-reporter']);
  assert.equal(result.requiredCorrectness.status, 'pass');
  assert.equal(result.firstFailure, null);
});

test('derives the full-run wall from terminal job facts when no run boundary is present', () => {
  const packet = fixture();
  delete packet.run.createdAt;
  delete packet.run.completedAt;
  const result = projectCriticalPath(packet);
  assert.equal(result.status, 'valid');
  assert.equal(result.fullRunWall.seconds, 60);
  assert.equal(result.fullRunWall.source, 'job-boundary');
});

test('keeps a terminal first failure distinct from required correctness failure', () => {
  const packet = fixture();
  packet.jobs[2].conclusion = 'failure';
  const result = projectCriticalPath(packet);
  assert.equal(result.status, 'valid');
  assert.equal(result.requiredCorrectness.status, 'fail');
  assert.equal(result.requiredCorrectness.failedJobCount, 1);
  assert.deepEqual(result.firstFailure, {
    name: 'test-b',
    conclusion: 'failure',
    completedAt: '2026-08-12T00:00:40.000Z',
    completedMilliseconds: Date.parse('2026-08-12T00:00:40Z'),
  });
});

test('fails closed for incomplete, runner-null, nonterminal, and reversed facts', () => {
  const cases = [
    [
      'runner-null-pre-run-skip',
      (packet) => {
        packet.jobs[1].conclusion = 'skipped';
        packet.jobs[1].runnerId = null;
        packet.jobs[1].runnerName = null;
      },
    ],
    [
      'run-nonterminal',
      (packet) => {
        packet.run.status = 'in_progress';
      },
    ],
    [
      'run-conclusion-missing',
      (packet) => {
        delete packet.run.conclusion;
      },
    ],
    [
      'timing-invalid',
      (packet) => {
        packet.jobs[0].completedAt = '2026-08-11T23:59:59Z';
      },
    ],
    [
      'incomplete-roster',
      (packet) => {
        packet.jobs = packet.jobs.slice(0, 2);
      },
    ],
    [
      'fingerprint-missing',
      (packet) => {
        delete packet.run.inputFingerprint;
      },
    ],
  ];
  for (const [code, mutate] of cases) {
    const packet = clone(fixture());
    mutate(packet);
    const result = projectCriticalPath(packet);
    assert.equal(result.status, 'invalidEvidence', code);
    assert.equal(result.admissible, false, code);
    assert.equal(result.reasonCodes.includes(code), true, code);
    assert.equal(result.criticalPath, null, code);
  }
});

test('rejects missing or ambiguous required correctness facts', () => {
  const missing = fixture();
  delete missing.jobs[1].completedAt;
  const missingResult = projectCriticalPath(missing);
  assert.equal(missingResult.requiredCorrectness.status, 'invalidEvidence');
  assert.equal(missingResult.reasonCodes.includes('required-job-timing-missing'), true);

  const ambiguous = fixture();
  ambiguous.jobs[1].conclusion = 'failure';
  ambiguous.jobs[2].conclusion = 'failure';
  ambiguous.jobs[1].completedAt = '2026-08-12T00:00:40Z';
  ambiguous.jobs[1].activeSeconds = 30;
  ambiguous.jobs[1].totalSeconds = 40;
  const ambiguousResult = projectCriticalPath(ambiguous);
  assert.equal(ambiguousResult.status, 'invalidEvidence');
  assert.equal(ambiguousResult.reasonCodes.includes('first-failure-ambiguous'), true);
});

test('module remains hermetic and reuses no GitHub transport', () => {
  const source = readFileSync(new URL('../collect-ci-critical-path.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:gh|GITHUB_ACTIONS|GITHUB_API_URL|fetch)\b/);
  assert.doesNotMatch(source, /(?:execFile|spawn)\s*\(/);
});
