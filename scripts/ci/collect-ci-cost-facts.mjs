#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseGhPages } from './parse-gh-pages.mjs';

const maxDelaySeconds = 60;

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
function measureExpandedBytes(artifacts) {
  const root = mkdtempSync(join(tmpdir(), 'ci-artifact-expanded-'));
  try {
    return Object.fromEntries(
      artifacts.map((artifact) => {
        const archive = join(root, `${artifact.id}.zip`);
        const destination = join(root, String(artifact.id));
        const bytes = execFileSync(
          'gh',
          ['api', `repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifact.id}/zip`],
          { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
        );
        writeFileSync(archive, bytes);
        // Artifact ZIPs can contain duplicate paths when producers merge outputs.
        // Cost collection is a read-only measurement, so overwrite deterministically
        // instead of letting unzip prompt on a non-interactive runner.
        execFileSync('unzip', ['-q', '-o', archive, '-d', destination]);
        const diskUsage = execFileSync('du', ['-sk', destination], { encoding: 'utf8' });
        const kibibytes = Number(diskUsage.trim().split(/\s+/)[0]);
        if (!Number.isFinite(kibibytes))
          fail('ci-cost-expanded-bytes-missing', { artifactId: artifact.id });
        return [artifact.id, kibibytes * 1024];
      }),
    );
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
      !Number.isInteger(artifact.producerAttempt) ||
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
    producerAttempts: records.map((record) => record.producerAttempt),
    lastRequiredArtifactReadyAt: artifactReady.created_at,
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
const cacheTiming = cacheTimingPath
  ? readJson(resolve(cacheTimingPath), 'ci-cost-cache-timing-missing')
  : null;
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
const artifactsById = new Map(
  artifacts
    .filter((artifact) => Number(artifact.workflow_run?.id ?? runId) === runId)
    .map((artifact) => [String(artifact.id), artifact]),
);
const sharedProduction = sharedProductionFacts(
  input?.sharedProduction ?? merged.sharedProduction,
  merged,
  contract,
  mapping,
  artifactsById,
  jobs,
);
const sharedEvidence = sharedEvidenceFacts(sharedEvidenceInput);
const expanded =
  input?.expandedBytesByArtifactId ??
  measureExpandedBytes([...mapping.values()].map((record) => artifactsById.get(record.artifactId)));
const factsArtifacts = [...mapping.values()].map((record) => {
  const artifact = artifactsById.get(record.artifactId);
  const compressedBytes = artifact?.size_in_bytes;
  if (!artifact || !Number.isFinite(compressedBytes) || !timestamp(artifact.created_at))
    fail('ci-cost-artifact-fact-missing', { artifactId: record.artifactId, class: record.class });
  const expandedBytes = expanded[record.artifactId];
  if (!Number.isFinite(expandedBytes))
    fail('ci-cost-expanded-bytes-missing', { artifactId: record.artifactId, class: record.class });
  return {
    name: record.artifactName,
    class: record.class,
    id: record.artifactId,
    producer: record.producer,
    producerAttempt: record.producerAttempt,
    compressedBytes,
    expandedBytes,
    readyAt: artifact.created_at,
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
const artifactBytes = new Map(
  factsArtifacts.map((artifact) => [artifact.class, artifact.compressedBytes]),
);
function compressionRatio(compressedBytes, expandedBytes) {
  return expandedBytes === 0 ? null : Number((compressedBytes / expandedBytes).toFixed(6));
}
const artifactBytesByClass = Object.fromEntries(
  factsArtifacts.map((artifact) => [
    artifact.class,
    {
      compressedBytes: artifact.compressedBytes,
      expandedBytes: artifact.expandedBytes,
      compressionRatio: compressionRatio(artifact.compressedBytes, artifact.expandedBytes),
    },
  ]),
);
const totalCompressedBytes = factsArtifacts.reduce(
  (sum, artifact) => sum + artifact.compressedBytes,
  0,
);
const totalExpandedBytes = factsArtifacts.reduce(
  (sum, artifact) => sum + artifact.expandedBytes,
  0,
);
const consumers = contract.timingRoster.map((consumer) => {
  const timing = perConsumer.find((entry) => entry.jobIdentity === consumer.jobIdentity);
  const classes = requiredArtifactClasses(contract, consumer);
  return {
    name: consumer.jobIdentity,
    downloadedBytes: consumer.notApplicable
      ? 0
      : classes.reduce((sum, className) => sum + (artifactBytes.get(className) ?? 0), 0),
    startedAt: timingJobForIdentity(jobs, consumer.jobIdentity)?.started_at ?? null,
    lastRequiredArtifactReadyAt: timing?.lastRequiredArtifactReadyAt ?? null,
  };
});
const result = {
  runId,
  runAttempt,
  producerAttempts: merged.producerAttempts,
  artifacts: factsArtifacts,
  artifactBytes: {
    totalCompressedBytes,
    totalExpandedBytes,
    compressionRatio: compressionRatio(totalCompressedBytes, totalExpandedBytes),
    byClass: artifactBytesByClass,
  },
  jobs: jobs.map((job) => ({
    name: job.name,
    startedAt: job.started_at ?? null,
    completedAt: job.completed_at ?? null,
    result: job.conclusion ?? null,
  })),
  consumers,
  cache: input?.cache ?? {
    activeBytes: cacheAudit?.activeBytesAfter ?? null,
    warmRestoreSeconds: cacheTiming?.warmRestoreSeconds ?? null,
    entries: cacheAudit?.entries ?? [],
  },
  sharedProduction,
  wallClock: { requiredJobRoster: contract.requiredCIJobRoster },
  ac06: { status: ac06Status, perConsumer, sharedEvidence },
};
const out = resolve(argument('--out') ?? 'ci-cost-facts.json');
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
if (mergedDownloadDir) rmSync(mergedDownloadDir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ status: 'ok', out, ac06: ac06Status })}\n`);
