#!/usr/bin/env node
// required-ci-checks.mjs — emits direct required checks when ci.yml is path-filtered.
//
// ci.yml intentionally ignores docs/skill/rules-only pull requests. GitHub rulesets
// require named checks to be reported for every PR, so this workflow asks GitHub
// whether ci.yml created a pull_request run for the head SHA. A run with a complete
// required roster remains the owner; skipped, empty, partial, failed, and unavailable
// evidence fails closed. A missing run is fallback-eligible only when the caller carries
// independent path-filter proof; absence alone is never proof. We do not evaluate
// paths.json here: GitHub's actual workflow scheduling decision is the SSOT.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const CI_WORKFLOW = 'ci.yml';

// This manifest is the repository projection of the active Protect ruleset.
// Keep the external ruleset derived from this file; do not hand-maintain a
// second list in the fallback reporter or workflow comments.
const requiredCheckManifest = JSON.parse(
  readFileSync(new URL('./required-ci-checks.json', import.meta.url), 'utf8'),
);

if (
  !Array.isArray(requiredCheckManifest) ||
  requiredCheckManifest.length === 0 ||
  requiredCheckManifest.some((name) => typeof name !== 'string' || name.length === 0) ||
  new Set(requiredCheckManifest).size !== requiredCheckManifest.length
) {
  throw new Error('required-ci-checks.json must be a non-empty array of unique check names');
}

export const REQUIRED_CHECK_NAMES = requiredCheckManifest;

export const REQUIRED_CONTEXT_ADMISSION_STATUSES = Object.freeze([
  'path-filtered',
  'ordinary-push-main',
  'normal-ci-run',
  'operational-skip',
  'zero-job',
  'api-error',
  'partial-roster',
  'genuine-failure',
]);

const TERMINAL_RUN_STATUS = 'completed';
const NON_TERMINAL_RUN_STATUSES = new Set([
  'in_progress',
  'pending',
  'queued',
  'requested',
  'waiting',
]);
const SUCCESS_CONCLUSION = 'success';
const FAILURE_CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'startup_failure',
  'timed_out',
]);

function normalizedString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null;
}

function jobName(job) {
  if (!job || typeof job !== 'object') return null;
  const value = job.name ?? job.jobName ?? job.job_name;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function jobConclusion(job) {
  if (!job || typeof job !== 'object') return null;
  return normalizedString(job.conclusion ?? job.result ?? job.status);
}

function runEvent(run) {
  if (!run || typeof run !== 'object') return null;
  return normalizedString(run.event ?? run.eventName ?? run.event_name);
}

function runStatus(run) {
  if (!run || typeof run !== 'object') return null;
  return normalizedString(run.status ?? run.runStatus ?? run.run_status);
}

function runConclusion(run) {
  if (!run || typeof run !== 'object') return null;
  return normalizedString(run.conclusion ?? run.runConclusion ?? run.run_conclusion);
}

function operationMarker(run) {
  if (!run || typeof run !== 'object') return null;
  const values = [
    run.operationalContext,
    run.operational_context,
    run.incident,
    run.incidentContext,
    run.incident_context,
    run.skipReason,
    run.skip_reason,
  ];
  const marker = values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
  return marker === '' ? null : marker;
}

function isOperationalSkipEvidence(run, jobs) {
  const marker = operationMarker(run);
  const incidentMarked =
    marker !== null &&
    /\b(incident|operational|outage|degraded|infrastructure|runner)\b/.test(marker);
  const skippedJobs = Array.isArray(jobs)
    ? jobs
        .filter((job) => jobConclusion(job) === 'skipped')
        .map(jobName)
        .filter(Boolean)
    : [];
  const allJobsSkipped =
    Array.isArray(jobs) && jobs.length > 0 && skippedJobs.length === jobs.length;
  return {
    incidentMarked,
    allJobsSkipped,
    skippedJobs,
    marker,
  };
}

function admissionDecision(status, reasonCodes, details = {}) {
  if (!REQUIRED_CONTEXT_ADMISSION_STATUSES.includes(status)) {
    throw new Error(`required-ci-checks: unknown admission status ${status}`);
  }
  return {
    status,
    fallbackEligible: status === 'path-filtered' && details.pathFilteredProven === true,
    terminal: details.terminal ?? false,
    complete: details.complete ?? false,
    actionable:
      status !== 'normal-ci-run' &&
      !(status === 'path-filtered' && details.pathFilteredProven === true),
    reasonCodes: [...new Set(reasonCodes)],
    ...details,
  };
}

/**
 * Classify the evidence boundary before required-context fallback can emit checks.
 *
 * `pathFiltered` is deliberately explicit. Absence of a workflow run is not proof that
 * GitHub path-filtered the PR: an incident, zero-job run, or API gap can produce the
 * same observation. Callers must carry independent path-filter evidence before this
 * classifier permits synthetic success.
 *
 * @param {{run?: object|null, jobs?: Array<object>|null, pathFiltered?: boolean, apiError?: unknown}} input
 * @returns {{status:string,fallbackEligible:boolean,terminal:boolean,complete:boolean,reasonCodes:string[]}}
 */
export function classifyRequiredContextAdmission(input = {}) {
  const {
    run = null,
    jobs = null,
    pathFiltered = false,
    apiError = null,
  } = input && typeof input === 'object' ? input : {};

  if (apiError !== null && apiError !== undefined) {
    return admissionDecision('api-error', ['api-error'], {
      detail: String(apiError?.message ?? apiError),
    });
  }

  if (run === null || run === undefined) {
    return admissionDecision(
      'path-filtered',
      pathFiltered === true ? ['path-filtered-proven'] : ['path-filtered-unproven'],
      {
        pathFilteredProven: pathFiltered === true,
        terminal: false,
        complete: false,
      },
    );
  }

  const runStatusValue = runStatus(run);
  const runConclusionValue = runConclusion(run);
  const runEventValue = runEvent(run);

  if (runEventValue === null) {
    return admissionDecision('api-error', ['run-event-missing'], {
      terminal: false,
      complete: false,
    });
  }

  if (runStatusValue === null) {
    return admissionDecision('api-error', ['run-status-missing'], {
      terminal: false,
      complete: false,
    });
  }

  if (runStatusValue !== TERMINAL_RUN_STATUS) {
    if (!NON_TERMINAL_RUN_STATUSES.has(runStatusValue)) {
      return admissionDecision('api-error', ['run-status-unknown'], {
        terminal: false,
        complete: false,
      });
    }
    return admissionDecision(
      runEventValue === 'pull_request' ? 'normal-ci-run' : 'ordinary-push-main',
      ['run-not-terminal'],
      {
        event: runEventValue,
        terminal: false,
        complete: false,
      },
    );
  }

  if (runConclusionValue === 'skipped') {
    return admissionDecision('operational-skip', ['run-skipped'], {
      event: runEventValue,
      terminal: true,
      complete: false,
    });
  }

  if (runConclusionValue === null) {
    return admissionDecision('api-error', ['run-conclusion-missing'], {
      event: runEventValue,
      terminal: true,
      complete: false,
    });
  }

  if (FAILURE_CONCLUSIONS.has(runConclusionValue)) {
    return admissionDecision('genuine-failure', ['run-failed'], {
      event: runEventValue,
      terminal: true,
      complete: false,
    });
  }

  if (runConclusionValue !== SUCCESS_CONCLUSION) {
    return admissionDecision('api-error', ['run-conclusion-unknown'], {
      event: runEventValue,
      terminal: true,
      complete: false,
    });
  }

  const operationalEvidence = isOperationalSkipEvidence(run, jobs);
  if (operationalEvidence.incidentMarked) {
    return admissionDecision('operational-skip', ['incident-skip'], {
      event: runEventValue,
      terminal: true,
      complete: false,
      skippedContexts: operationalEvidence.skippedJobs,
      operationalMarker: operationalEvidence.marker,
    });
  }

  if (runEventValue !== 'pull_request' && !Array.isArray(jobs)) {
    return admissionDecision('ordinary-push-main', ['non-pull-request-run'], {
      event: runEventValue,
      terminal: true,
      complete: false,
    });
  }

  if (!Array.isArray(jobs)) {
    return admissionDecision('api-error', ['jobs-unavailable'], {
      event: runEventValue,
      terminal: true,
      complete: false,
    });
  }

  if (operationalEvidence.allJobsSkipped) {
    return admissionDecision(
      'operational-skip',
      [runEventValue === 'pull_request' ? 'required-context-skipped' : 'incident-skip'],
      {
        event: runEventValue,
        terminal: true,
        complete: false,
        skippedContexts: operationalEvidence.skippedJobs,
        operationalMarker: operationalEvidence.marker,
      },
    );
  }

  if (jobs.length === 0) {
    return admissionDecision('zero-job', ['zero-job'], {
      event: runEventValue,
      terminal: true,
      complete: false,
    });
  }

  if (runEventValue !== 'pull_request') {
    return admissionDecision('ordinary-push-main', ['non-pull-request-run'], {
      event: runEventValue,
      terminal: true,
      complete: false,
    });
  }

  const names = jobs.map(jobName);
  const requiredNames = new Set(REQUIRED_CHECK_NAMES);
  const malformedJobs = jobs
    .map((job, index) => (jobName(job) === null ? index : null))
    .filter((index) => index !== null);
  const duplicateContexts = names.filter(
    (name, index) => name !== null && requiredNames.has(name) && names.indexOf(name) !== index,
  );
  const observedNames = new Set(names.filter((name) => name !== null));
  const missingContexts = REQUIRED_CHECK_NAMES.filter((name) => !observedNames.has(name));
  const requiredJobs = jobs.filter((job) => {
    const name = jobName(job);
    return name !== null && requiredNames.has(name);
  });
  if (missingContexts.length > 0 || duplicateContexts.length > 0 || malformedJobs.length > 0) {
    const reasonCodes = [];
    if (missingContexts.length > 0) reasonCodes.push('partial-roster');
    if (duplicateContexts.length > 0) reasonCodes.push('duplicate-context');
    if (malformedJobs.length > 0) reasonCodes.push('malformed-roster');
    return admissionDecision('partial-roster', reasonCodes, {
      event: runEventValue,
      terminal: true,
      complete: false,
      missingContexts,
      duplicateContexts: [...new Set(duplicateContexts)],
      malformedJobs,
    });
  }

  const skippedContexts = requiredJobs
    .filter((job) => jobConclusion(job) === 'skipped')
    .map((job) => jobName(job));
  if (skippedContexts.length > 0) {
    return admissionDecision('operational-skip', ['required-context-skipped'], {
      event: runEventValue,
      terminal: true,
      complete: false,
      skippedContexts,
    });
  }

  const failedContextSet = new Set(
    requiredJobs
      .filter((job) => FAILURE_CONCLUSIONS.has(jobConclusion(job)))
      .map((job) => jobName(job)),
  );
  const failedContexts = REQUIRED_CHECK_NAMES.filter((name) => failedContextSet.has(name));
  const unknownContexts = requiredJobs
    .filter((job) => {
      const conclusion = jobConclusion(job);
      return conclusion !== SUCCESS_CONCLUSION && !FAILURE_CONCLUSIONS.has(conclusion);
    })
    .map((job) => jobName(job));
  if (unknownContexts.length > 0) {
    return admissionDecision('api-error', ['required-context-conclusion-missing'], {
      event: runEventValue,
      terminal: true,
      complete: false,
      unknownContexts,
    });
  }
  if (failedContexts.length > 0) {
    return admissionDecision('genuine-failure', ['required-context-failed'], {
      event: runEventValue,
      terminal: true,
      complete: false,
      failedContexts,
    });
  }

  return admissionDecision('normal-ci-run', ['required-roster-complete'], {
    event: runEventValue,
    terminal: true,
    complete: true,
    observedContexts: REQUIRED_CHECK_NAMES,
  });
}

/**
 * @param {Array<{event:string, createdAt?:string}>} runs
 * @returns {{event:string, createdAt?:string}|null}
 */
export function pickLatestPullRequestRun(runs) {
  const pullRequestRuns = (Array.isArray(runs) ? runs : []).filter(
    (run) => runEvent(run) === 'pull_request',
  );
  if (pullRequestRuns.length === 0) return null;
  return pullRequestRuns.reduce((latest, run) => {
    const latestCreatedAt = latest.createdAt ?? latest.created_at ?? '';
    const runCreatedAt = run.createdAt ?? run.created_at ?? '';
    return runCreatedAt > latestCreatedAt ? run : latest;
  });
}

function fetchRuns(repo, sha) {
  const output = execFileSync(
    'gh',
    [
      'api',
      '--method',
      'GET',
      `repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${sha}&event=pull_request&per_page=100`,
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(output).workflow_runs ?? [];
}

function fetchJobs(repo, run) {
  const runId = run?.id ?? run?.run_id ?? run?.database_id;
  if (runId === undefined || runId === null) {
    throw new Error('ci.yml run is missing its immutable run id');
  }
  const attempt = run.run_attempt ?? run.runAttempt ?? 1;
  const output = execFileSync(
    'gh',
    [
      'api',
      '--method',
      'GET',
      `repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
    ],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed.jobs)) throw new Error('ci.yml jobs response is not an array');
  return parsed.jobs;
}

function createPassedCheck(repo, sha, name) {
  execFileSync(
    'gh',
    [
      'api',
      '--method',
      'POST',
      `repos/${repo}/check-runs`,
      '-f',
      `name=${name}`,
      '-f',
      `head_sha=${sha}`,
      '-f',
      'status=completed',
      '-f',
      'conclusion=success',
      '-f',
      'output[title]=CI path filter skipped',
      '-f',
      'output[summary]=ci.yml did not run because this pull request changed no CI-scoped paths.',
    ],
    { stdio: 'inherit' },
  );
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function inspectRun(repo, run) {
  let jobs = null;
  let apiError = null;
  const runConclusion = normalizedString(run.conclusion ?? run.run_conclusion);
  if (normalizedString(run.status ?? run.runStatus ?? run.run_status) === TERMINAL_RUN_STATUS) {
    if (runConclusion === SUCCESS_CONCLUSION) {
      try {
        jobs = fetchJobs(repo, run);
      } catch (error) {
        apiError = error;
      }
    }
  }
  return classifyRequiredContextAdmission({ run, jobs, apiError });
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.PR_HEAD_SHA;
  if (!repo || !sha) {
    console.error(
      'required-ci-checks: missing GITHUB_REPOSITORY or PR_HEAD_SHA — cannot determine whether ci.yml ran.',
    );
    process.exit(2);
  }

  const appearanceTimeoutMilliseconds = Number(process.env.CI_RUN_APPEAR_MS ?? 120_000);
  const pollMilliseconds = Number(process.env.CI_RUN_POLL_MS ?? 15_000);
  const appearanceDeadline = Date.now() + appearanceTimeoutMilliseconds;

  while (Date.now() < appearanceDeadline) {
    let run;
    try {
      run = pickLatestPullRequestRun(fetchRuns(repo, sha));
    } catch (error) {
      const decision = classifyRequiredContextAdmission({ apiError: error });
      console.error(
        `required-ci-checks: ${decision.status} (${decision.reasonCodes.join(', ')}) — ${error.message ?? error}`,
      );
      process.exit(2);
    }

    if (run !== null) {
      const decision = inspectRun(repo, run);
      if (decision.status === 'normal-ci-run') {
        console.log(
          `required-ci-checks: ci.yml ran for ${sha}; required-context status=${decision.status}.`,
        );
        return;
      }
      console.error(
        `required-ci-checks: ${decision.status} (${decision.reasonCodes.join(', ')}); no fallback checks emitted.`,
      );
      process.exit(2);
    }

    console.log(
      `required-ci-checks: waiting for ci.yml to appear for ${sha} (${appearanceTimeoutMilliseconds / 1000}s grace)…`,
    );
    await sleep(pollMilliseconds);
  }

  let run;
  try {
    run = pickLatestPullRequestRun(fetchRuns(repo, sha));
  } catch (error) {
    const decision = classifyRequiredContextAdmission({ apiError: error });
    console.error(
      `required-ci-checks: ${decision.status} (${decision.reasonCodes.join(', ')}) — ${error.message ?? error}`,
    );
    process.exit(2);
  }

  if (run !== null) {
    const decision = inspectRun(repo, run);
    if (decision.status === 'normal-ci-run') {
      console.log(
        `required-ci-checks: ci.yml ran for ${sha}; required-context status=${decision.status}.`,
      );
      return;
    }
    console.error(
      `required-ci-checks: ${decision.status} (${decision.reasonCodes.join(', ')}); no fallback checks emitted.`,
    );
    process.exit(2);
  }

  const pathFiltered = process.env.CI_PATH_FILTERED === 'true';
  const decision = classifyRequiredContextAdmission({ run, pathFiltered });
  if (!decision.fallbackEligible) {
    console.error(
      `required-ci-checks: ${decision.status} (${decision.reasonCodes.join(', ')}); no fallback checks emitted.`,
    );
    process.exit(2);
  }

  for (const name of REQUIRED_CHECK_NAMES) {
    try {
      createPassedCheck(repo, sha, name);
    } catch (error) {
      console.error(`required-ci-checks: failed to create ${name} — ${error.message ?? error}`);
      process.exit(2);
    }
  }

  console.log(
    `required-ci-checks: ci.yml was path-filtered; emitted ${REQUIRED_CHECK_NAMES.length} passes.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
