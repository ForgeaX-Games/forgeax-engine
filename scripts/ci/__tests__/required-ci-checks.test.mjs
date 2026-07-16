import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { pickLatestPullRequestRun, REQUIRED_CHECK_NAMES } from '../required-ci-checks.mjs';

const scriptPath = fileURLToPath(new URL('../required-ci-checks.mjs', import.meta.url));

const run = (values) => ({
  event: 'pull_request',
  createdAt: '2026-07-15T00:00:00Z',
  ...values,
});

test('lists the exact direct CI contexts selected for the ruleset', () => {
  assert.deepEqual(REQUIRED_CHECK_NAMES, [
    'build-artifacts',
    'primary-pnpm',
    'vitest-browser',
    'smoke-fleet',
    'vitest-dawn',
    'webkit-fallback',
    'portability-bun',
    'metrics-validate',
    'collectathon-boot-e2e',
  ]);
});

test('returns null when ci.yml has no pull request run for the head SHA', () => {
  assert.equal(pickLatestPullRequestRun([]), null);
  assert.equal(pickLatestPullRequestRun(undefined), null);
  assert.equal(pickLatestPullRequestRun([run({ event: 'push' })]), null);
});

test('selects the newest pull request ci.yml run', () => {
  const newest = run({ createdAt: '2026-07-15T00:01:00Z' });
  assert.equal(
    pickLatestPullRequestRun([run({ createdAt: '2026-07-15T00:00:00Z' }), newest]),
    newest,
  );
});

function runWithFakeGitHub(runs) {
  const root = mkdtempSync(join(tmpdir(), 'required-ci-checks-'));
  const callLog = join(root, 'calls');
  const fakeGh = join(root, 'gh');
  writeFileSync(
    fakeGh,
    [
      '#!/bin/sh',
      'if [ "$1" = "run" ]; then printf "%s" "$GH_RUN_LIST_JSON"; exit 0; fi',
      'printf "%s\\n" "$*" >> "$GH_CALL_LOG"',
      'printf "{}"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  try {
    execFileSync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        CI_RUN_APPEAR_MS: '0',
        GH_CALL_LOG: callLog,
        GH_RUN_LIST_JSON: JSON.stringify(runs),
        GITHUB_REPOSITORY: 'ForgeaX-Games/forgeax-engine',
        PATH: `${root}:${process.env.PATH}`,
        PR_HEAD_SHA: 'deadbeef',
      },
      stdio: 'pipe',
    });
    try {
      return readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

test('does not create duplicate required contexts when ci.yml ran', () => {
  assert.deepEqual(runWithFakeGitHub([run({})]), []);
});

test('creates one passed direct context for every required check when ci.yml was skipped', () => {
  const calls = runWithFakeGitHub([]);
  assert.equal(calls.length, REQUIRED_CHECK_NAMES.length);
  for (const name of REQUIRED_CHECK_NAMES) {
    assert.ok(
      calls.some((call) => call.includes(`name=${name}`)),
      `missing ${name}`,
    );
  }
});
