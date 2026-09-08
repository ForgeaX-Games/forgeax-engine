import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function dryRunGroups() {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/ci/run-split-vitest-browser.mjs',
      '--dry-run',
      '--group-size=4',
      '--shard-count=1',
      '--shard-index=0',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(': ') + 2).split(', '));
}

test('preview browser owners are isolated from ordinary bounded groups', () => {
  const groups = dryRunGroups();
  const previewGroup = groups.find((group) =>
    group.some((file) => file.startsWith('apps/preview/')),
  );
  assert.ok(previewGroup);
  assert.ok(previewGroup.length > 1);
  assert.ok(previewGroup.every((file) => file.startsWith('apps/preview/')));

  const regularGroups = groups.filter((group) => group !== previewGroup);
  assert.ok(regularGroups.every((group) => group.length <= 4));

  const files = groups.flat();
  assert.equal(new Set(files).size, files.length, 'a browser test may belong to only one group');
});

test('advanced lighting browser owners share a dedicated process boundary', () => {
  const groups = dryRunGroups();
  const advancedLighting = groups.filter((group) =>
    group.some((file) => file.startsWith('apps/learn-render/5.advanced-lighting/')),
  );
  assert.equal(advancedLighting.length, 4);

  const lifecycleHeavy = advancedLighting.filter((group) =>
    group.some((file) =>
      /apps\/learn-render\/5\.advanced-lighting\/(?:6\.hdr|7\.bloom|8\.deferred-shading|9\.ssao)\//.test(
        file,
      ),
    ),
  );
  assert.equal(lifecycleHeavy.length, 2);
  assert.deepEqual(
    lifecycleHeavy.map((group) => group.length).sort((left, right) => left - right),
    [1, 3],
  );
  const bloomGroup = lifecycleHeavy.find((group) =>
    group.some((file) => file.includes('/7.bloom/')),
  );
  assert.deepEqual(
    bloomGroup?.map((file) => file.includes('/7.bloom/')),
    [true],
  );

  const processIsolated = groups.filter((group) =>
    group.some(
      (file) =>
        file === 'packages/app/__tests__/thin-wrapper.browser.test.ts' ||
        file === 'packages/app/__tests__/worker-resize.browser.test.ts' ||
        file === 'packages/runtime/src/__tests__/render-feature-prepared-graphics.browser.test.ts',
    ),
  );
  assert.equal(processIsolated.length, 3);
  assert.ok(processIsolated.every((group) => group.length === 1));
});
