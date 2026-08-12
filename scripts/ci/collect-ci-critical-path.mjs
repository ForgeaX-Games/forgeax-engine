#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 1;
const POOLS = new Set(['standard', 'heavy']);
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
const NON_TERMINAL_CONCLUSIONS = new Set(['queued', 'requested', 'waiting', 'in_progress']);
const FAILURE_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'skipped',
  'timed_out',
  'neutral',
  'action_required',
  'startup_failure',
  'stale',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function toTimestamp(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function timestampValue(value) {
  return toTimestamp(value) === null ? null : value;
}

function seconds(value) {
  return Number((value / 1000).toFixed(6));
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

function valueAt(value, ...paths) {
  for (const path of paths) {
    const parts = path.split('.');
    let current = value;
    for (const part of parts) {
      if (!isObject(current)) {
        current = undefined;
        break;
      }
      current = current[part];
    }
    if (current !== undefined && current !== null) return current;
  }
  return null;
}

function rosterFrom(facts, options) {
  const value = firstDefined(
    options?.requiredJobRoster,
    facts?.requiredJobRoster,
    facts?.wallClock?.requiredJobRoster,
    facts?.contract?.requiredCIJobRoster,
  );
  if (!Array.isArray(value)) return null;
  const roster = value.filter((name) => typeof name === 'string' && name.trim() !== '');
  return roster.length === value.length ? roster : null;
}

function expectedIdentity(facts, options) {
  const expected = firstDefined(options?.expectedIdentity, facts?.expectedIdentity, {});
  return isObject(expected) ? expected : {};
}

function observedIdentity(facts) {
  const identity = firstDefined(facts?.identity, facts?.run, facts?.runMetadata, facts, {});
  return {
    runId: firstDefined(identity?.runId, identity?.run_id, identity?.id),
    runAttempt: firstDefined(identity?.runAttempt, identity?.run_attempt, identity?.attempt),
    headSha: firstDefined(identity?.headSha, identity?.head_sha),
    inputFingerprint: firstDefined(
      identity?.inputFingerprint,
      identity?.input_fingerprint,
      identity?.fingerprint,
    ),
  };
}

function integer(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function string(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function identityReasons(facts, options, state) {
  const observed = observedIdentity(facts);
  const expected = expectedIdentity(facts, options);
  for (const [name, normalize] of [
    ['runId', integer],
    ['runAttempt', integer],
    ['headSha', string],
    ['inputFingerprint', string],
  ]) {
    const expectedValue = normalize(expected[name]);
    const observedValue = normalize(observed[name]);
    if (expectedValue === null) continue;
    if (observedValue === null) {
      addReason(
        state,
        `${name === 'runId' ? 'run-id' : name === 'runAttempt' ? 'attempt' : name === 'headSha' ? 'head-sha' : 'fingerprint'}-missing`,
        {
          expected: expectedValue,
        },
      );
    } else if (observedValue !== expectedValue) {
      addReason(
        state,
        `${name === 'runId' ? 'run-id' : name === 'runAttempt' ? 'attempt' : name === 'headSha' ? 'head-sha' : 'fingerprint'}-mismatch`,
        {
          expected: expectedValue,
          observed: observedValue,
        },
      );
    }
  }
  if (integer(observed.runId) === null) addReason(state, 'run-id-missing');
  if (integer(observed.runAttempt) === null) addReason(state, 'attempt-missing');
  if (string(observed.headSha) === null) addReason(state, 'head-sha-missing');
  if (string(observed.inputFingerprint) === null) addReason(state, 'fingerprint-missing');
  return {
    runId: integer(observed.runId),
    runAttempt: integer(observed.runAttempt),
    headSha: string(observed.headSha),
    inputFingerprint: string(observed.inputFingerprint),
  };
}

function addReason(state, code, detail = {}, scope = 'packet') {
  if (state.reasonCodes.includes(code)) return;
  state.reasonCodes.push(code);
  state.reasons.push({ code, scope, detail });
}

function runState(facts) {
  const source = firstDefined(facts?.run, facts?.runMetadata, facts, {});
  return {
    status: string(valueAt(source, 'status', 'runStatus', 'run_status'))?.toLowerCase() ?? null,
    conclusion:
      string(valueAt(source, 'conclusion', 'runConclusion', 'run_conclusion'))?.toLowerCase() ??
      null,
  };
}

function checkRunState(facts, state) {
  const observed = runState(facts);
  if (observed.status === null) addReason(state, 'run-status-missing', {}, 'run');
  else if (observed.status !== 'completed') {
    addReason(
      state,
      NON_TERMINAL_CONCLUSIONS.has(observed.status) ? 'run-nonterminal' : 'run-status-unknown',
      { status: observed.status },
      'run',
    );
  }
  if (observed.conclusion === null) addReason(state, 'run-conclusion-missing', {}, 'run');
  else if (!TERMINAL_CONCLUSIONS.has(observed.conclusion)) {
    addReason(
      state,
      NON_TERMINAL_CONCLUSIONS.has(observed.conclusion)
        ? 'run-nonterminal'
        : 'run-conclusion-unknown',
      { conclusion: observed.conclusion },
      'run',
    );
  }
  return observed;
}

function jobConclusion(job) {
  return string(firstDefined(job?.conclusion, job?.result, job?.status))?.toLowerCase() ?? null;
}

function jobName(job) {
  return string(firstDefined(job?.name, job?.jobName, job?.job_name));
}

function jobTiming(job) {
  const nested = isObject(job?.timing) ? job.timing : {};
  const createdAt = timestampValue(firstDefined(job?.createdAt, job?.created_at, nested.createdAt));
  const startedAt = timestampValue(firstDefined(job?.startedAt, job?.started_at, nested.startedAt));
  const completedAt = timestampValue(
    firstDefined(job?.completedAt, job?.completed_at, nested.completedAt),
  );
  const queueWaitSeconds = firstDefined(job?.queueWaitSeconds, nested.queueWaitSeconds);
  const activeSeconds = firstDefined(job?.activeSeconds, nested.activeSeconds);
  const totalSeconds = firstDefined(job?.totalSeconds, nested.totalSeconds);
  return {
    createdAt,
    startedAt,
    completedAt,
    queueWaitSeconds,
    activeSeconds,
    totalSeconds,
  };
}

function timingValues(timing) {
  const created = toTimestamp(timing.createdAt);
  const started = toTimestamp(timing.startedAt);
  const completed = toTimestamp(timing.completedAt);
  if (created === null || started === null || completed === null) return null;
  if (started < created || completed < started) return null;
  const derived = {
    queueWaitSeconds: seconds(started - created),
    activeSeconds: seconds(completed - started),
    totalSeconds: seconds(completed - created),
  };
  const provided = {
    queueWaitSeconds: timing.queueWaitSeconds,
    activeSeconds: timing.activeSeconds,
    totalSeconds: timing.totalSeconds,
  };
  for (const [name, value] of Object.entries(provided)) {
    if (value !== undefined && value !== null && !isFiniteNonNegative(value)) return null;
    if (value !== undefined && value !== null && Math.abs(value - derived[name]) > 1e-6)
      return null;
  }
  return {
    createdAt: timing.createdAt,
    startedAt: timing.startedAt,
    completedAt: timing.completedAt,
    queueWaitSeconds: provided.queueWaitSeconds ?? derived.queueWaitSeconds,
    activeSeconds: provided.activeSeconds ?? derived.activeSeconds,
    totalSeconds: provided.totalSeconds ?? derived.totalSeconds,
    createdMilliseconds: created,
    startedMilliseconds: started,
    completedMilliseconds: completed,
  };
}

function normalizeJob(job, required, state) {
  const name = jobName(job);
  if (!name) {
    addReason(state, 'job-name-missing', {}, 'job');
    return null;
  }
  const status = string(job?.status)?.toLowerCase() ?? null;
  const conclusion = jobConclusion(job);
  if (status === 'invalidevidence' || status === 'invalid' || status === 'unknown')
    addReason(state, 'job-invalid-evidence', { name, status }, name);
  if (conclusion === null) addReason(state, 'job-conclusion-missing', { name }, name);
  else if (NON_TERMINAL_CONCLUSIONS.has(conclusion))
    addReason(state, 'job-nonterminal', { name, conclusion }, name);
  else if (!TERMINAL_CONCLUSIONS.has(conclusion))
    addReason(state, 'job-conclusion-unknown', { name, conclusion }, name);
  const runnerId = firstDefined(job?.runnerId, job?.runner_id);
  const runnerName = string(firstDefined(job?.runnerName, job?.runner_name));
  if (runnerId === null || runnerName === null)
    addReason(
      state,
      conclusion === 'skipped' ? 'runner-null-pre-run-skip' : 'runner-missing',
      { name, runnerId: runnerId ?? null, runnerName },
      name,
    );
  const pool = string(firstDefined(job?.pool, job?.runnerPool, job?.runner_pool));
  if (!POOLS.has(pool)) addReason(state, 'pool-missing-or-invalid', { name, pool }, name);
  const timing = jobTiming(job);
  const values = timingValues(timing);
  if (!values) {
    const missing = ['createdAt', 'startedAt', 'completedAt'].filter((field) => !timing[field]);
    addReason(
      state,
      missing.length > 0 ? 'timing-missing' : 'timing-invalid',
      { name, missing },
      name,
    );
  }
  return {
    name,
    required,
    status,
    conclusion,
    runnerId,
    runnerName,
    pool,
    timing: values,
    raw: job,
  };
}

function intervals(rows) {
  return rows
    .filter((row) => row.timing)
    .map((row) => ({
      name: row.name,
      pool: row.pool,
      start: row.timing.startedMilliseconds,
      end: row.timing.completedMilliseconds,
    }));
}

function temporalSegments(rows) {
  const events = [];
  for (const interval of intervals(rows)) {
    events.push({ time: interval.start, delta: 1, name: interval.name, type: 'start' });
    events.push({ time: interval.end, delta: -1, name: interval.name, type: 'end' });
  }
  events.sort((left, right) => left.time - right.time || left.delta - right.delta);
  const segments = [];
  const active = new Map();
  let cursor = events[0]?.time ?? null;
  for (const event of events) {
    if (cursor !== null && event.time > cursor && active.size > 0) {
      segments.push({
        startMilliseconds: cursor,
        endMilliseconds: event.time,
        seconds: seconds(event.time - cursor),
        concurrency: active.size,
        jobs: [...active.keys()].sort(),
      });
    }
    if (event.type === 'start') active.set(event.name, true);
    else active.delete(event.name);
    cursor = event.time;
  }
  return segments;
}

function aggregate(rows) {
  const totals = { queueWaitSeconds: 0, activeSeconds: 0, totalSeconds: 0 };
  const byPool = {
    standard: { queueWaitSeconds: 0, activeSeconds: 0, totalSeconds: 0, jobCount: 0 },
    heavy: { queueWaitSeconds: 0, activeSeconds: 0, totalSeconds: 0, jobCount: 0 },
  };
  for (const row of rows) {
    const timing = row.timing;
    totals.queueWaitSeconds += timing.queueWaitSeconds;
    totals.activeSeconds += timing.activeSeconds;
    totals.totalSeconds += timing.totalSeconds;
    const pool = byPool[row.pool];
    pool.queueWaitSeconds += timing.queueWaitSeconds;
    pool.activeSeconds += timing.activeSeconds;
    pool.totalSeconds += timing.totalSeconds;
    pool.jobCount += 1;
  }
  for (const value of [totals, ...Object.values(byPool)]) {
    for (const key of ['queueWaitSeconds', 'activeSeconds', 'totalSeconds'])
      value[key] = Number(value[key].toFixed(6));
  }
  return { totals, byPool };
}

function boundary(source, state, code) {
  const start = firstDefined(
    source?.startAt,
    source?.start_at,
    source?.createdAt,
    source?.created_at,
    source?.startedAt,
    source?.started_at,
    source?.runStartedAt,
    source?.run_started_at,
  );
  const end = firstDefined(
    source?.endAt,
    source?.end_at,
    source?.completedAt,
    source?.completed_at,
    source?.updatedAt,
    source?.updated_at,
    source?.runCompletedAt,
    source?.run_completed_at,
  );
  if (timestampValue(start) === null || timestampValue(end) === null) {
    addReason(state, code, { fields: ['startAt', 'endAt'] });
    return null;
  }
  return {
    startAt: start,
    endAt: end,
    startMilliseconds: toTimestamp(start),
    endMilliseconds: toTimestamp(end),
  };
}

function runWall(rows, facts, state) {
  const sources = [
    facts?.fullRunWall,
    facts?.wallClock?.fullRunWall,
    facts?.run,
    facts?.runMetadata,
    facts?.wallClock,
  ];
  for (const source of sources) {
    if (!isObject(source)) continue;
    const hasExplicitBoundary = [
      'startAt',
      'start_at',
      'createdAt',
      'created_at',
      'startedAt',
      'started_at',
      'runStartedAt',
      'run_started_at',
      'endAt',
      'end_at',
      'completedAt',
      'completed_at',
      'updatedAt',
      'updated_at',
      'runCompletedAt',
      'run_completed_at',
    ].some((field) => source[field] !== undefined && source[field] !== null);
    if (!hasExplicitBoundary) continue;
    const explicit = boundary(source, state, 'run-boundary-invalid');
    if (!explicit) return null;
    if (explicit.endMilliseconds < explicit.startMilliseconds)
      addReason(state, 'run-boundary-reversed');
    return {
      ...explicit,
      source: source === facts?.fullRunWall ? 'full-run-wall' : 'run-boundary',
    };
  }
  if (rows.length === 0) {
    addReason(state, 'run-boundary-missing');
    return null;
  }
  const start = Math.min(...rows.map((row) => row.timing.createdMilliseconds));
  const end = Math.max(...rows.map((row) => row.timing.completedMilliseconds));
  return {
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    startMilliseconds: start,
    endMilliseconds: end,
    source: 'job-boundary',
  };
}

function firstFailure(requiredRows) {
  const failures = requiredRows.filter(
    (row) => FAILURE_CONCLUSIONS.has(row.conclusion) && row.conclusion !== 'skipped',
  );
  if (failures.length === 0) return { failures: [], first: null, ambiguous: false };
  const earliest = Math.min(...failures.map((row) => row.timing.completedMilliseconds));
  const candidates = failures.filter((row) => row.timing.completedMilliseconds === earliest);
  return {
    failures,
    ambiguous: candidates.length > 1,
    first:
      candidates.length === 1
        ? {
            name: candidates[0].name,
            conclusion: candidates[0].conclusion,
            completedAt: candidates[0].timing.completedAt,
            completedMilliseconds: candidates[0].timing.completedMilliseconds,
          }
        : null,
  };
}

function invalidResult(state, identity, roster) {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'invalidEvidence',
    admissible: false,
    code: state.reasonCodes[0] ?? 'critical-path-evidence-invalid',
    reasonCodes: [...state.reasonCodes],
    reasons: [...state.reasons],
    identity,
    requiredJobRoster: roster,
    fullRunWall: null,
    totals: null,
    criticalPath: null,
    postCriticalReportingTail: null,
    firstFailure: null,
    requiredCorrectness: { status: 'invalidEvidence', verdict: null },
    jobs: [],
  };
}

export function projectCriticalPath(facts, options = {}) {
  const state = { reasonCodes: [], reasons: [] };
  if (!isObject(facts)) {
    addReason(state, 'facts-missing');
    return invalidResult(state, null, null);
  }
  const roster = rosterFrom(facts, options);
  if (!roster || roster.length === 0) addReason(state, 'required-roster-missing');
  else if (new Set(roster).size !== roster.length) addReason(state, 'required-roster-duplicate');
  const identity = identityReasons(facts, options, state);
  checkRunState(facts, state);
  const jobs = Array.isArray(facts.jobs) ? facts.jobs : null;
  if (!jobs) addReason(state, 'jobs-missing');
  else if (jobs.length === 0) addReason(state, 'zero-jobs');
  const rows = jobs
    ? jobs.map((job) => normalizeJob(job, roster?.includes(jobName(job)) ?? false, state))
    : [];
  const namedRows = rows.filter((row) => row !== null);
  const byName = new Map();
  for (const row of namedRows) {
    if (byName.has(row.name)) addReason(state, 'duplicate-job', { name: row.name });
    byName.set(row.name, row);
  }
  const requiredRows = roster ? roster.map((name) => byName.get(name) ?? null) : [];
  if (roster) {
    const missing = roster.filter((_name, index) => requiredRows[index] === null);
    const extra = namedRows.map((row) => row.name).filter((name) => !roster.includes(name));
    if (missing.length > 0) addReason(state, 'incomplete-roster', { missing });
    if (extra.length === 0 && namedRows.length === 0) addReason(state, 'zero-jobs');
  }
  const usableRows = namedRows.filter((row) => row.timing);
  const fullWall = usableRows.length > 0 ? runWall(usableRows, facts, state) : null;
  const requiredUsableRows = requiredRows.filter((row) => row?.timing);
  if (requiredUsableRows.length !== requiredRows.length)
    addReason(state, 'required-job-timing-missing');
  const requiredFailures = firstFailure(requiredUsableRows);
  const correctnessFailures = requiredUsableRows.filter((row) => row.conclusion !== 'success');
  const requiredComplete =
    roster !== null &&
    requiredRows.length === roster.length &&
    requiredRows.every((row) => row?.timing && row.status !== 'invalidEvidence');
  const correctnessStatus = !requiredComplete
    ? 'invalidEvidence'
    : correctnessFailures.length > 0
      ? 'fail'
      : 'pass';
  const correctness = {
    status: correctnessStatus,
    verdict: correctnessStatus === 'pass' ? 'pass' : correctnessStatus === 'fail' ? 'fail' : null,
    requiredJobCount: roster?.length ?? null,
    observedRequiredJobCount: requiredRows.filter(Boolean).length,
    successfulJobCount: requiredUsableRows.filter((row) => row.conclusion === 'success').length,
    failedJobCount: correctnessFailures.length,
    failedJobs: correctnessFailures.map((row) => ({ name: row.name, conclusion: row.conclusion })),
    firstFailure: requiredFailures.first,
    firstFailureAmbiguous: requiredFailures.ambiguous,
  };
  if (requiredFailures.ambiguous)
    addReason(state, 'first-failure-ambiguous', {
      names: requiredFailures.failures
        .filter(
          (row) =>
            row.timing.completedMilliseconds ===
            Math.min(
              ...requiredFailures.failures.map((entry) => entry.timing.completedMilliseconds),
            ),
        )
        .map((row) => row.name),
    });
  if (state.reasonCodes.length > 0) {
    const result = invalidResult(state, identity, roster);
    result.requiredCorrectness = correctness;
    result.jobs = namedRows.map((row) => projectJob(row));
    return result;
  }
  const requiredIntervals = temporalSegments(requiredRows);
  const overlapSegments = requiredIntervals.filter((segment) => segment.concurrency > 1);
  const requiredStart = Math.min(...requiredRows.map((row) => row.timing.startedMilliseconds));
  const requiredEnd = Math.max(...requiredRows.map((row) => row.timing.completedMilliseconds));
  const requiredActiveSeconds = requiredRows.reduce(
    (sum, row) => sum + row.timing.activeSeconds,
    0,
  );
  const requiredUnionSeconds = requiredIntervals.reduce((sum, segment) => sum + segment.seconds, 0);
  const overlapSeconds = overlapSegments.reduce(
    (sum, segment) => sum + segment.seconds * (segment.concurrency - 1),
    0,
  );
  const reportingRows = namedRows.filter((row) => !row.required);
  const tailStart = Math.max(...requiredRows.map((row) => row.timing.completedMilliseconds));
  const tailEnd = fullWall.endMilliseconds;
  const tailSeconds = Math.max(0, seconds(tailEnd - tailStart));
  const totals = aggregate(namedRows);
  const result = {
    schemaVersion: SCHEMA_VERSION,
    status: 'valid',
    admissible: true,
    code: null,
    reasonCodes: [],
    reasons: [],
    identity,
    requiredJobRoster: roster,
    fullRunWall: {
      startAt: fullWall.startAt,
      endAt: fullWall.endAt,
      seconds: seconds(fullWall.endMilliseconds - fullWall.startMilliseconds),
      source: fullWall.source ?? 'run-boundary',
    },
    totals,
    queueWaitSeconds: totals.totals.queueWaitSeconds,
    activeSeconds: totals.totals.activeSeconds,
    totalSeconds: totals.totals.totalSeconds,
    criticalPath: {
      status: 'valid',
      basis: 'required-job-temporal-envelope',
      startAt: new Date(requiredStart).toISOString(),
      endAt: new Date(requiredEnd).toISOString(),
      seconds: seconds(requiredEnd - requiredStart),
      activeSeconds: Number(requiredActiveSeconds.toFixed(6)),
      unionSeconds: Number(requiredUnionSeconds.toFixed(6)),
      overlapSeconds: Number(overlapSeconds.toFixed(6)),
      overlapRatio:
        requiredActiveSeconds === 0
          ? null
          : Number((overlapSeconds / requiredActiveSeconds).toFixed(6)),
      segments: requiredIntervals.map((segment) => ({
        startAt: new Date(segment.startMilliseconds).toISOString(),
        endAt: new Date(segment.endMilliseconds).toISOString(),
        seconds: segment.seconds,
        concurrency: segment.concurrency,
        jobs: segment.jobs,
      })),
      overlapSegments: overlapSegments.map((segment) => ({
        startAt: new Date(segment.startMilliseconds).toISOString(),
        endAt: new Date(segment.endMilliseconds).toISOString(),
        seconds: segment.seconds,
        concurrency: segment.concurrency,
        jobs: segment.jobs,
      })),
    },
    postCriticalReportingTail: {
      status: 'valid',
      startAt: new Date(tailStart).toISOString(),
      endAt: new Date(tailEnd).toISOString(),
      seconds: tailSeconds,
      jobs: reportingRows
        .filter((row) => row.timing.completedMilliseconds > tailStart)
        .map((row) => row.name),
      note: 'Reporting tail is timing context only.',
    },
    firstFailure: correctness.firstFailure,
    requiredCorrectness: correctness,
    jobs: namedRows.map((row) => projectJob(row)),
  };
  return result;
}

function projectJob(row) {
  const timing = row.timing;
  return {
    name: row.name,
    required: row.required,
    status: row.status ?? 'valid',
    conclusion: row.conclusion,
    runnerId: row.runnerId,
    runnerName: row.runnerName,
    pool: row.pool,
    createdAt: timing?.createdAt ?? null,
    startedAt: timing?.startedAt ?? null,
    completedAt: timing?.completedAt ?? null,
    queueWaitSeconds: timing?.queueWaitSeconds ?? null,
    activeSeconds: timing?.activeSeconds ?? null,
    totalSeconds: timing?.totalSeconds ?? null,
  };
}

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const input = readJson(argument(argv, '--input'));
  const expected = readJson(argument(argv, '--expected')) ?? {};
  const result = projectCriticalPath(input, { expectedIdentity: expected });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const output = argument(argv, '--out');
  if (output) writeFileSync(resolve(output), serialized);
  process.stdout.write(serialized);
  if (result.status === 'invalidEvidence') process.exitCode = 1;
}

export default projectCriticalPath;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
