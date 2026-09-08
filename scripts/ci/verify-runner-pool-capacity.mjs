#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerResources } from '../lib/runner-resources.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));

export function assessRunnerPoolCapacity(pool, resources, capacityPools) {
  const expected = capacityPools[pool];
  if (expected === undefined) {
    return {
      ok: false,
      code: 'ci-runner-pool-unknown',
      expected: Object.keys(capacityPools),
      actual: pool,
      hint: 'Use a capacity pool declared by full-run-terminal-slo-contract.json.',
    };
  }
  const actual = {
    vcpus: resources.cpus,
    memoryBytes: resources.memoryBytes,
    source: resources.containerized ? 'cgroup' : 'host',
  };
  const minimum = {
    vcpus: expected.vcpus,
    memoryBytes: expected.memoryGiB * 1_000_000_000,
  };
  if (actual.vcpus < minimum.vcpus || actual.memoryBytes < minimum.memoryBytes) {
    return {
      ok: false,
      code: 'ci-runner-pool-capacity-mismatch',
      pool,
      expected: minimum,
      actual,
      hint: `Remove the ${pool} label from this runner or repair its container quota before retrying.`,
    };
  }
  return { ok: true, pool, expected: minimum, actual };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function main() {
  const pool = argument('--pool');
  const configuredContractPath = argument('--contract');
  const contractPath =
    configuredContractPath === null
      ? resolve(here, 'full-run-terminal-slo-contract.json')
      : resolve(configuredContractPath);
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const result = assessRunnerPoolCapacity(pool, runnerResources(), contract.capacityPools);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
