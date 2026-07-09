// merge-gate.test.mjs — regression guard for the deadlock-critical decisions in
// scripts/ci/merge-gate.mjs. These two pure functions are the one place a bug
// could either (a) permanently block every docs-only PR, or (b) wave through a
// red code PR. The poll loop around them is plumbing; this covers the logic.
//
// Usage: node --test scripts/ci/__tests__/merge-gate.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyRun, pickLatestRun } from '../merge-gate.mjs';

const runRow = (o) => ({
  event: 'pull_request',
  createdAt: '2026-07-09T10:00:00Z',
  databaseId: 1,
  ...o,
});
const job = (status, conclusion) => ({ status, conclusion });

// ---- pickLatestRun --------------------------------------------------------

test('no runs at all → null (caller applies appearance grace, then passes)', () => {
  assert.equal(pickLatestRun([]), null);
  assert.equal(pickLatestRun(undefined), null);
});

test('only non-pull_request runs (push/schedule) → null — never gate on the wrong event', () => {
  assert.equal(pickLatestRun([runRow({ event: 'push' })]), null);
});

test('picks the newest attempt by createdAt (re-run wins over stale row)', () => {
  const runs = [
    runRow({ databaseId: 1, createdAt: '2026-07-09T10:00:00Z' }),
    runRow({ databaseId: 2, createdAt: '2026-07-09T11:00:00Z' }),
  ];
  assert.equal(pickLatestRun(runs).databaseId, 2);
});

// ---- classifyRun: run-level completion is authoritative -------------------

test('run completed + success → pass', () => {
  assert.equal(classifyRun({ status: 'completed', conclusion: 'success' }, []), 'pass');
});

for (const c of [
  'failure',
  'cancelled',
  'timed_out',
  'startup_failure',
  'action_required',
  'stale',
]) {
  test(`run completed + ${c} → fail`, () => {
    assert.equal(classifyRun({ status: 'completed', conclusion: c }, []), 'fail');
  });
}

test('run completed + neutral/skipped → pass (non-blocking)', () => {
  assert.equal(classifyRun({ status: 'completed', conclusion: 'skipped' }, []), 'pass');
  assert.equal(classifyRun({ status: 'completed', conclusion: 'neutral' }, []), 'pass');
});

// ---- classifyRun: zombie run (status stuck, jobs terminal) ----------------

test('run stuck queued but a job already cancelled → fail fast (the 2026-07-09 zombie)', () => {
  const jobs = [job('completed', 'success'), job('completed', 'cancelled')];
  assert.equal(classifyRun({ status: 'queued', conclusion: null }, jobs), 'fail');
});

test('run in_progress + a job failed → fail fast', () => {
  const jobs = [job('completed', 'success'), job('completed', 'failure')];
  assert.equal(classifyRun({ status: 'in_progress', conclusion: null }, jobs), 'fail');
});

test('run in_progress + jobs all still running or passed → pending (keep waiting)', () => {
  const jobs = [job('completed', 'success'), job('in_progress', null)];
  assert.equal(classifyRun({ status: 'in_progress', conclusion: null }, jobs), 'pending');
});

test('run queued + no jobs yet → pending (do not infer pass from an empty job list)', () => {
  assert.equal(classifyRun({ status: 'queued', conclusion: null }, []), 'pending');
});

test('run in_progress + only some jobs finished green → pending (job list grows through the run)', () => {
  // build-artifacts completes before downstream jobs are even created; "all
  // present jobs green" must NOT short-circuit to pass while the run is live.
  const jobs = [job('completed', 'success')];
  assert.equal(classifyRun({ status: 'in_progress', conclusion: null }, jobs), 'pending');
});
