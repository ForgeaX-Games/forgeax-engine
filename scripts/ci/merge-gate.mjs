#!/usr/bin/env node
// merge-gate.mjs — the single always-run required check for main-branch PRs.
//
// Why this exists: ci.yml is `paths:`-filtered (scripts/ci/paths.json SSOT), so
// docs/skill/rules-only PRs never trigger it. A `required_status_checks` rule
// naming ci.yml's jobs would leave those PRs permanently blocked ("waiting for
// status to be reported"). This gate runs on EVERY PR (no path filter) and emits
// one required check that reflects ci.yml's real conclusion when CI ran, and
// passes fast when path filters legitimately skipped it — deadlock-free by
// construction. The ruleset requires only this one check, so it stays stable as
// ci.yml jobs are split/renamed.
//
// Authority = GitHub's own path-filter decision: we do NOT re-implement glob
// matching against paths.json (a wrong matcher could deadlock a docs PR or, worse,
// wave through an ungated code PR). Instead we ask GitHub whether a ci.yml run was
// created for this PR head SHA. No run after a short grace ⇒ CI was skipped ⇒ pass.
//
// Decision semantics mirror the finalizer self-gate poll
// (forgeax-harness .../forgeax-step-finalize/agents/finalizer.md Step 5):
//   any fail/cancel ⇒ block · any still-running ⇒ wait · all success ⇒ pass.
//
// Env (set by merge-gate.yml):
//   GH_TOKEN   — token for `gh` (github.token)
//   GITHUB_REPOSITORY   — owner/repo
//   PR_HEAD_SHA         — github.event.pull_request.head.sha (NOT github.sha,
//                         which on pull_request is the ephemeral merge commit)
// Tunables (env, defaults chosen for near-instant run registration):
//   MERGE_GATE_APPEAR_MS  — grace for a ci.yml run to appear (default 120000)
//   MERGE_GATE_TIMEOUT_MS — max wait for the run to conclude (default 1800000)
//   MERGE_GATE_POLL_MS    — poll interval (default 15000)

import { execFileSync } from 'node:child_process';
import process from 'node:process';

const CI_WORKFLOW = 'ci.yml';

// Conclusions that must block a merge. Anything not here and not `success`
// (e.g. skipped/neutral) is treated as non-blocking pass-through.
const BLOCKING_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'startup_failure',
  'action_required',
  'stale',
]);

/**
 * Pick the authoritative ci.yml pull_request run for this head SHA, or null.
 * A re-run that goes green must win over a stale failed row → newest createdAt.
 *
 * @param {Array<{event:string, createdAt?:string, databaseId?:number}>} runs
 *   Raw `gh run list --workflow=ci.yml --commit=<sha>` rows.
 * @returns {{event:string, createdAt?:string, databaseId?:number}|null}
 */
export function pickLatestRun(runs) {
  const prRuns = (runs ?? []).filter((r) => r.event === 'pull_request');
  if (prRuns.length === 0) return null;
  return prRuns.reduce((a, b) => ((b.createdAt ?? '') > (a.createdAt ?? '') ? b : a));
}

/**
 * Classify an authoritative run from its run-level status/conclusion AND its
 * per-job rows. Pure + deadlock-critical → unit-tested.
 *
 * Why job-level and not just run-level: GitHub occasionally zombifies a run —
 * the run wrapper stays `status:queued` while its jobs are force-cancelled by
 * runner-pool starvation (observed 2026-07-09: jobs cancelled with empty runner
 * names while the run never left `queued`). Reading run-level status alone hangs
 * until timeout. A cancelled/failed ci.yml genuinely did NOT pass, so we detect
 * it fast from the jobs instead of waiting the run out.
 *
 * @param {{status:string, conclusion:string|null}} run  run-level state
 * @param {Array<{status:string, conclusion:string|null}>} jobs  per-job rows
 * @returns {'pass'|'fail'|'pending'}
 */
export function classifyRun(run, jobs) {
  // Run-level completion is authoritative when GitHub actually sets it.
  if (run.status === 'completed') {
    return BLOCKING_CONCLUSIONS.has(run.conclusion ?? '') ? 'fail' : 'pass';
  }
  // Run not marked complete: fail fast if ANY job has already reached a blocking
  // terminal state (the zombie / early-cancel signal). Never INFER pass from
  // jobs — the job list grows through the run (build-artifacts completes before
  // downstream jobs are even created), so "all jobs done" is only trustworthy
  // once the run wrapper says completed, handled above.
  if (
    (jobs ?? []).some(
      (j) => j.status === 'completed' && BLOCKING_CONCLUSIONS.has(j.conclusion ?? ''),
    )
  ) {
    return 'fail';
  }
  return 'pending';
}

function fetchRuns(repo, sha) {
  const out = execFileSync(
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
      'status,conclusion,event,createdAt,databaseId',
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

function fetchJobs(repo, runId) {
  const out = execFileSync('gh', ['run', 'view', '--repo', repo, String(runId), '--json', 'jobs'], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  return (parsed.jobs ?? []).map((j) => ({ status: j.status, conclusion: j.conclusion }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.PR_HEAD_SHA;
  if (!repo || !sha) {
    // Fail Fast (arch principle #5): missing wiring must not silently pass.
    console.error(
      'merge-gate: missing GITHUB_REPOSITORY or PR_HEAD_SHA — cannot locate the ci.yml run to gate on.',
    );
    process.exit(2);
  }

  const appearMs = Number(process.env.MERGE_GATE_APPEAR_MS ?? 120_000);
  const timeoutMs = Number(process.env.MERGE_GATE_TIMEOUT_MS ?? 1_800_000);
  const pollMs = Number(process.env.MERGE_GATE_POLL_MS ?? 15_000);

  const start = Date.now();
  const appearDeadline = start + appearMs;
  const concludeDeadline = start + timeoutMs;

  let seen = false;
  while (Date.now() < concludeDeadline) {
    let run;
    try {
      run = pickLatestRun(fetchRuns(repo, sha));
    } catch (err) {
      // gh auth / network / API errors are infra failures, not "CI passed".
      console.error(`merge-gate: gh run list failed — ${err.message ?? err}`);
      process.exit(2);
    }

    if (run === null) {
      // No ci.yml run exists for this SHA yet.
      if (!seen && Date.now() >= appearDeadline) {
        console.log(
          `merge-gate: no ci.yml run for ${sha} after ${appearMs / 1000}s — path filters skipped CI, nothing to gate. Merge allowed.`,
        );
        process.exit(0);
      }
      console.log(
        `merge-gate: waiting for a ci.yml run to appear for ${sha} (grace ${appearMs / 1000}s)…`,
      );
      await sleep(pollMs);
      continue;
    }

    seen = true;
    let jobs = [];
    try {
      jobs = fetchJobs(repo, run.databaseId);
    } catch (err) {
      // Non-fatal: fall back to run-level classification (jobs default []).
      console.log(
        `merge-gate: could not read jobs for run ${run.databaseId} — ${err.message ?? err}`,
      );
    }

    const verdict = classifyRun(run, jobs);
    if (verdict === 'pass') {
      console.log(`merge-gate: ci.yml succeeded for ${sha} — merge allowed.`);
      process.exit(0);
    }
    if (verdict === 'fail') {
      console.error(
        `merge-gate: ci.yml did not succeed for ${sha} — merge blocked. Re-run or fix CI.`,
      );
      process.exit(1);
    }
    console.log(`merge-gate: ci.yml run in progress for ${sha} — waiting ${pollMs / 1000}s…`);
    await sleep(pollMs);
  }

  console.error(
    `merge-gate: ci.yml did not conclude for ${sha} within ${timeoutMs / 1000}s — merge blocked (timeout).`,
  );
  process.exit(1);
}

// Only run the poll loop when invoked directly; importing for tests must not poll.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
