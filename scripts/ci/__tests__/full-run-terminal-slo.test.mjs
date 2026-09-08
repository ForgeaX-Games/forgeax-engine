import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  admitPacket,
  compareMatchedPairs,
  loadContract,
  loadRoster,
  projectEvidence,
  projectTerminalTiming,
} from '../check-full-run-terminal-slo.mjs';

const roster = JSON.parse(
  readFileSync(new URL('../required-ci-checks.json', import.meta.url), 'utf8'),
);
const rosterAuthority = loadRoster();

function identity(overrides = {}) {
  return {
    runId: 4101,
    runAttempt: 2,
    headSha: 'a'.repeat(40),
    treatmentId: 'baseline',
    ...overrides,
  };
}

function classifications(overrides = {}) {
  return Object.fromEntries(
    roster.map((name) => [name, { classification: 'executed-success', ...overrides[name] }]),
  );
}

function packet(overrides = {}) {
  return {
    schemaVersion: 1,
    identity: identity(),
    source: { producerId: 'ci-evidence', fingerprint: 'sha256:evidence' },
    rosterAuthority: {
      path: 'scripts/ci/required-ci-checks.json',
      fingerprint: rosterAuthority.fingerprint,
    },
    classifications: classifications(),
    ...overrides,
  };
}

const terminalStart = '2026-08-14T00:00:00.000Z';

function terminalPacket(overrides = {}) {
  const jobs = [
    {
      name: 'build-artifacts',
      runId: 4101,
      runAttempt: 2,
      createdAt: '2026-08-14T00:00:20.000Z',
      startedAt: '2026-08-14T00:01:00.000Z',
      completedAt: '2026-08-14T00:05:00.000Z',
      source: {
        runId: 4101,
        runAttempt: 2,
        headSha: 'a'.repeat(40),
        treatmentId: 'baseline',
      },
      classification: 'executed-success',
      required: true,
    },
    {
      name: 'primary-pnpm',
      runId: 4101,
      runAttempt: 2,
      createdAt: '2026-08-14T00:00:30.000Z',
      startedAt: '2026-08-14T00:02:00.000Z',
      completedAt: '2026-08-14T00:10:00.000Z',
      source: {
        runId: 4101,
        runAttempt: 2,
        headSha: 'a'.repeat(40),
        treatmentId: 'baseline',
      },
      classification: 'executed-success',
      required: true,
    },
  ];
  const terminalClassifications = Object.fromEntries(
    roster.map((name) => [
      name,
      {
        classification: 'intentional-skip',
        predicate: 'fixture-only',
        reason: 'fixture excludes unrelated context',
        semanticCoverageFingerprint: 'sha256:fixture',
      },
    ]),
  );
  for (const job of jobs) {
    terminalClassifications[job.name] = { classification: 'executed-success' };
  }
  const providedJobs = overrides.jobs ?? jobs;
  const normalizedJobs = providedJobs.map((job) =>
    Object.hasOwn(job, 'source')
      ? job
      : {
          ...job,
          source: {
            runId: 4101,
            runAttempt: 2,
            headSha: 'a'.repeat(40),
            treatmentId: 'baseline',
          },
        },
  );
  const defaultTerminal = {
    createdAt: terminalStart,
    terminalAt: '2026-08-14T00:20:00.000Z',
    source: {
      runId: 4101,
      runAttempt: 2,
      headSha: 'a'.repeat(40),
      treatmentId: 'baseline',
    },
    runId: 4101,
    runAttempt: 2,
    state: 'completed',
  };
  const normalizedTerminal = overrides.terminal ?? defaultTerminal;
  return packet({
    ...overrides,
    terminal: normalizedTerminal,
    classifications: overrides.classifications ?? terminalClassifications,
    jobs: normalizedJobs,
  });
}

test('contract exposes the terminal wall rule, closed states, identity, recovery, and capacity declarations', () => {
  const contract = loadContract();
  assert.equal(contract.terminalWall.maxSeconds, 1200);
  assert.deepEqual(contract.identity.fields, ['runId', 'runAttempt', 'headSha', 'treatmentId']);
  assert.ok(contract.verdicts.includes('invalid-evidence'));
  assert.ok(contract.verdicts.includes('unknown-evidence'));
  assert.ok(contract.classifications.includes('intentional-skip'));
  assert.deepEqual(contract.capacityPools.standard, { vcpus: 4, memoryGiB: 8 });
  assert.deepEqual(contract.capacityPools.heavy, { vcpus: 8, memoryGiB: 16 });
  assert.equal(contract.rosterAuthority.path, 'scripts/ci/required-ci-checks.json');
  assert.deepEqual(contract.recovery.requiredFields, [
    'code',
    'failureLayer',
    'property',
    'expected',
    'observed',
    'detail',
    'action',
  ]);
  assert.deepEqual(contract.recovery.failureLayers, [
    'source',
    'terminal',
    'delivery',
    'comparison',
  ]);
});

test('the single index anchors recovery and immutable snapshot boundaries', () => {
  const index = readFileSync(new URL('../full-run-terminal-slo.md', import.meta.url), 'utf8');
  const contract = readFileSync(
    new URL('../full-run-terminal-slo-contract.json', import.meta.url),
    'utf8',
  );
  const terminalOwner = readFileSync(
    new URL('../check-full-run-terminal-slo.mjs', import.meta.url),
    'utf8',
  );

  for (const link of [
    './full-run-terminal-slo-contract.json',
    './required-ci-checks.json',
    './check-ci-admission.mjs',
  ]) {
    assert.match(index, new RegExp(`\\]\\(${link.replaceAll('.', '\\.')}\\)`));
  }
  assert.match(index, /compareMatchedPairs/);
  assert.match(index, /node scripts\/ci\/check-ci-admission\.mjs/);
  assert.match(index, /"schemaVersion"/);
  assert.match(index, /"artifacts"/);
  assert.match(index, /"pairs"/);
  assert.match(index, /recoveryAction/);
  assert.match(index, /failureLayer/);
  assert.match(index, /source\|terminal\|delivery\|comparison/);
  assert.match(index, /7d5f525c8d91013aab82696fefefa33c97e293ef/);
  assert.match(index, /218e6040[0-9a-f]*/i);
  assert.match(index, /archival/i);
  assert.match(index, /harness authority/i);
  assert.match(index, /not.*runtime packet/i);
  assert.doesNotMatch(`${contract}\n${terminalOwner}`, /snapshotDigest|sourceSha|baseSha/);
});

test('admits an envelope only when identity and the authoritative roster are exact', () => {
  const result = admitPacket(packet());
  assert.equal(result.classification, 'unknown-evidence');
  assert.equal(result.recoveryAction.action, 'recollect-evidence');
  assert.deepEqual(result.identity, identity());

  const missing = admitPacket(
    packet({ classifications: { ...classifications(), 'smoke-fleet': undefined } }),
  );
  assert.equal(missing.classification, 'unknown-evidence');
  assert.equal(missing.recoveryAction.property, 'classifications.smoke-fleet');

  const extra = admitPacket(
    packet({
      classifications: {
        ...classifications(),
        'foreign-context': { classification: 'executed-success' },
      },
    }),
  );
  assert.equal(extra.classification, 'invalid-evidence');
  assert.equal(extra.recoveryAction.property, 'classifications');

  const missingAuthority = admitPacket(packet({ rosterAuthority: undefined }));
  assert.equal(missingAuthority.classification, 'unknown-evidence');
  assert.equal(missingAuthority.recoveryAction.code, 'roster-authority-missing');

  const foreignAuthority = admitPacket(
    packet({
      rosterAuthority: { path: 'foreign-roster.json', fingerprint: rosterAuthority.fingerprint },
    }),
  );
  assert.equal(foreignAuthority.classification, 'invalid-evidence');
  assert.equal(foreignAuthority.recoveryAction.code, 'roster-authority-foreign');

  const staleAuthority = admitPacket(
    packet({
      rosterAuthority: { path: 'scripts/ci/required-ci-checks.json', fingerprint: 'sha256:stale' },
    }),
  );
  assert.equal(staleAuthority.classification, 'invalid-evidence');
  assert.equal(staleAuthority.recoveryAction.code, 'roster-authority-stale');
});

test('rejects duplicate or foreign identity evidence without free-form log parsing', () => {
  const duplicate = admitPacket(
    packet({
      evidence: [
        { ...identity(), evidenceId: 'first' },
        { ...identity(), evidenceId: 'second' },
      ],
    }),
  );
  assert.equal(duplicate.classification, 'invalid-evidence');
  assert.equal(duplicate.recoveryAction.property, 'identity');

  const foreign = admitPacket(
    packet({ source: { producerId: 'ci-evidence', fingerprint: 'sha256:evidence', runId: 99 } }),
  );
  assert.equal(foreign.classification, 'invalid-evidence');
  assert.equal(foreign.recoveryAction.action, 'discard-foreign-evidence');
});

test('requires intentional skips to carry an authoritative predicate, reason, and coverage fingerprint', () => {
  const valid = classifications({
    'webkit-fallback': {
      classification: 'intentional-skip',
      predicate: 'platform-unavailable',
      reason: 'WebKit is unavailable on this runner',
      semanticCoverageFingerprint: 'sha256:coverage',
    },
  });
  const admitted = admitPacket(packet({ classifications: valid }));
  assert.notEqual(admitted.classification, 'invalid-evidence');
  assert.deepEqual(admitted.classifications['webkit-fallback'], valid['webkit-fallback']);

  const unauthorized = admitPacket(
    packet({
      classifications: {
        ...classifications(),
        'webkit-fallback': { classification: 'intentional-skip', reason: 'skip it' },
      },
    }),
  );
  assert.equal(unauthorized.classification, 'invalid-evidence');
  assert.equal(unauthorized.recoveryAction.property, 'classifications.webkit-fallback.predicate');
});

test('derives the terminal wall at exactly 1,200 seconds and keeps diagnostic clocks separate', () => {
  const result = projectTerminalTiming(
    terminalPacket({
      terminal: {
        createdAt: terminalStart,
        terminalAt: '2026-08-14T00:20:00.000Z',
        source: { runId: 4101, runAttempt: 2, headSha: 'a'.repeat(40) },
        runId: 4101,
        runAttempt: 2,
        state: 'completed',
        updatedAt: '2026-08-14T00:15:00.000Z',
      },
    }),
  );
  assert.equal(result.classification, 'admissible');
  assert.equal(result.timing.terminalWallSeconds, 1200);
  assert.equal(result.timing.diagnosticUpdatedAt, '2026-08-14T00:15:00.000Z');
  assert.equal(result.timing.queueSeconds, 130);
  assert.equal(result.timing.activeSeconds, 720);
  assert.equal(result.timing.totalSeconds, 850);
  assert.equal(
    result.timing.queueSeconds + result.timing.activeSeconds,
    result.timing.totalSeconds,
  );
});

test('rejects above-limit, missing, reversed, fallback, and cross-attempt terminal clocks', () => {
  const above = projectTerminalTiming(
    terminalPacket({
      terminal: { ...terminalPacket().terminal, terminalAt: '2026-08-14T00:20:01.000Z' },
    }),
  );
  assert.equal(above.classification, 'slo-breach');
  assert.equal(above.recoveryAction.property, 'timing.terminalWallSeconds');

  const missing = projectTerminalTiming(terminalPacket({ terminal: { createdAt: terminalStart } }));
  assert.equal(missing.classification, 'unknown-evidence');
  assert.equal(missing.recoveryAction.code, 'terminal-clock-missing');

  const reversed = projectTerminalTiming(
    terminalPacket({
      terminal: {
        ...terminalPacket().terminal,
        createdAt: '2026-08-14T00:21:00.000Z',
      },
    }),
  );
  assert.equal(reversed.classification, 'invalid-evidence');
  assert.equal(reversed.recoveryAction.code, 'terminal-clock-reversed');

  const fallback = projectTerminalTiming(
    terminalPacket({
      terminal: { updatedAt: '2026-08-14T00:10:00.000Z' },
    }),
  );
  assert.equal(fallback.classification, 'unknown-evidence');
  assert.equal(fallback.recoveryAction.code, 'terminal-clock-fallback');

  const crossAttempt = projectTerminalTiming(
    terminalPacket({
      terminal: { ...terminalPacket().terminal, runAttempt: 3 },
    }),
  );
  assert.equal(crossAttempt.classification, 'invalid-evidence');
  assert.equal(crossAttempt.recoveryAction.code, 'terminal-clock-foreign-attempt');

  const missingBinding = projectTerminalTiming(
    terminalPacket({ terminal: { ...terminalPacket().terminal, source: undefined } }),
  );
  assert.equal(missingBinding.classification, 'unknown-evidence');
  assert.equal(missingBinding.recoveryAction.code, 'terminal-clock-source-missing');
});

test('attributes tied critical owners and includes the zero or nonzero terminal tail', () => {
  const tied = terminalPacket({
    terminal: { ...terminalPacket().terminal, terminalAt: '2026-08-14T00:12:00.000Z' },
    jobs: [
      {
        name: 'primary-pnpm',
        runId: 4101,
        runAttempt: 2,
        createdAt: '2026-08-14T00:00:00.000Z',
        startedAt: '2026-08-14T00:01:00.000Z',
        completedAt: '2026-08-14T00:10:00.000Z',
        classification: 'executed-success',
        required: true,
      },
      {
        name: 'build-artifacts',
        runId: 4101,
        runAttempt: 2,
        createdAt: '2026-08-14T00:00:00.000Z',
        startedAt: '2026-08-14T00:02:00.000Z',
        completedAt: '2026-08-14T00:10:00.000Z',
        classification: 'executed-success',
        required: true,
      },
    ],
  });
  const result = projectTerminalTiming(tied);
  assert.equal(result.classification, 'admissible');
  assert.deepEqual(result.timing.requiredCriticalOwners, ['build-artifacts', 'primary-pnpm']);
  assert.equal(result.timing.requiredCriticalPathCompletedAt, '2026-08-14T00:10:00.000Z');
  assert.equal(result.timing.postCriticalReportingTailSeconds, 120);

  const noTail = projectTerminalTiming(
    terminalPacket({
      terminal: { ...terminalPacket().terminal, terminalAt: '2026-08-14T00:10:00.000Z' },
    }),
  );
  assert.equal(noTail.classification, 'admissible');
  assert.equal(noTail.timing.postCriticalReportingTailSeconds, 0);
});

test('rejects invalid job clocks and does not fabricate timing for intentional skips', () => {
  const reversed = projectTerminalTiming(
    terminalPacket({
      jobs: [
        {
          name: 'build-artifacts',
          runId: 4101,
          runAttempt: 2,
          createdAt: '2026-08-14T00:03:00.000Z',
          startedAt: '2026-08-14T00:02:00.000Z',
          completedAt: '2026-08-14T00:01:00.000Z',
          classification: 'executed-success',
          required: true,
        },
      ],
    }),
  );
  assert.equal(reversed.classification, 'invalid-evidence');
  assert.equal(reversed.recoveryAction.code, 'job-clock-reversed');

  const crossAttempt = projectTerminalTiming(
    terminalPacket({
      jobs: terminalPacket().jobs.map((job) => ({ ...job, runAttempt: 3 })),
    }),
  );
  assert.equal(crossAttempt.classification, 'invalid-evidence');
  assert.equal(crossAttempt.recoveryAction.code, 'job-clock-foreign-attempt');

  const missingBinding = projectTerminalTiming(
    terminalPacket({
      jobs: terminalPacket().jobs.map((job) => ({ ...job, source: undefined })),
    }),
  );
  assert.equal(missingBinding.classification, 'unknown-evidence');
  assert.equal(missingBinding.recoveryAction.code, 'job-clock-source-missing');

  const skipped = projectTerminalTiming(
    terminalPacket({
      classifications: {
        ...terminalPacket().classifications,
        'build-artifacts': {
          classification: 'intentional-skip',
          predicate: 'path-filtered',
          reason: 'not applicable',
          semanticCoverageFingerprint: 'sha256:coverage',
        },
      },
      jobs: terminalPacket().jobs.map((job) =>
        job.name === 'build-artifacts' ? { ...job, classification: 'intentional-skip' } : job,
      ),
    }),
  );
  assert.equal(skipped.classification, 'admissible');
  assert.equal(skipped.timing.jobCount, 1);
  assert.equal(skipped.timing.queueSeconds, 90);
});

test('keeps terminal and job clocks bound to the complete packet identity', () => {
  const terminalForeignTreatment = projectTerminalTiming(
    terminalPacket({
      terminal: {
        ...terminalPacket().terminal,
        source: {
          runId: 4101,
          runAttempt: 2,
          headSha: 'a'.repeat(40),
          treatmentId: 'treatment',
        },
      },
    }),
  );
  assert.equal(terminalForeignTreatment.classification, 'invalid-evidence');
  assert.equal(terminalForeignTreatment.recoveryAction.code, 'terminal-clock-foreign-treatment');
  assert.equal(terminalForeignTreatment.recoveryAction.action, 'discard-foreign-evidence');

  const jobForeignTreatment = projectTerminalTiming(
    terminalPacket({
      jobs: terminalPacket().jobs.map((job) => ({
        ...job,
        source: { ...job.source, treatmentId: 'treatment' },
      })),
    }),
  );
  assert.equal(jobForeignTreatment.classification, 'invalid-evidence');
  assert.equal(jobForeignTreatment.recoveryAction.code, 'job-clock-foreign-treatment');
  assert.equal(jobForeignTreatment.recoveryAction.action, 'discard-foreign-evidence');

  const exact = projectTerminalTiming(terminalPacket());
  assert.equal(exact.classification, 'admissible');
  assert.equal(exact.timing.queueSeconds + exact.timing.activeSeconds, exact.timing.totalSeconds);
  assert.equal(Object.hasOwn(exact.timing, 'queueLatencySeconds'), false);
  assert.equal(Object.hasOwn(exact.timing, 'physicalHost'), false);
});

function m3Provenance(overrides = {}) {
  const base = {
    runId: 4101,
    runAttempt: 2,
    headSha: 'a'.repeat(40),
    treatmentId: 'baseline',
  };
  return {
    producer: {
      ...base,
      producerId: 'terminal-packet-producer',
      fingerprint: 'sha256:producer',
    },
    artifact: {
      ...base,
      artifactId: 'artifact-4101',
      fingerprint: 'sha256:artifact',
    },
    report: {
      ...base,
      reportId: 'report-4101',
      fingerprint: 'sha256:report',
    },
    ...overrides,
  };
}

function capacityJobs(
  capacity = { pool: 'standard', observation: { vcpus: 4, memoryGiB: 8, source: 'cgroup' } },
) {
  return terminalPacket().jobs.map((job) => ({ ...job, capacity }));
}

test('joins producer, artifact, and consumed report to the full packet identity', () => {
  const valid = projectEvidence(
    terminalPacket({ provenance: m3Provenance(), jobs: capacityJobs() }),
  );
  assert.equal(valid.classification, 'admissible');
  assert.equal(valid.provenance.report.reportId, 'report-4101');

  const foreignReport = projectEvidence(
    terminalPacket({
      provenance: m3Provenance({ report: { ...m3Provenance().report, headSha: 'b'.repeat(40) } }),
      jobs: capacityJobs(),
    }),
  );
  assert.equal(foreignReport.classification, 'invalid-evidence');
  assert.equal(foreignReport.recoveryAction.property, 'provenance.report.headSha');

  const staleArtifact = projectEvidence(
    terminalPacket({
      provenance: m3Provenance({ artifact: { ...m3Provenance().artifact, runAttempt: 1 } }),
      jobs: capacityJobs(),
    }),
  );
  assert.equal(staleArtifact.classification, 'invalid-evidence');
  assert.equal(staleArtifact.recoveryAction.action, 'discard-foreign-evidence');
});

test('rejects missing or foreign producer-artifact-report fingerprints without joining stale evidence', () => {
  const missingFingerprint = projectEvidence(
    terminalPacket({
      provenance: m3Provenance({
        producer: { ...m3Provenance().producer, fingerprint: undefined },
      }),
      jobs: capacityJobs(),
    }),
  );
  assert.equal(missingFingerprint.classification, 'unknown-evidence');
  assert.equal(missingFingerprint.recoveryAction.property, 'provenance.producer.fingerprint');
  assert.equal(missingFingerprint.recoveryAction.action, 'recollect-evidence');

  const foreignTreatment = projectEvidence(
    terminalPacket({
      provenance: m3Provenance({
        report: { ...m3Provenance().report, treatmentId: 'treatment' },
      }),
      jobs: capacityJobs(),
    }),
  );
  assert.equal(foreignTreatment.classification, 'invalid-evidence');
  assert.equal(foreignTreatment.recoveryAction.property, 'provenance.report.treatmentId');
  assert.equal(foreignTreatment.recoveryAction.action, 'discard-foreign-evidence');
});

test('separates standard and heavy declarations from measured or unavailable capacity', () => {
  const heavy = projectEvidence(
    terminalPacket({
      provenance: m3Provenance(),
      jobs: capacityJobs({
        pool: 'heavy',
        observation: { vcpus: 8, memoryGiB: 16, source: 'cgroup' },
      }),
    }),
  );
  assert.equal(heavy.classification, 'admissible');
  assert.deepEqual(
    heavy.capacity.jobs.map((job) => job.declared),
    [
      { pool: 'heavy', vcpus: 8, memoryGiB: 16 },
      { pool: 'heavy', vcpus: 8, memoryGiB: 16 },
    ],
  );

  const unavailable = projectEvidence(
    terminalPacket({
      provenance: m3Provenance(),
      jobs: capacityJobs({
        pool: 'standard',
        observation: { status: 'unavailable', reason: 'host omitted' },
      }),
    }),
  );
  assert.equal(unavailable.classification, 'admissible');
  assert.equal(unavailable.capacity.jobs[0].observation.status, 'unavailable');

  const labelOnly = projectEvidence(
    terminalPacket({
      provenance: m3Provenance(),
      jobs: terminalPacket().jobs.map((job) => ({ ...job, runnerLabel: 'standard' })),
    }),
  );
  assert.equal(labelOnly.classification, 'unknown-evidence');
  assert.equal(labelOnly.recoveryAction.action, 'measure-capacity');

  const belowDeclaration = projectEvidence(
    terminalPacket({
      provenance: m3Provenance(),
      jobs: capacityJobs({
        pool: 'standard',
        observation: { vcpus: 2, memoryGiB: 8, source: 'cgroup' },
      }),
    }),
  );
  assert.equal(belowDeclaration.classification, 'invalid-evidence');
  assert.equal(
    belowDeclaration.recoveryAction.property,
    'jobs.build-artifacts.capacity.observation.vcpus',
  );

  const labelOnlyWithHostName = projectEvidence(
    terminalPacket({
      provenance: m3Provenance(),
      jobs: terminalPacket().jobs.map((job) => ({
        ...job,
        runnerLabel: 'heavy-8c16g',
        capacity: undefined,
      })),
    }),
  );
  assert.equal(labelOnlyWithHostName.classification, 'unknown-evidence');
  assert.equal(labelOnlyWithHostName.recoveryAction.action, 'measure-capacity');
  assert.equal(Object.hasOwn(labelOnlyWithHostName, 'physicalHost'), false);
});

test('keeps absent and nonterminal packet evidence explicitly non-admitted', () => {
  const absent = admitPacket(null);
  assert.equal(absent.classification, 'unknown-evidence');
  assert.equal(absent.recoveryAction.code, 'packet-missing');
  assert.equal(absent.recoveryAction.action, 'recollect-evidence');

  const nonterminal = terminalPacket({
    terminal: {
      ...terminalPacket().terminal,
      state: 'in_progress',
      terminalAt: undefined,
    },
  });
  const result = admitPacket(nonterminal);
  assert.equal(result.classification, 'unknown-evidence');
  assert.equal(result.recoveryAction.action, 'wait-for-terminality');
  assert.equal(Object.hasOwn(result, 'queueLatencySeconds'), false);
  assert.equal(Object.hasOwn(result, 'physicalHost'), false);
});

test('preserves failed contexts, bounded retries, and tied earliest failures after later success', () => {
  const failures = [
    {
      context: 'primary-pnpm',
      occurredAt: '2026-08-14T00:08:00.000Z',
      runId: 4101,
      runAttempt: 2,
      headSha: 'a'.repeat(40),
      treatmentId: 'baseline',
      conclusion: 'failure',
      reason: 'test failure',
      retry: { class: 'authorized-test-retry', attempt: 1, maxAttempts: 2 },
    },
    {
      context: 'build-artifacts',
      occurredAt: '2026-08-14T00:08:00.000Z',
      runId: 4101,
      runAttempt: 2,
      headSha: 'a'.repeat(40),
      treatmentId: 'baseline',
      conclusion: 'failure',
      reason: 'artifact failure',
      retry: { class: 'authorized-test-retry', attempt: 1, maxAttempts: 2 },
    },
  ];
  const result = projectEvidence(
    terminalPacket({
      provenance: m3Provenance(),
      jobs: capacityJobs(),
      failures,
      retries: [
        { context: 'primary-pnpm', attempt: 2, maxAttempts: 2, class: 'authorized-test-retry' },
      ],
    }),
  );
  assert.equal(result.classification, 'admissible');
  assert.deepEqual(result.firstFailure.contexts, ['build-artifacts', 'primary-pnpm']);
  assert.equal(result.firstFailure.occurredAt, '2026-08-14T00:08:00.000Z');
  assert.equal(result.retries[0].attempt, 2);

  const overRetry = projectEvidence(
    terminalPacket({
      provenance: m3Provenance(),
      jobs: capacityJobs(),
      retries: [
        { context: 'primary-pnpm', attempt: 3, maxAttempts: 2, class: 'authorized-test-retry' },
      ],
    }),
  );
  assert.equal(overRetry.classification, 'invalid-evidence');
  assert.equal(overRetry.recoveryAction.property, 'retries[0].attempt');

  const unauthorized = projectEvidence(
    terminalPacket({
      provenance: m3Provenance(),
      jobs: capacityJobs(),
      retries: [
        {
          context: 'primary-pnpm',
          attempt: 2,
          maxAttempts: 2,
          class: 'unauthorized-retry-class',
        },
      ],
    }),
  );
  assert.equal(unauthorized.classification, 'invalid-evidence');
  assert.equal(unauthorized.recoveryAction.code, 'retry-class-unauthorized');
});

function matchedPacket({
  runId,
  treatmentId,
  headSha = 'a'.repeat(40),
  wallSeconds = 600,
  jobs: overrideJobs,
  ...overrides
}) {
  const terminalAt = new Date(Date.parse(terminalStart) + wallSeconds * 1000).toISOString();
  const provenance = m3Provenance({
    producer: { ...m3Provenance().producer, runId, treatmentId, headSha },
    artifact: { ...m3Provenance().artifact, runId, treatmentId, headSha },
    report: { ...m3Provenance().report, runId, treatmentId, headSha },
  });
  return terminalPacket({
    identity: identity({ runId, treatmentId, headSha }),
    terminal: {
      ...terminalPacket().terminal,
      runId,
      terminalAt,
      source: { runId, runAttempt: 2, headSha, treatmentId },
    },
    provenance,
    jobs: (overrideJobs ?? capacityJobs()).map((job) => ({
      ...job,
      runId,
      runAttempt: 2,
      source: { runId, runAttempt: 2, headSha, treatmentId },
    })),
    ...overrides,
  });
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

function treatmentTerminalPair(index, terminalOverrides) {
  const pair = matchedPair(index);
  pair.treatment.terminal = {
    ...pair.treatment.terminal,
    ...terminalOverrides,
  };
  return pair;
}

test('requires two distinct matched exact-head pairs before issuing a verdict', () => {
  const onePair = compareMatchedPairs([matchedPair(1)]);
  assert.equal(onePair.verdict, 'unknown-evidence');
  assert.equal(onePair.recoveryAction.code, 'matched-pairs-insufficient');
  assert.equal(onePair.recoveryAction.action, 'recollect-evidence');

  const twoPairs = compareMatchedPairs([matchedPair(1), matchedPair(2)]);
  assert.equal(twoPairs.verdict, 'slo-pass');
  assert.equal(twoPairs.classification, 'slo-pass');
  assert.equal(twoPairs.matchedPairs, 2);
});

test('rejects foreign heads and duplicate pair identities as invalid evidence', () => {
  const foreignHead = compareMatchedPairs([
    matchedPair(1, { treatment: { headSha: 'b'.repeat(40) } }),
    matchedPair(2),
  ]);
  assert.equal(foreignHead.verdict, 'invalid-evidence');
  assert.equal(foreignHead.recoveryAction.code, 'matched-head-mismatch');
  assert.equal(foreignHead.recoveryAction.property, 'pairs[0].treatment.identity.headSha');

  const duplicate = compareMatchedPairs([matchedPair(1), matchedPair(1)]);
  assert.equal(duplicate.verdict, 'invalid-evidence');
  assert.equal(duplicate.recoveryAction.code, 'matched-pair-duplicate');
});

test('rollback-required takes precedence for wall, correctness, retry, capacity, and improvement triggers', () => {
  const cases = [
    {
      name: 'terminal wall breach',
      treatment: { wallSeconds: 1201 },
      code: 'treatment-terminal-wall-breach',
    },
    {
      name: 'no improvement',
      treatment: { wallSeconds: 600 },
      baseline: { wallSeconds: 600 },
      code: 'treatment-no-improvement',
    },
    {
      name: 'correctness regression',
      treatment: {
        classifications: {
          ...terminalPacket().classifications,
          'build-artifacts': { classification: 'executed-failure' },
        },
      },
      code: 'treatment-correctness-regression',
    },
    {
      name: 'lost context',
      treatment: {
        classifications: Object.fromEntries(
          roster.map((name) => [
            name,
            name === 'smoke-fleet' ? undefined : terminalPacket().classifications[name],
          ]),
        ),
      },
      code: 'treatment-required-context-lost',
    },
    {
      name: 'retry instability',
      treatment: {
        retries: [
          { context: 'primary-pnpm', attempt: 2, maxAttempts: 2, class: 'authorized-test-retry' },
        ],
      },
      baseline: { retries: [] },
      code: 'treatment-retry-instability',
    },
    {
      name: 'capacity change',
      treatment: {
        jobs: capacityJobs({
          pool: 'heavy',
          observation: { vcpus: 8, memoryGiB: 16, source: 'cgroup' },
        }),
      },
      code: 'treatment-capacity-changed',
    },
  ];
  for (const scenario of cases) {
    const result = compareMatchedPairs([
      matchedPair(1, { baseline: scenario.baseline, treatment: scenario.treatment }),
      matchedPair(2, { baseline: scenario.baseline, treatment: scenario.treatment }),
    ]);
    assert.equal(result.verdict, 'rollback-required', scenario.name);
    assert.equal(result.recoveryAction.code, scenario.code, scenario.name);
  }
});

test('does not pass terminal non-success packets and emits correctness-failure for matched failures', () => {
  const failed = {
    classifications: {
      ...terminalPacket().classifications,
      'build-artifacts': { classification: 'executed-failure' },
    },
  };
  const result = compareMatchedPairs([
    matchedPair(1, { baseline: failed, treatment: failed }),
    matchedPair(2, { baseline: failed, treatment: failed }),
  ]);
  assert.equal(result.verdict, 'correctness-failure');
  assert.equal(result.recoveryAction.code, 'baseline-correctness-failure');

  const cancelled = compareMatchedPairs([
    matchedPair(1, {
      baseline: {
        classifications: {
          ...terminalPacket().classifications,
          'build-artifacts': { classification: 'cancelled' },
        },
      },
      treatment: {
        classifications: {
          ...terminalPacket().classifications,
          'build-artifacts': { classification: 'cancelled' },
        },
      },
    }),
    matchedPair(2, {
      baseline: {
        classifications: {
          ...terminalPacket().classifications,
          'build-artifacts': { classification: 'cancelled' },
        },
      },
      treatment: {
        classifications: {
          ...terminalPacket().classifications,
          'build-artifacts': { classification: 'cancelled' },
        },
      },
    }),
  ]);
  assert.equal(cancelled.verdict, 'correctness-failure');
});

test('rejects treatment-only terminal non-success outcomes before speed comparison', () => {
  const cases = [
    ['failure', { state: 'failure' }],
    ['cancelled', { state: 'cancelled' }],
    ['superseded', { state: 'superseded' }],
    ['state/conclusion disagreement', { state: 'completed', conclusion: 'failure' }],
  ];
  for (const [name, terminal] of cases) {
    const result = compareMatchedPairs([
      treatmentTerminalPair(1, terminal),
      treatmentTerminalPair(2, terminal),
    ]);
    assert.equal(result.verdict, 'rollback-required', name);
    assert.equal(result.recoveryAction.code, 'treatment-correctness-failure', name);
    assert.equal(result.recoveryAction.property, 'pairs[0].treatment.correctnessFailure', name);
  }
});

test('unknown and invalid packet states retain property-addressable recovery', () => {
  const unknown = compareMatchedPairs([
    matchedPair(1, { treatment: { terminal: { createdAt: terminalStart } } }),
    matchedPair(2),
  ]);
  assert.equal(unknown.verdict, 'unknown-evidence');
  assert.equal(unknown.recoveryAction.action, 'wait-for-terminality');
  assert.match(unknown.recoveryAction.property, /pairs\[0\]/);

  const invalid = compareMatchedPairs([
    matchedPair(1, {
      treatment: {
        provenance: m3Provenance({
          producer: { ...m3Provenance().producer, runId: 99 },
        }),
      },
    }),
    matchedPair(2),
  ]);
  assert.equal(invalid.verdict, 'invalid-evidence');
  assert.equal(invalid.recoveryAction.action, 'discard-foreign-evidence');
  assert.equal(invalid.recoveryAction.property, 'pairs[0].treatment.provenance.producer.runId');
});

test('recovery layers stay explicit while partial evidence remains fail-closed', () => {
  const cases = [
    {
      layer: 'source',
      result: admitPacket(packet({ source: undefined })),
      expectedCode: 'provenance-missing',
    },
    {
      layer: 'terminal',
      result: admitPacket(packet({ terminal: null })),
      expectedCode: 'terminal-clock-missing',
    },
    {
      layer: 'delivery',
      result: admitPacket(terminalPacket()),
      expectedCode: 'provenance-field-missing',
    },
    {
      layer: 'comparison',
      result: compareMatchedPairs([]),
      expectedCode: 'matched-pairs-insufficient',
    },
  ];

  for (const { layer, result, expectedCode } of cases) {
    assert.notEqual(result.classification ?? result.verdict, 'slo-pass');
    assert.ok(result.recoveryAction, `${layer} failure must expose recoveryAction`);
    assert.equal(result.recoveryAction.code, expectedCode);
    assert.equal(result.recoveryAction.failureLayer, layer);
    for (const field of [
      'code',
      'failureLayer',
      'property',
      'expected',
      'observed',
      'detail',
      'action',
    ]) {
      assert.ok(Object.hasOwn(result.recoveryAction, field), `${layer}.${field}`);
    }
    assert.equal(typeof result.recoveryAction.detail, 'string');
    assert.equal(typeof result.recoveryAction.action, 'string');
  }

  const partial = admitPacket(packet({ source: undefined }));
  assert.deepEqual(partial.identity, identity());
  assert.deepEqual(partial.classifications, classifications());
  assert.notEqual(partial.classification, 'admissible');
});
