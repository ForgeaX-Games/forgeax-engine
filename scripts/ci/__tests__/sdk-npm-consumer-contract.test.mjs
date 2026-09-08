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
