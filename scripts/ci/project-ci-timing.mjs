#!/usr/bin/env node

const SCHEMA_VERSION = 1;
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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function integer(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function timestamp(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function seconds(milliseconds) {
  return Number((milliseconds / 1000).toFixed(6));
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function addReason(state, code, detail = {}) {
  if (state.reasonCodes.includes(code)) return;
  state.reasonCodes.push(code);
  state.reasons.push({ code, detail });
}

function invalidProjection(state, identity, roster) {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'invalidEvidence',
    admissible: false,
    code: state.reasonCodes[0] ?? 'ci-timing-projection-invalid',
    reasonCodes: [...state.reasonCodes],
    reasons: [...state.reasons],
    identity,
    requiredJobRoster: roster,
    fullRunWall: null,
    totals: null,
    criticalPath: null,
    postCriticalReportingTail: null,
    costReporterDelay: null,
    stickySkip: null,
    artifactReadyDelays: null,
    note: 'Timing is attribution context only; no performance conclusion is inferred.',
  };
}

function jobConclusion(job) {
  return nonEmptyString(job?.result ?? job?.conclusion)?.toLowerCase() ?? null;
}

function readTiming(job) {
  const createdAt = job?.createdAt ?? job?.created_at;
  const startedAt = job?.startedAt ?? job?.started_at;
  const completedAt = job?.completedAt ?? job?.completed_at;
  const createdMilliseconds = timestamp(createdAt);
  const startedMilliseconds = timestamp(startedAt);
  const completedMilliseconds = timestamp(completedAt);
  if (
    createdMilliseconds === null ||
    startedMilliseconds === null ||
    completedMilliseconds === null
  )
    return { status: 'invalidEvidence', code: 'timing-missing' };
  if (startedMilliseconds < createdMilliseconds || completedMilliseconds < startedMilliseconds)
    return {
      status: 'invalidEvidence',
      code: 'timing-reversed',
      createdAt,
      startedAt,
      completedAt,
    };
  const derived = {
    queueWaitSeconds: seconds(startedMilliseconds - createdMilliseconds),
    activeSeconds: seconds(completedMilliseconds - startedMilliseconds),
    totalSeconds: seconds(completedMilliseconds - createdMilliseconds),
  };
  for (const [name, value] of Object.entries(derived)) {
    const provided = job?.[name];
    if (provided === null || provided === undefined) continue;
    if (!finiteNonNegative(provided) || Math.abs(provided - value) > 1e-6)
      return { status: 'invalidEvidence', code: 'timing-ambiguous', field: name };
  }
  return {
    status: 'valid',
    createdAt,
    startedAt,
    completedAt,
    createdMilliseconds,
    startedMilliseconds,
    completedMilliseconds,
    ...derived,
  };
}

function normalizeJob(job, state, strict) {
  const name = nonEmptyString(job?.name);
  if (!name) {
    if (strict) addReason(state, 'job-name-missing');
    return null;
  }
  const conclusion = jobConclusion(job);
  if (strict && !conclusion) addReason(state, 'job-conclusion-missing', { name });
  else if (strict && !TERMINAL_CONCLUSIONS.has(conclusion))
    addReason(state, 'job-conclusion-unknown', { name, conclusion });
  const timing = readTiming(job);
  if (strict && timing.status !== 'valid')
    addReason(state, `job-${timing.code}`, { name, ...timing });
  if (strict && job?.status === 'invalidEvidence' && conclusion !== 'skipped')
    addReason(state, 'job-invalid-evidence', { name });
  return { name, conclusion, timing: timing.status === 'valid' ? timing : null, raw: job };
}

function requiredRoster(facts, options) {
  const roster = options.requiredJobRoster ?? facts?.wallClock?.requiredJobRoster;
  if (!Array.isArray(roster) || roster.length === 0) return null;
  if (!roster.every((name) => nonEmptyString(name))) return null;
  return [...roster];
}

function temporalSegments(rows) {
  const events = [];
  for (const row of rows) {
    events.push({ time: row.timing.startedMilliseconds, delta: 1, name: row.name, type: 'start' });
    events.push({ time: row.timing.completedMilliseconds, delta: -1, name: row.name, type: 'end' });
  }
  events.sort((left, right) => left.time - right.time || left.delta - right.delta);
  const active = new Map();
  const segments = [];
  let cursor = events[0]?.time ?? null;
  for (const event of events) {
    if (cursor !== null && event.time > cursor && active.size > 0)
      segments.push({
        startMilliseconds: cursor,
        endMilliseconds: event.time,
        seconds: seconds(event.time - cursor),
        concurrency: active.size,
        jobs: [...active.keys()].sort(),
      });
    if (event.type === 'start') active.set(event.name, true);
    else active.delete(event.name);
    cursor = event.time;
  }
  return segments;
}

function projectJob(row, required) {
  const timing = row.timing;
  return {
    name: row.name,
    required,
    conclusion: row.conclusion,
    createdAt: timing?.createdAt ?? null,
    startedAt: timing?.startedAt ?? null,
    completedAt: timing?.completedAt ?? null,
    queueWaitSeconds: timing?.queueWaitSeconds ?? null,
    activeSeconds: timing?.activeSeconds ?? null,
    totalSeconds: timing?.totalSeconds ?? null,
  };
}

function projectArtifactReadyDelays(facts, state) {
  const consumers = facts?.consumers;
  const statuses = new Map(
    (facts?.ac06?.perConsumer ?? [])
      .filter((entry) => nonEmptyString(entry?.jobIdentity))
      .map((entry) => [entry.jobIdentity, entry.status]),
  );
  if (!Array.isArray(consumers) || consumers.length === 0) {
    addReason(state, 'artifact-ready-consumers-missing');
    return null;
  }
  const seen = new Set();
  let valid = true;
  const rows = consumers.map((consumer) => {
    const name = nonEmptyString(consumer?.name);
    if (!name) {
      addReason(state, 'artifact-ready-consumer-name-missing');
      valid = false;
      return { name: null, status: 'invalidEvidence', code: 'consumer-name-missing' };
    }
    if (seen.has(name)) {
      addReason(state, 'artifact-ready-consumer-ambiguous', { name });
      valid = false;
      return { name, status: 'invalidEvidence', code: 'consumer-ambiguous' };
    }
    seen.add(name);
    if (statuses.get(name) === 'notApplicable')
      return {
        name,
        status: 'notApplicable',
        readyAt: null,
        startedAt: null,
        delaySeconds: null,
      };
    const readyAt = consumer?.lastRequiredArtifactReadyAt;
    const startedAt = consumer?.startedAt;
    const readyMilliseconds = timestamp(readyAt);
    const startedMilliseconds = timestamp(startedAt);
    if (readyMilliseconds === null || startedMilliseconds === null) {
      addReason(state, 'artifact-ready-delay-missing', { name });
      valid = false;
      return {
        name,
        status: 'invalidEvidence',
        code: 'ready-or-start-missing',
        readyAt: readyAt ?? null,
        startedAt: startedAt ?? null,
        delaySeconds: null,
      };
    }
    if (startedMilliseconds < readyMilliseconds) {
      addReason(state, 'artifact-ready-delay-reversed', { name });
      valid = false;
      return {
        name,
        status: 'invalidEvidence',
        code: 'ready-after-start',
        readyAt,
        startedAt,
        delaySeconds: null,
      };
    }
    return {
      name,
      status: 'valid',
      observedStatus: statuses.get(name) ?? null,
      readyAt,
      startedAt,
      delaySeconds: seconds(startedMilliseconds - readyMilliseconds),
    };
  });
  return {
    status: valid ? 'valid' : 'invalidEvidence',
    consumers: rows,
    note: 'Artifact-ready delay is transport context only.',
  };
}

export function projectCiTiming(facts, options = {}) {
  const state = { reasonCodes: [], reasons: [] };
  if (!isObject(facts)) {
    addReason(state, 'facts-missing');
    return invalidProjection(state, null, null);
  }
  const identity = {
    runId: integer(facts.runId ?? facts.identity?.runId),
    runAttempt: integer(facts.runAttempt ?? facts.identity?.runAttempt),
  };
  if (identity.runId === null) addReason(state, 'run-id-missing');
  if (identity.runAttempt === null) addReason(state, 'run-attempt-missing');
  const roster = requiredRoster(facts, options);
  if (!roster) addReason(state, 'required-roster-missing');
  else if (new Set(roster).size !== roster.length) addReason(state, 'required-roster-duplicate');
  const inputJobs = Array.isArray(facts.jobs) ? facts.jobs : null;
  if (!inputJobs || inputJobs.length === 0) addReason(state, 'jobs-missing');
  const strictNames = new Set([...(roster ?? []), 'cost-reporter', 'sticky-comment']);
  const rows = inputJobs
    ? inputJobs.map((job) => normalizeJob(job, state, strictNames.has(job?.name))).filter(Boolean)
    : [];
  const byName = new Map();
  for (const row of rows) {
    if (byName.has(row.name)) addReason(state, 'job-ambiguous', { name: row.name });
    byName.set(row.name, row);
  }
  const requiredRows = roster ? roster.map((name) => byName.get(name) ?? null) : [];
  if (roster) {
    const missing = roster.filter((_name, index) => requiredRows[index] === null);
    if (missing.length > 0) addReason(state, 'required-roster-incomplete', { missing });
  }
  const skippedRequiredRows = requiredRows.filter((row) => row?.conclusion === 'skipped');
  const executableRequiredRows = requiredRows.filter(
    (row) => row && row.conclusion !== 'skipped' && row.timing,
  );
  if (requiredRows.some((row) => !row?.timing)) addReason(state, 'required-timing-incomplete');
  const terminalRows = rows.filter((row) => row.timing && TERMINAL_CONCLUSIONS.has(row.conclusion));
  if (terminalRows.length === 0) addReason(state, 'terminal-boundary-missing');
  const artifactReadyDelays = projectArtifactReadyDelays(facts, state);
  const costRows = rows.filter((row) => row.name === 'cost-reporter');
  if (costRows.length === 0) addReason(state, 'cost-reporter-missing');
  if (costRows.length > 1) addReason(state, 'cost-reporter-ambiguous');
  const stickyRows = rows.filter((row) => row.name === 'sticky-comment');
  if (roster?.includes('sticky-comment') && stickyRows.length === 0)
    addReason(state, 'sticky-job-missing');
  if (stickyRows.length > 1) addReason(state, 'sticky-job-ambiguous');
  const sticky = stickyRows.length === 1 ? stickyRows[0] : null;
  const costReporter = costRows.length === 1 ? costRows[0] : null;
  const criticalSegments = temporalSegments(executableRequiredRows);
  const overlapSegments = criticalSegments.filter((segment) => segment.concurrency > 1);
  const criticalStart = executableRequiredRows.length
    ? Math.min(...executableRequiredRows.map((row) => row.timing.startedMilliseconds))
    : null;
  const criticalEnd = executableRequiredRows.length
    ? Math.max(...executableRequiredRows.map((row) => row.timing.completedMilliseconds))
    : null;
  if (criticalStart === null || criticalEnd === null)
    addReason(state, 'critical-path-boundary-missing');
  const fullStart = terminalRows.length
    ? Math.min(...terminalRows.map((row) => row.timing.createdMilliseconds))
    : null;
  const fullEnd = terminalRows.length
    ? Math.max(...terminalRows.map((row) => row.timing.completedMilliseconds))
    : null;
  const fullWall =
    fullStart !== null && fullEnd !== null && fullEnd >= fullStart
      ? {
          startAt: iso(fullStart),
          endAt: iso(fullEnd),
          seconds: seconds(fullEnd - fullStart),
          source: 'job-boundary',
        }
      : null;
  if (!fullWall && fullStart !== null && fullEnd !== null)
    addReason(state, 'terminal-boundary-reversed');
  const totals = rows.every((row) => row.timing)
    ? rows.reduce(
        (result, row) => ({
          queueWaitSeconds: result.queueWaitSeconds + row.timing.queueWaitSeconds,
          activeSeconds: result.activeSeconds + row.timing.activeSeconds,
          totalSeconds: result.totalSeconds + row.timing.totalSeconds,
        }),
        { queueWaitSeconds: 0, activeSeconds: 0, totalSeconds: 0 },
      )
    : null;
  if (totals) for (const key of Object.keys(totals)) totals[key] = Number(totals[key].toFixed(6));
  if (state.reasonCodes.length > 0) return invalidProjection(state, identity, roster);
  const requiredActiveSeconds = executableRequiredRows.reduce(
    (sum, row) => sum + row.timing.activeSeconds,
    0,
  );
  const unionSeconds = criticalSegments.reduce((sum, segment) => sum + segment.seconds, 0);
  const overlapSeconds = overlapSegments.reduce(
    (sum, segment) => sum + segment.seconds * (segment.concurrency - 1),
    0,
  );
  const costTiming = costReporter.timing;
  const tailSeconds = seconds(fullEnd - criticalEnd);
  if (fullEnd < criticalEnd) addReason(state, 'post-critical-boundary-reversed');
  const stickySkip = {
    status: sticky.conclusion === 'skipped' ? 'skipped' : 'ran',
    skipped: sticky.conclusion === 'skipped',
    jobs: [projectJob(sticky, roster.includes('sticky-comment'))],
    note: 'Sticky reporting is terminal context only.',
  };
  const costReporterDelay = {
    status: 'valid',
    startedAt: costTiming.startedAt,
    completedAt: costTiming.completedAt,
    queueWaitSeconds: costTiming.queueWaitSeconds,
    activeSeconds: costTiming.activeSeconds,
    totalSeconds: costTiming.totalSeconds,
    delayAfterCriticalPathSeconds: seconds(
      Math.max(0, costTiming.startedMilliseconds - criticalEnd),
    ),
    overlapWithCriticalPathSeconds: seconds(
      Math.max(0, criticalEnd - costTiming.startedMilliseconds),
    ),
    terminalTailSeconds: tailSeconds,
    note: 'Cost-reporter delay is timing context only.',
  };
  const result = {
    schemaVersion: SCHEMA_VERSION,
    status: 'valid',
    admissible: true,
    code: null,
    reasonCodes: [],
    reasons: [],
    identity,
    requiredJobRoster: roster,
    fullRunWall: fullWall,
    totals,
    criticalPath: {
      status: 'valid',
      basis: 'required-job-temporal-envelope',
      startAt: iso(criticalStart),
      endAt: iso(criticalEnd),
      seconds: seconds(criticalEnd - criticalStart),
      activeSeconds: Number(requiredActiveSeconds.toFixed(6)),
      unionSeconds: Number(unionSeconds.toFixed(6)),
      overlapSeconds: Number(overlapSeconds.toFixed(6)),
      overlapRatio:
        requiredActiveSeconds === 0
          ? null
          : Number((overlapSeconds / requiredActiveSeconds).toFixed(6)),
      jobs: executableRequiredRows.map((row) => row.name),
      skippedJobs: skippedRequiredRows.map((row) => row.name),
      segments: criticalSegments.map((segment) => ({
        startAt: iso(segment.startMilliseconds),
        endAt: iso(segment.endMilliseconds),
        seconds: segment.seconds,
        concurrency: segment.concurrency,
        jobs: segment.jobs,
      })),
      overlapSegments: overlapSegments.map((segment) => ({
        startAt: iso(segment.startMilliseconds),
        endAt: iso(segment.endMilliseconds),
        seconds: segment.seconds,
        concurrency: segment.concurrency,
        jobs: segment.jobs,
      })),
    },
    postCriticalReportingTail: {
      status: 'valid',
      startAt: iso(criticalEnd),
      endAt: iso(fullEnd),
      seconds: tailSeconds,
      jobs: rows
        .filter(
          (row) =>
            !roster.includes(row.name) &&
            row.timing &&
            row.timing.completedMilliseconds > criticalEnd,
        )
        .map((row) => row.name),
      note: 'Post-critical reporting tail is timing context only.',
    },
    costReporterDelay,
    stickySkip,
    artifactReadyDelays,
    note: 'Timing is attribution context only; no performance conclusion is inferred.',
  };
  if (state.reasonCodes.length > 0) return invalidProjection(state, identity, roster);
  return result;
}

export default projectCiTiming;
