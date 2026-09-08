import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatCpuList,
  parseCpuList,
  resolveRunnerCpuAffinity,
} from '../run-with-runner-cpu-affinity.mjs';

test('parses and formats Linux CPU lists', () => {
  assert.deepEqual(parseCpuList('0-3,8,10-11'), [0, 1, 2, 3, 8, 10, 11]);
  assert.equal(formatCpuList([0, 1, 2, 3, 8, 10, 11]), '0-3,8,10-11');
});

test('rejects malformed CPU lists', () => {
  assert.deepEqual(parseCpuList('0-3,wat'), []);
  assert.deepEqual(parseCpuList('3-1'), []);
});

test('selects the cgroup CPU budget from the process allowed set', () => {
  const result = resolveRunnerCpuAffinity({
    platform: 'linux',
    resources: { cpus: 8, containerized: true },
    allowedCpus: parseCpuList('4-7,12-19'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'taskset');
  assert.equal(result.selectedCpuList, '4-7,12-15');
});

test('fails closed when the allowed set cannot satisfy the cgroup budget', () => {
  const result = resolveRunnerCpuAffinity({
    platform: 'linux',
    resources: { cpus: 8, containerized: true },
    allowedCpus: parseCpuList('0-3'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cpuset-smaller-than-cgroup-quota');
});

test('does not alter a direct host runner', () => {
  const result = resolveRunnerCpuAffinity({
    platform: 'linux',
    resources: { cpus: 8, containerized: false },
    allowedCpus: parseCpuList('0-95'),
  });
  assert.deepEqual(result, {
    ok: true,
    mode: 'none',
    reason: 'host-runner-no-cgroup',
    runnerCpus: 8,
    containerized: false,
    allowedCpuCount: 96,
    allowedCpuList: '0-95',
  });
});
