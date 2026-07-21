import assert from 'node:assert/strict';
import test from 'node:test';

import { runnerResources, workspaceConcurrency } from '../lib/runner-resources.mjs';

function probe(files, hostMemoryBytes = 64 * 1024 ** 3, availableParallelism = 32) {
  return runnerResources({
    hostMemoryBytes,
    availableParallelism,
    exists: (path) => path in files,
    readFile: (path) => files[path],
  });
}

test('uses cgroup v2 CPU and memory limits for CPU containers', () => {
  const result = probe({
    '/sys/fs/cgroup/cpu.max': '400000 100000',
    '/sys/fs/cgroup/memory.max': String(8 * 1024 ** 3),
  });
  assert.deepEqual(result, { cpus: 4, memoryBytes: 8 * 1024 ** 3, containerized: true });
});

test('uses cgroup v1 CPU and memory limits for CPU containers', () => {
  const result = probe({
    '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '200000',
    '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(4 * 1024 ** 3),
  });
  assert.deepEqual(result, { cpus: 2, memoryBytes: 4 * 1024 ** 3, containerized: true });
});

test('uses host resources on direct CVM runners', () => {
  const result = probe({
    '/sys/fs/cgroup/cpu.max': 'max 100000',
    '/sys/fs/cgroup/memory.max': 'max',
  });
  assert.deepEqual(result, { cpus: 32, memoryBytes: 64 * 1024 ** 3, containerized: false });
});

test('leaves one CPU free while fitting workers in nominal memory', () => {
  assert.equal(
    workspaceConcurrency({ cpus: 4, memoryBytes: 8_000_000_000, reserveGB: 2, workerGB: 2 }),
    3,
  );
});
