import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const root = join(directory, '..', '..', '..');
const script = join(root, 'scripts', 'ci', 'collect-ci-cost-facts.mjs');
const monitorScript = join(root, 'scripts', 'ci', 'collect-ci-cost-monitor.mjs');
const contract = JSON.parse(
  readFileSync(join(root, 'scripts', 'ci', 'build-artifact-contract.json'), 'utf8'),
);

function fingerprint(label) {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

test('uses non-interactive overwrite mode when expanding duplicate artifact paths', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(source, /execFileAsync\('unzip', \['-q', '-o', archive, '-d', destination\]\)/);
});

test('deduplicates artifact expansion when provenance classes share an artifact', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(
    source,
    /new Map\(artifacts\.map\(\(artifact\) => \[String\(artifact\.id\), artifact\]\)\)/,
  );
  assert.match(source, /mapBatches\(\n\s+uniqueArtifacts,\n\s+expandedBytesConcurrency,/);
  assert.match(source, /const expandedBytesConcurrency = 3;/);
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
    {
      name: 'build-artifacts',
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
  for (const [index, job] of jobs.entries()) {
    job.id = 100 + index;
    job.runner_id = 200 + index;
    job.runner_name = `runner-${index}`;
    job.runner_group_id = 300;
    job.labels = ['self-hosted', index % 2 === 0 ? 'standard' : 'heavy'];
  }
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
        producerRunAttempt: 1,
        artifactName: `ignored-${index}`,
        artifactId: `artifact-${index}`,
        inputFingerprint: fingerprint(className),
        upload: {
          startedAt: '2026-07-16T00:00:00Z',
          completedAt: '2026-07-16T00:00:02Z',
          elapsedSeconds: 2,
          transferAttempt: 1,
        },
      })),
      sharedInputs: { inputFingerprint: 'shared-input-fingerprint' },
    },
    artifactPages: [{ total_count: artifacts.length, artifacts }],
    jobPages: [{ total_count: jobs.length, jobs }],
    expandedBytesByArtifactId: Object.fromEntries(artifacts.map((artifact) => [artifact.id, 2000])),
    downloadObservationsByArtifactId: Object.fromEntries(
      artifacts.map((artifact) => [
        artifact.id,
        {
          startedAt: '2026-07-16T00:00:16Z',
          completedAt: '2026-07-16T00:00:18Z',
          elapsedSeconds: 2,
        },
      ]),
    ),
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
    cacheTiming: {
      schemaVersion: 1,
      family: 'merged-ddc',
      identity: { runId: '42', runAttempt: 1 },
      producer: { owner: 'cache-warm', producerRunAttempt: 1 },
      consumer: { owner: 'cost-reporter', runAttempt: 1 },
      inputFingerprint: fingerprint('merged-ddc'),
      requestedKey: 'forgeax-ddc-primary',
      matchedKey: 'forgeax-ddc-primary',
      cacheHit: 'true',
      restore: { elapsedSeconds: 1 },
      save: { outcome: 'notApplicable' },
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

function sharePhysicalArtifacts(input) {
  const physicalByTransfer = new Map();
  for (const record of input.mergedProvenance.artifacts) {
    const transfer = contract.artifactClasses[record.class].transferArtifact;
    const physicalId = physicalByTransfer.get(transfer) ?? `${transfer}-physical`;
    physicalByTransfer.set(transfer, physicalId);
    record.artifactId = physicalId;
  }
  const artifactsById = new Map();
  for (const [index, record] of input.mergedProvenance.artifacts.entries()) {
    if (artifactsById.has(record.artifactId)) continue;
    artifactsById.set(record.artifactId, {
      id: record.artifactId,
      name: record.artifactName,
      size_in_bytes: 1000 + index,
      created_at: `2026-07-16T00:00:${String(index + 1).padStart(2, '0')}Z`,
      expired: false,
      workflow_run: { id: 42, run_attempt: 1 },
    });
  }
  input.artifactPages = [
    { total_count: artifactsById.size, artifacts: [...artifactsById.values()] },
  ];
  input.expandedBytesByArtifactId = Object.fromEntries(
    [...artifactsById.keys()].map((id, index) => [id, 2000 + index]),
  );
  input.downloadObservationsByArtifactId = Object.fromEntries(
    [...artifactsById.keys()].map((id) => [
      id,
      {
        startedAt: '2026-07-16T00:00:16Z',
        completedAt: '2026-07-16T00:00:18Z',
        elapsedSeconds: 2,
      },
    ]),
  );
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

test('emits exactly one contract-bound valid result for every declared return family', () => {
  const result = run(fixture());
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(result.facts.returnEvidence.schemaVersion, contract.returnEvidence.schemaVersion);
  assert.equal(result.facts.returnEvidence.contractVersion, contract.version);
  const expectedFamilies = [
    ...contract.returnEvidence.cacheFamilies.map(({ family }) => family),
    ...Object.keys(contract.artifactClasses),
  ].sort();
  const rows = result.facts.returnEvidence.families;
  assert.deepEqual(rows.map(({ family }) => family).sort(), expectedFamilies);
  assert.equal(new Set(rows.map(({ family }) => family)).size, expectedFamilies.length);
  assert.equal(
    rows.every(({ status }) => status === 'valid'),
    true,
  );
  for (const row of rows) {
    assert.deepEqual(row.identity, { runId: 42, runAttempt: 1 });
    assert.equal(typeof row.inputFingerprint, 'string');
    assert.equal(row.inputFingerprint.length > 0, true);
  }
  assert.equal(rows.find(({ family }) => family === 'merged-ddc').classification, 'exact-hit');
});

test('classifies cache outcomes only from structured cache owner facts', () => {
  for (const [classification, mutate] of [
    [
      'prefix-hit',
      (cache) => {
        cache.cacheHit = 'false';
        cache.matchedKey = 'forgeax-ddc-prefix';
      },
    ],
    [
      'miss',
      (cache) => {
        cache.cacheHit = '';
        cache.matchedKey = '';
        cache.save = { outcome: 'success', elapsedSeconds: 3 };
      },
    ],
  ]) {
    const input = fixture();
    mutate(input.cacheTiming);
    const result = run(input);
    assert.equal(result.exitCode, 0, result.stdout);
    const row = result.facts.returnEvidence.families.find(({ family }) => family === 'merged-ddc');
    assert.equal(row.status, 'valid');
    assert.equal(row.classification, classification);
    assert.equal(row.inputFingerprint, fingerprint('merged-ddc'));
  }

  const inconsistent = fixture();
  inconsistent.cacheTiming.cacheHit = 'true';
  inconsistent.cacheTiming.matchedKey = 'forgeax-ddc-prefix';
  const result = run(inconsistent);
  assert.equal(result.exitCode, 0, result.stdout);
  const row = result.facts.returnEvidence.families.find(({ family }) => family === 'merged-ddc');
  assert.equal(row.status, 'invalidEvidence');
  assert.equal(row.code, 'cache-output-inconsistent');
  assert.deepEqual(row.detail, {
    cacheHit: 'true',
    requestedKey: 'forgeax-ddc-primary',
    matchedKey: 'forgeax-ddc-prefix',
  });
});

test('keeps missing family owner evidence local and structurally recoverable', () => {
  const input = fixture();
  const target = input.mergedProvenance.artifacts.find(
    ({ class: className }) => className === 'app-dist-1',
  );
  delete target.inputFingerprint;
  const result = run(input);
  assert.equal(result.exitCode, 0, result.stdout);
  const targetRow = result.facts.returnEvidence.families.find(
    ({ family }) => family === 'app-dist-1',
  );
  assert.equal(targetRow.status, 'invalidEvidence');
  assert.equal(targetRow.code, 'fingerprint-missing');
  assert.deepEqual(targetRow.identity, { runId: 42, runAttempt: 1 });
  assert.equal(typeof targetRow.expected, 'object');
  assert.equal(typeof targetRow.hint, 'string');
  assert.equal(typeof targetRow.detail, 'object');
  assert.equal('compressedArchiveBytes' in targetRow, false);
  assert.equal('download' in targetRow, false);
  assert.equal(
    result.facts.returnEvidence.families
      .filter(({ family }) => family !== 'app-dist-1')
      .every(({ status }) => status === 'valid'),
    true,
  );
});

test('rejects malformed producer fingerprints as family-local mismatch evidence', () => {
  const artifactInput = fixture();
  const target = artifactInput.mergedProvenance.artifacts.find(
    ({ class: className }) => className === 'app-dist-1',
  );
  target.inputFingerprint = 'sha256:not-a-digest';
  const artifactResult = run(artifactInput);
  assert.equal(artifactResult.exitCode, 0, artifactResult.stdout);
  const artifactRow = artifactResult.facts.returnEvidence.families.find(
    ({ family }) => family === 'app-dist-1',
  );
  assert.equal(artifactRow.status, 'invalidEvidence');
  assert.equal(artifactRow.code, 'fingerprint-mismatch');
  assert.equal(artifactRow.detail.observedFingerprint, 'sha256:not-a-digest');
  assert.equal(
    artifactResult.facts.returnEvidence.families
      .filter(({ family }) => family !== 'app-dist-1')
      .every(({ status }) => status === 'valid'),
    true,
  );

  const cacheInput = fixture();
  cacheInput.cacheTiming.inputFingerprint = 'sha256:not-a-digest';
  const cacheResult = run(cacheInput);
  assert.equal(cacheResult.exitCode, 0, cacheResult.stdout);
  const cacheRow = cacheResult.facts.returnEvidence.families.find(
    ({ family }) => family === 'merged-ddc',
  );
  assert.equal(cacheRow.status, 'invalidEvidence');
  assert.equal(cacheRow.code, 'fingerprint-mismatch');
  assert.equal(cacheRow.detail.observedFingerprint, 'sha256:not-a-digest');
});

test('rejects aggregate and selected producer attempt mismatches per family', () => {
  const aggregate = fixture();
  aggregate.mergedProvenance.aggregateAttempt = 2;
  const aggregateResult = run(aggregate);
  assert.equal(aggregateResult.exitCode, 0, aggregateResult.stdout);
  assert.equal(
    aggregateResult.facts.returnEvidence.families.every(
      ({ status, code }) => status === 'invalidEvidence' && code === 'aggregate-attempt-mismatch',
    ),
    true,
  );

  const foreign = fixture();
  const target = foreign.mergedProvenance.artifacts.find(
    ({ class: className }) => className === 'app-dist-2',
  );
  target.producerRunAttempt = 2;
  const foreignResult = run(foreign);
  assert.equal(foreignResult.exitCode, 0, foreignResult.stdout);
  const row = foreignResult.facts.returnEvidence.families.find(
    ({ family }) => family === 'app-dist-2',
  );
  assert.equal(row.status, 'invalidEvidence');
  assert.equal(row.code, 'foreign-producer-attempt');
  assert.equal(row.inputFingerprint, fingerprint('app-dist-2'));
  assert.deepEqual(row.expected, { producer: 'app-shard-2', producerRunAttempt: 1 });
  assert.deepEqual(row.detail, { observedProducerAttempt: 2 });
});

test('keeps native job and runner observations without queue or effect claims', () => {
  const result = run(fixture());
  assert.equal(result.exitCode, 0, result.stdout);
  const job = result.facts.jobs.find(({ name }) => name === 'core-build');
  assert.deepEqual(job, {
    jobId: 101,
    name: 'core-build',
    runAttempt: 1,
    startedAt: '2026-07-16T00:00:00Z',
    completedAt: '2026-07-16T00:00:00Z',
    result: 'success',
    runnerId: 201,
    runnerName: 'runner-1',
    runnerGroupId: 300,
    labels: ['self-hosted', 'heavy'],
  });
  assert.doesNotMatch(JSON.stringify(result.facts), /queue|criticalPath|runnerCost|speedup|Effect/);
});

test('monitor runtime failure emits ten recoverable invalid rows without blocking', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ci-cost-monitor-'));
  const outputPath = join(temp, 'facts.json');
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        monitorScript,
        '--input',
        join(temp, 'missing-input.json'),
        '--run-id',
        '42',
        '--attempt',
        '3',
        '--out',
        outputPath,
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    assert.match(stdout, /::warning title=CI cost monitor::/);
    const facts = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.deepEqual(
      facts.returnEvidence.families.map(({ family }) => family).sort(),
      [
        ...contract.returnEvidence.cacheFamilies.map(({ family }) => family),
        ...Object.keys(contract.artifactClasses),
      ].sort(),
    );
    assert.equal(
      facts.returnEvidence.families.every(
        ({ status, code, identity, expected, hint, detail }) =>
          status === 'invalidEvidence' &&
          code === 'owner-fact-missing' &&
          identity.runId === 42 &&
          identity.runAttempt === 3 &&
          typeof expected === 'object' &&
          typeof hint === 'string' &&
          typeof detail === 'object',
      ),
      true,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
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

test('measures and totals each shared physical artifact only once', () => {
  const input = fixture();
  sharePhysicalArtifacts(input);
  const result = run(input);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(result.facts.physicalArtifacts.length, 5);
  assert.equal(new Set(result.facts.physicalArtifacts.map(({ artifactId }) => artifactId)).size, 5);
  assert.equal(
    result.facts.artifactBytes.totalCompressedBytes,
    result.facts.physicalArtifacts.reduce(
      (sum, artifact) => sum + artifact.compressedArchiveBytes,
      0,
    ),
  );
  assert.equal(
    result.facts.artifactBytes.totalExpandedBytes,
    result.facts.physicalArtifacts.reduce((sum, artifact) => sum + artifact.expandedDiskBytes, 0),
  );
  const coreRows = result.facts.returnEvidence.families.filter(({ family }) =>
    ['engine-dist', 'wasm-runtime', 'wasm-fbx', 'wasm-codec'].includes(family),
  );
  assert.equal(new Set(coreRows.map(({ artifactId }) => artifactId)).size, 1);
});

test('does not synthesize missing physical transfer timing from metadata or zero', () => {
  const input = fixture();
  sharePhysicalArtifacts(input);
  const coreId = input.mergedProvenance.artifacts.find(
    ({ class: className }) => className === 'engine-dist',
  ).artifactId;
  delete input.downloadObservationsByArtifactId[coreId];
  const artifact = input.artifactPages[0].artifacts.find(({ id }) => id === coreId);
  artifact.created_at = '2026-07-16T00:00:02Z';
  artifact.logs = 'download completed in 0 seconds';
  artifact.stepDurationSeconds = 0;
  const result = run(input);
  assert.equal(result.exitCode, 0, result.stdout);
  const coreRows = result.facts.returnEvidence.families.filter(({ family }) =>
    ['engine-dist', 'wasm-runtime', 'wasm-fbx', 'wasm-codec'].includes(family),
  );
  assert.equal(
    coreRows.every(
      ({ status, code, detail }) =>
        status === 'invalidEvidence' &&
        code === 'owner-fact-missing' &&
        detail.field === 'download',
    ),
    true,
  );
  assert.equal(
    result.facts.physicalArtifacts.some(({ artifactId }) => artifactId === coreId),
    false,
  );
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

test('anchors effective ready-to-start timing after the artifact provider aggregate completes', () => {
  const input = fixture();
  const provider = input.jobPages[0].jobs.find((job) => job.name === 'build-artifacts');
  provider.completed_at = '2026-07-16T00:00:19Z';
  const result = run(input);
  assert.equal(result.exitCode, 0, result.stdout);
  const timing = result.facts.ac06.perConsumer.find(
    (consumer) => consumer.jobIdentity === 'primary-pnpm',
  );
  assert.equal(timing.artifactProviderReadyAt, '2026-07-16T00:00:19Z');
  assert.equal(timing.effectiveReadyAt, '2026-07-16T00:00:19Z');
  assert.equal(timing.observedArtifactReadyToJobStartDelaySeconds, 11);
  assert.equal(timing.unattributedStartDelaySeconds, 1);

  const missingProvider = fixture();
  missingProvider.jobPages[0].jobs = missingProvider.jobPages[0].jobs.filter(
    (job) => job.name !== 'build-artifacts',
  );
  missingProvider.jobPages[0].total_count -= 1;
  const missingResult = run(missingProvider);
  assert.equal(missingResult.exitCode, 0, missingResult.stdout);
  assert.equal(
    missingResult.facts.ac06.perConsumer.find((consumer) => consumer.jobIdentity === 'primary-pnpm')
      .code,
    'ci-cost-artifact-provider-completion-missing',
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
