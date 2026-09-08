import assert from 'node:assert/strict';
import test from 'node:test';

import { runGroups } from '../run-split-vitest-coverage.mjs';

test('runs coverage groups at the requested bound and preserves result order', async () => {
  let active = 0;
  let peak = 0;
  const completed = [];
  const groups = [['slow'], ['fast'], ['middle'], ['last']];
  const delays = [30, 5, 15, 1];

  const results = await runGroups({
    groups,
    concurrency: 2,
    runGroupImpl: async (group, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delays[index]));
      active -= 1;
      completed.push(group[0]);
      return `${group[0]}-result`;
    },
  });

  assert.equal(peak, 2);
  assert.notDeepEqual(completed, groups.flat());
  assert.deepEqual(
    results,
    groups.map(([name]) => `${name}-result`),
  );
});

test('stops scheduling new groups after the first failure', async () => {
  const started = [];

  await assert.rejects(
    runGroups({
      groups: [['fail'], ['in-flight'], ['must-not-start'], ['also-must-not-start']],
      concurrency: 2,
      runGroupImpl: async ([name]) => {
        started.push(name);
        if (name === 'fail') throw new Error('expected failure');
        await new Promise((resolve) => setTimeout(resolve, 10));
        return name;
      },
    }),
    /expected failure/,
  );

  assert.deepEqual(started, ['fail', 'in-flight']);
});
