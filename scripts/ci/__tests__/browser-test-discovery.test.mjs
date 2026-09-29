import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { browserTestFiles } from '../run-split-vitest-browser.mjs';

test('actual Vitest discovery matches every Engine browser owner and excludes external experiments', () => {
  assert.ok(
    process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST,
    'Run after shared app inputs are prepared; discovery must not cold-cook Engine shaders.',
  );
  const target =
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts';
  const discovery = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'list',
      '--config',
      'config/vitest.browser.config.ts',
      '--project=browser',
      '--filesOnly',
      '--json',
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(discovery.status, 0, discovery.stderr);
  const files = JSON.parse(discovery.stdout).map(({ file }) =>
    file.replace(`${process.cwd()}/`, ''),
  );
  assert.deepEqual(files.sort(), [...browserTestFiles(), target].sort());
});

test('actual Vitest discovery refuses a browser test in the floating harness', () => {
  assert.ok(process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST);
  const harness = join(process.cwd(), '.forgeax-harness');
  mkdirSync(harness, { recursive: true });
  const directory = mkdtempSync(join(harness, 'browser-discovery-regression-'));
  const target = relative(process.cwd(), join(directory, 'probe.browser.test.ts'));
  try {
    writeFileSync(target, "import { it } from 'vitest'; it('harness experiment', () => {});\n");
    const discovery = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'list',
        '--config',
        'config/vitest.browser.config.ts',
        '--project=browser',
        target,
        '--filesOnly',
        '--json',
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(discovery.status, 0, discovery.stderr);
    assert.deepEqual(JSON.parse(discovery.stdout), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
