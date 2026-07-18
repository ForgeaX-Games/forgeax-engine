#!/usr/bin/env node
// required-ci-checks.mjs — emits direct required checks when ci.yml is path-filtered.
//
// ci.yml intentionally ignores docs/skill/rules-only pull requests. GitHub rulesets
// require named checks to be reported for every PR, so this workflow asks GitHub
// whether ci.yml created a pull_request run for the head SHA. If it did not, it
// writes successful check runs for the same direct CI contexts; if it did, ci.yml
// itself owns those contexts. We do not evaluate paths.json here: GitHub's actual
// workflow scheduling decision is the SSOT.

import { execFileSync } from 'node:child_process';
import process from 'node:process';

const CI_WORKFLOW = 'ci.yml';

export const REQUIRED_CHECK_NAMES = [
  'build-artifacts',
  'primary-pnpm',
  'vitest-browser',
  'smoke-fleet',
  'vitest-dawn',
  'webkit-fallback',
  'portability-bun',
  'metrics-validate',
  'collectathon-boot-e2e',
];

/**
 * @param {Array<{event:string, createdAt?:string}>} runs
 * @returns {{event:string, createdAt?:string}|null}
 */
export function pickLatestPullRequestRun(runs) {
  const pullRequestRuns = (runs ?? []).filter((run) => run.event === 'pull_request');
  if (pullRequestRuns.length === 0) return null;
  return pullRequestRuns.reduce((latest, run) =>
    (run.createdAt ?? '') > (latest.createdAt ?? '') ? run : latest,
  );
}

function fetchRuns(repo, sha) {
  const output = execFileSync(
    'gh',
    [
      'run',
      'list',
      '--repo',
      repo,
      '--workflow',
      CI_WORKFLOW,
      '--commit',
      sha,
      '--json',
      'event,createdAt',
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(output);
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
      console.error(`required-ci-checks: cannot list ci.yml runs — ${error.message ?? error}`);
      process.exit(2);
    }

    if (run !== null) {
      console.log(`required-ci-checks: ci.yml ran for ${sha}; its jobs own the required contexts.`);
      return;
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
    console.error(`required-ci-checks: cannot list ci.yml runs — ${error.message ?? error}`);
    process.exit(2);
  }

  if (run !== null) {
    console.log(`required-ci-checks: ci.yml ran for ${sha}; its jobs own the required contexts.`);
    return;
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
