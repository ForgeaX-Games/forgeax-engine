import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeRunPacket } from '../normalize-run-packet.mjs';

const expected = {
  runId: 42,
  headSha: 'a'.repeat(40),
  runAttempt: 1,
  treatmentId: 'baseline',
  inputFingerprint: `sha256:${'b'.repeat(64)}`,
  declaredRoster: ['core-build', 'coverage-pnpm'],
  artifactRoster: ['artifact-core'],
};

function job(name, pool = 'standard') {
  return {
    id: name === 'core-build' ? 101 : 102,
    name,
    run_attempt: 1,
    conclusion: 'success',
    runner_id: name === 'core-build' ? 201 : 202,
    runner_name: `${pool}-runner`,
    labels: ['self-hosted', pool],
    command: name === 'core-build' ? 'pnpm build:engine' : 'pnpm test:unit --coverage',
    maxWorkers: name === 'core-build' ? 2 : 6,
    resourceProbe: {
      source: 'cgroup',
      cpus: pool === 'heavy' ? 8 : 4,
      memoryGB: pool === 'heavy' ? 15 : 8,
    },
    created_at: '2026-08-12T00:00:00Z',
    started_at: '2026-08-12T00:00:05Z',
    completed_at: '2026-08-12T00:00:25Z',
    queueWaitSeconds: 5,
    activeSeconds: 20,
    totalSeconds: 25,
  };
}

function fixture() {
  return {
    schemaVersion: 1,
    run: {
      runId: '42',
      runAttempt: 1,
      headSha: expected.headSha,
      treatmentId: expected.treatmentId,
      inputFingerprint: expected.inputFingerprint,
      status: 'completed',
      conclusion: 'success',
    },
    jobs: [job('core-build'), job('coverage-pnpm', 'heavy')],
    artifacts: [
      {
        id: 'artifact-core',
        workflow_run: { id: 42, run_attempt: 1 },
        headSha: expected.headSha,
        treatmentId: expected.treatmentId,
        inputFingerprint: expected.inputFingerprint,
      },
    ],
  };
}

function clone(value) {
  return structuredClone(value);
}

test('admits an executable packet only when identity, roster, facts, pools, and timings are complete', () => {
  const result = normalizeRunPacket(fixture(), expected);
  assert.equal(result.admissible, true);
  assert.equal(result.status, 'admissible');
  assert.deepEqual(result.reasonCodes, []);
  assert.deepEqual(
    result.jobs.map(({ name, pool, status }) => ({ name, pool, status })),
    [
      { name: 'core-build', pool: 'standard', status: 'valid' },
      { name: 'coverage-pnpm', pool: 'heavy', status: 'valid' },
    ],
  );
});

test('derives timing values only from a complete ordered timestamp triplet', () => {
  const packet = fixture();
  for (const target of packet.jobs) {
    delete target.queueWaitSeconds;
    delete target.activeSeconds;
    delete target.totalSeconds;
  }
  const result = normalizeRunPacket(packet, expected);
  assert.equal(result.admissible, true);
  assert.deepEqual(result.jobs[0].timing, {
    createdAt: '2026-08-12T00:00:00Z',
    startedAt: '2026-08-12T00:00:05Z',
    completedAt: '2026-08-12T00:00:25Z',
    queueWaitSeconds: 5,
    activeSeconds: 20,
    totalSeconds: 25,
  });
});

test('classifies the required fail-closed packet matrix with deterministic reason codes', () => {
  const cases = [
    [
      'runner-null-pre-run-skip',
      (packet) => {
        const target = packet.jobs[1];
        target.conclusion = 'skipped';
        target.runner_id = null;
        target.runner_name = null;
      },
    ],
    [
      'zero-jobs',
      (packet) => {
        packet.jobs = [];
      },
    ],
    [
      'attempt-mismatch',
      (packet) => {
        packet.run.runAttempt = 2;
      },
    ],
    [
      'fingerprint-mismatch',
      (packet) => {
        packet.run.inputFingerprint = `sha256:${'c'.repeat(64)}`;
      },
    ],
    [
      'run-nonterminal',
      (packet) => {
        packet.run.status = 'in_progress';
      },
    ],
    [
      'run-id-missing',
      (packet) => {
        delete packet.run.runId;
      },
    ],
    [
      'run-failed',
      (packet) => {
        packet.run.conclusion = 'failure';
      },
    ],
    [
      'run-conclusion-missing',
      (packet) => {
        delete packet.run.conclusion;
      },
    ],
    [
      'run-conclusion-unknown',
      (packet) => {
        packet.run.conclusion = 'not-a-real-conclusion';
      },
    ],
    [
      'run-status-unknown',
      (packet) => {
        packet.run.status = 'not-a-real-status';
      },
    ],
    [
      'missing-cgroup-probe',
      (packet) => {
        delete packet.jobs[0].resourceProbe;
      },
    ],
    [
      'missing-timestamp',
      (packet) => {
        packet.jobs[0].started_at = null;
      },
    ],
    [
      'reversed-timestamp',
      (packet) => {
        packet.jobs[0].completed_at = '2026-08-11T23:59:59Z';
      },
    ],
    [
      'missing-pool',
      (packet) => {
        packet.jobs[0].labels = ['self-hosted'];
      },
    ],
    [
      'duplicate-pool',
      (packet) => {
        packet.jobs[0].labels = ['self-hosted', 'standard', 'heavy'];
      },
    ],
    [
      'incomplete-roster',
      (packet) => {
        packet.jobs = [packet.jobs[0]];
      },
    ],
  ];
  for (const [code, mutate] of cases) {
    const packet = clone(fixture());
    mutate(packet);
    const result = normalizeRunPacket(packet, expected);
    assert.equal(result.admissible, false, code);
    assert.equal(result.reasonCodes.includes(code), true, code);
  }
});

test('classifies every known nonterminal run state as unknown and fail-closed', () => {
  for (const status of ['queued', 'requested', 'waiting', 'in_progress']) {
    const packet = fixture();
    packet.run.status = status;
    const result = normalizeRunPacket(packet, expected);
    assert.equal(result.admissible, false, status);
    assert.equal(result.classification, 'unknown', status);
    assert.deepEqual(result.reasonCodes, ['run-nonterminal'], status);
  }
});

test('classifies every explicit terminal failure before admitting packet facts', () => {
  for (const conclusion of [
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'startup_failure',
    'stale',
  ]) {
    const packet = fixture();
    packet.run.conclusion = conclusion;
    const result = normalizeRunPacket(packet, expected);
    assert.equal(result.admissible, false, conclusion);
    assert.equal(result.classification, 'invalid', conclusion);
    assert.deepEqual(result.reasonCodes, ['run-failed'], conclusion);
    assert.deepEqual(result.reasons, [
      { code: 'run-failed', scope: 'run', detail: { conclusion } },
    ]);
  }
});

test('rejects identity and artifact provenance mismatches without changing the packet', () => {
  const packet = fixture();
  const before = structuredClone(packet);
  packet.run.headSha = 'c'.repeat(40);
  packet.artifacts[0].workflow_run.id = 99;
  packet.artifacts[0].inputFingerprint = `sha256:${'c'.repeat(64)}`;
  const result = normalizeRunPacket(packet, expected);
  assert.equal(result.admissible, false);
  assert.equal(result.reasonCodes.includes('head-sha-mismatch'), true);
  assert.equal(result.reasonCodes.includes('artifact-run-mismatch'), true);
  assert.equal(result.reasonCodes.includes('artifact-fingerprint-mismatch'), true);
  assert.deepEqual(before.run.runId, '42');
  assert.equal(packet.jobs[0].maxWorkers, 2);
});

test('rejects each missing artifact identity field with an observable expected value', () => {
  const cases = [
    [
      'runId',
      'artifact-binding-missing',
      (artifact) => {
        delete artifact.runId;
        delete artifact.workflow_run.id;
      },
    ],
    [
      'runAttempt',
      'artifact-attempt-missing',
      (artifact) => {
        delete artifact.runAttempt;
        delete artifact.workflow_run.run_attempt;
      },
    ],
    ['headSha', 'artifact-head-missing', (artifact) => delete artifact.headSha],
    ['treatmentId', 'artifact-treatment-missing', (artifact) => delete artifact.treatmentId],
    [
      'inputFingerprint',
      'artifact-fingerprint-missing',
      (artifact) => {
        delete artifact.inputFingerprint;
      },
    ],
  ];

  for (const [field, code, remove] of cases) {
    const packet = fixture();
    remove(packet.artifacts[0]);
    const result = normalizeRunPacket(packet, expected);
    const reason = result.reasons.find((entry) => entry.code === code);
    assert.notEqual(result.admissible, true, field);
    assert.ok(reason, field);
    assert.equal(reason.detail.expected, expected[field], field);
    assert.equal(reason.detail.observed, null, field);
  }
});

test('rejects each mismatched artifact identity field with expected and observed values', () => {
  const cases = [
    [
      'runId',
      'artifact-run-mismatch',
      (artifact) => {
        artifact.runId = 99;
      },
    ],
    [
      'runAttempt',
      'artifact-attempt-mismatch',
      (artifact) => {
        artifact.runAttempt = 2;
      },
    ],
    [
      'headSha',
      'artifact-head-mismatch',
      (artifact) => {
        artifact.headSha = 'c'.repeat(40);
      },
    ],
    [
      'treatmentId',
      'artifact-treatment-mismatch',
      (artifact) => {
        artifact.treatmentId = 'treatment';
      },
    ],
    [
      'inputFingerprint',
      'artifact-fingerprint-mismatch',
      (artifact) => {
        artifact.inputFingerprint = `sha256:${'c'.repeat(64)}`;
      },
    ],
  ];

  for (const [field, code, mismatch] of cases) {
    const packet = fixture();
    mismatch(packet.artifacts[0]);
    const result = normalizeRunPacket(packet, expected);
    const reason = result.reasons.find((entry) => entry.code === code);
    assert.notEqual(result.admissible, true, field);
    assert.ok(reason, field);
    assert.equal(reason.detail.expected, expected[field], field);
    assert.equal(reason.detail.observed, packet.artifacts[0][field], field);
  }
});

test('does not infer capacity from labels or runner names and requires a cgroup probe', () => {
  const packet = fixture();
  packet.jobs[1].resourceProbe = { source: 'runner-name', cpus: 8, memoryGB: 15 };
  packet.jobs[1].runner_name = '8C16G-heavy-runner';
  const result = normalizeRunPacket(packet, expected);
  assert.equal(result.admissible, false);
  assert.equal(result.reasonCodes.includes('resource-probe-not-cgroup'), true);
  assert.equal(result.jobs[1].resourceProbe.source, 'runner-name');
});

test('accepts the native requestedLabels projection for pool evidence', () => {
  const packet = fixture();
  for (const target of packet.jobs) delete target.labels;
  packet.jobs[0].requestedLabels = ['self-hosted', 'standard'];
  packet.jobs[1].requestedLabels = ['self-hosted', 'heavy'];
  const result = normalizeRunPacket(packet, expected);
  assert.equal(result.admissible, true);
  assert.deepEqual(
    result.jobs.map(({ pool }) => pool),
    ['standard', 'heavy'],
  );
});

test('preserves duplicate pool declarations instead of deduplicating candidates', () => {
  const packet = fixture();
  packet.jobs[0].labels = ['self-hosted', 'standard', 'standard'];
  const result = normalizeRunPacket(packet, expected);
  assert.equal(result.admissible, false);
  assert.equal(result.reasonCodes.includes('duplicate-pool'), true);
});

test('module is hermetic and has no GitHub or process-dispatch dependency', () => {
  const source = readFileSync(new URL('../normalize-run-packet.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:gh|GITHUB_ACTIONS|GITHUB_API_URL)\b/);
  assert.doesNotMatch(source, /(?:execFile|spawn|fetch)\s*\(/);
});

test('binds the complete packet identity and rejects malformed identity mutations', () => {
  const valid = normalizeRunPacket(fixture(), expected);
  assert.equal(valid.admissible, true);
  assert.deepEqual(valid.identity, {
    runId: 42,
    headSha: expected.headSha,
    runAttempt: 1,
    treatmentId: 'baseline',
    inputFingerprint: expected.inputFingerprint,
  });

  const cases = [
    ['missing-treatment-id', (packet) => delete packet.run.treatmentId, 'treatment-id-missing'],
    [
      'foreign-treatment-id',
      (packet) => {
        packet.run.treatmentId = 'treatment';
      },
      'treatment-id-mismatch',
    ],
    [
      'mixed-job-treatment-id',
      (packet) => {
        packet.jobs[0].treatmentId = 'treatment';
      },
      'treatment-id-mismatch',
    ],
    [
      'non-positive-attempt',
      (packet) => {
        packet.run.runAttempt = 0;
      },
      'attempt-invalid',
    ],
    [
      'short-head-sha',
      (packet) => {
        packet.run.headSha = 'deadbeef';
      },
      'head-sha-invalid',
    ],
    [
      'foreign-artifact-identity',
      (packet) => {
        packet.artifacts[0].id = 'artifact-foreign';
      },
      'incomplete-artifact-roster',
    ],
    [
      'mixed-artifact-treatment-id',
      (packet) => {
        packet.artifacts[0].treatmentId = 'treatment';
      },
      'artifact-treatment-mismatch',
    ],
    [
      'stale-provenance-fingerprint',
      (packet) => {
        packet.jobs[0].inputFingerprint = `sha256:${'c'.repeat(64)}`;
      },
      'fingerprint-mismatch',
    ],
  ];

  for (const [name, mutate, reasonCode] of cases) {
    const packet = clone(fixture());
    mutate(packet);
    const result = normalizeRunPacket(packet, expected);
    assert.equal(result.admissible, false, name);
    assert.equal(result.reasonCodes.includes(reasonCode), true, name);
  }
});

test('keeps absent packets and nonterminal runs unknown without manufacturing timing or capacity', () => {
  const absent = normalizeRunPacket(null, expected);
  assert.equal(absent.admissible, false);
  assert.equal(absent.classification, 'unknown');
  assert.deepEqual(absent.reasonCodes, ['packet-missing']);

  for (const status of ['queued', 'requested', 'waiting', 'in_progress']) {
    const packet = fixture();
    packet.run.status = status;
    const result = normalizeRunPacket(packet, expected);
    assert.equal(result.admissible, false, status);
    assert.equal(result.classification, 'unknown', status);
    assert.equal(result.reasonCodes.includes('run-nonterminal'), true, status);
    assert.equal(Object.hasOwn(result.jobs[0], 'queueLatencySeconds'), false, status);
    assert.equal(Object.hasOwn(result.jobs[0], 'physicalHost'), false, status);
  }
});
