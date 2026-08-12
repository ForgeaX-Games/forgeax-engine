#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NORMALIZER_SCHEMA_VERSION = 1;
const POOLS = Object.freeze(['standard', 'heavy']);
const TERMINAL_CONCLUSIONS = new Set([
  'success',
  'failure',
  'cancelled',
  'skipped',
  'timed_out',
  'neutral',
  'action_required',
  'startup_failure',
  'stale',
]);
const NON_TERMINAL_STATES = new Set(['queued', 'requested', 'waiting', 'in_progress']);
const TERMINAL_RUN_STATES = new Set(['completed']);

const UNKNOWN_CODES = new Set([
  'packet-missing',
  'run-missing',
  'expected-identity-missing',
  'run-id-missing',
  'head-sha-missing',
  'run-attempt-missing',
  'fingerprint-missing',
  'run-conclusion-missing',
  'roster-missing',
  'jobs-missing',
  'artifacts-missing',
  'job-conclusion-missing',
  'runner-missing',
  'attempt-missing',
  'missing-command',
  'missing-worker-fact',
  'missing-cgroup-probe',
  'resource-fact-missing',
  'missing-timestamp',
  'missing-timing',
  'artifact-binding-missing',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

function field(value, ...paths) {
  for (const path of paths) {
    const parts = path.split('.');
    let current = value;
    for (const part of parts) {
      if (!isObject(current) && !Array.isArray(current)) {
        current = undefined;
        break;
      }
      current = current[part];
    }
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function integerValue(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function positiveInteger(value) {
  const number = integerValue(value);
  return number !== null && number > 0 ? number : null;
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestamp(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function identityFrom(value) {
  return {
    runId: firstDefined(
      field(value, 'runId', 'run_id', 'id', 'identity.runId', 'identity.run_id'),
      null,
    ),
    headSha: firstDefined(
      field(value, 'headSha', 'head_sha', 'identity.headSha', 'identity.head_sha'),
      null,
    ),
    runAttempt: firstDefined(
      field(
        value,
        'runAttempt',
        'run_attempt',
        'attempt',
        'identity.runAttempt',
        'identity.run_attempt',
      ),
      null,
    ),
    inputFingerprint: firstDefined(
      field(
        value,
        'inputFingerprint',
        'input_fingerprint',
        'fingerprint',
        'identity.inputFingerprint',
        'identity.input_fingerprint',
      ),
      null,
    ),
  };
}

function expectedFrom(packet, expected) {
  const embedded = firstDefined(packet?.expected, packet?.expect, packet?.admission);
  const source = isObject(embedded) ? { ...embedded, ...expected } : expected;
  const rosterValue = firstDefined(
    source?.declaredRoster,
    source?.declaredJobRoster,
    source?.roster,
    source?.jobRoster,
    source?.requiredJobRoster,
    packet?.declaredRoster,
    packet?.declaredJobRoster,
    packet?.requiredJobRoster,
    packet?.wallClock?.requiredJobRoster,
    packet?.contract?.requiredCIJobRoster,
  );
  const roster = Array.isArray(rosterValue)
    ? rosterValue
    : firstDefined(rosterValue?.jobs, rosterValue?.names, null);
  const artifactRoster = firstDefined(source?.artifactRoster, packet?.artifactRoster);
  const sourceIdentity = identityFrom(source);
  const packetExpectedIdentity = {
    runId: firstDefined(packet?.expectedRunId, packet?.expected?.runId),
    headSha: firstDefined(packet?.expectedHeadSha, packet?.expected?.headSha),
    runAttempt: firstDefined(packet?.expectedRunAttempt, packet?.expected?.runAttempt),
    inputFingerprint: firstDefined(packet?.expectedFingerprint, packet?.expected?.inputFingerprint),
  };
  return {
    runId: firstDefined(sourceIdentity.runId, packetExpectedIdentity.runId),
    headSha: firstDefined(sourceIdentity.headSha, packetExpectedIdentity.headSha),
    runAttempt: firstDefined(sourceIdentity.runAttempt, packetExpectedIdentity.runAttempt),
    inputFingerprint: firstDefined(
      sourceIdentity.inputFingerprint,
      packetExpectedIdentity.inputFingerprint,
    ),
    declaredRoster: Array.isArray(roster)
      ? roster.filter((name) => typeof name === 'string')
      : null,
    artifactRoster: Array.isArray(artifactRoster)
      ? artifactRoster.filter((id) => typeof id === 'string' || typeof id === 'number')
      : null,
  };
}

function observedRunFrom(packet) {
  const packetIdentity = identityFrom(packet);
  const nestedIdentity = identityFrom(firstDefined(packet?.run, packet?.runMetadata, {}));
  return {
    runId: firstDefined(nestedIdentity.runId, packetIdentity.runId),
    headSha: firstDefined(nestedIdentity.headSha, packetIdentity.headSha),
    runAttempt: firstDefined(nestedIdentity.runAttempt, packetIdentity.runAttempt),
    inputFingerprint: firstDefined(
      nestedIdentity.inputFingerprint,
      packetIdentity.inputFingerprint,
    ),
  };
}

function observedRunState(packet) {
  const source = firstDefined(packet?.run, packet?.runMetadata, packet);
  const status = firstDefined(
    field(source, 'status', 'runStatus', 'run_status'),
    field(packet, 'runStatus', 'run_status'),
  );
  const conclusion = firstDefined(
    field(source, 'conclusion', 'runConclusion', 'run_conclusion'),
    field(packet, 'runConclusion', 'run_conclusion'),
  );
  return {
    status: typeof status === 'string' ? status.toLowerCase() : null,
    conclusion: typeof conclusion === 'string' ? conclusion.toLowerCase() : null,
  };
}

function observedJobs(packet) {
  if (Array.isArray(packet?.jobs)) return packet.jobs;
  if (Array.isArray(packet?.jobFacts)) return packet.jobFacts;
  if (Array.isArray(packet?.jobObservations)) return packet.jobObservations;
  return null;
}

function observedArtifacts(packet) {
  if (Array.isArray(packet?.artifacts)) return packet.artifacts;
  if (Array.isArray(packet?.artifactFacts)) return packet.artifactFacts;
  if (Array.isArray(packet?.artifactObservations)) return packet.artifactObservations;
  return null;
}

function addReason(state, code, detail = {}, scope = 'packet') {
  if (state.reasonCodes.includes(code)) return;
  state.reasonCodes.push(code);
  state.reasons.push({ code, scope, detail });
}

function identityComparison(state, expected, observed) {
  const fields = [
    ['runId', integerValue],
    ['headSha', stringValue],
    ['runAttempt', integerValue],
    ['inputFingerprint', stringValue],
  ];
  for (const [name, normalize] of fields) {
    const expectedValue = normalize(expected[name]);
    const observedValue = normalize(observed[name]);
    if (expectedValue === null) {
      addReason(state, 'expected-identity-missing', { field: name });
      continue;
    }
    const codeName =
      name === 'runAttempt'
        ? 'attempt'
        : name === 'inputFingerprint'
          ? 'fingerprint'
          : name.replace('headSha', 'head-sha').replace('runId', 'run-id');
    if (observedValue === null) {
      addReason(state, `${codeName}-missing`, { expected: expectedValue });
      continue;
    }
    if (observedValue !== expectedValue)
      addReason(state, `${codeName}-mismatch`, {
        expected: expectedValue,
        observed: observedValue,
      });
  }
}

function jobIdentity(job) {
  return {
    runId: firstDefined(field(job, 'runId', 'run_id', 'run.id'), null),
    headSha: firstDefined(field(job, 'headSha', 'head_sha', 'run.headSha', 'run.head_sha'), null),
    runAttempt: firstDefined(field(job, 'runAttempt', 'run_attempt', 'attempt'), null),
    inputFingerprint: firstDefined(
      field(job, 'inputFingerprint', 'input_fingerprint', 'fingerprint'),
      null,
    ),
  };
}

function artifactIdentity(artifact) {
  const workflowRun = firstDefined(artifact?.workflow_run, artifact?.workflowRun, {});
  return {
    id: firstDefined(artifact?.artifactId, artifact?.artifact_id, artifact?.id, null),
    runId: firstDefined(
      field(artifact, 'runId', 'run_id'),
      field(workflowRun, 'id', 'run_id', 'runId'),
      null,
    ),
    headSha: firstDefined(
      field(artifact, 'headSha', 'head_sha'),
      field(workflowRun, 'head_sha', 'headSha'),
      null,
    ),
    runAttempt: firstDefined(
      field(artifact, 'runAttempt', 'run_attempt', 'attempt'),
      field(workflowRun, 'run_attempt', 'runAttempt'),
      null,
    ),
    inputFingerprint: firstDefined(
      field(artifact, 'inputFingerprint', 'input_fingerprint', 'fingerprint'),
      null,
    ),
  };
}

function poolForJob(job) {
  const explicit = field(job, 'pool', 'runnerPool', 'runner_pool');
  const labels = firstDefined(
    field(job, 'labels', 'runnerLabels', 'runner_labels', 'requestedLabels', 'requested_labels'),
    [],
  );
  const labelPools = Array.isArray(labels) ? labels.filter((label) => POOLS.includes(label)) : [];
  const explicitPool = typeof explicit === 'string' && explicit.trim() !== '' ? explicit : null;
  const candidates = [...labelPools, ...(explicitPool ? [explicitPool] : [])];
  return {
    pool: candidates.length === 1 ? candidates[0] : null,
    candidates,
    labels: Array.isArray(labels) ? labels : [],
  };
}

function commandFact(job) {
  const value = firstDefined(
    field(job, 'command', 'commandLine', 'command_line', 'workerInvocation', 'worker_invocation'),
    field(job, 'commandFacts.command', 'facts.command', 'execution.command'),
  );
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const commands = value.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
    return commands.length > 0 ? commands : null;
  }
  return isObject(value) && Object.keys(value).length > 0 ? value : null;
}

function workerFact(job) {
  const value = firstDefined(
    field(job, 'workerCount', 'worker_count', 'maxWorkers', 'max_workers', 'workers'),
    field(
      job,
      'workerFacts.workerCount',
      'workerFacts.maxWorkers',
      'facts.workerCount',
      'facts.maxWorkers',
    ),
  );
  const count = positiveInteger(value);
  return count === null ? null : { count };
}

function resourceFact(job) {
  const probe = firstDefined(
    field(job, 'resourceProbe', 'resource_probe', 'reportedResources', 'reported_resources'),
    field(job, 'resourceFacts', 'resource_facts', 'resources'),
  );
  if (!isObject(probe)) return { probe: null, code: 'missing-cgroup-probe' };
  const source = firstDefined(probe.source, probe.kind, probe.origin);
  if (source !== 'cgroup') return { probe, code: 'resource-probe-not-cgroup' };
  const cpus = firstDefined(probe.cpus, probe.cpuCount, probe.cpu_count, probe.cpu);
  const memory = firstDefined(
    probe.memoryGB,
    probe.memoryGb,
    probe.memoryGiB,
    probe.memory_gb,
    probe.memoryBytes,
    probe.memory_bytes,
  );
  if (!(Number.isFinite(cpus) && cpus > 0) || !(Number.isFinite(memory) && memory > 0))
    return { probe, code: 'resource-fact-missing' };
  return { probe: { ...probe, cpus, memory }, code: null };
}

function timingFact(job) {
  const createdAt = firstDefined(
    field(job, 'createdAt', 'created_at'),
    field(job, 'timing.createdAt'),
  );
  const startedAt = firstDefined(
    field(job, 'startedAt', 'started_at'),
    field(job, 'timing.startedAt'),
  );
  const completedAt = firstDefined(
    field(job, 'completedAt', 'completed_at'),
    field(job, 'timing.completedAt'),
  );
  const queueWaitSeconds = firstDefined(
    field(job, 'queueWaitSeconds', 'queue_wait_seconds'),
    field(job, 'timing.queueWaitSeconds', 'timing.queue_wait_seconds'),
  );
  const activeSeconds = firstDefined(
    field(job, 'activeSeconds', 'active_seconds'),
    field(job, 'timing.activeSeconds', 'timing.active_seconds'),
  );
  const totalSeconds = firstDefined(
    field(job, 'totalSeconds', 'total_seconds'),
    field(job, 'timing.totalSeconds', 'timing.total_seconds'),
  );
  const timingValues = { queueWaitSeconds, activeSeconds, totalSeconds };
  const providedTiming = Object.values(timingValues).filter(
    (value) => value !== undefined && value !== null,
  ).length;
  const parsed = {
    createdAt: timestamp(createdAt),
    startedAt: timestamp(startedAt),
    completedAt: timestamp(completedAt),
    queueWaitSeconds: finiteNonNegative(queueWaitSeconds),
    activeSeconds: finiteNonNegative(activeSeconds),
    totalSeconds: finiteNonNegative(totalSeconds),
    values: { createdAt, startedAt, completedAt, queueWaitSeconds, activeSeconds, totalSeconds },
  };
  if ([parsed.createdAt, parsed.startedAt, parsed.completedAt].some((value) => value === null))
    return { ...parsed, code: 'missing-timestamp' };
  if (parsed.startedAt < parsed.createdAt || parsed.completedAt < parsed.startedAt)
    return { ...parsed, code: 'reversed-timestamp' };
  if (providedTiming > 0 && providedTiming < 3) return { ...parsed, code: 'missing-timing' };
  if (
    providedTiming === 3 &&
    [parsed.queueWaitSeconds, parsed.activeSeconds, parsed.totalSeconds].some(
      (value) => value === null,
    )
  )
    return { ...parsed, code: 'missing-timing' };
  const derived = {
    queueWaitSeconds: (parsed.startedAt - parsed.createdAt) / 1000,
    activeSeconds: (parsed.completedAt - parsed.startedAt) / 1000,
    totalSeconds: (parsed.completedAt - parsed.createdAt) / 1000,
  };
  if (
    (providedTiming === 3 && Math.abs(derived.queueWaitSeconds - parsed.queueWaitSeconds) > 1e-6) ||
    (providedTiming === 3 && Math.abs(derived.activeSeconds - parsed.activeSeconds) > 1e-6) ||
    (providedTiming === 3 && Math.abs(derived.totalSeconds - parsed.totalSeconds) > 1e-6)
  )
    return { ...parsed, derived, code: 'timing-mismatch' };
  return {
    ...parsed,
    derived,
    values: {
      ...parsed.values,
      queueWaitSeconds: providedTiming === 0 ? derived.queueWaitSeconds : queueWaitSeconds,
      activeSeconds: providedTiming === 0 ? derived.activeSeconds : activeSeconds,
      totalSeconds: providedTiming === 0 ? derived.totalSeconds : totalSeconds,
    },
    code: null,
  };
}

function normalizeJob(job, expected, state) {
  if (!isObject(job)) {
    addReason(state, 'job-invalid', {}, 'job');
    return { status: 'invalid', reasonCodes: ['job-invalid'] };
  }
  const name = stringValue(firstDefined(job.name, job.jobName, job.job_name));
  const reasons = [];
  const local = { reasonCodes: [], reasons: [] };
  const addLocal = (code, detail = {}) => {
    if (!local.reasonCodes.includes(code)) local.reasonCodes.push(code);
    if (!reasons.some((entry) => entry.code === code)) reasons.push({ code, detail });
    addReason(state, code, { name, ...detail }, name ?? 'job');
  };
  if (!name) addLocal('job-name-missing');
  const identity = jobIdentity(job);
  if (integerValue(identity.runAttempt) === null) addLocal('attempt-missing');
  for (const [key, normalize, code] of [
    ['runId', integerValue, 'run-id-mismatch'],
    ['headSha', stringValue, 'head-sha-mismatch'],
    ['runAttempt', integerValue, 'attempt-mismatch'],
    ['inputFingerprint', stringValue, 'fingerprint-mismatch'],
  ]) {
    const value = normalize(identity[key]);
    const expectedValue = normalize(expected[key]);
    if (value !== null && expectedValue !== null && value !== expectedValue)
      addLocal(code, { expected: expectedValue, observed: value });
  }
  const conclusion = firstDefined(job.conclusion, job.result, job.status);
  const conclusionValue = typeof conclusion === 'string' ? conclusion.toLowerCase() : null;
  if (!conclusionValue) addLocal('job-conclusion-missing');
  else if (NON_TERMINAL_STATES.has(conclusionValue)) addLocal('job-nonterminal');
  else if (!TERMINAL_CONCLUSIONS.has(conclusionValue)) addLocal('job-conclusion-unknown');
  const runnerId = firstDefined(field(job, 'runnerId', 'runner_id'), null);
  const runnerName = stringValue(firstDefined(field(job, 'runnerName', 'runner_name'), null));
  if (conclusionValue === 'skipped' && runnerId === null && runnerName === null)
    addLocal('runner-null-pre-run-skip');
  else if (runnerId === null || runnerName === null) addLocal('runner-missing');
  const pool = poolForJob(job);
  if (pool.candidates.length === 0) addLocal('missing-pool');
  else if (pool.candidates.length > 1) addLocal('duplicate-pool', { candidates: pool.candidates });
  else if (!POOLS.includes(pool.pool)) addLocal('invalid-pool', { observed: pool.pool });
  const command = commandFact(job);
  if (command === null) addLocal('missing-command');
  const workers = workerFact(job);
  if (workers === null) addLocal('missing-worker-fact');
  const resources = resourceFact(job);
  if (resources.code) addLocal(resources.code);
  const timing = timingFact(job);
  if (timing.code) addLocal(timing.code);
  const normalized = {
    jobId: firstDefined(field(job, 'jobId', 'job_id', 'id'), null),
    name,
    conclusion: conclusionValue,
    runnerId,
    runnerName,
    pool: pool.pool,
    command,
    workers,
    resourceProbe: resources.probe,
    timing: timing.code ? null : timing.values,
    status: local.reasonCodes.length === 0 ? 'valid' : 'invalid',
    reasonCodes: local.reasonCodes,
    reasons,
  };
  return normalized;
}

function normalizeArtifact(artifact, expected, state) {
  const identity = artifactIdentity(artifact);
  const id = identity.id === null ? null : String(identity.id);
  const reasons = [];
  const add = (code, detail = {}) => {
    if (!reasons.some((entry) => entry.code === code)) reasons.push({ code, detail });
    addReason(state, code, { artifactId: id, ...detail }, 'artifact');
  };
  if (id === null) add('artifact-id-missing');
  const runId = integerValue(identity.runId);
  const expectedRunId = integerValue(expected.runId);
  if (runId === null) add('artifact-binding-missing', { field: 'runId' });
  else if (expectedRunId !== null && runId !== expectedRunId)
    add('artifact-run-mismatch', { expected: expectedRunId, observed: runId });
  const attempt = integerValue(identity.runAttempt);
  const expectedAttempt = integerValue(expected.runAttempt);
  if (attempt !== null && expectedAttempt !== null && attempt !== expectedAttempt)
    add('artifact-attempt-mismatch', { expected: expectedAttempt, observed: attempt });
  const headSha = stringValue(identity.headSha);
  const expectedHeadSha = stringValue(expected.headSha);
  if (headSha !== null && expectedHeadSha !== null && headSha !== expectedHeadSha)
    add('artifact-head-mismatch', { expected: expectedHeadSha, observed: headSha });
  const fingerprint = stringValue(identity.inputFingerprint);
  const expectedFingerprint = stringValue(expected.inputFingerprint);
  if (fingerprint !== null && expectedFingerprint !== null && fingerprint !== expectedFingerprint)
    add('artifact-fingerprint-mismatch', { expected: expectedFingerprint, observed: fingerprint });
  return {
    artifactId: id,
    runId,
    headSha,
    runAttempt: attempt,
    inputFingerprint: fingerprint,
    status: reasons.length === 0 ? 'valid' : 'invalid',
    reasonCodes: reasons.map(({ code }) => code),
    reasons,
  };
}

export function normalizeRunPacket(packet, expected = {}) {
  const state = { reasonCodes: [], reasons: [] };
  if (!isObject(packet)) {
    addReason(state, 'packet-missing');
    return result(state, null, null, [], []);
  }
  const expectation = expectedFrom(packet, isObject(expected) ? expected : {});
  const run = observedRunFrom(packet);
  const runState = observedRunState(packet);
  if (!isObject(firstDefined(packet.run, packet.runMetadata, packet)))
    addReason(state, 'run-missing');
  if (runState.status !== null && NON_TERMINAL_STATES.has(runState.status))
    addReason(state, 'run-nonterminal', { status: runState.status }, 'run');
  else if (runState.status !== null && !TERMINAL_RUN_STATES.has(runState.status))
    addReason(state, 'run-status-unknown', { status: runState.status }, 'run');
  if (runState.conclusion === null) addReason(state, 'run-conclusion-missing', {}, 'run');
  else if (!TERMINAL_CONCLUSIONS.has(runState.conclusion))
    addReason(state, 'run-conclusion-unknown', { conclusion: runState.conclusion }, 'run');
  identityComparison(state, expectation, run);
  if (!expectation.declaredRoster) addReason(state, 'roster-missing');
  const jobs = observedJobs(packet);
  if (jobs === null) addReason(state, 'jobs-missing');
  else if (jobs.length === 0) addReason(state, 'zero-jobs');
  const jobRows = jobs === null ? [] : jobs.map((job) => normalizeJob(job, expectation, state));
  const observedNames = jobRows.map((job) => job.name).filter((name) => name !== null);
  const duplicateNames = [
    ...new Set(observedNames.filter((name, index) => observedNames.indexOf(name) !== index)),
  ];
  if (duplicateNames.length > 0) addReason(state, 'duplicate-job', { names: duplicateNames });
  if (expectation.declaredRoster) {
    const declared = new Set(expectation.declaredRoster);
    const observed = new Set(observedNames);
    const missing = expectation.declaredRoster.filter((name) => !observed.has(name));
    const extra = observedNames.filter((name) => !declared.has(name));
    if (missing.length > 0 || extra.length > 0)
      addReason(state, 'incomplete-roster', { missing, extra });
  }
  const artifacts = observedArtifacts(packet);
  if (artifacts === null) addReason(state, 'artifacts-missing');
  const artifactRows =
    artifacts === null
      ? []
      : artifacts.map((artifact) => normalizeArtifact(artifact, expectation, state));
  const artifactIds = artifactRows.map(({ artifactId }) => artifactId).filter((id) => id !== null);
  const duplicateArtifacts = [
    ...new Set(artifactIds.filter((id, index) => artifactIds.indexOf(id) !== index)),
  ];
  if (duplicateArtifacts.length > 0)
    addReason(state, 'duplicate-artifact', { artifactIds: duplicateArtifacts });
  if (expectation.artifactRoster) {
    const observed = new Set(artifactIds);
    const expectedIds = expectation.artifactRoster.map(String);
    const missing = expectedIds.filter((id) => !observed.has(id));
    const extra = artifactIds.filter((id) => !expectedIds.includes(id));
    if (missing.length > 0 || extra.length > 0)
      addReason(state, 'incomplete-artifact-roster', { missing, extra });
  }
  const identity = {
    runId: integerValue(run.runId),
    headSha: stringValue(run.headSha),
    runAttempt: integerValue(run.runAttempt),
    inputFingerprint: stringValue(run.inputFingerprint),
  };
  return result(state, identity, expectation, jobRows, artifactRows);
}

function result(state, identity, expected, jobs, artifacts) {
  const admissible = state.reasonCodes.length === 0;
  const classification = admissible
    ? 'admissible'
    : state.reasonCodes.some((code) => !UNKNOWN_CODES.has(code))
      ? 'invalid'
      : 'unknown';
  return {
    schemaVersion: NORMALIZER_SCHEMA_VERSION,
    admissible,
    status: classification,
    classification,
    reasonCodes: [...state.reasonCodes],
    code: state.reasonCodes[0] ?? null,
    reasons: [...state.reasons],
    identity,
    expected,
    jobs,
    artifacts,
  };
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function readJson(path, code) {
  if (!path || !existsSync(path)) return { [code]: true };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { [code]: true };
  }
}

function main() {
  const argv = process.argv.slice(2);
  const inputPath = argumentValue(argv, '--input');
  const outputPath = argumentValue(argv, '--out');
  const expectedPath = argumentValue(argv, '--expected');
  const input = readJson(inputPath, 'packet-missing');
  const expected = expectedPath ? readJson(expectedPath, 'expected-identity-missing') : {};
  const packet = input.packetMissing ? null : input;
  const normalized = normalizeRunPacket(packet, expected);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  if (outputPath) writeFileSync(resolve(outputPath), serialized);
  process.stdout.write(serialized);
}

export default normalizeRunPacket;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
