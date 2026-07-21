import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';

function cgroupCpuLimit(read) {
  const v2 = read('/sys/fs/cgroup/cpu.max');
  if (v2) {
    const [quota, period] = v2.split(/\s+/);
    if (quota !== 'max' && Number(quota) > 0 && Number(period) > 0)
      return Number(quota) / Number(period);
  }
  const quota = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  const period = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
  return quota > 0 && period > 0 ? quota / period : null;
}

function cgroupMemoryLimit(read, hostMemoryBytes) {
  const raw =
    read('/sys/fs/cgroup/memory.max') ?? read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const bytes = raw === 'max' || raw === null ? null : Number(raw);
  return Number.isFinite(bytes) && bytes > 0 && bytes < hostMemoryBytes ? bytes : null;
}

/**
 * Uses cgroup quota and memory when a runner is containerized. Node otherwise
 * reports the CVM host resources, which is correct for direct CVM runners but
 * can grossly overstate a CPU container's usable capacity.
 */
export function runnerResources({
  availableParallelism = os.availableParallelism?.() ?? os.cpus().length,
  hostMemoryBytes = os.totalmem(),
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  const read = (path) => (exists(path) ? readFile(path, 'utf8').trim() : null);
  const cpuQuota = cgroupCpuLimit(read);
  const memoryLimit = cgroupMemoryLimit(read, hostMemoryBytes);
  return {
    cpus: Math.max(1, Math.floor(Math.min(availableParallelism, cpuQuota ?? availableParallelism))),
    memoryBytes: memoryLimit ?? hostMemoryBytes,
    containerized: cpuQuota !== null || memoryLimit !== null,
  };
}

export function workspaceConcurrency({ cpus, memoryBytes, reserveGB, workerGB }) {
  const memoryGB = Math.ceil(memoryBytes / 1024 ** 3);
  const memoryBudget = Math.max(1, Math.floor((memoryGB - reserveGB) / workerGB));
  return Math.max(1, Math.min(cpus - 1, memoryBudget));
}
