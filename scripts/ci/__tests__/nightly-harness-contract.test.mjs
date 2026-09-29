import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/nightly.yml'), 'utf8');
const harnessSync = readFileSync(resolve('scripts/sync-harness.mjs'), 'utf8');

function jobSection(name) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing ${name}`);
  const remaining = workflow.slice(start);
  const nextJob = remaining.slice(1).search(/\n {2}[a-z][\w-]+:/);
  return remaining.slice(0, nextJob === -1 ? undefined : nextJob + 1);
}

test('nightly materializes the authenticated harness before documentation tests', () => {
  const smokeJob = jobSection('smoke-browser-dawn');
  const install = smokeJob.indexOf('- name: Install (frozen)');
  const materialize = smokeJob.indexOf('- name: Materialize harness documentation');
  const dawn = smokeJob.indexOf('- name: Vitest dawn project');
  assert.ok(install >= 0, 'missing nightly install step');
  assert.ok(materialize > install, 'harness must materialize after install');
  assert.ok(dawn > materialize, 'harness must materialize before tests');

  const setup = smokeJob.slice(install, materialize);
  const harness = smokeJob.slice(materialize, dawn);
  assert.match(setup, /FORGEAX_SKIP_HARNESS_SYNC: ['"]1['"]/);
  assert.match(setup, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(setup, /--ignore-scripts/);
  assert.match(
    setup,
    /- name: Prepare Dawn device-limit normalization[\s\S]*?uses: \.\/\.github\/actions\/prepare-dawn-device-limits/,
  );
  assert.match(harness, /shell: bash/);
  assert.match(harness, /FORGEAX_HARNESS_TOKEN: \$\{\{ secrets\.GHA \}\}/);
  assert.match(harness, /FORGEAX_HARNESS_SPARSE_DOCS: ['"]1['"]/);
  assert.match(harness, /node scripts\/ci\/materialize-harness-docs\.mjs/);
  assert.match(
    smokeJob,
    /- name: Setup Node\.js for WASM hydration[\s\S]*?package-manager-cache: false/,
  );
  assert.doesNotMatch(smokeJob, /Setup Node\.js \(non-Linux upstream\)/);
  assert.match(smokeJob, /NODE_OPTIONS: --max-old-space-size=4096/);
});

test('nightly bounds harness documentation recovery to the shared retry helper', () => {
  const smokeJob = jobSection('smoke-browser-dawn');
  const materialize = smokeJob.indexOf('- name: Materialize harness documentation');
  const dawn = smokeJob.indexOf('- name: Vitest dawn project');
  const harness = smokeJob.slice(materialize, dawn);
  assert.match(harness, /node scripts\/ci\/materialize-harness-docs\.mjs/);
  assert.doesNotMatch(harness, /sleep|while true|for attempt/);
});

test('sparse harness sync skips the clone checkout before applying docs patterns', () => {
  assert.match(harnessSync, /'--filter=blob:none', '--sparse', '--no-checkout'/);
  assert.match(harnessSync, /'sparse-checkout', 'set', 'docs'/);
  assert.match(harnessSync, /git\(\['read-tree', '-mu', 'HEAD'\]/);
});

test('nightly Metal native boundary restores its pinned wgpu source before Cargo gates', () => {
  const metalJob = jobSection('native-ray-query-metal-build');
  const node = metalJob.indexOf('- name: Setup Node.js');
  const wgpu = metalJob.indexOf('- name: Restore pinned wgpu checkout');
  const install = metalJob.indexOf('- name: Install workspace dependencies');
  const cargo = metalJob.indexOf('- name: Verify Metal native owner');

  assert.ok(node >= 0, 'Metal job must provision Node for checkout recovery');
  assert.ok(wgpu > node, 'wgpu checkout must wait for Node');
  assert.ok(install > wgpu, 'dependency installation must see the pinned wgpu source');
  assert.ok(cargo > install, 'Cargo gates must run after wgpu restoration');
  assert.match(metalJob.slice(wgpu, install), /node scripts\/ci\/prepare-wgpu-checkout\.mjs/);
});
