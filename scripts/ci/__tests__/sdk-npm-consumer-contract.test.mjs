import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const preflight = readFileSync(resolve('scripts/forgeax/check-sdk-npm-consumer.mjs'), 'utf8');

test('SDK npm consumer preflight keeps the real install isolated and diagnosable', () => {
  assert.match(preflight, /const npmCache = resolve\(temporaryRoot, '\.npm-cache'\)/);
  assert.match(preflight, /'--cache',\s*npmCache/);
  assert.match(preflight, /npm_config_cache: npmCache/);
  assert.match(preflight, /phase: 'npm-install'/);
  assert.match(preflight, /requestCount: registryRequests\.length/);
  assert.match(preflight, /toolchain: \{ node: process\.version, npm: npmVersion \}/);
});

test('PR and release consumer gates install the same pinned npm before consuming SDKs', () => {
  const version = readFileSync(resolve('.npm-version'), 'utf8').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  for (const name of ['sdk-pr-preflight.yml', 'sdk-release.yml']) {
    const workflow = readFileSync(resolve('.github/workflows', name), 'utf8');
    const setup = workflow.indexOf('npm install --global "npm@$(cat .npm-version)"');
    const consume = workflow.indexOf('pnpm sdk:check:npm');
    assert.ok(setup >= 0 && consume > setup, `${name}: pin npm before SDK install`);
    assert.doesNotMatch(workflow, /--legacy-peer-deps/);
  }
  const preflight = readFileSync(resolve('.github/workflows/sdk-pr-preflight.yml'), 'utf8');
  assert.match(preflight, /- '\.npm-version'/);
});
