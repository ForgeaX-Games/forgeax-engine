#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const limits = {
  totalCompressedBytes: 69_224_539,
  consumerCompressedBytes: 41_534_723,
  activeCacheBytes: 7_918_954_215,
  warmRestoreSeconds: 180,
  artifactReadyToJobStartSeconds: 60,
};
function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}
function error(code, detail = {}) {
  return { code, ...detail };
}
function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
function hasNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
function requiredNumber(errors, value, field) {
  if (!hasNumber(value)) errors.push(error('ci-cost-required-field-missing', { field }));
  return value;
}
function validateBudget(errors, actual, expected, code, detail = {}) {
  if (hasNumber(actual) && actual > expected)
    errors.push(error(code, { actual, expected, ...detail }));
}
function checkAc06(errors, facts) {
  if (!facts.ac06 || !Array.isArray(facts.ac06.perConsumer)) {
    errors.push(error('ci-cost-ac06-missing'));
    return;
  }
  for (const consumer of facts.ac06.perConsumer) {
    if (consumer.status === 'notApplicable') continue;
    if (consumer.status === 'invalidSample') {
      errors.push(
        error(consumer.code ?? 'ci-cost-ac06-invalid-sample', { consumer: consumer.jobIdentity }),
      );
      continue;
    }
    const actual =
      consumer.observedArtifactReadyToJobStartDelaySeconds ??
      consumer.unattributedStartDelaySeconds;
    if (!hasNumber(actual)) {
      errors.push(
        error('ci-cost-required-field-missing', {
          consumer: consumer.jobIdentity,
          field: 'observedArtifactReadyToJobStartDelaySeconds',
        }),
      );
      continue;
    }
    if (actual < 0) {
      errors.push(
        error('ci-cost-artifact-ready-after-job-start', {
          consumer: consumer.jobIdentity,
          actual,
          expected: '>=0',
        }),
      );
      continue;
    }
    if (actual > limits.artifactReadyToJobStartSeconds || consumer.status === 'fail') {
      errors.push(
        error('ci-cost-artifact-ready-to-job-start-budget-exceeded', {
          consumer: consumer.jobIdentity,
          artifactIds: consumer.artifactIds ?? [],
          lastRequiredArtifactReadyAt: consumer.lastRequiredArtifactReadyAt,
          observedJobStartedAt: consumer.observedJobStartedAt,
          actualSeconds: actual,
          expectedSeconds: limits.artifactReadyToJobStartSeconds,
        }),
      );
    }
  }
  if (facts.ac06.status !== 'pass')
    errors.push(error('ci-cost-ac06-not-pass', { actual: facts.ac06.status, expected: 'pass' }));
}
function checkSharedProduction(errors, facts) {
  const value = facts.sharedProduction;
  if (!value || value.status === 'invalidEvidence') {
    errors.push(error(value?.code ?? 'ci-cost-shared-facts-missing', { detail: value ?? null }));
    return;
  }
  if (value.producer !== 'shared-app-inputs')
    errors.push(
      error('ci-cost-shared-provenance-producer-invalid', {
        actual: value.producer,
        expected: 'shared-app-inputs',
      }),
    );
  const expected = ['shared-asset-pack', 'shared-engine-shaders'];
  if (
    !Array.isArray(value.artifactClasses) ||
    expected.some((className) => !value.artifactClasses.includes(className))
  )
    errors.push(
      error('ci-cost-shared-provenance-class-uncovered', {
        actual: value.artifactClasses,
        expected,
      }),
    );
  for (const field of [
    'sourceScanCount',
    'payloadEmitCount',
    'engineCompileCount',
    'transferBytes',
    'totalDurationSeconds',
    'artifactBytes',
  ])
    requiredNumber(errors, value[field], `sharedProduction.${field}`);
}

const baselineRef = {
  runId: 29489169050,
  medianWallClockSeconds: 1294,
  worstWallClockSeconds: 1335,
};

function medianOf(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function sumOf(values) {
  return values.reduce((s, v) => s + (hasNumber(v) ? v : 0), 0);
}

function worstOf(values) {
  if (values.length === 0) return null;
  return Math.max(...values);
}

function isComparable(entry, reference) {
  if (entry.cancelled === true) return false;
  if (!entry.artifacts || !Array.isArray(entry.artifacts) || entry.artifacts.length === 0)
    return false;
  if (entry.artifacts.some((a) => !a || typeof a.id !== 'string' || !a.readyAt)) return false;
  if (reference) {
    if (entry.runnerType !== reference.runnerType) return false;
    if (entry.runAttempt !== reference.runAttempt) return false;
    if (
      JSON.stringify(entry.requiredRoster ?? []) !== JSON.stringify(reference.requiredRoster ?? [])
    )
      return false;
  }
  return true;
}

function countAc06(entries) {
  const summary = { pass: 0, fail: 0, invalid: 0, incomparable: 0 };
  for (const entry of entries) {
    const ac06 = entry.ac06;
    if (!ac06 || ac06.status === 'insufficientEvidence') {
      summary.incomparable++;
    } else if (ac06.status === 'pass') {
      summary.pass++;
    } else if (ac06.status === 'fail') {
      summary.fail++;
    } else if (ac06.status === 'invalid') {
      summary.invalid++;
    } else {
      summary.incomparable++;
    }
  }
  return summary;
}

const mode = argument('--mode');
if (mode === 'multi-run') {
  const factsDir = argument('--facts-dir');
  if (!factsDir) {
    process.stdout.write(
      `${JSON.stringify({ status: 'insufficientEvidence', comparableCount: 0 })}\n`,
    );
    process.exit(0);
  }
  const entries = [];
  if (existsSync(factsDir)) {
    for (const name of readdirSync(factsDir).sort()) {
      if (!name.endsWith('.json')) continue;
      const entry = readJson(resolve(factsDir, name));
      if (entry) entries.push(entry);
    }
  }
  let reference = null;
  const comparable = [];
  for (const entry of entries) {
    if (reference === null) {
      if (isComparable(entry, null)) {
        reference = entry;
        comparable.push(entry);
      }
    } else if (isComparable(entry, reference)) {
      comparable.push(entry);
    }
  }
  if (comparable.length < 10) {
    process.stdout.write(
      `${JSON.stringify({
        status: 'insufficientEvidence',
        comparableCount: comparable.length,
        totalEntries: entries.length,
      })}\n`,
    );
    process.exit(0);
  }
  const medianWallClock = medianOf(
    comparable.map((e) => e.wallClock?.medianWallClockSeconds).filter(hasNumber),
  );
  const worstWallClock = worstOf(
    comparable.map((e) => e.wallClock?.worstWallClockSeconds).filter(hasNumber),
  );
  const medianArtifactBytes = medianOf(
    comparable.map((e) => sumOf((e.artifacts ?? []).map((a) => a.compressedBytes ?? 0))),
  );
  const medianCacheBytes = medianOf(comparable.map((e) => e.cache?.activeBytes).filter(hasNumber));
  const medianDdcRestore = medianOf(
    comparable.map((e) => e.cache?.warmRestoreSeconds).filter(hasNumber),
  );
  const wallClockRatio =
    hasNumber(medianWallClock) && baselineRef.medianWallClockSeconds > 0
      ? medianWallClock / baselineRef.medianWallClockSeconds
      : null;
  const worstWallClockRatio =
    hasNumber(worstWallClock) && baselineRef.worstWallClockSeconds > 0
      ? worstWallClock / baselineRef.worstWallClockSeconds
      : null;
  const ac06Summary = countAc06(comparable);
  const result = {
    status: 'comparable',
    comparableCount: comparable.length,
    totalEntries: entries.length,
    reference: { runId: baselineRef.runId },
    medianWallClockSeconds: medianWallClock,
    worstWallClockSeconds: worstWallClock,
    wallClockRatio: wallClockRatio !== null ? Math.round(wallClockRatio * 10000) / 10000 : null,
    worstWallClockRatio:
      worstWallClockRatio !== null ? Math.round(worstWallClockRatio * 10000) / 10000 : null,
    medianArtifactBytes,
    medianCacheBytes,
    medianDdcRestoreSeconds: medianDdcRestore,
    ac06Summary,
    runnerType: reference?.runnerType ?? null,
    runAttempt: reference?.runAttempt ?? null,
  };
  const medianImprovement =
    hasNumber(medianWallClock) && baselineRef.medianWallClockSeconds > 0
      ? (1 - medianWallClock / baselineRef.medianWallClockSeconds) * 100
      : null;
  const maxRegression =
    wallClockRatio !== null && worstWallClockRatio !== null
      ? Math.max(
          wallClockRatio > 1 ? (wallClockRatio - 1) * 100 : 0,
          worstWallClockRatio > 1 ? (worstWallClockRatio - 1) * 100 : 0,
        )
      : null;
  if (
    medianImprovement !== null &&
    medianImprovement >= 15 &&
    maxRegression !== null &&
    maxRegression <= 10
  ) {
    result.shardExpansionCandidate = {
      medianImprovementPercent: Math.round(medianImprovement * 100) / 100,
      maxRegressionPercent: maxRegression,
      recommendation: 'Candidate for 4-6 shard evaluation. Requires human approval before rollout.',
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}
if (mode !== 'single-run') {
  process.stdout.write(
    `${JSON.stringify({ status: 'insufficientEvidence', mode: mode ?? null })}\n`,
  );
  process.exit(0);
}
const facts = readJson(resolve(argument('--facts') ?? 'ci-cost-facts.json'));
if (!facts) {
  process.stdout.write(`${JSON.stringify(error('ci-cost-facts-missing'))}\n`);
  process.exit(1);
}
const errors = [];
const artifacts = Array.isArray(facts.artifacts) ? facts.artifacts : null;
if (!artifacts) errors.push(error('ci-cost-required-field-missing', { field: 'artifacts' }));
const total = (artifacts ?? []).reduce(
  (sum, artifact, index) =>
    sum + requiredNumber(errors, artifact?.compressedBytes, `artifacts[${index}].compressedBytes`),
  0,
);
validateBudget(
  errors,
  total,
  limits.totalCompressedBytes,
  'ci-cost-artifact-total-budget-exceeded',
);
for (const [index, consumer] of (Array.isArray(facts.consumers) ? facts.consumers : []).entries()) {
  const bytes = requiredNumber(
    errors,
    consumer?.downloadedBytes,
    `consumers[${index}].downloadedBytes`,
  );
  validateBudget(
    errors,
    bytes,
    limits.consumerCompressedBytes,
    'ci-cost-consumer-budget-exceeded',
    { consumer: consumer?.name },
  );
}
const activeBytes = requiredNumber(errors, facts.cache?.activeBytes, 'cache.activeBytes');
const restoreSeconds = requiredNumber(
  errors,
  facts.cache?.warmRestoreSeconds,
  'cache.warmRestoreSeconds',
);
validateBudget(
  errors,
  activeBytes,
  limits.activeCacheBytes,
  'ci-cost-cache-active-bytes-budget-exceeded',
);
validateBudget(
  errors,
  restoreSeconds,
  limits.warmRestoreSeconds,
  'ci-cost-cache-restore-budget-exceeded',
);
checkAc06(errors, facts);
checkSharedProduction(errors, facts);
if (!process.argv.includes('--skip-workflow-check')) {
  try {
    execFileSync(
      process.execPath,
      ['scripts/ci/check-build-artifact-contract.mjs', '--workflow', '.github/workflows/ci.yml'],
      { stdio: 'pipe' },
    );
  } catch {
    errors.push(error('ci-cost-contract-workflow-inconsistent'));
  }
}
if (errors.length > 0) {
  for (const item of errors) process.stdout.write(`${JSON.stringify(item)}\n`);
  process.exit(1);
}
process.stdout.write(
  `${JSON.stringify({ status: 'pass', mode: 'single-run', totalCompressedBytes: total })}\n`,
);
