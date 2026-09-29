import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..', '..');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const runner = readFileSync(resolve(root, 'scripts/ci/run-dawn-smoke-roster.mjs'), 'utf8');

test('workflow derives expected product SHA from the event head', () => {
  assert.match(workflow, /EXPECTED_PRODUCT_SHA/);
  assert.match(workflow, /github\.event\.pull_request\.head\.sha/);
  assert.match(workflow, /github\.sha/);
});

test('all roster invocations receive the external expected product SHA', () => {
  assert.match(workflow, /run-dawn-smoke-roster\.mjs --run[\s\S]*--expected-product-sha/);
  assert.match(workflow, /run-dawn-smoke-roster\.mjs --aggregate[\s\S]*--expected-product-sha/);
  assert.match(runner, /expectedProductSha/);
  assert.match(runner, /rev-parse/);
});

test('build and consumer checkouts use the same external product identity', () => {
  assert.match(workflow, /ref: \$\{\{ env\.EXPECTED_PRODUCT_SHA \}\}/);
  assert.match(workflow, /engineSha: process\.env\.EXPECTED_PRODUCT_SHA/);
  assert.match(runner, /run requires a full external expectedProductSha/);
  assert.match(runner, /aggregate requires a full external expectedProductSha/);
});

test('runner does not use its own HEAD as the expected identity', () => {
  assert.match(runner, /expectedProductSha/);
  assert.doesNotMatch(runner, /expectedProductSha\s*=\s*readHead/);
});
