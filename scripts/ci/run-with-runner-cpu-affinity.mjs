#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runnerResources } from '../lib/runner-resources.mjs';

const PROC_STATUS = '/proc/self/status';

/**
 * Expand Linux's Cpus_allowed_list representation without trusting the
 * machine label. The benchmark only binds to CPUs that the runner process is
 * already allowed to use.
 */
export function parseCpuList(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  const cpus = [];
  for (const token of value.trim().split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token.trim());
    if (!match) return [];
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return [];
    for (let cpu = start; cpu <= end; cpu += 1) cpus.push(cpu);
  }
  return [...new Set(cpus)].sort((left, right) => left - right);
}

export function formatCpuList(cpus) {
  if (!Array.isArray(cpus) || cpus.length === 0) return '';
  const sorted = [...new Set(cpus)]
    .filter((cpu) => Number.isSafeInteger(cpu) && cpu >= 0)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return '';
  const ranges = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const cpu of sorted.slice(1)) {
    if (cpu === previous + 1) {
      previous = cpu;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = previous = cpu;
  }
  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(',');
}

export function readAllowedCpuList({ read = (path) => readFileSync(path, 'utf8') } = {}) {
  let status;
  try {
    status = read(PROC_STATUS);
  } catch {
    return [];
  }
  const match = /^Cpus_allowed_list:\s*(\S+)\s*$/m.exec(status);
  return parseCpuList(match?.[1] ?? '');
}

export function resolveRunnerCpuAffinity({
  platform = process.platform,
  resources = runnerResources(),
  allowedCpus = readAllowedCpuList(),
} = {}) {
  const common = {
    runnerCpus: resources.cpus,
    containerized: resources.containerized,
    allowedCpuCount: allowedCpus.length,
    allowedCpuList: formatCpuList(allowedCpus),
  };
  if (platform !== 'linux') {
    return { ok: true, mode: 'none', reason: 'non-linux-runner', ...common };
  }
  if (!resources.containerized) {
    return { ok: true, mode: 'none', reason: 'host-runner-no-cgroup', ...common };
  }
  if (!Number.isInteger(resources.cpus) || resources.cpus < 1) {
    return { ok: false, mode: 'fail-closed', reason: 'runner-cpu-capacity-unavailable', ...common };
  }
  if (allowedCpus.length < resources.cpus) {
    return {
      ok: false,
      mode: 'fail-closed',
      reason: 'cpuset-smaller-than-cgroup-quota',
      ...common,
    };
  }
  const selectedCpus = allowedCpus.slice(0, resources.cpus);
  return {
    ok: true,
    mode: 'taskset',
    reason: 'bind-to-cgroup-cpu-budget',
    selectedCpuCount: selectedCpus.length,
    selectedCpuList: formatCpuList(selectedCpus),
    ...common,
  };
}

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator !== 0 || separator === argv.length - 1)
    throw new Error('usage: run-with-runner-cpu-affinity.mjs -- <command> [args...]');
  return argv.slice(separator + 1);
}

function run(command, affinity) {
  const env = {
    ...process.env,
    FORGEAX_RUNNER_CPU_AFFINITY: JSON.stringify(affinity),
  };
  const childCommand = affinity.mode === 'taskset' ? 'taskset' : command[0];
  const childArgs =
    affinity.mode === 'taskset'
      ? ['--cpu-list', affinity.selectedCpuList, ...command]
      : command.slice(1);
  const child = spawn(childCommand, childArgs, { env, stdio: 'inherit' });
  child.once('error', (error) => {
    process.stderr.write(`[runner-affinity] failed to start ${childCommand}: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('close', (status, signal) => {
    if (status !== null) process.exitCode = status;
    else process.exitCode = 1;
    if (signal) process.stderr.write(`[runner-affinity] child terminated by ${signal}\n`);
  });
}

function main(argv) {
  const command = parseArgs(argv);
  const affinity = resolveRunnerCpuAffinity();
  process.stdout.write(`[runner-affinity] ${JSON.stringify(affinity)}\n`);
  if (!affinity.ok) {
    process.stderr.write(`[runner-affinity] refusing an unqualified runner\n`);
    process.exitCode = 1;
    return;
  }
  run(command, affinity);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[runner-affinity] ${error.message}\n`);
    process.exitCode = 1;
  }
}
