#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POOL_LABELS } from './check-runner-pool-labels.mjs';
import { projectCiTiming } from './project-ci-timing.mjs';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--out');
const output = outputIndex === -1 ? null : args[outputIndex + 1];
if (!output)
  throw new Error('Usage: collect-ci-cost-monitor.mjs --out <facts.json> [collect args]');

const result = spawnSync(process.execPath, ['scripts/ci/collect-ci-cost-facts.mjs', ...args], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) {
  const argument = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : (args[index + 1] ?? null);
  };
  const contract = JSON.parse(
    readFileSync(resolve(argument('--contract') ?? 'scripts/ci/build-artifact-contract.json')),
  );
  const runId = Number(argument('--run-id') ?? process.env.GITHUB_RUN_ID);
  const runAttempt = Number(argument('--attempt') ?? process.env.GITHUB_RUN_ATTEMPT);
  const identity = {
    runId: Number.isInteger(runId) ? runId : null,
    runAttempt: Number.isInteger(runAttempt) ? runAttempt : null,
  };
  const cacheFamilies = contract.returnEvidence.cacheFamilies.map((family) => ({
    family: family.family,
    producer: family.producer,
  }));
  const artifactFamilies = Object.entries(contract.artifactClasses).map(([family, value]) => ({
    family,
    producer: value.producer,
  }));
  const families = [...cacheFamilies, ...artifactFamilies].map(({ family, producer }) => ({
    family,
    identity,
    producer: { owner: producer, producerRunAttempt: null },
    consumer: { owner: 'cost-reporter', runAttempt: identity.runAttempt },
    status: 'invalidEvidence',
    code: 'owner-fact-missing',
    expected: { owner: producer, field: 'runtimeCollection' },
    hint: 'Check the selected producer or consumer owner facts, then collect a new evidence sample.',
    detail: { owner: producer, field: 'runtimeCollection' },
  }));
  const jobs = contract.requiredCIJobRoster.map((name) => ({
    jobId: null,
    name,
    runAttempt: identity.runAttempt,
    createdAt: null,
    startedAt: null,
    completedAt: null,
    result: null,
    runnerId: null,
    runnerName: null,
    runnerGroupId: null,
    labels: [],
    pool: null,
    queueWaitSeconds: null,
    activeSeconds: null,
    totalSeconds: null,
    status: 'invalidEvidence',
    code: 'ci-cost-job-timing-missing',
    expected: {
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      timestamps: ['createdAt', 'startedAt', 'completedAt'],
      pool: POOL_LABELS,
    },
    hint: 'Check the run-scoped job timestamps and runner labels, then collect a new evidence sample.',
    detail: {
      runAttempt: identity.runAttempt,
      missing: ['createdAt', 'startedAt', 'completedAt'],
    },
  }));
  const facts = {
    schemaVersion: contract.returnEvidence.schemaVersion,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    returnEvidence: {
      schemaVersion: contract.returnEvidence.schemaVersion,
      contractVersion: contract.version,
      families,
    },
    producerAttempts: {},
    artifacts: [],
    physicalArtifacts: [],
    artifactBytes: {
      totalCompressedBytes: null,
      totalExpandedBytes: null,
      compressionRatio: null,
      byClass: {},
    },
    consumers: [],
    jobs,
    cache: { activeBytes: null },
    wallClock: { requiredJobRoster: contract.requiredCIJobRoster },
    ac06: { status: 'invalidEvidence', perConsumer: [] },
    sharedProduction: { status: 'invalidEvidence' },
    monitorFailure: { code: 'ci-cost-facts-unavailable', exitCode: result.status },
  };
  facts.timingProjection = projectCiTiming(facts);
  writeFileSync(output, `${JSON.stringify(facts, null, 2)}\n`);
  process.stdout.write(
    '::warning title=CI cost monitor::Cost facts were unavailable; invalid evidence was recorded without blocking CI.\n',
  );
} else {
  const facts = JSON.parse(readFileSync(output, 'utf8'));
  facts.timingProjection = projectCiTiming(facts);
  writeFileSync(output, `${JSON.stringify(facts, null, 2)}\n`);
}
