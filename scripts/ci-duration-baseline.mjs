#!/usr/bin/env node
// CI duration baseline reporter (feat-20260512 M7 / AC-14 / D-2 soft target).
//
// Fetches the last >= 8 completed runs of ci.yml on main from the GitHub
// Actions API and emits a JSON object with the median run duration in
// seconds. Consumed by sticky-comment / release-notes to show
// `baseline median: <N>s | this PR: <M>s | delta: <±X>s`. Soft target — does
// NOT gate PR merge (requirements §OOS-5).
//
// Auth: uses GITHUB_TOKEN if set (GH_TOKEN as fallback); otherwise hits the
// unauthenticated endpoint (the forgeax-engine repo is public). Zero npm
// deps; stdlib only.
//
// Usage:
//   node scripts/ci-duration-baseline.mjs            # human-readable summary + JSON
//   node scripts/ci-duration-baseline.mjs --json     # machine-readable JSON only
//   OWNER=foo REPO=bar node scripts/ci-duration-baseline.mjs

import process from 'node:process';

const OWNER = process.env.OWNER || 'ForgeaX-Games';
const REPO = process.env.REPO || 'forgeax-engine';
const WORKFLOW = process.env.WORKFLOW || 'ci.yml';
const PER_PAGE = 20;
const MIN_SAMPLE = 8;

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function fetchRuns() {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?branch=main&status=completed&per_page=${PER_PAGE}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'forgeax-ci-duration-baseline',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${res.statusText} for ${url}`);
  }
  const data = await res.json();
  return data.workflow_runs || [];
}

function durationMs(run) {
  // Prefer run_duration_ms (sum of job durations); fall back to wallclock diff
  // if the field is absent (older API responses or unauthenticated rate-limit).
  if (typeof run.run_duration_ms === 'number' && run.run_duration_ms > 0) {
    return run.run_duration_ms;
  }
  if (run.created_at && run.updated_at) {
    return new Date(run.updated_at).getTime() - new Date(run.created_at).getTime();
  }
  return null;
}

async function main() {
  const jsonOnly = process.argv.includes('--json');
  let runs;
  try {
    runs = await fetchRuns();
  } catch (err) {
    process.stderr.write(`[ci-duration-baseline] FAIL: ${err.message}\n`);
    process.exit(1);
  }
  const durations = runs
    .map((r) => ({ id: r.id, htmlUrl: r.html_url, durationMs: durationMs(r) }))
    .filter((r) => typeof r.durationMs === 'number' && r.durationMs > 0);
  if (durations.length < MIN_SAMPLE) {
    process.stderr.write(
      `[ci-duration-baseline] WARN: only ${durations.length} samples available (min=${MIN_SAMPLE})\n`,
    );
  }
  const med = median(durations.map((d) => d.durationMs));
  const out = {
    owner: OWNER,
    repo: REPO,
    workflow: WORKFLOW,
    sampleSize: durations.length,
    medianMs: med,
    medianSeconds: med == null ? null : Math.round(med / 1000),
    latestRuns: durations.slice(0, MIN_SAMPLE).map((d) => ({
      id: d.id,
      htmlUrl: d.htmlUrl,
      durationSeconds: Math.round(d.durationMs / 1000),
    })),
  };
  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  const minSec = out.medianSeconds;
  const human = minSec == null ? 'n/a' : `${Math.floor(minSec / 60)}m${minSec % 60}s (${minSec}s)`;
  process.stdout.write(
    `[ci-duration-baseline] ${OWNER}/${REPO}::${WORKFLOW} branch=main sample=${out.sampleSize} median=${human}\n`,
  );
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main();
