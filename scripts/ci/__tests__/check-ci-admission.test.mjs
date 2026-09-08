import assert from 'node:assert/strict';
import test from 'node:test';

import { projectCiAdmission } from '../check-ci-admission.mjs';
import { loadRoster } from '../check-full-run-terminal-slo.mjs';
import {
  REQUIRED_CHECK_NAMES,
  REQUIRED_CONTEXT_ADMISSION_STATUSES,
} from '../required-ci-checks.mjs';

const HEAD_SHA = 'a'.repeat(40);
const INPUT_FINGERPRINT = `sha256:${'b'.repeat(64)}`;
const RECOVERY_ACTIONS = new Set([
  'recollect-evidence',
  'wait-for-terminality',
  'restore-roster-classification',
  'discard-foreign-evidence',
  'measure-capacity',
]);
const RECOVERY_FIELDS = ['code', 'property', 'expected', 'observed', 'detail', 'action'];
const TERMINAL_ROSTER = loadRoster();
const TERMINAL_START = '2026-08-14T00:00:00.000Z';

function runFixture(values = {}) {
  return {
    id: 42,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    head_sha: HEAD_SHA,
    ...values,
  };
}

function jobFixture(name, values = {}) {
  return { id: `${name}-job`, name, conclusion: 'success', ...values };
}

function completeRoster() {
  return REQUIRED_CHECK_NAMES.map((name) => jobFixture(name));
}

function rawPacketFixture() {
  const jobs = REQUIRED_CHECK_NAMES.map((name, index) => ({
    id: `${name}-job`,
    name,
    runId: 42,
    runAttempt: 1,
    headSha: HEAD_SHA,
    treatmentId: 'baseline',
    inputFingerprint: INPUT_FINGERPRINT,
    conclusion: 'success',
    runner_id: index + 1,
    runner_name: `runner-${index}`,
    labels: ['self-hosted', 'standard'],
    command: 'pnpm test:unit',
    maxWorkers: 2,
    resourceProbe: { source: 'cgroup', cpus: 4, memoryGB: 8 },
    created_at: '2026-08-14T00:00:00Z',
    started_at: '2026-08-14T00:00:05Z',
    completed_at: '2026-08-14T00:00:25Z',
  }));
  return {
    run: {
      runId: 42,
      runAttempt: 1,
      headSha: HEAD_SHA,
      treatmentId: 'baseline',
      inputFingerprint: INPUT_FINGERPRINT,
      status: 'completed',
      conclusion: 'success',
    },
    jobs,
    artifacts: [
      {
        id: 'artifact-core',
        runId: 42,
        runAttempt: 1,
        headSha: HEAD_SHA,
        treatmentId: 'baseline',
        inputFingerprint: INPUT_FINGERPRINT,
      },
    ],
  };
}

function rawAdmissionInput(packet) {
  return {
    run: runFixture({ treatmentId: 'baseline', inputFingerprint: INPUT_FINGERPRINT }),
    jobs: packet.jobs,
    packet,
  };
}

function failedRoster() {
  return completeRoster().map((job, index) =>
    index === 0 ? { ...job, conclusion: 'failure' } : job,
  );
}

function identity(values = {}) {
  return { runId: 42, runAttempt: 1, headSha: HEAD_SHA, treatmentId: 'baseline', ...values };
}

function provenPathFilter() {
  return {
    identity: identity(),
    pathFiltered: true,
    pathFilterProof: { headSha: HEAD_SHA, workflow: 'ci.yml', excluded: true },
  };
}

function assertRecoveryEnvelope(result, expectedStatus) {
  assert.equal(result.status, expectedStatus);
  assert.equal(result.fallbackEligible, false);
  assert.ok(result.recoveryAction, `${expectedStatus} must expose recoveryAction`);
  for (const field of RECOVERY_FIELDS) {
    assert.ok(
      Object.hasOwn(result.recoveryAction, field),
      `${expectedStatus} recoveryAction.${field}`,
    );
  }
  assert.equal(typeof result.recoveryAction.code, 'string');
  assert.equal(typeof result.recoveryAction.property, 'string');
  assert.ok(result.recoveryAction.expected !== undefined);
  assert.ok(result.recoveryAction.observed !== undefined);
  assert.equal(typeof result.recoveryAction.detail, 'string');
  assert.equal(RECOVERY_ACTIONS.has(result.recoveryAction.action), true);
}

function terminalClassifications(overrides = {}) {
  return Object.fromEntries(
    REQUIRED_CHECK_NAMES.map((name) => [
      name,
      {
        classification: 'intentional-skip',
        predicate: 'fixture-only',
        reason: 'fixture excludes unrelated context',
        semanticCoverageFingerprint: 'sha256:fixture',
        ...overrides[name],
      },
    ]),
  );
}

function capacityJobs(
  capacity = { pool: 'standard', observation: { vcpus: 4, memoryGiB: 8, source: 'cgroup' } },
) {
  return ['build-artifacts', 'primary-pnpm'].map((name) => ({
    name,
    createdAt: '2026-08-14T00:00:20.000Z',
    startedAt: '2026-08-14T00:01:00.000Z',
    completedAt: '2026-08-14T00:05:00.000Z',
    classification: 'executed-success',
    required: true,
    capacity,
  }));
}

function packetProvenance({ runId, treatmentId, headSha }) {
  const base = { runId, runAttempt: 2, headSha, treatmentId };
  return {
    producer: { ...base, producerId: 'terminal-packet-producer', fingerprint: 'sha256:producer' },
    artifact: { ...base, artifactId: `artifact-${runId}`, fingerprint: 'sha256:artifact' },
    report: { ...base, reportId: `report-${runId}`, fingerprint: 'sha256:report' },
  };
}

function matchedPacket({
  runId,
  treatmentId,
  headSha = 'a'.repeat(40),
  wallSeconds = 600,
  classifications = terminalClassifications({
    'build-artifacts': { classification: 'executed-success' },
    'primary-pnpm': { classification: 'executed-success' },
  }),
  jobs = capacityJobs(),
  failures = [
    {
      context: 'primary-pnpm',
      occurredAt: '2026-08-14T00:08:00.000Z',
      runId,
      runAttempt: 2,
      headSha,
      treatmentId,
      conclusion: 'failure',
      reason: 'fixture failure before an authorized retry',
      retry: { class: 'authorized-test-retry', attempt: 1, maxAttempts: 2 },
    },
  ],
  retries = [
    { context: 'primary-pnpm', attempt: 1, maxAttempts: 2, class: 'authorized-test-retry' },
  ],
  rosterAuthority = {
    path: 'scripts/ci/required-ci-checks.json',
    fingerprint: TERMINAL_ROSTER.fingerprint,
  },
  terminal = {},
} = {}) {
  const source = { runId, runAttempt: 2, headSha, treatmentId };
  const terminalAt = new Date(Date.parse(TERMINAL_START) + wallSeconds * 1000).toISOString();
  return {
    schemaVersion: 1,
    identity: { runId, runAttempt: 2, headSha, treatmentId },
    source: { producerId: 'ci-evidence', fingerprint: 'sha256:evidence' },
    rosterAuthority,
    classifications,
    terminal: {
      createdAt: TERMINAL_START,
      terminalAt,
      source,
      runId,
      runAttempt: 2,
      state: 'completed',
      ...terminal,
    },
    jobs: jobs.map((job) => ({ ...job, runId, runAttempt: 2, source })),
    provenance: packetProvenance({ runId, treatmentId, headSha }),
    failures: failures.map((failure) => ({
      ...failure,
      runId,
      runAttempt: 2,
      headSha,
      treatmentId,
    })),
    retries,
  };
}

function matchedPair(index, overrides = {}) {
  return {
    baseline: matchedPacket({
      runId: 5000 + index * 2,
      treatmentId: 'baseline',
      wallSeconds: 900,
      ...overrides.baseline,
    }),
    treatment: matchedPacket({
      runId: 5001 + index * 2,
      treatmentId: 'treatment',
      wallSeconds: 800,
      ...overrides.treatment,
    }),
  };
}

function comparisonInput(pairs) {
  const input = {
    identity: identity({ runId: 9000 }),
    run: runFixture({ id: 9000, run_id: 9000 }),
    jobs: completeRoster(),
  };
  if (pairs !== undefined) input.pairs = pairs;
  return input;
}

function assertComparisonRecovery(result, expectedVerdict, expectedCode) {
  const comparison = result.evidence.comparison;
  assert.equal(comparison.verdict, expectedVerdict);
  assert.equal(comparison.classification, expectedVerdict);
  assert.ok(comparison.recoveryAction, `${expectedVerdict} must expose recoveryAction`);
  assert.equal(result.recoveryAction?.code, expectedCode);
  assert.deepEqual(result.recoveryAction, comparison.recoveryAction);
  for (const field of RECOVERY_FIELDS) {
    assert.ok(
      Object.hasOwn(comparison.recoveryAction, field),
      `${expectedVerdict} recoveryAction.${field}`,
    );
  }
  assert.equal(typeof comparison.recoveryAction.property, 'string');
  assert.equal(typeof comparison.recoveryAction.detail, 'string');
  assert.equal(RECOVERY_ACTIONS.has(comparison.recoveryAction.action), true);
}

test('exposes the closed eight-status admission vocabulary and manifest projection', () => {
  const result = projectCiAdmission(provenPathFilter());
  assert.deepEqual(result.roster.expected, REQUIRED_CHECK_NAMES);
  assert.equal(result.roster.expected.length, 21);
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

test('permits fallback only for identity-bound path-filter proof', () => {
  const proven = projectCiAdmission(provenPathFilter());
  assert.equal(proven.status, 'path-filtered');
  assert.equal(proven.fallbackEligible, true);
  assert.equal(proven.recoveryAction, null);

  const unproven = projectCiAdmission({ identity: identity(), pathFiltered: true });
  assertRecoveryEnvelope(unproven, 'path-filtered');

  const mismatched = projectCiAdmission({
    identity: identity(),
    pathFiltered: true,
    pathFilterProof: { headSha: 'b'.repeat(40), workflow: 'ci.yml', excluded: true },
  });
  assertRecoveryEnvelope(mismatched, 'path-filtered');
});

test('permits a no-run same-head proof with head-only identity', () => {
  const result = projectCiAdmission({
    identity: { headSha: HEAD_SHA },
    run: null,
    jobs: null,
    pathFiltered: true,
    pathFilterProof: { headSha: HEAD_SHA, workflow: 'ci.yml', excluded: true },
  });

  assert.equal(result.status, 'path-filtered');
  assert.equal(result.fallbackEligible, true);
  assert.equal(result.recoveryAction, null);
  assert.deepEqual(result.identity, {
    runId: null,
    runAttempt: null,
    headSha: HEAD_SHA,
    treatmentId: null,
  });
  assert.equal(result.evidence.run, null);
});

test('rejects head-only fallback when a verifier packet is supplied', () => {
  const result = projectCiAdmission({
    identity: { headSha: HEAD_SHA },
    run: null,
    jobs: null,
    packet: matchedPacket({ runId: 42, treatmentId: 'baseline' }),
    pathFiltered: true,
    pathFilterProof: { headSha: HEAD_SHA, workflow: 'ci.yml', excluded: true },
  });

  assert.equal(result.status, 'path-filtered');
  assert.equal(result.evidence.packet.classification, 'admissible');
  assert.equal(result.fallbackEligible, false);
  assert.equal(result.recoveryAction?.code, 'identity-run-id-missing');
  assert.equal(result.recoveryAction?.property, 'identity.runId');
  assert.equal(result.recoveryAction?.action, 'recollect-evidence');
});

test('accepts only a same-head structured exclusion proof', () => {
  const eligible = projectCiAdmission({
    identity: identity(),
    pathFiltered: true,
    pathFilterProof: {
      headSha: HEAD_SHA.toUpperCase(),
      workflow: 'ci.yml',
      excluded: true,
    },
  });
  assert.equal(eligible.status, 'path-filtered');
  assert.equal(eligible.fallbackEligible, true);
  assert.equal(eligible.recoveryAction, null);

  const rejectedCases = [
    ['bare boolean', { pathFiltered: true }],
    ['missing proof', { pathFiltered: true, pathFilterProof: undefined }],
    [
      'foreign proof',
      {
        pathFiltered: true,
        pathFilterProof: { headSha: 'b'.repeat(40), workflow: 'ci.yml', excluded: true },
      },
    ],
    [
      'wrong workflow',
      {
        pathFiltered: true,
        pathFilterProof: { headSha: HEAD_SHA, workflow: 'other.yml', excluded: true },
      },
    ],
    [
      'included workflow',
      {
        pathFiltered: true,
        pathFilterProof: { headSha: HEAD_SHA, workflow: 'ci.yml', excluded: false },
      },
    ],
    [
      'missing proof head',
      { pathFiltered: true, pathFilterProof: { workflow: 'ci.yml', excluded: true } },
    ],
  ];

  for (const [name, values] of rejectedCases) {
    const result = projectCiAdmission({ identity: identity(), ...values });
    assert.equal(result.status, 'path-filtered', name);
    assert.equal(result.fallbackEligible, false, name);
    assert.equal(result.recoveryAction?.code, 'path-filter-proof-missing', name);
    assert.equal(result.recoveryAction?.action, 'recollect-evidence', name);
  }
});

test('defers caller-shaped observations without a pure proof carrier', () => {
  const input = {
    identity: identity(),
    pathFiltered: true,
    PR_HEAD_SHA: HEAD_SHA,
    CI_PATH_FILTERED: true,
    source: {
      pathFiltered: true,
      PR_HEAD_SHA: HEAD_SHA,
      CI_PATH_FILTERED: 'true',
    },
  };
  const before = structuredClone(input);
  const calls = { get: 0, post: 0, spawn: 0 };
  const previousFetch = globalThis.fetch;
  const previousPost = globalThis.post;
  const previousSpawn = globalThis.spawn;
  globalThis.fetch = async () => {
    calls.get += 1;
  };
  globalThis.post = () => {
    calls.post += 1;
  };
  globalThis.spawn = () => {
    calls.spawn += 1;
  };

  try {
    const result = projectCiAdmission(input);
    assert.equal(result.status, 'path-filtered');
    assert.equal(result.fallbackEligible, false);
    assert.equal(result.recoveryAction?.code, 'path-filter-proof-missing');
    assert.equal(result.evidence.pathFilterProof, null);
    assert.deepEqual(input, before);
    assert.deepEqual(calls, { get: 0, post: 0, spawn: 0 });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPost === undefined) delete globalThis.post;
    else globalThis.post = previousPost;
    if (previousSpawn === undefined) delete globalThis.spawn;
    else globalThis.spawn = previousSpawn;
  }
});

test('requires the pure pathFilterProof carrier for eligibility', () => {
  const proof = { headSha: HEAD_SHA, workflow: 'ci.yml', excluded: true };
  const observationCases = [
    ['source observation', { source: { pathFilterProof: proof } }],
    ['caller metadata', { caller: { pathFilterProof: proof } }],
  ];

  for (const [name, values] of observationCases) {
    const result = projectCiAdmission({ identity: identity(), pathFiltered: true, ...values });
    assert.equal(result.fallbackEligible, false, name);
    assert.equal(result.recoveryAction?.code, 'path-filter-proof-missing', name);
  }

  const input = {
    identity: identity(),
    pathFiltered: true,
    caller: { pathFilterProof: proof },
    source: { pathFilterProof: proof },
    pathFilterProof: proof,
  };
  const before = structuredClone(input);
  const calls = { get: 0, post: 0, spawn: 0 };
  const previousFetch = globalThis.fetch;
  const previousPost = globalThis.post;
  const previousSpawn = globalThis.spawn;
  globalThis.fetch = async () => {
    calls.get += 1;
  };
  globalThis.post = () => {
    calls.post += 1;
  };
  globalThis.spawn = () => {
    calls.spawn += 1;
  };

  try {
    const first = projectCiAdmission(input);
    const second = projectCiAdmission(input);
    assert.equal(first.fallbackEligible, true);
    assert.equal(first.evidence.pathFilterProof.headSha, HEAD_SHA);
    assert.deepEqual(first, second);
    assert.deepEqual(input, before);
    assert.deepEqual(calls, { get: 0, post: 0, spawn: 0 });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPost === undefined) delete globalThis.post;
    else globalThis.post = previousPost;
    if (previousSpawn === undefined) delete globalThis.spawn;
    else globalThis.spawn = previousSpawn;
  }
});

test('keeps ordinary push/main and normal pull-request runs distinct', () => {
  const ordinary = projectCiAdmission({
    identity: identity(),
    run: runFixture({ event: 'push' }),
    jobs: completeRoster(),
  });
  assertRecoveryEnvelope(ordinary, 'ordinary-push-main');

  const normal = projectCiAdmission({
    identity: identity(),
    run: runFixture(),
    jobs: completeRoster(),
  });
  assert.equal(normal.status, 'normal-ci-run');
  assert.equal(normal.fallbackEligible, false);
  assert.equal(normal.recoveryAction, null);
  assert.deepEqual(normal.roster.observed, REQUIRED_CHECK_NAMES);
});

test('retains run-not-terminal recovery for an in-progress pull-request run', () => {
  const inProgress = projectCiAdmission({
    identity: identity(),
    run: runFixture({ status: 'in_progress', conclusion: null }),
    jobs: completeRoster(),
  });

  assert.equal(inProgress.status, 'normal-ci-run');
  assert.equal(inProgress.evidence.complete, false);
  assert.equal(inProgress.recoveryAction?.failureLayer, 'source');
  assert.equal(inProgress.recoveryAction?.code, 'run-not-terminal');
  assert.equal(inProgress.recoveryAction?.action, 'wait-for-terminality');
  assert.equal(inProgress.recoveryAction, inProgress.recoveryActions[0]);
  assert.deepEqual(
    inProgress.recoveryActions.map(({ failureLayer, code }) => ({ failureLayer, code })),
    [{ failureLayer: 'source', code: 'run-not-terminal' }],
  );

  const terminal = projectCiAdmission({
    identity: identity(),
    run: runFixture(),
    jobs: completeRoster(),
  });

  assert.equal(terminal.status, 'normal-ci-run');
  assert.equal(terminal.evidence.complete, true);
  assert.equal(terminal.recoveryAction, null);
  assert.deepEqual(terminal.recoveryActions, []);
});

test('records unknown extra contexts without rejecting complete required evidence', () => {
  const result = projectCiAdmission({
    identity: identity(),
    run: runFixture(),
    jobs: [...completeRoster(), jobFixture('unknown-context')],
  });
  assert.equal(result.status, 'normal-ci-run');
  assert.equal(result.evidence.complete, true);
  assert.deepEqual(result.roster.extra, ['unknown-context']);
  assert.equal(result.recoveryAction, null);
  assert.deepEqual(result.recoveryActions, []);
});

test('rejects supplied identity fields that disagree with the source run', () => {
  const result = projectCiAdmission({
    identity: identity({ runId: 99, runAttempt: 2, headSha: 'b'.repeat(40), treatmentId: 'other' }),
    run: runFixture({ treatment_id: 'baseline' }),
    jobs: completeRoster(),
  });
  assert.equal(result.evidence.complete, false);
  assert.equal(result.recoveryAction.code, 'identity-run-id-mismatch');
  assert.equal(result.recoveryAction.property, 'identity.runId');
  assert.deepEqual(result.identity, {
    runId: 42,
    runAttempt: 1,
    headSha: HEAD_SHA,
    treatmentId: 'baseline',
  });
});

test('keeps operational skip, zero-job, API error, partial roster, and failure actionable', () => {
  const cases = [
    ['operational-skip', { run: runFixture({ conclusion: 'skipped' }) }],
    ['zero-job', { run: runFixture(), jobs: [] }],
    ['api-error', { apiError: new Error('fixture transport failure') }],
    ['partial-roster', { run: runFixture(), jobs: completeRoster().slice(0, -1) }],
    [
      'genuine-failure',
      {
        run: runFixture(),
        jobs: failedRoster(),
      },
    ],
  ];

  for (const [expectedStatus, input] of cases) {
    assertRecoveryEnvelope(projectCiAdmission({ identity: identity(), ...input }), expectedStatus);
  }
});

test('is deterministic and read-only for pure local evidence fixtures', () => {
  const input = {
    identity: identity(),
    run: runFixture(),
    jobs: completeRoster(),
  };
  const before = structuredClone(input);
  const first = projectCiAdmission(input);
  const second = projectCiAdmission(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
});

test('does not complete an otherwise full roster when packet identity is malformed', () => {
  const malformed = projectCiAdmission({
    identity: {
      runId: 42,
      runAttempt: 0,
      headSha: 'deadbeef',
      treatmentId: 'baseline',
    },
    run: runFixture(),
    jobs: completeRoster(),
  });
  assert.equal(malformed.fallbackEligible, false);
  assert.equal(malformed.evidence.complete, false);
  assert.ok(malformed.recoveryAction);
  assert.equal(typeof malformed.recoveryAction.code, 'string');
  assert.equal(typeof malformed.recoveryAction.property, 'string');
  assert.equal(typeof malformed.recoveryAction.detail, 'string');
  assert.equal(typeof malformed.recoveryAction.action, 'string');
});

test('keeps absent and insufficient matched evidence non-comparable', () => {
  const absent = projectCiAdmission(comparisonInput([]));
  assertComparisonRecovery(absent, 'unknown-evidence', 'matched-pairs-insufficient');

  const onePair = projectCiAdmission(comparisonInput([matchedPair(1)]));
  assertComparisonRecovery(onePair, 'unknown-evidence', 'matched-pairs-insufficient');
  assert.equal(onePair.evidence.comparison.matchedPairs, 1);
});

test('does not infer a comparison from an ordinary API-shaped run', () => {
  const result = projectCiAdmission(comparisonInput());
  assert.equal(result.status, 'normal-ci-run');
  assert.equal(result.evidence.comparison, null);
  assert.equal(result.recoveryAction, null);
});

test('composes raw packet normalization before admission completion', () => {
  const result = projectCiAdmission({
    identity: identity(),
    run: runFixture(),
    jobs: completeRoster(),
    packet: {
      run: {
        runId: 42,
        runAttempt: 1,
        headSha: HEAD_SHA,
        treatmentId: 'baseline',
        inputFingerprint: `sha256:${'b'.repeat(64)}`,
        status: 'completed',
        conclusion: 'success',
      },
      jobs: [],
      artifacts: [],
    },
  });
  assert.equal(result.evidence.packet, null);
  assert.equal(result.evidence.packetNormalization.classification, 'invalid');
  assert.equal(result.evidence.packetNormalization.reasonCodes.includes('zero-jobs'), true);
  assert.equal(result.recoveryAction.code, 'zero-jobs');
});

test('keeps raw admission incomplete when artifact identity is partial', () => {
  const cases = [
    [
      'artifact-id-and-run-only',
      (artifact) => {
        delete artifact.runAttempt;
        delete artifact.headSha;
        delete artifact.treatmentId;
        delete artifact.inputFingerprint;
      },
    ],
    ['missing-run-attempt', (artifact) => delete artifact.runAttempt],
    ['missing-head-sha', (artifact) => delete artifact.headSha],
    ['missing-treatment-id', (artifact) => delete artifact.treatmentId],
    ['missing-input-fingerprint', (artifact) => delete artifact.inputFingerprint],
  ];

  for (const [name, mutate] of cases) {
    const packet = rawPacketFixture();
    mutate(packet.artifacts[0]);
    const result = projectCiAdmission(rawAdmissionInput(packet));
    assert.equal(result.status, 'normal-ci-run', name);
    assert.equal(result.evidence.packetNormalization.admissible, false, name);
    assert.equal(result.evidence.complete, false, name);
    assert.equal(result.fallbackEligible, false, name);
    assert.ok(result.recoveryAction, name);
    assert.match(result.recoveryAction.code, /^artifact-/, name);
  }
});

test('admits complete raw identity through the existing projection without external calls', () => {
  const packet = rawPacketFixture();
  const input = rawAdmissionInput(packet);
  const before = structuredClone(input);
  const calls = { fetch: 0, spawn: 0, post: 0 };
  const previousFetch = globalThis.fetch;
  const previousSpawn = globalThis.spawn;
  const previousPost = globalThis.post;
  globalThis.fetch = async () => {
    calls.fetch += 1;
  };
  globalThis.spawn = () => {
    calls.spawn += 1;
  };
  globalThis.post = () => {
    calls.post += 1;
  };

  try {
    const result = projectCiAdmission(input);
    assert.equal(result.status, 'normal-ci-run');
    assert.equal(result.evidence.packetNormalization.admissible, true);
    assert.equal(result.evidence.complete, true);
    assert.equal(result.recoveryAction, null);
    assert.deepEqual(input, before);
    assert.deepEqual(calls, { fetch: 0, spawn: 0, post: 0 });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSpawn === undefined) delete globalThis.spawn;
    else globalThis.spawn = previousSpawn;
    if (previousPost === undefined) delete globalThis.post;
    else globalThis.post = previousPost;
  }
});

test('rejects a verifier packet whose identity disagrees with the outer run', () => {
  const result = projectCiAdmission({
    identity: identity(),
    run: runFixture(),
    jobs: completeRoster(),
    packet: matchedPacket({ runId: 99, treatmentId: 'baseline', headSha: HEAD_SHA }),
  });
  assert.equal(result.evidence.packet.classification, 'admissible');
  assert.equal(result.evidence.packetNormalization.classification, 'invalid');
  assert.equal(result.evidence.packetNormalization.reasonCodes.includes('run-id-mismatch'), true);
  assert.equal(result.evidence.complete, false);
  assert.equal(result.fallbackEligible, false);
  assert.equal(result.recoveryAction?.code, 'identity-run-id-mismatch');
  assert.equal(result.recoveryAction?.property, 'identity.runId');
});

test('requires exact heads, one roster authority, and distinct treatment identities', () => {
  const cases = [
    [
      'cross-head pair',
      matchedPair(1, { treatment: { headSha: 'b'.repeat(40) } }),
      'matched-head-mismatch',
    ],
    [
      'roster-divergent pair',
      matchedPair(1, {
        treatment: {
          rosterAuthority: {
            path: 'scripts/ci/required-ci-checks.json',
            fingerprint: 'sha256:foreign-roster',
          },
        },
      }),
      'roster-authority-stale',
    ],
    [
      'same treatment identity',
      matchedPair(1, { treatment: { treatmentId: 'baseline' } }),
      'matched-treatment-id-mismatch',
    ],
  ];
  for (const [name, pair, code] of cases) {
    const result = projectCiAdmission(comparisonInput([pair, matchedPair(2)]));
    assertComparisonRecovery(result, 'invalid-evidence', code);
    assert.match(result.evidence.comparison.recoveryAction.property, /^pairs\[0\]/, name);
  }
});

test('blocks correctness, intentional-skip, first-failure, and retry regressions', () => {
  const failedTreatment = terminalClassifications({
    'build-artifacts': { classification: 'executed-failure' },
    'primary-pnpm': { classification: 'executed-success' },
  });
  const changedSkip = terminalClassifications({
    'build-artifacts': { classification: 'executed-success' },
    'primary-pnpm': { classification: 'executed-success' },
    'smoke-fleet': { classification: 'executed-success' },
  });
  const regressions = [
    [
      'correctness regression',
      { treatment: { classifications: failedTreatment } },
      'treatment-correctness-regression',
      'rollback-required',
    ],
    [
      'intentional skip changed',
      {
        treatment: {
          classifications: changedSkip,
          jobs: [...capacityJobs(), { ...capacityJobs()[0], name: 'smoke-fleet' }],
        },
      },
      'treatment-skip-changed',
      'rollback-required',
    ],
    [
      'earlier first failure',
      {
        treatment: {
          failures: [
            {
              context: 'primary-pnpm',
              occurredAt: '2026-08-14T00:07:00.000Z',
              runId: 5001 + 2,
              runAttempt: 2,
              headSha: 'a'.repeat(40),
              treatmentId: 'treatment',
              conclusion: 'failure',
              reason: 'fixture failure moved earlier',
              retry: { class: 'authorized-test-retry', attempt: 1, maxAttempts: 2 },
            },
          ],
        },
      },
      'treatment-first-failure',
      'rollback-required',
    ],
    [
      'extra retry',
      {
        treatment: {
          retries: [
            { context: 'primary-pnpm', attempt: 2, maxAttempts: 2, class: 'authorized-test-retry' },
          ],
        },
      },
      'treatment-retry-instability',
      'rollback-required',
    ],
  ];
  for (const [name, overrides, code, verdict] of regressions) {
    const result = projectCiAdmission(
      comparisonInput([matchedPair(1, overrides), matchedPair(2, overrides)]),
    );
    assertComparisonRecovery(result, verdict, code);
    assert.match(result.evidence.comparison.recoveryAction.property, /^pairs\[0\]/, name);
  }
});

test('blocks capacity changes, terminal-wall breaches, and no-improvement pairs', () => {
  const cases = [
    [
      'capacity declaration changed',
      {
        treatment: {
          jobs: capacityJobs({
            pool: 'heavy',
            observation: { vcpus: 8, memoryGiB: 16, source: 'cgroup' },
          }),
        },
      },
      'treatment-capacity-changed',
    ],
    [
      'terminal wall breach',
      { treatment: { wallSeconds: 1201 } },
      'treatment-terminal-wall-breach',
    ],
    [
      'no improvement',
      { baseline: { wallSeconds: 800 }, treatment: { wallSeconds: 800 } },
      'treatment-no-improvement',
    ],
  ];
  for (const [name, overrides, code] of cases) {
    const result = projectCiAdmission(
      comparisonInput([matchedPair(1, overrides), matchedPair(2, overrides)]),
    );
    assertComparisonRecovery(result, 'rollback-required', code);
    assert.match(result.evidence.comparison.recoveryAction.property, /^pairs\[0\]/, name);
  }
});

test('admits only two stable exact-head pairs and preserves deterministic evidence', () => {
  const input = comparisonInput([matchedPair(1), matchedPair(2)]);
  const before = structuredClone(input);
  const first = projectCiAdmission(input);
  const second = projectCiAdmission(input);
  assert.equal(first.evidence.comparison.verdict, 'slo-pass');
  assert.equal(first.evidence.comparison.classification, 'slo-pass');
  assert.equal(first.evidence.comparison.matchedPairs, 2);
  assert.equal(first.recoveryAction, null);
  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
});

test('propagates one layered recovery envelope without executing recovery', () => {
  const terminalFailurePacket = matchedPacket({ runId: 42, treatmentId: 'baseline' });
  terminalFailurePacket.terminal = {
    ...terminalFailurePacket.terminal,
    createdAt: undefined,
  };

  const topology = projectCiAdmission({
    identity: identity(),
    run: runFixture(),
    jobs: [],
  });
  const terminal = projectCiAdmission({
    identity: identity({ runAttempt: 2 }),
    run: runFixture({ run_attempt: 2, treatment_id: 'baseline' }),
    jobs: completeRoster(),
    packet: terminalFailurePacket,
  });
  const raw = rawPacketFixture();
  delete raw.artifacts[0].inputFingerprint;
  const delivery = projectCiAdmission(rawAdmissionInput(raw));
  const comparison = projectCiAdmission(comparisonInput([]));

  const cases = [
    [topology, 'source', 'zero-job'],
    [terminal, 'terminal', 'terminal-clock-missing'],
    [delivery, 'delivery', 'artifact-fingerprint-missing'],
    [comparison, 'comparison', 'matched-pairs-insufficient'],
  ];
  for (const [result, layer, code] of cases) {
    assert.ok(result.recoveryAction, `${layer} recoveryAction`);
    assert.equal(result.recoveryAction.failureLayer, layer);
    assert.equal(result.recoveryAction.code, code);
    for (const field of RECOVERY_FIELDS.concat('failureLayer')) {
      assert.ok(Object.hasOwn(result.recoveryAction, field), `${layer}.${field}`);
    }
    assert.equal(result.fallbackEligible, false);
    if (layer !== 'comparison') assert.notEqual(result.evidence.complete, true);
  }

  assert.equal(terminal.evidence.packet.classification, 'unknown-evidence');
  assert.equal(terminal.evidence.packet.recoveryAction.failureLayer, 'terminal');
  assert.equal(terminal.evidence.packetNormalization.admissible, false);
  assert.equal(terminal.recoveryAction.failureLayer, 'terminal');

  const calls = { fetch: 0, spawn: 0, post: 0 };
  const previousFetch = globalThis.fetch;
  const previousSpawn = globalThis.spawn;
  const previousPost = globalThis.post;
  globalThis.fetch = async () => {
    calls.fetch += 1;
  };
  globalThis.spawn = () => {
    calls.spawn += 1;
  };
  globalThis.post = () => {
    calls.post += 1;
  };
  try {
    projectCiAdmission(comparisonInput([]));
    assert.deepEqual(calls, { fetch: 0, spawn: 0, post: 0 });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSpawn === undefined) delete globalThis.spawn;
    else globalThis.spawn = previousSpawn;
    if (previousPost === undefined) delete globalThis.post;
    else globalThis.post = previousPost;
  }
});

test('projects compound recovery actions in dependency order without losing layers', () => {
  const packet = rawPacketFixture();
  delete packet.artifacts[0].inputFingerprint;
  const result = projectCiAdmission({
    identity: identity(),
    run: runFixture(),
    jobs: [],
    packet,
    pairs: [],
  });

  assert.deepEqual(
    result.recoveryActions.map(({ failureLayer, code }) => ({ failureLayer, code })),
    [
      { failureLayer: 'source', code: 'zero-job' },
      { failureLayer: 'delivery', code: 'artifact-fingerprint-missing' },
      { failureLayer: 'comparison', code: 'matched-pairs-insufficient' },
    ],
  );
  assert.deepEqual(result.recoveryAction, result.recoveryActions[0]);
  assert.equal(result.evidence.reasonCodes.includes('zero-job'), true);
  assert.equal(result.evidence.packetNormalization.admissible, false);
  assert.equal(result.evidence.comparison.verdict, 'unknown-evidence');
});
