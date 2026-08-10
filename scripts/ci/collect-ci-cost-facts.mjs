#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { POOL_LABELS } from './check-runner-pool-labels.mjs';
import { observeArtifactDownload } from './download-artifact-with-retry.mjs';
import { isFingerprint } from './evidence/fingerprint.mjs';
import { parseGhPages } from './parse-gh-pages.mjs';

const maxDelaySeconds = 60;
const execFileAsync = promisify(execFile);
const expandedBytesConcurrency = 3;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}
function fail(code, detail = {}) {
  process.stdout.write(`${JSON.stringify({ code, ...detail })}\n`);
  process.exit(1);
}
function readJson(path, code) {
  if (!path || !existsSync(path)) fail(code);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(code);
  }
}
function flattenPages(pages, key) {
  if (!Array.isArray(pages) || pages.length === 0)
    fail('ci-cost-rest-pagination-missing', { expected: key });
  const expected = pages[0]?.total_count;
  const values = pages.flatMap((page) => page?.[key] ?? []);
  if (!Number.isInteger(expected) || values.length !== expected)
    fail('ci-cost-rest-pagination-incomplete', { actual: values.length, expected, key });
  return values;
}
function ghPages(endpoint, key) {
  const text = execFileSync('gh', ['api', '--paginate', endpoint], { encoding: 'utf8' });
  try {
    return flattenPages(parseGhPages(text), key);
  } catch {
    fail('ci-cost-rest-pagination-invalid', { expected: key });
  }
}
function dateSeconds(value) {
  const time = Date.parse(value ?? '');
  return Number.isNaN(time) ? null : time / 1000;
}
function timestamp(value) {
  return typeof value === 'string' && dateSeconds(value) !== null ? value : null;
}
function timingSeconds(later, earlier) {
  return Number((dateSeconds(later) - dateSeconds(earlier)).toFixed(6));
}
function timingInvalid(job, runAttempt, code, expected, detail) {
  return {
    jobId: job.id ?? null,
    name: job.name,
    runAttempt: job.run_attempt ?? null,
    createdAt: job.created_at ?? null,
    startedAt: job.started_at ?? null,
    completedAt: job.completed_at ?? null,
    result: job.conclusion ?? null,
    runnerId: job.runner_id ?? null,
    runnerName: job.runner_name ?? null,
    runnerGroupId: job.runner_group_id ?? null,
    labels: Array.isArray(job.labels) ? job.labels : [],
    pool: null,
    queueWaitSeconds: null,
    activeSeconds: null,
    totalSeconds: null,
    status: 'invalidEvidence',
    code,
    expected,
    hint: 'Check the run-scoped job timestamps and runner labels, then collect a new evidence sample.',
    detail: {
      runAttempt: Number.isInteger(runAttempt) ? runAttempt : null,
      ...detail,
    },
  };
}
function jobTimingProjection(job, runId, runAttempt) {
  const createdAt = timestamp(job.created_at);
  const startedAt = timestamp(job.started_at);
  const completedAt = timestamp(job.completed_at);
  const labels = Array.isArray(job.labels) ? job.labels : [];
  const pools = labels.filter((label) => POOL_LABELS.includes(label));
  const baseExpected = {
    runId,
    runAttempt,
    timestamps: ['createdAt', 'startedAt', 'completedAt'],
    pool: POOL_LABELS,
  };
  if (!createdAt || !startedAt || !completedAt)
    return timingInvalid(job, runAttempt, 'ci-cost-job-timing-missing', baseExpected, {
      missing: ['createdAt', 'startedAt', 'completedAt'].filter(
        (field) => !{ createdAt, startedAt, completedAt }[field],
      ),
    });
  if (
    dateSeconds(startedAt) < dateSeconds(createdAt) ||
    dateSeconds(completedAt) < dateSeconds(startedAt)
  )
    return timingInvalid(job, runAttempt, 'ci-cost-job-timing-reversed', baseExpected, {
      createdAt,
      startedAt,
      completedAt,
    });
  if (pools.length !== 1)
    return timingInvalid(job, runAttempt, 'ci-cost-job-pool-invalid', baseExpected, {
      labels,
      pools,
    });
  return {
    jobId: job.id ?? null,
    name: job.name,
    runAttempt: job.run_attempt ?? null,
    createdAt,
    startedAt,
    completedAt,
    result: job.conclusion ?? null,
    runnerId: job.runner_id ?? null,
    runnerName: job.runner_name ?? null,
    runnerGroupId: job.runner_group_id ?? null,
    labels,
    pool: pools[0],
    queueWaitSeconds: timingSeconds(startedAt, createdAt),
    activeSeconds: timingSeconds(completedAt, startedAt),
    totalSeconds: timingSeconds(completedAt, createdAt),
    status: 'valid',
  };
}
function requiredArtifactClasses(contract, timingEntry) {
  if (timingEntry.notApplicable) return [];
  const classes = contract.consumers?.[timingEntry.consumer]?.requiredArtifactClasses;
  if (!Array.isArray(classes))
    fail('ci-cost-timing-consumer-invalid', {
      jobIdentity: timingEntry.jobIdentity,
      consumer: timingEntry.consumer,
    });
  return classes;
}
async function mapBatches(values, concurrency, mapper) {
  const results = [];
  for (let offset = 0; offset < values.length; offset += concurrency) {
    const batch = values.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(batch.map(mapper));
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    results.push(...settled.map((result) => result.value));
  }
  return results;
}

async function measureExpandedBytes(artifacts) {
  const root = mkdtempSync(join(tmpdir(), 'ci-artifact-expanded-'));
  // Multiple provenance classes can intentionally point at one artifact. Measure each
  // archive once; the facts remain keyed by artifact ID and class projection is unchanged.
  const uniqueArtifacts = [
    ...new Map(artifacts.map((artifact) => [String(artifact.id), artifact])).values(),
  ];
  try {
    const measurements = await mapBatches(
      uniqueArtifacts,
      expandedBytesConcurrency,
      async (artifact) => {
        const archive = join(root, `${artifact.id}.zip`);
        const destination = join(root, String(artifact.id));
        let bytes;
        const observed = await observeArtifactDownload(async () => {
          const response = await execFileAsync(
            'gh',
            ['api', `repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifact.id}/zip`],
            { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
          );
          bytes = response.stdout;
          return bytes.byteLength;
        });
        writeFileSync(archive, bytes);
        // Artifact ZIPs can contain duplicate paths when producers merge outputs.
        // Cost collection is a read-only measurement, so overwrite deterministically
        // instead of letting unzip prompt on a non-interactive runner.
        await execFileAsync('unzip', ['-q', '-o', archive, '-d', destination]);
        const { stdout: diskUsage } = await execFileAsync('du', ['-sk', destination], {
          encoding: 'utf8',
        });
        const kibibytes = Number(diskUsage.trim().split(/\s+/)[0]);
        if (!Number.isFinite(kibibytes))
          fail('ci-cost-expanded-bytes-missing', { artifactId: artifact.id });
        return [
          artifact.id,
          {
            ...observed,
            expandedDiskBytes: kibibytes * 1024,
          },
        ];
      },
    );
    return Object.fromEntries(measurements);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function validateMerged(merged, contract, runId) {
  if (!merged || typeof merged !== 'object') fail('ci-provenance-merged-missing');
  if (
    Number(merged.runId) !== runId ||
    !Array.isArray(merged.artifacts) ||
    !merged.producerAttempts
  )
    fail('ci-provenance-merged-invalid', { actual: merged, expected: { runId } });
  const expected = new Set(contract.provenance.payloadClasses);
  const mapping = new Map();
  for (const artifact of merged.artifacts) {
    if (
      !expected.has(artifact?.class) ||
      typeof artifact.artifactId !== 'string' ||
      !Number.isInteger(artifact.producerRunAttempt) ||
      mapping.has(artifact.class)
    )
      fail('ci-provenance-merged-invalid', { artifact });
    mapping.set(artifact.class, artifact);
  }
  if (mapping.size !== expected.size || [...expected].some((className) => !mapping.has(className)))
    fail('ci-provenance-merged-invalid', {
      expectedClasses: [...expected],
      actualClasses: [...mapping.keys()],
    });
  return mapping;
}
function sharedProductionFacts(value, merged, contract, mapping, artifactsById, jobs) {
  const shared = contract.sharedInputs;
  const invalid = (code, detail = {}) => ({ status: 'invalidEvidence', code, ...detail });
  if (!value || typeof value !== 'object') return invalid('ci-cost-shared-facts-missing');
  if (!['cold', 'warm'].includes(value.cacheState))
    return invalid('ci-cost-shared-cache-state-invalid', { detail: value.cacheState });
  if (value.producer !== shared.producer)
    return invalid('ci-cost-shared-provenance-producer-invalid', {
      expected: shared.producer,
      detail: value.producer,
    });
  // The merged provenance mapping is the SSOT for class ownership; producer facts only measure production.
  if (
    shared.payloadClasses.some((className) => mapping.get(className)?.producer !== shared.producer)
  )
    return invalid('ci-cost-shared-provenance-class-uncovered', {
      expected: shared.payloadClasses,
      detail: shared.payloadClasses.filter(
        (className) => mapping.get(className)?.producer !== shared.producer,
      ),
    });
  for (const field of [
    'sourceScanCount',
    'payloadEmitCount',
    'engineCompileCount',
    'buildDurationSeconds',
  ])
    if (!Number.isFinite(value[field]) || value[field] < 0)
      return invalid('ci-cost-shared-fact-missing', { field });
  if (value.inputFingerprint !== merged.sharedInputs?.inputFingerprint)
    return invalid('ci-cost-shared-provenance-fingerprint-invalid');
  const records = shared.payloadClasses.map((className) => mapping.get(className));
  const artifactBytes = records.reduce((sum, record) => {
    const bytes = artifactsById.get(record?.artifactId)?.size_in_bytes;
    return Number.isFinite(bytes) ? sum + bytes : Number.NaN;
  }, 0);
  if (!Number.isFinite(artifactBytes)) return invalid('ci-cost-shared-artifact-bytes-missing');
  const producerJob = jobForIdentity(jobs, shared.producer);
  const started = dateSeconds(producerJob?.started_at);
  const completed = dateSeconds(producerJob?.completed_at);
  if (started === null || completed === null || completed < started)
    return invalid('ci-cost-shared-job-duration-missing');
  const transferConsumerCount = contract.timingRoster.filter((consumer) =>
    shared.payloadClasses.some((className) =>
      requiredArtifactClasses(contract, consumer).includes(className),
    ),
  ).length;
  return {
    ...value,
    artifactBytes,
    transferBytes: artifactBytes * transferConsumerCount,
    totalDurationSeconds: completed - started,
    provenance: {
      runId: merged.runId,
      runAttempt: merged.producerAttempts[shared.producer],
      inputFingerprint: value.inputFingerprint,
      artifactIds: records.map((record) => record.artifactId),
    },
  };
}
function sharedEvidenceFacts(value) {
  const invalid = (code, detail = {}) => ({ status: 'invalidEvidence', code, ...detail });
  if (!value || typeof value !== 'object') return invalid('ci-cost-shared-samples-missing');
  if (value.schemaVersion !== 1 || value.producer !== 'shared-evidence-probe')
    return invalid('ci-cost-shared-evidence-producer-invalid');
  if (typeof value.inputFingerprint !== 'string' || value.inputFingerprint.length === 0)
    return invalid('ci-cost-shared-evidence-fingerprint-missing');
  const baseline = value.baseline;
  const samples = value.samples;
  if (!baseline || !Array.isArray(samples)) return invalid('ci-cost-shared-samples-invalid');
  const byState = new Map(samples.map((sample) => [sample?.cacheState, sample]));
  const cold = byState.get('cold');
  const warm = byState.get('warm');
  if (!cold || !warm) return invalid('ci-cost-shared-cold-warm-missing');
  for (const field of ['sourceScanCount', 'payloadEmitCount', 'engineCompileCount']) {
    if (
      ![baseline, cold, warm].every(
        (record) => Number.isFinite(record[field]) && record[field] >= 0,
      )
    )
      return invalid('ci-cost-shared-sample-fact-missing', { field });
    if (cold[field] >= baseline[field] || warm[field] >= baseline[field])
      return invalid('ci-cost-shared-baseline-not-improved', {
        field,
        baseline: baseline[field],
        cold: cold[field],
        warm: warm[field],
      });
  }
  return { status: 'pass', baseline, samples: [cold, warm] };
}
function jobForIdentity(jobs, identity) {
  const matches = jobs.filter((job) => job.name === identity);
  return matches.length === 1 ? matches[0] : null;
}
function timingJobForIdentity(jobs, identity) {
  const matrixJobs = jobs.filter((job) => job.name.startsWith(`${identity}-`));
  const candidates =
    matrixJobs.length > 0 ? matrixJobs : jobs.filter((job) => job.name === identity);
  return (
    candidates
      .filter((job) => timestamp(job.started_at))
      .sort((left, right) => dateSeconds(left.started_at) - dateSeconds(right.started_at))[0] ??
    null
  );
}
function classifyConsumer(consumer, contract, mapping, artifactsById, jobs) {
  if (consumer.notApplicable) return { jobIdentity: consumer.jobIdentity, status: 'notApplicable' };
  const records = requiredArtifactClasses(contract, consumer).map((className) =>
    mapping.get(className),
  );
  if (records.some((record) => !record?.artifactId))
    return {
      jobIdentity: consumer.jobIdentity,
      status: 'invalidSample',
      code: 'ci-cost-artifact-id-missing',
    };
  const selected = records.map((record) => artifactsById.get(record.artifactId));
  if (selected.some((artifact) => !artifact || artifact.expired || !timestamp(artifact.created_at)))
    return {
      jobIdentity: consumer.jobIdentity,
      status: 'invalidSample',
      code: 'ci-cost-artifact-fact-missing',
    };
  const artifactReady = selected.reduce((latest, artifact) =>
    dateSeconds(artifact.created_at) > dateSeconds(latest.created_at) ? artifact : latest,
  );
  const job = timingJobForIdentity(jobs, consumer.jobIdentity);
  if (!job || ['skipped', 'cancelled'].includes(job.conclusion) || !timestamp(job.started_at))
    return {
      jobIdentity: consumer.jobIdentity,
      status: 'invalidSample',
      code: 'ci-cost-job-start-missing',
    };
  let effectiveReadyAt = artifactReady.created_at;
  const artifactProviderJob = consumer.artifactProvider
    ? jobForIdentity(jobs, consumer.artifactProvider)
    : null;
  if (consumer.artifactProvider !== undefined) {
    if (!artifactProviderJob || !timestamp(artifactProviderJob.completed_at))
      return {
        jobIdentity: consumer.jobIdentity,
        status: 'invalidSample',
        code: 'ci-cost-artifact-provider-completion-missing',
      };
    if (dateSeconds(artifactProviderJob.completed_at) > dateSeconds(effectiveReadyAt))
      effectiveReadyAt = artifactProviderJob.completed_at;
  }
  for (const prerequisite of consumer.allowedNonArtifactPrerequisites ?? []) {
    const prerequisiteJob = jobForIdentity(jobs, prerequisite);
    if (!prerequisiteJob || !timestamp(prerequisiteJob.completed_at))
      return {
        jobIdentity: consumer.jobIdentity,
        status: 'invalidSample',
        code: 'ci-cost-non-artifact-prerequisite-missing',
      };
    if (dateSeconds(prerequisiteJob.completed_at) > dateSeconds(effectiveReadyAt))
      effectiveReadyAt = prerequisiteJob.completed_at;
  }
  const actualSeconds = dateSeconds(job.started_at) - dateSeconds(effectiveReadyAt);
  const detail = {
    jobIdentity: consumer.jobIdentity,
    artifactIds: selected.map((artifact) => artifact.id),
    producerAttempts: records.map((record) => record.producerRunAttempt),
    lastRequiredArtifactReadyAt: artifactReady.created_at,
    artifactProviderReadyAt: artifactProviderJob?.completed_at ?? null,
    lastPrerequisiteReadyAt: effectiveReadyAt,
    effectiveReadyAt,
    observedJobStartedAt: job.started_at,
    observedArtifactReadyToJobStartDelaySeconds:
      dateSeconds(job.started_at) - dateSeconds(artifactReady.created_at),
    unattributedStartDelaySeconds: actualSeconds,
    actualSeconds,
    expectedSeconds: maxDelaySeconds,
  };
  if (actualSeconds < 0)
    return { ...detail, status: 'invalidSample', code: 'ci-cost-artifact-ready-after-job-start' };
  if (actualSeconds > maxDelaySeconds)
    return {
      ...detail,
      status: 'fail',
      code: 'ci-cost-artifact-ready-to-job-start-budget-exceeded',
    };
  return { ...detail, status: 'pass' };
}

function familyBase(family, runId, runAttempt, producer, producerRunAttempt, inputFingerprint) {
  return {
    family,
    identity: {
      runId: Number.isInteger(runId) ? runId : null,
      runAttempt: Number.isInteger(runAttempt) ? runAttempt : null,
    },
    producer: {
      owner: producer ?? null,
      producerRunAttempt: Number.isInteger(producerRunAttempt) ? producerRunAttempt : null,
    },
    consumer: {
      owner: 'cost-reporter',
      runAttempt: Number.isInteger(runAttempt) ? runAttempt : null,
    },
    inputFingerprint:
      typeof inputFingerprint === 'string' && inputFingerprint.length > 0 ? inputFingerprint : null,
  };
}

function invalidFamily(contract, base, code, expected, detail) {
  const detailFields = contract.returnEvidence?.invalidEvidence?.codes?.[code];
  if (!Array.isArray(detailFields)) fail('ci-cost-contract-invalid', { code });
  const normalizedDetail = Object.fromEntries(
    detailFields.map((field) => [field, detail?.[field] ?? null]),
  );
  return {
    ...base,
    status: 'invalidEvidence',
    code,
    expected,
    hint: 'Check the selected producer or consumer owner facts, then collect a new evidence sample.',
    detail: normalizedDetail,
  };
}

function validUpload(value) {
  return (
    value &&
    timestamp(value.startedAt) &&
    timestamp(value.completedAt) &&
    Number.isFinite(value.elapsedSeconds) &&
    value.elapsedSeconds >= 0 &&
    Number.isInteger(value.transferAttempt) &&
    value.transferAttempt >= 1
  );
}

function validDownload(value) {
  return (
    value &&
    timestamp(value.startedAt) &&
    timestamp(value.completedAt) &&
    Number.isFinite(value.elapsedSeconds) &&
    value.elapsedSeconds >= 0
  );
}

function artifactFamilyResult({
  contract,
  family,
  record,
  artifact,
  measurement,
  runId,
  runAttempt,
  aggregateAttempt,
  selectedAttempt,
}) {
  const declared = contract.artifactClasses[family];
  const observedAttempt = record?.producerRunAttempt;
  const base = familyBase(
    family,
    runId,
    runAttempt,
    record?.producer,
    observedAttempt,
    record?.inputFingerprint,
  );
  if (aggregateAttempt !== runAttempt)
    return invalidFamily(
      contract,
      base,
      'aggregate-attempt-mismatch',
      { runAttempt },
      { observedRunAttempt: aggregateAttempt },
    );
  if (!record || record.producer !== declared.producer)
    return invalidFamily(
      contract,
      base,
      'provenance-missing',
      { producer: declared.producer },
      { producer: record?.producer ?? null },
    );
  if (observedAttempt !== selectedAttempt)
    return invalidFamily(
      contract,
      base,
      'foreign-producer-attempt',
      { producer: declared.producer, producerRunAttempt: selectedAttempt ?? null },
      { observedProducerAttempt: observedAttempt ?? null },
    );
  if (typeof record.inputFingerprint !== 'string' || record.inputFingerprint.length === 0)
    return invalidFamily(
      contract,
      base,
      'fingerprint-missing',
      { inputFingerprint: 'producer-owned per-family fingerprint' },
      { producer: declared.producer },
    );
  if (!isFingerprint(record.inputFingerprint))
    return invalidFamily(
      contract,
      base,
      'fingerprint-mismatch',
      { inputFingerprint: 'sha256:<64 lowercase hex digest>' },
      { observedFingerprint: record.inputFingerprint },
    );
  if (!artifact || String(artifact.id) !== record.artifactId)
    return invalidFamily(
      contract,
      base,
      'artifact-identity-mismatch',
      { artifactId: record.artifactId },
      { observedArtifactId: artifact?.id ?? null },
    );
  if (Number(artifact.workflow_run?.id) !== runId)
    return invalidFamily(
      contract,
      base,
      'cross-run',
      { runId },
      { observedRunId: Number(artifact.workflow_run?.id) || null },
    );
  if (!Number.isFinite(artifact.size_in_bytes))
    return invalidFamily(
      contract,
      base,
      'owner-fact-missing',
      { owner: 'github-artifact-rest', field: 'compressedArchiveBytes' },
      { owner: 'github-artifact-rest', field: 'compressedArchiveBytes' },
    );
  if (!validUpload(record.upload))
    return invalidFamily(
      contract,
      base,
      'owner-fact-missing',
      { owner: declared.producer, field: 'upload' },
      { owner: declared.producer, field: 'upload' },
    );
  if (!measurement || !Number.isFinite(measurement.expandedDiskBytes))
    return invalidFamily(
      contract,
      base,
      'owner-fact-missing',
      { owner: 'cost-reporter', field: 'expandedDiskBytes' },
      { owner: 'cost-reporter', field: 'expandedDiskBytes' },
    );
  if (!validDownload(measurement.download))
    return invalidFamily(
      contract,
      base,
      'owner-fact-missing',
      { owner: 'cost-reporter', field: 'download' },
      { owner: 'cost-reporter', field: 'download' },
    );
  return {
    ...base,
    status: 'valid',
    inputFingerprint: record.inputFingerprint,
    artifactId: record.artifactId,
    compressedArchiveBytes: artifact.size_in_bytes,
    expandedDiskBytes: measurement.expandedDiskBytes,
    upload: record.upload,
    download: measurement.download,
    physicalScope: 'artifact',
  };
}

function cacheFamilyResult(contract, value, runId, runAttempt, aggregateAttempt) {
  const declared = contract.returnEvidence.cacheFamilies[0];
  const observedAttempt = value?.producer?.producerRunAttempt;
  const base = familyBase(
    declared.family,
    runId,
    runAttempt,
    value?.producer?.owner,
    observedAttempt,
    value?.inputFingerprint,
  );
  if (aggregateAttempt !== runAttempt)
    return invalidFamily(
      contract,
      base,
      'aggregate-attempt-mismatch',
      { runAttempt },
      { observedRunAttempt: aggregateAttempt },
    );
  if (!value || typeof value !== 'object')
    return invalidFamily(
      contract,
      base,
      'owner-fact-missing',
      { owner: declared.producer, field: 'cacheOwnerPacket' },
      { owner: declared.producer, field: 'cacheOwnerPacket' },
    );
  if (Number(value.identity?.runId) !== runId)
    return invalidFamily(
      contract,
      base,
      'cross-run',
      { runId },
      { observedRunId: Number(value.identity?.runId) || null },
    );
  if (value.identity?.runAttempt !== runAttempt || observedAttempt !== runAttempt)
    return invalidFamily(
      contract,
      base,
      'aggregate-attempt-mismatch',
      { runAttempt },
      { observedRunAttempt: value.identity?.runAttempt ?? observedAttempt ?? null },
    );
  if (value.producer?.owner !== declared.producer || value.consumer?.owner !== declared.consumer)
    return invalidFamily(
      contract,
      base,
      'provenance-missing',
      { producer: declared.producer, consumer: declared.consumer },
      { producer: value.producer?.owner ?? null },
    );
  if (typeof value.inputFingerprint !== 'string' || value.inputFingerprint.length === 0)
    return invalidFamily(
      contract,
      base,
      'fingerprint-missing',
      { inputFingerprint: 'producer-owned merged DDC fingerprint' },
      { producer: declared.producer },
    );
  if (!isFingerprint(value.inputFingerprint))
    return invalidFamily(
      contract,
      base,
      'fingerprint-mismatch',
      { inputFingerprint: 'sha256:<64 lowercase hex digest>' },
      { observedFingerprint: value.inputFingerprint },
    );
  const requestedKey = typeof value.requestedKey === 'string' ? value.requestedKey : '';
  const matchedKey = typeof value.matchedKey === 'string' ? value.matchedKey : '';
  const cacheHit = typeof value.cacheHit === 'string' ? value.cacheHit : '';
  const restoreValid =
    Number.isFinite(value.restore?.elapsedSeconds) && value.restore.elapsedSeconds >= 0;
  const exact = cacheHit === 'true' && requestedKey !== '' && matchedKey === requestedKey;
  const prefix =
    cacheHit === 'false' && requestedKey !== '' && matchedKey !== '' && matchedKey !== requestedKey;
  const miss =
    cacheHit === '' &&
    requestedKey !== '' &&
    matchedKey === '' &&
    typeof value.save?.outcome === 'string' &&
    value.save.outcome !== '' &&
    value.save.outcome !== 'notApplicable' &&
    Number.isFinite(value.save?.elapsedSeconds) &&
    value.save.elapsedSeconds >= 0;
  const hitSaveValid = (exact || prefix) && value.save?.outcome === 'notApplicable';
  if (!restoreValid || (!miss && !hitSaveValid))
    return invalidFamily(
      contract,
      base,
      'cache-output-inconsistent',
      { classification: 'exact-hit, prefix-hit, or observed miss+save' },
      { cacheHit, requestedKey, matchedKey },
    );
  return {
    ...base,
    status: 'valid',
    inputFingerprint: value.inputFingerprint,
    classification: exact ? 'exact-hit' : prefix ? 'prefix-hit' : 'miss',
    requestedKey,
    matchedKey,
    restore: value.restore,
    save: value.save,
  };
}

const inputPath = argument('--input');
const input = inputPath ? readJson(resolve(inputPath), 'ci-cost-input-invalid') : null;
const mergedArtifactName = argument('--merged-artifact-name');
const mergedDownloadDir = mergedArtifactName
  ? mkdtempSync(join(tmpdir(), 'ci-provenance-merged-'))
  : null;
if (mergedArtifactName) {
  try {
    execFileSync(
      'gh',
      [
        'run',
        'download',
        String(argument('--run-id') ?? process.env.GITHUB_RUN_ID),
        '--name',
        mergedArtifactName,
        '--dir',
        mergedDownloadDir,
      ],
      { stdio: 'pipe' },
    );
  } catch {
    fail('ci-provenance-merged-missing', { artifactName: mergedArtifactName });
  }
}
const cacheAuditPath = argument('--cache-audit');
const cacheTimingPath = argument('--cache-timing');
const cacheAudit = cacheAuditPath
  ? readJson(resolve(cacheAuditPath), 'ci-cost-cache-audit-missing')
  : null;
const cacheTiming =
  input?.cacheTiming ??
  (cacheTimingPath ? readJson(resolve(cacheTimingPath), 'ci-cost-cache-timing-missing') : null);
const contractPath = resolve(argument('--contract') ?? 'scripts/ci/build-artifact-contract.json');
const contract = readJson(contractPath, 'ci-cost-contract-invalid');
const sharedEvidencePath = argument('--shared-evidence');
const sharedEvidenceInput =
  input?.sharedEvidence ??
  (sharedEvidencePath
    ? readJson(resolve(sharedEvidencePath), 'ci-cost-shared-evidence-missing')
    : null);
const runId = Number(input?.runId ?? argument('--run-id') ?? process.env.GITHUB_RUN_ID);
const runAttempt = Number(
  input?.runAttempt ?? argument('--attempt') ?? process.env.GITHUB_RUN_ATTEMPT,
);
if (!Number.isInteger(runId) || !Number.isInteger(runAttempt)) fail('ci-cost-run-identity-missing');
const mergedPath = input
  ? null
  : resolve(
      argument('--merged-provenance') ??
        join(mergedDownloadDir ?? '.', 'ci-provenance-merged.json'),
    );
const merged = input?.mergedProvenance ?? readJson(mergedPath, 'ci-provenance-merged-missing');
const mapping = validateMerged(merged, contract, runId);
const artifacts = input
  ? flattenPages(input.artifactPages, 'artifacts')
  : ghPages(`repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}/artifacts`, 'artifacts');
const jobs = input
  ? flattenPages(input.jobPages, 'jobs')
  : ghPages(`repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}/jobs`, 'jobs');
const artifactsById = new Map(artifacts.map((artifact) => [String(artifact.id), artifact]));
const sharedProduction = sharedProductionFacts(
  input?.sharedProduction ?? merged.sharedProduction,
  merged,
  contract,
  mapping,
  artifactsById,
  jobs,
);
const sharedEvidence = sharedEvidenceFacts(sharedEvidenceInput);
const measurements = input
  ? Object.fromEntries(
      [...new Set([...mapping.values()].map((record) => record.artifactId))].map((artifactId) => [
        artifactId,
        {
          expandedDiskBytes: input.expandedBytesByArtifactId?.[artifactId],
          download: input.downloadObservationsByArtifactId?.[artifactId],
        },
      ]),
    )
  : await measureExpandedBytes(
      [...mapping.values()]
        .map((record) => artifactsById.get(record.artifactId))
        .filter((artifact) => artifact && Number(artifact.workflow_run?.id) === runId),
    );
const artifactFamilyResults = Object.keys(contract.artifactClasses).map((family) => {
  const record = mapping.get(family);
  return artifactFamilyResult({
    contract,
    family,
    record,
    artifact: record ? artifactsById.get(record.artifactId) : null,
    measurement: record ? measurements[record.artifactId] : null,
    runId,
    runAttempt,
    aggregateAttempt: merged.aggregateAttempt,
    selectedAttempt: record ? merged.producerAttempts[record.producer] : null,
  });
});
const cacheFamily = cacheFamilyResult(
  contract,
  cacheTiming,
  runId,
  runAttempt,
  merged.aggregateAttempt,
);
const validArtifactFamilies = artifactFamilyResults.filter(({ status }) => status === 'valid');
const physicalArtifacts = [
  ...new Map(
    validArtifactFamilies.map((row) => [
      row.artifactId,
      {
        artifactId: row.artifactId,
        compressedArchiveBytes: row.compressedArchiveBytes,
        expandedDiskBytes: row.expandedDiskBytes,
        upload: row.upload,
        download: row.download,
      },
    ]),
  ).values(),
];
const factsArtifacts = validArtifactFamilies.map((row) => {
  const record = mapping.get(row.family);
  const artifact = artifactsById.get(row.artifactId);
  return {
    name: record.artifactName,
    class: row.family,
    id: row.artifactId,
    producer: row.producer.owner,
    producerAttempt: row.producer.producerRunAttempt,
    inputFingerprint: row.inputFingerprint,
    compressedBytes: row.compressedArchiveBytes,
    expandedBytes: row.expandedDiskBytes,
    upload: row.upload,
    download: row.download,
    readyAt: timestamp(artifact?.created_at),
  };
});
const perConsumer = contract.timingRoster.map((consumer) =>
  classifyConsumer(consumer, contract, mapping, artifactsById, jobs),
);
const ac06Status =
  sharedProduction.status === 'invalidEvidence' || sharedEvidence.status === 'invalidEvidence'
    ? 'invalid'
    : perConsumer.some((consumer) => consumer.status === 'invalidSample')
      ? 'invalid'
      : perConsumer.some((consumer) => consumer.status === 'fail')
        ? 'fail'
        : 'pass';
function compressionRatio(compressedBytes, expandedBytes) {
  return expandedBytes === 0 ? null : Number((compressedBytes / expandedBytes).toFixed(6));
}
const artifactBytesByClass = Object.fromEntries(
  validArtifactFamilies.map((row) => [
    row.family,
    {
      compressedBytes: row.compressedArchiveBytes,
      expandedBytes: row.expandedDiskBytes,
      compressionRatio: compressionRatio(row.compressedArchiveBytes, row.expandedDiskBytes),
    },
  ]),
);
const totalCompressedBytes = physicalArtifacts.reduce(
  (sum, artifact) => sum + artifact.compressedArchiveBytes,
  0,
);
const totalExpandedBytes = physicalArtifacts.reduce(
  (sum, artifact) => sum + artifact.expandedDiskBytes,
  0,
);
const consumers = contract.timingRoster.map((consumer) => {
  const timing = perConsumer.find((entry) => entry.jobIdentity === consumer.jobIdentity);
  const classes = requiredArtifactClasses(contract, consumer);
  const artifactIds = new Set(
    validArtifactFamilies
      .filter((row) => classes.includes(row.family))
      .map((row) => row.artifactId),
  );
  return {
    name: consumer.jobIdentity,
    downloadedBytes: consumer.notApplicable
      ? 0
      : physicalArtifacts
          .filter((artifact) => artifactIds.has(artifact.artifactId))
          .reduce((sum, artifact) => sum + artifact.compressedArchiveBytes, 0),
    startedAt: timingJobForIdentity(jobs, consumer.jobIdentity)?.started_at ?? null,
    lastRequiredArtifactReadyAt: timing?.lastRequiredArtifactReadyAt ?? null,
  };
});
const result = {
  schemaVersion: contract.returnEvidence.schemaVersion,
  runId,
  runAttempt,
  producerAttempts: merged.producerAttempts,
  artifacts: factsArtifacts,
  physicalArtifacts,
  returnEvidence: {
    schemaVersion: contract.returnEvidence.schemaVersion,
    contractVersion: contract.version,
    families: [cacheFamily, ...artifactFamilyResults],
  },
  artifactBytes: {
    totalCompressedBytes,
    totalExpandedBytes,
    compressionRatio: compressionRatio(totalCompressedBytes, totalExpandedBytes),
    byClass: artifactBytesByClass,
  },
  jobs: jobs.map((job) => jobTimingProjection(job, runId, runAttempt)),
  consumers,
  cache: {
    ...(input?.cache ?? {}),
    activeBytes: input?.cache?.activeBytes ?? cacheAudit?.activeBytesAfter ?? null,
    warmRestoreSeconds:
      cacheFamily.status === 'valid'
        ? cacheFamily.restore.elapsedSeconds
        : (input?.cache?.warmRestoreSeconds ?? null),
    cacheHit: cacheTiming?.cacheHit ?? null,
    inputFingerprint: cacheTiming?.inputFingerprint ?? null,
    producerRunAttempt: cacheTiming?.producer?.producerRunAttempt ?? null,
    entries: input?.cache?.entries ?? cacheAudit?.entries ?? [],
  },
  sharedProduction,
  wallClock: { requiredJobRoster: contract.requiredCIJobRoster },
  ac06: { status: ac06Status, perConsumer, sharedEvidence },
};
const out = resolve(argument('--out') ?? 'ci-cost-facts.json');
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
if (mergedDownloadDir) rmSync(mergedDownloadDir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ status: 'ok', out, ac06: ac06Status })}\n`);
