import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..', '..');
const action = readFileSync(
  resolve(root, '.github/actions/prepare-xdg-runtime/action.yml'),
  'utf8',
);

const workflowJobs = new Map([
  [
    '.github/workflows/ci.yml',
    [
      'primary-pnpm',
      'coverage-pnpm-shard',
      'directional-csm-browser',
      'vitest-browser-shard',
      'shared-inputs-browser',
      'multithread-browser-benchmark',
      'smoke-fleet',
      'bevy-smoke-fleet',
      'vitest-dawn',
      'webkit-fallback',
      'metrics-validate-browser',
      'metrics-validate-runtime',
      'metrics-validate',
      'collectathon-boot-e2e',
    ],
  ],
  ['.github/workflows/nightly.yml', ['smoke-browser-dawn']],
  ['.github/workflows/gpu-pass-timing-real-gpu.yml', ['gpu-pass-timing-benchmark']],
  ['.github/workflows/native-ray-query.yml', ['native-ray-query-contract']],
  ['.github/workflows/sdk-pr-preflight.yml', ['build-sdk']],
  ['.github/workflows/sdk-release-candidate.yml', ['archive-browser', 'collision']],
]);

function jobBlock(workflow, job) {
  const start = workflow.search(new RegExp(`^  ${job}:\\s*$`, 'm'));
  assert.notEqual(start, -1, `missing jobs.${job}`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^ {2}[a-zA-Z0-9_-]+:\s*$/m);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

test('shared XDG runtime action creates a private Linux directory and exports it', () => {
  assert.match(action, /using: composite/);
  assert.match(action, /if: runner\.os == 'Linux'/);
  assert.match(action, /mktemp -d/);
  assert.match(action, /chmod 700/);
  assert.match(action, /test -w/);
  assert.match(action, /XDG_RUNTIME_DIR=%s\\n.*GITHUB_ENV/);
});

test('every CI GPU or headed-browser producer prepares XDG before its carrier', () => {
  for (const [relativePath, jobs] of workflowJobs) {
    const workflow = readFileSync(resolve(root, relativePath), 'utf8');
    for (const job of jobs) {
      const block = jobBlock(workflow, job);
      const prepare = block.indexOf('uses: ./.github/actions/prepare-xdg-runtime');
      assert.notEqual(prepare, -1, `${relativePath} jobs.${job} must prepare XDG_RUNTIME_DIR`);
      const checkout = block.indexOf('actions/checkout@');
      assert.ok(checkout < prepare, `${relativePath} jobs.${job} prepares XDG after checkout`);
      const firstCarrier = block.search(
        /(xvfb-run|vitest run --project=dawn|run-direct-light-dawn|smoke:browser|smoke:desktop|smoke:templates)/,
      );
      assert.ok(
        firstCarrier === -1 || prepare < firstCarrier,
        `${relativePath} jobs.${job} prepares XDG before its carrier`,
      );
    }
  }
});
