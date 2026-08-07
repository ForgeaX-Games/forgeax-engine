import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/nightly.yml'), 'utf8');

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
  assert.match(harness, /shell: bash/);
  assert.match(harness, /FORGEAX_HARNESS_TOKEN: \$\{\{ secrets\.GHA \}\}/);
  assert.match(harness, /FORGEAX_HARNESS_SPARSE_DOCS: ['"]1['"]/);
  assert.match(harness, /pnpm harness:sync/);
  for (const document of [
    'material-asset-migration.md',
    'vfx-particle-runtime-design.md',
    'reports/2026-08-03-black-screen-diagnosis-review.md',
  ]) {
    assert.match(harness, new RegExp(`test -f \\.forgeax-harness/docs/${document}`));
  }
});
