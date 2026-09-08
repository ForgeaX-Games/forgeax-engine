import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/nightly.yml'), 'utf8');

function jobSection(name) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing ${name}`);
  const remaining = workflow.slice(start);
  const nextJob = remaining.slice(1).search(/\n {2}[a-z][\w-]+:/);
  return remaining.slice(0, nextJob === -1 ? undefined : nextJob + 1);
}

test('nightly failure issue records failed jobs and deduplicates reruns', () => {
  const section = jobSection('notify-failure');
  assert.match(section, /if: failure\(\)/);
  assert.match(section, /issues: write/);
  assert.match(section, /actions: read/);
  assert.match(section, /retries: 3/);
  assert.match(section, /github\.rest\.actions\.listJobsForWorkflowRun/);
  assert.match(section, /\*\*failed jobs \/ steps\*\*:/);
  assert.match(section, /\*\*nightly run id\*\*:/);
  assert.match(section, /process\.env\.GITHUB_RUN_ATTEMPT/);
  assert.doesNotMatch(section, /context\.runAttempt/);
  assert.match(section, /github\.rest\.issues\.listForRepo/);
  assert.match(section, /updated existing nightly issue/);
  assert.match(section, /github\.rest\.issues\.create/);
});

test('nightly coverage checkout keeps the historical sibling-gate baseline', () => {
  const checkout = workflow.slice(
    workflow.indexOf('      - name: Checkout\n'),
    workflow.indexOf('      - name: Setup Rust toolchain\n'),
  );
  assert.match(
    checkout,
    /fetch-depth: 0/,
    'nightly must retain the historical commit used by the sibling ancestry gate',
  );
});

test('nightly uses the canonical package graph and declaration preflight', () => {
  const section = jobSection('smoke-browser-dawn');
  const start = section.indexOf(
    '      - name: Build (.mjs + .d.ts, packages only — apps tested from source)',
  );
  assert.notEqual(start, -1, 'missing nightly package build step');
  const end = section.indexOf('\n      - name:', start + 1);
  const build = section.slice(start, end === -1 ? undefined : end);
  assert.match(build, /FORGEAX_BUILD_NO_TASK_CACHE: ['"]1['"]/);
  assert.match(build, /node scripts\/build-packages\.mjs/);
  assert.match(build, /node scripts\/typecheck-output-preflight\.mjs/);
  assert.match(build, /pnpm exec tsc -b/);
  assert.ok(
    build.indexOf('typecheck-output-preflight') < build.indexOf('pnpm exec tsc -b'),
    'declaration preflight must run before the final typecheck',
  );
  assert.doesNotMatch(build, /pnpm -r --filter=/);
});

test('nightly success closes only machine-tracked issues with proof', () => {
  const section = jobSection('notify-success');
  assert.match(section, /needs: \[smoke-browser-dawn, native-ray-query-metal-build\]/);
  assert.match(
    section,
    /needs\.smoke-browser-dawn\.result == 'success'.*needs\.native-ray-query-metal-build\.result == 'success'/s,
  );
  assert.match(section, /issues: write/);
  assert.match(section, /\*\*nightly run id\*\*:/);
  assert.match(section, /state: 'closed'/);
  assert.match(section, /\*\*scenario\*\*: nightly-green/);
});
