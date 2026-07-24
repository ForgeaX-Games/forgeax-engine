import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
const benchWorkflow = readFileSync(resolve('.github/workflows/bench.yml'), 'utf8');
const requiredWorkflow = readFileSync(resolve('.github/workflows/required-ci-checks.yml'), 'utf8');
const postMergeMonitor = readFileSync(resolve('.github/workflows/post-merge-monitor.yml'), 'utf8');
const requiredChecks = readFileSync(resolve('.github/workflows/required-ci-checks.yml'), 'utf8');
const collectathonSmoke = readFileSync(
  resolve('apps/collectathon/scripts/smoke-browser.mjs'),
  'utf8',
);

function jobSection(name) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing ${name}`);
  const remaining = workflow.slice(start);
  const nextJob = remaining.slice(1).search(/\n {2}[a-z][\w-]+:/);
  return remaining.slice(0, nextJob === -1 ? undefined : nextJob + 1);
}

test('private-repository CI has one trusted runner/control path', () => {
  assert.doesNotMatch(workflow, /IS_FORK_PR/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.repo\.full_name/);
  assert.doesNotMatch(workflow, /github-hosted-linux-x64/);
  assert.doesNotMatch(workflow, /fork PR/i);
  assert.match(
    jobSection('coverage-pnpm'),
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64"\]'\) \}\}/,
  );
  assert.doesNotMatch(jobSection('coverage-pnpm'), /github\.event\.pull_request/);
});

test('coverage and perf ownership are not duplicated in primary-pnpm', () => {
  const primary = jobSection('primary-pnpm');
  assert.doesNotMatch(primary, /Vitest unit/);
  assert.doesNotMatch(primary, /vitest-unit-out\.json/);
  assert.doesNotMatch(primary, /--project=ecs-perf/);
  assert.match(jobSection('coverage-pnpm'), /Vitest coverage \(v8\) \+ typecheck/);
  assert.match(jobSection('coverage-pnpm'), /ECS performance ratio gates \(uninstrumented\)/);
});

test('required-checks retains PR-head validation as an input, not a fork guard', () => {
  assert.match(
    requiredChecks,
    /repository: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/,
  );
  assert.match(requiredChecks, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
});

test('collectathon browser boot uses the trusted Linux WebGPU capability', () => {
  const collectathon = jobSection('collectathon-boot-e2e');
  assert.match(
    collectathon,
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "ubuntu"\]'\) \}\}/,
  );
  assert.doesNotMatch(collectathon, /macos-latest/);
  assert.match(collectathon, /install-mesa-vulkan-drivers/);
  assert.match(collectathon, /install-playwright-chrome-beta/);
  assert.match(collectathon, /FORGEAX_CHROME_CHANNEL: chrome-beta/);
  assert.match(collectathon, /FORGEAX_COLLECTATHON_OFFSCREEN: ['"]1['"]/);
  assert.match(collectathonSmoke, /chromeChannel === 'chrome-beta'/);
  assert.match(collectathonSmoke, /FORGEAX_COLLECTATHON_OFFSCREEN/);
  assert.match(collectathonSmoke, /device\.createTexture/);
  assert.match(collectathonSmoke, /--use-vulkan=swiftshader/);
  assert.match(collectathonSmoke, /--disable-vulkan-surface/);
});

test('CI preserves in-flight evidence across newer commits', () => {
  for (const [name, source] of [
    ['ci', workflow],
    ['bench', benchWorkflow],
    ['required-ci-checks', requiredWorkflow],
    ['post-merge-monitor', postMergeMonitor],
  ]) {
    assert.doesNotMatch(
      source,
      /cancel-in-progress:\s*true/,
      `${name} must not preempt prior runs`,
    );
    assert.match(source, /cancel-in-progress:\s*false/, `${name} must declare preserve semantics`);
  }
});

test('post-merge issue lookup retries transient GitHub API transport failures', () => {
  const start = postMergeMonitor.indexOf('  - name: List existing open post-merge issues');
  assert.notEqual(start, -1, 'missing post-merge issue lookup step');
  const section = postMergeMonitor.slice(start);
  const nextStep = section.slice(1).search(/\n {6}- name:/);
  const lookup = section.slice(0, nextStep === -1 ? undefined : nextStep + 1);
  assert.match(lookup, /retries: 3/);
  assert.match(lookup, /retry-exempt-status-codes: 400,401,403,404,422/);
});
