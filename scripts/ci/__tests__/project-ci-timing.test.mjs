import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectCiTiming } from '../project-ci-timing.mjs';

const root = join(new URL('.', import.meta.url).pathname, '..', '..', '..');
const summaryScript = join(root, 'scripts', 'ci', 'write-ci-cost-summary.mjs');

function instant(second) {
  return new Date(Date.parse('2026-08-12T00:00:00Z') + second * 1000).toISOString();
}

function job(name, start, end, conclusion = 'success', extra = {}) {
  return {
    name,
    result: conclusion,
    createdAt: instant(start),
    startedAt: instant(start),
    completedAt: instant(end),
    queueWaitSeconds: 0,
    activeSeconds: end - start,
    totalSeconds: end - start,
    ...extra,
  };
}

function fixture() {
  return {
    runId: 42,
    runAttempt: 1,
    wallClock: { requiredJobRoster: ['build', 'test-a', 'test-b', 'sticky-comment'] },
    jobs: [
      job('build', 0, 10),
      job('test-a', 10, 30),
      job('test-b', 10, 40),
      job('sticky-comment', 40, 40, 'skipped', { status: 'invalidEvidence' }),
      job('cost-reporter', 40, 60),
    ],
    consumers: [
      {
        name: 'test-a',
        lastRequiredArtifactReadyAt: instant(5),
        startedAt: instant(30),
      },
      { name: 'publish', lastRequiredArtifactReadyAt: null, startedAt: null },
    ],
    ac06: {
      perConsumer: [
        { jobIdentity: 'test-a', status: 'pass' },
        { jobIdentity: 'publish', status: 'notApplicable' },
      ],
    },
    artifacts: [],
    artifactBytes: {
      totalCompressedBytes: 0,
      totalExpandedBytes: 0,
      compressionRatio: null,
      byClass: {},
    },
    returnEvidence: { families: [] },
    sharedProduction: {},
    cache: {},
  };
}

test('projects critical path, overlap, reporting tail, cost delay, sticky skip, and artifact delay', () => {
  const result = projectCiTiming(fixture());
  assert.equal(result.status, 'valid');
  assert.equal(result.admissible, true);
  assert.equal(result.fullRunWall.seconds, 60);
  assert.equal(result.criticalPath.seconds, 40);
  assert.equal(result.criticalPath.unionSeconds, 40);
  assert.equal(result.criticalPath.overlapSeconds, 20);
  assert.equal(result.criticalPath.overlapRatio, 0.333333);
  assert.equal(result.postCriticalReportingTail.seconds, 20);
  assert.deepEqual(result.postCriticalReportingTail.jobs, ['cost-reporter']);
  assert.equal(result.costReporterDelay.activeSeconds, 20);
  assert.equal(result.costReporterDelay.terminalTailSeconds, 20);
  assert.equal(result.stickySkip.status, 'skipped');
  assert.equal(result.stickySkip.skipped, true);
  assert.equal(result.artifactReadyDelays.status, 'valid');
  assert.equal(result.artifactReadyDelays.consumers[0].delaySeconds, 25);
});

test('preserves explicit unknown for missing, reversed, and ambiguous packet facts', () => {
  const cases = [
    ['required-roster-incomplete', (facts) => facts.jobs.splice(1, 1)],
    ['job-timing-reversed', (facts) => (facts.jobs[1].completedAt = instant(9))],
    ['cost-reporter-ambiguous', (facts) => facts.jobs.push(job('cost-reporter', 40, 61))],
    ['job-timing-ambiguous', (facts) => (facts.jobs[0].activeSeconds = 99)],
    ['artifact-ready-delay-missing', (facts) => (facts.consumers[0].startedAt = null)],
  ];
  for (const [code, mutate] of cases) {
    const facts = fixture();
    mutate(facts);
    const result = projectCiTiming(facts);
    assert.equal(result.status, 'invalidEvidence', code);
    assert.equal(result.admissible, false, code);
    assert.equal(result.reasonCodes.includes(code), true, code);
    assert.equal(result.criticalPath, null, code);
    assert.equal(result.postCriticalReportingTail, null, code);
  }
});

test('monitor attaches the projection and summary renders neutral timing fields', () => {
  const monitor = readFileSync(join(root, 'scripts', 'ci', 'collect-ci-cost-monitor.mjs'), 'utf8');
  assert.match(monitor, /projectCiTiming/);
  assert.match(monitor, /timingProjection/);
  const facts = fixture();
  facts.timingProjection = projectCiTiming(facts);
  const temp = mkdtempSync(join(tmpdir(), 'ci-timing-summary-'));
  const factsPath = join(temp, 'facts.json');
  const summaryPath = join(temp, 'summary.md');
  try {
    writeFileSync(factsPath, JSON.stringify(facts));
    execFileSync(process.execPath, [summaryScript, '--facts', factsPath, '--output', summaryPath]);
    const output = readFileSync(summaryPath, 'utf8');
    assert.match(output, /## Timing attribution/);
    assert.match(output, /Critical-path overlap: 20 seconds/);
    assert.match(output, /Post-critical reporting tail: 20 seconds/);
    assert.match(output, /Sticky reporting: skipped/);
    assert.match(output, /\| test-a \| valid \| 25 \|/);
    assert.doesNotMatch(output, /speedup|runner.cost effect/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
