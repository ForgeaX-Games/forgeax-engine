import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { pickLatestPullRequestRun, REQUIRED_CHECK_NAMES } from '../required-ci-checks.mjs';

const scriptPath = fileURLToPath(new URL('../required-ci-checks.mjs', import.meta.url));
const workflowPath = resolve(
  fileURLToPath(new URL('../../..', import.meta.url)),
  '.github/workflows/required-ci-checks.yml',
);

const run = (values) => ({
  event: 'pull_request',
  createdAt: '2026-07-15T00:00:00Z',
  ...values,
});

test('lists the exact direct CI contexts selected for the ruleset', () => {
  assert.deepEqual(REQUIRED_CHECK_NAMES, [
    'build-artifacts',
    'primary-pnpm',
    'coverage-pnpm',
    'vitest-browser',
    'shared-inputs-browser',
    'smoke-fleet',
    'smoke-fleet-0',
    'smoke-fleet-1',
    'smoke-fleet-2',
    'bevy-smoke-fleet',
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
      'case " $* " in *" --repo "*) exit 1;; esac',
      'if [ "$1" = "api" ] && [ "$3" = "GET" ]; then printf "{\\"workflow_runs\\":%s}" "$GH_RUN_LIST_JSON"; exit 0; fi',
      'if [ "$1" = "api" ] && [ "$3" = "POST" ]; then printf "%s\\n" "$*" >> "$GH_CALL_LOG"; printf "{}"; exit 0; fi',
      'exit 1',
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

test('installs the reporter prerequisites before running the required-context reporter', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const setupNode = workflow.indexOf('uses: actions/setup-node@v5');
  const setupPnpm = workflow.indexOf('uses: pnpm/action-setup@v5');
  const installGh = workflow.indexOf('command -v gh >/dev/null');
  const reporter = workflow.indexOf('run: node scripts/ci/required-ci-checks.mjs');

  assert.equal(setupPnpm, -1, 'required-ci-checks must not install unused pnpm');
  assert.ok(setupNode >= 0, 'required-ci-checks must install Node explicitly');
  assert.ok(installGh >= 0, 'required-ci-checks must ensure gh is available explicitly');
  assert.ok(reporter >= 0, 'required-ci-checks must run the reporter script');
  assert.ok(setupNode < reporter, 'Node setup must precede the reporter script');
  assert.ok(installGh < reporter, 'gh setup must precede the reporter script');
  assert.match(
    workflow,
    /uses: actions\/setup-node@v5\s+with:\s+node-version-file: \.nvmrc\s+package-manager-cache: false/,
    'the reporter-only Node setup must not save an unused pnpm cache',
  );
});

test('validates PR-head workflows with pinned actionlint before synthetic passes', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const checkoutHead = workflow.indexOf('name: Checkout PR-head workflow definitions');
  const installActionlint = workflow.indexOf('name: Install pinned actionlint');
  const runActionlint = workflow.indexOf('name: Validate PR-head workflow definitions');
  const reporter = workflow.indexOf('run: node scripts/ci/required-ci-checks.mjs');

  assert.ok(checkoutHead >= 0, 'admission must read workflow definitions from the PR head');
  assert.match(
    workflow,
    /repository: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/,
  );
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /path: pr-head/);
  assert.match(
    workflow,
    /sparse-checkout:\s+\|\s+\.github\/workflows\s+\.github\/actionlint\.yaml/,
  );
  assert.ok(
    installActionlint > checkoutHead,
    'pinned actionlint installs after the isolated checkout',
  );
  assert.match(workflow, /rhysd\/actionlint[^\n]*v1\.7\.12/);
  assert.ok(runActionlint > installActionlint, 'actionlint runs after its pinned install');
  assert.ok(reporter > runActionlint, 'synthetic required passes are impossible before actionlint');
  assert.match(workflow, /working-directory: pr-head/);
});

// t7: don't-break — build-artifacts remains a required context name after M2
test('t7: REQUIRED_CHECK_NAMES includes build-artifacts as required context', () => {
  assert.ok(
    REQUIRED_CHECK_NAMES.includes('build-artifacts'),
    'build-artifacts must be in REQUIRED_CHECK_NAMES after M2 workflow split',
  );
});

test('t7: REQUIRED_CHECK_NAMES includes every direct CI gate', () => {
  assert.strictEqual(
    REQUIRED_CHECK_NAMES.length,
    15,
    'REQUIRED_CHECK_NAMES must include the legacy smoke aggregate and matrix gates',
  );
});
