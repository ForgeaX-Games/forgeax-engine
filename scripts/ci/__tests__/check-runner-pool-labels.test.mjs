import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { checkWorkflowDirectory, checkWorkflowText } from '../check-runner-pool-labels.mjs';

const repoRoot = resolve(new URL('../../..', import.meta.url).pathname);

test('all repository workflow runner selectors satisfy the pool contract', () => {
  const result = checkWorkflowDirectory(resolve(repoRoot, '.github/workflows'));
  assert.deepEqual(result.errors, []);
  const selfHosted = result.selectors.filter((selector) => selector.kind === 'self-hosted');
  assert.ok(selfHosted.length > 0);
  assert.ok(selfHosted.every((selector) => ['standard', 'heavy'].includes(selector.pool)));
  assert.ok(result.selectors.some((selector) => selector.kind === 'github-hosted'));
});

test('rejects a self-hosted selector without a pool label', () => {
  const result = checkWorkflowText(
    'jobs:\n  bench:\n    runs-on: [self-hosted, Linux, X64]\n',
    'bench.yml',
  );
  assert.match(result.errors[0], /exactly one of standard or heavy/);
});

test('rejects a self-hosted selector carrying both pool labels', () => {
  const result = checkWorkflowText(
    'jobs:\n  bench:\n    runs-on: [self-hosted, Linux, X64, standard, heavy]\n',
    'bench.yml',
  );
  assert.match(result.errors[0], /found standard, heavy/);
});

test('accepts the nightly GitHub-hosted matrix', () => {
  const result = checkWorkflowText(
    [
      'jobs:',
      '  smoke:',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - runner: \'"ubuntu-latest"\'',
      '          - runner: \'"macos-latest"\'',
      '    runs-on: $' + '{{ fromJSON(matrix.runner) }}',
    ].join('\n'),
    'nightly.yml',
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.selectors[0].kind, 'github-hosted');
});

test('rejects a dynamic matrix that can select self-hosted without a pool', () => {
  const result = checkWorkflowText(
    [
      'jobs:',
      '  smoke:',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - runner: \'"self-hosted"\'',
      '    runs-on: $' + '{{ fromJSON(matrix.runner) }}',
    ].join('\n'),
    'nightly.yml',
  );
  assert.match(result.errors[0], /dynamic self-hosted runner selection/);
});

test('rejects a job without a runner selector or reusable workflow', () => {
  const result = checkWorkflowText('jobs:\n  orphan:\n    timeout-minutes: 5\n', 'broken.yml');
  assert.match(result.errors[0], /must declare runs-on or use a reusable workflow/);
});

test('the required workflow invokes the pool contract against PR-head definitions', () => {
  const workflow = readFileSync(
    resolve(repoRoot, '.github/workflows/required-ci-checks.yml'),
    'utf8',
  );
  assert.match(workflow, /Validate self-hosted runner pool labels/);
  assert.match(workflow, /--workflows-dir pr-head\/\.github\/workflows/);
});
