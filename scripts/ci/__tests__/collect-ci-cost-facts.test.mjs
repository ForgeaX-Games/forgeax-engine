import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const root = join(directory, '..', '..', '..');
const script = join(root, 'scripts', 'ci', 'collect-ci-cost-facts.mjs');
const contract = JSON.parse(
  readFileSync(join(root, 'scripts', 'ci', 'build-artifact-contract.json'), 'utf8'),
);

test('uses non-interactive overwrite mode when expanding duplicate artifact paths', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(source, /execFileSync\('unzip', \['-q', '-o', archive, '-d', destination\]\)/);
});

function fixture() {
  const payloadClasses = contract.provenance.payloadClasses;
  const artifacts = payloadClasses.map((_className, index) => ({
    id: `artifact-${index}`,
    name: `ignored-${index}`,
    size_in_bytes: 1000 + index,
    created_at: `2026-07-16T00:00:${String(index + 1).padStart(2, '0')}Z`,
    expired: false,
    workflow_run: { id: 42, run_attempt: 1 },
  }));
  const jobs = [
    {
      name: 'post-merge-gate',
      started_at: '2026-07-16T00:00:00Z',
      completed_at: '2026-07-16T00:00:00Z',
      conclusion: 'success',
      run_attempt: 1,
    },
    {
      name: 'core-build',
      started_at: '2026-07-16T00:00:00Z',
      completed_at: '2026-07-16T00:00:00Z',
      conclusion: 'success',
      run_attempt: 1,
    },
    {
      name: 'shared-app-inputs',
      started_at: '2026-07-16T00:00:00Z',
      completed_at: '2026-07-16T00:00:15Z',
      conclusion: 'success',
      run_attempt: 1,
    },
    ...contract.timingRoster
      .filter((consumer) => !consumer.notApplicable)
      .map((consumer) => ({
        name: consumer.jobIdentity,
        started_at: '2026-07-16T00:00:20Z',
        completed_at: '2026-07-16T00:01:00Z',
        conclusion: 'success',
        run_attempt: 1,
      })),
  ];
  return {
    runId: 42,
    runAttempt: 1,
    mergedProvenance: {
      schemaVersion: 1,
      runId: 42,
      aggregateAttempt: 1,
      producerAttempts: {
        'core-build': 1,
        'shared-app-inputs': 1,
        'app-shard-0': 1,
        'app-shard-1': 1,
        'app-shard-2': 1,
      },
      artifacts: payloadClasses.map((className, index) => ({
        class: className,
        producer: className.startsWith('app-')
          ? `app-shard-${className.at(-1)}`
          : className.startsWith('shared-')
            ? 'shared-app-inputs'
            : 'core-build',
        producerAttempt: 1,
        artifactName: `ignored-${index}`,
        artifactId: `artifact-${index}`,
      })),
      sharedInputs: { inputFingerprint: 'shared-input-fingerprint' },
    },
    artifactPages: [{ total_count: artifacts.length, artifacts }],
    jobPages: [{ total_count: jobs.length, jobs }],
    expandedBytesByArtifactId: Object.fromEntries(artifacts.map((artifact) => [artifact.id, 2000])),
    sharedProduction: {
      cacheState: 'cold',
      producer: 'shared-app-inputs',
      inputFingerprint: 'shared-input-fingerprint',
      sourceScanCount: 1,
      payloadEmitCount: 2,
      engineCompileCount: 1,
      buildDurationSeconds: 10,
    },
    sharedEvidence: {
      schemaVersion: 1,
      producer: 'shared-evidence-probe',
      inputFingerprint: 'shared-input-fingerprint',
      baseline: { sourceScanCount: 3, payloadEmitCount: 4, engineCompileCount: 3 },
      samples: [
        { cacheState: 'cold', sourceScanCount: 1, payloadEmitCount: 2, engineCompileCount: 1 },
        { cacheState: 'warm', sourceScanCount: 1, payloadEmitCount: 2, engineCompileCount: 1 },
      ],
    },
    cache: { activeBytes: 100, warmRestoreSeconds: 1, entries: [] },
  };
}

function run(input) {
  const temp = mkdtempSync(join(tmpdir(), 'ci-cost-facts-'));
  const inputPath = join(temp, 'input.json');
  const outputPath = join(temp, 'facts.json');
  writeFileSync(inputPath, JSON.stringify(input));
  try {
    const stdout = execFileSync(
      process.execPath,
      [script, '--input', inputPath, '--out', outputPath],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return { exitCode: 0, stdout, facts: JSON.parse(readFileSync(outputPath, 'utf8')) };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout?.toString() ?? '' };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test('t19: resolves artifact facts only through merged provenance IDs across paginated API data', () => {
  const input = fixture();
  input.artifactPages = [
    {
      total_count: input.artifactPages[0].artifacts.length,
      artifacts: input.artifactPages[0].artifacts.slice(0, 3),
    },
    {
      total_count: input.artifactPages[0].artifacts.length,
      artifacts: input.artifactPages[0].artifacts.slice(3),
    },
  ];
  input.jobPages = [
    { total_count: input.jobPages[0].jobs.length, jobs: input.jobPages[0].jobs.slice(0, 3) },
    { total_count: input.jobPages[0].jobs.length, jobs: input.jobPages[0].jobs.slice(3) },
  ];
  const result = run(input);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(result.facts.artifacts.length, contract.provenance.payloadClasses.length);
  assert.equal(result.facts.ac06.status, 'pass');
  assert.equal(
    result.facts.ac06.perConsumer.every(
      (consumer) => consumer.status === 'pass' || consumer.status === 'notApplicable',
    ),
    true,
  );
  assert.equal(
    result.facts.consumers.find((consumer) => consumer.name === 'primary-pnpm')
      .lastRequiredArtifactReadyAt,
    '2026-07-16T00:00:09Z',
  );
});

test('accepts the merged provenance run ID serialized by the artifact producer', () => {
  const input = fixture();
  input.mergedProvenance.runId = String(input.runId);
  const result = run(input);
  assert.equal(result.exitCode, 0, result.stdout);
});

test('t19: records deterministic per-class byte totals and compression ratios', () => {
  const input = fixture();
  const appDist = input.mergedProvenance.artifacts.find(
    (artifact) => artifact.class === 'app-dist-2',
  );
  const appDistFact = input.artifactPages[0].artifacts.find(
    (artifact) => artifact.id === appDist.artifactId,
  );
  appDistFact.size_in_bytes = 800_000_000;
  input.expandedBytesByArtifactId[appDist.artifactId] = 1_600_000_000;
  const result = run(input);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.deepEqual(result.facts.artifactBytes.byClass['app-dist-2'], {
    compressedBytes: 800_000_000,
    expandedBytes: 1_600_000_000,
    compressionRatio: 0.5,
  });
  assert.equal(result.facts.artifactBytes.totalCompressedBytes, 800_008_028);
  assert.equal(result.facts.artifactBytes.totalExpandedBytes, 1_600_016_000);
  assert.equal(result.facts.artifactBytes.compressionRatio, 0.5);
});

test('t19: preserves an absent expanded payload as an explicit null ratio', () => {
  const input = fixture();
  const artifact = input.mergedProvenance.artifacts.find((entry) => entry.class === 'wasm-codec');
  input.expandedBytesByArtifactId[artifact.artifactId] = 0;
  const result = run(input);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(result.facts.artifactBytes.byClass['wasm-codec'].compressionRatio, null);
});

test('t19: rejects absent or invalid merged provenance instead of scanning artifact names', () => {
  for (const mutate of [
    (input) => delete input.mergedProvenance,
    (input) => input.mergedProvenance.artifacts.pop(),
    (input) => {
      delete input.mergedProvenance.producerAttempts;
    },
  ]) {
    const input = fixture();
    mutate(input);
    const result = run(input);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stdout, /ci-provenance-merged-(missing|invalid)/);
  }
});

test('t19: classifies timing records as pass, fail, invalidSample, and notApplicable', () => {
  const delayed = fixture();
  delayed.jobPages[0].jobs.find((job) => job.name === 'vitest-dawn').started_at =
    '2026-07-16T00:01:08Z';
  const failed = run(delayed);
  assert.equal(failed.exitCode, 0, failed.stdout);
  assert.equal(
    failed.facts.ac06.perConsumer.find((consumer) => consumer.jobIdentity === 'vitest-dawn').code,
    'ci-cost-artifact-ready-to-job-start-budget-exceeded',
  );

  const invalid = fixture();
  invalid.jobPages[0].jobs.find((job) => job.name === 'vitest-dawn').started_at = null;
  const invalidResult = run(invalid);
  assert.equal(invalidResult.exitCode, 0, invalidResult.stdout);
  assert.equal(
    invalidResult.facts.ac06.perConsumer.find((consumer) => consumer.jobIdentity === 'vitest-dawn')
      .status,
    'invalidSample',
  );

  const prerequisite = fixture();
  prerequisite.jobPages[0].jobs.find((job) => job.name === 'post-merge-gate').completed_at =
    '2026-07-16T00:00:08Z';
  const prerequisiteResult = run(prerequisite);
  assert.equal(prerequisiteResult.exitCode, 0, prerequisiteResult.stdout);
  assert.equal(
    prerequisiteResult.facts.ac06.perConsumer.find(
      (consumer) => consumer.jobIdentity === 'vitest-dawn',
    ).status,
    'pass',
  );
  assert.equal(
    prerequisiteResult.facts.ac06.perConsumer.find(
      (consumer) => consumer.jobIdentity === 'vitest-dawn',
    ).effectiveReadyAt,
    '2026-07-16T00:00:08Z',
  );
});

test('w22: derives matrix consumer timing from the earliest real child, not its compatibility aggregate', () => {
  const input = fixture();
  const aggregate = input.jobPages[0].jobs.find((job) => job.name === 'smoke-fleet');
  aggregate.started_at = '2026-07-16T00:02:00Z';
  aggregate.completed_at = '2026-07-16T00:02:30Z';
  input.jobPages[0].jobs.push(
    {
      name: 'smoke-fleet-0',
      started_at: '2026-07-16T00:00:20Z',
      completed_at: '2026-07-16T00:01:00Z',
      conclusion: 'success',
      run_attempt: 1,
    },
    {
      name: 'smoke-fleet-1',
      started_at: '2026-07-16T00:00:30Z',
      completed_at: '2026-07-16T00:01:00Z',
      conclusion: 'success',
      run_attempt: 1,
    },
  );
  input.jobPages[0].total_count += 2;
  const result = run(input);
  assert.equal(result.exitCode, 0, result.stdout);
  const timing = result.facts.ac06.perConsumer.find(
    (consumer) => consumer.jobIdentity === 'smoke-fleet',
  );
  assert.equal(timing.status, 'pass');
  assert.equal(timing.observedJobStartedAt, '2026-07-16T00:00:20Z');
  assert.equal(
    result.facts.consumers.find((consumer) => consumer.name === 'smoke-fleet').startedAt,
    '2026-07-16T00:00:20Z',
  );
});

test('w19: records provenance-bound cold and warm shared production facts without cache substitutes', () => {
  for (const cacheState of ['cold', 'warm']) {
    const input = fixture();
    input.sharedProduction.cacheState = cacheState;
    const result = run(input);
    assert.equal(result.exitCode, 0, result.stdout);
    assert.equal(result.facts.sharedProduction.cacheState, cacheState);
    assert.equal(result.facts.sharedProduction.artifactBytes, 2009);
    assert.equal(result.facts.sharedProduction.transferBytes, 6027);
    assert.equal(result.facts.sharedProduction.totalDurationSeconds, 15);
    assert.deepEqual(result.facts.sharedProduction.provenance, {
      runId: 42,
      runAttempt: 1,
      inputFingerprint: 'shared-input-fingerprint',
      artifactIds: ['artifact-4', 'artifact-5'],
    });
  }

  for (const mutate of [
    (input) => delete input.sharedProduction,
    (input) => delete input.sharedProduction.engineCompileCount,
    (input) =>
      (input.mergedProvenance.artifacts.find(
        (artifact) => artifact.class === 'shared-asset-pack',
      ).producer = 'core-build'),
    (input) => (input.sharedProduction.producer = 'cache-key'),
  ]) {
    const input = fixture();
    mutate(input);
    const result = run(input);
    assert.equal(result.exitCode, 0, result.stdout);
    assert.equal(result.facts.sharedProduction.status, 'invalidEvidence');
    assert.match(result.facts.sharedProduction.code, /^ci-cost-shared-/);
  }
});

test('repair: reads measured facts from merged producer provenance and rejects mismatched linkage', () => {
  const input = fixture();
  input.mergedProvenance.sharedProduction = structuredClone(input.sharedProduction);
  delete input.sharedProduction;
  const result = run(input);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(result.facts.sharedProduction.provenance.runId, 42);

  input.mergedProvenance.sharedProduction.inputFingerprint = 'stale';
  const invalid = run(input);
  assert.equal(invalid.exitCode, 0, invalid.stdout);
  assert.equal(invalid.facts.sharedProduction.status, 'invalidEvidence');
  assert.equal(
    invalid.facts.sharedProduction.code,
    'ci-cost-shared-provenance-fingerprint-invalid',
  );
});

test('repair: retains invalid AC-06 evidence until cold, warm, and baseline records are present', () => {
  for (const mutate of [
    (input) => delete input.sharedEvidence,
    (input) => input.sharedEvidence.samples.pop(),
    (input) => (input.sharedEvidence.baseline.engineCompileCount = 1),
  ]) {
    const input = fixture();
    mutate(input);
    const result = run(input);
    assert.equal(result.exitCode, 0, result.stdout);
    assert.equal(result.facts.ac06.status, 'invalid');
    assert.equal(result.facts.ac06.sharedEvidence.status, 'invalidEvidence');
  }
});

test('repair: rejects shared evidence without its declared producer contract', () => {
  for (const mutate of [
    (input) => (input.sharedEvidence.producer = 'shared-app-inputs'),
    (input) => delete input.sharedEvidence.inputFingerprint,
    (input) => (input.sharedEvidence.schemaVersion = 2),
  ]) {
    const input = fixture();
    mutate(input);
    const result = run(input);
    assert.equal(result.exitCode, 0, result.stdout);
    assert.equal(result.facts.ac06.status, 'invalid');
    assert.equal(result.facts.ac06.sharedEvidence.status, 'invalidEvidence');
  }
});
