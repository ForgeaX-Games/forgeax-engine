import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const run = (...args) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ['scripts/ci/run-view-integration.mjs', '--candidate', ...args],
      { cwd: root, encoding: 'utf8' },
    ),
  );

test('required groups cover the complete consumer roster once and retain publication order', () => {
  const groups = run('--list-groups');
  const all = run('--dry-run');
  const grouped = groups.flatMap((group) =>
    run('--group', group, '--dry-run').filter(([owner]) => owner !== 'prepare'),
  );
  const key = (value) => JSON.stringify(value);
  assert.deepEqual(
    grouped.map(key).sort(),
    all
      .filter(([owner]) => owner !== 'prepare')
      .map(key)
      .sort(),
  );
  assert.equal(new Set(grouped.map(key)).size, grouped.length);
  for (const probe of [
    'verify-diagnostic-pages',
    'verify-engine-without-view',
    'verify-owner-surface-resize',
    'verify-page-plugin-lifecycle',
    'verify-engine-plugin-boundary',
    'verify-startup-boundaries',
    'verify-game3d-workspace',
    'verify-workspace-experience',
    'verify-view-panels-falsifier',
  ]) {
    assert.ok(
      all.some(([, , args]) => args.some((arg) => arg.endsWith(`${probe}.mjs`))),
      probe,
    );
  }
  assert.ok(all.some(([, , args]) => args.includes('--inject-legacy-history')));
  const plugin = run('--group', 'plugin', '--dry-run').filter(([owner]) => owner !== 'prepare');
  assert.equal(plugin.length, 1, 'the original complete ten-cycle probe remains one process');
  assert.equal(plugin[0][3], undefined, 'no cycle, frame, native-window or identity override');
  for (const language of ['js', 'ts']) {
    const stages = run('--group', `runtime-${language}`, '--dry-run').filter(
      ([owner]) => owner !== 'prepare',
    );
    assert.equal(stages.length, 2);
    assert.ok(stages.every((stage) => stage[3].FORGEAX_ENGINE_CHECKOUT === root));
    assert.equal(stages[0][3].FORGEAX_RUNTIME_PACK_LANGUAGE, language);
    assert.equal(stages[0][3].FORGEAX_RUNTIME_PACK_SNAPSHOT, '');
    assert.equal(
      stages[1][3].FORGEAX_RUNTIME_PACK_SNAPSHOT,
      resolve(stages[0][3].FORGEAX_EVIDENCE_DIR, 'saved-content.json'),
    );
  }
  const game3d = all.find(([, , args]) => args[0]?.endsWith('verify-game3d-workspace.mjs'));
  assert.equal(game3d[3].FORGEAX_ENGINE_CHECKOUT, root);
  assert.equal(game3d[3].FORGEAX_LOCAL_ENGINE, '1');
});

test('unknown groups fail instead of silently omitting required probes', () => {
  assert.throws(
    () => run('--group', 'missing', '--dry-run'),
    (error) => String(error.stderr).includes('unknown-view-integration-group:missing'),
  );
});

test('paired shards retain parent authorization for pinned private asset recovery', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const section = workflow.match(
    /^ {2}view-integration-shards:\n[\s\S]*?(?=^ {2}view-integration:)/m,
  )?.[0];
  assert.ok(section);
  const checkouts = section
    .split('      - uses: actions/checkout@v5')
    .slice(1)
    .map((step) => step.split(/\n {6}- /)[0]);
  assert.equal(checkouts.length, 2);
  assert.match(checkouts[0], /token: \$\{\{ secrets\.GHA \}\}/);
  assert.match(checkouts[0], /persist-credentials: true/);
  assert.match(checkouts[1], /path: tools\/view/);
  assert.match(checkouts[1], /persist-credentials: false/);
  assert.match(section, /Restore pinned assets for source recovery/);
});

test('four CI shards preserve every complete group and publication ordering', () => {
  const shards = run('--list-shards');
  assert.deepEqual(shards, [0, 1, 2, 3]);
  const all = run('--dry-run').filter(([owner]) => owner !== 'prepare');
  const partitioned = shards.map((shard) =>
    run('--shard', String(shard), '--dry-run').filter(([owner]) => owner !== 'prepare'),
  );
  assert.deepEqual(
    partitioned
      .flat()
      .map((value) => JSON.stringify(value))
      .sort(),
    all.map((value) => JSON.stringify(value)).sort(),
  );
  assert.ok(partitioned[2].some(([owner]) => owner === 'runtime-ts'));
  assert.ok(!partitioned[3].some(([owner]) => owner === 'runtime-ts'));
  for (const owner of run('--list-groups')) {
    const assigned = partitioned.filter((steps) => steps.some(([group]) => group === owner));
    assert.equal(assigned.length, 1, owner);
    assert.deepEqual(
      assigned[0].filter(([group]) => group === owner),
      all.filter(([group]) => group === owner),
    );
  }
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /shard: \$\{\{ fromJSON\(needs.core-build.outputs.view_shards\) \}\}/);
  assert.match(workflow, /--shard "\$\{\{ matrix.shard \}\}"/);
  assert.match(
    workflow,
    /xvfb-run -a node scripts\/ci\/run-with-runner-cpu-affinity\.mjs -- pnpm test:view/,
  );
  assert.throws(() => run('--shard', '4', '--dry-run'));
  assert.throws(() => run('--shard', '0', '--group', 'contracts', '--dry-run'));
});

test('CI paired consumers select the shared View workload while ordinary commands retain their defaults', () => {
  const all = JSON.parse(
    execFileSync(
      process.execPath,
      ['scripts/ci/run-view-integration.mjs', '--candidate', '--dry-run'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CI: 'true' } },
    ),
  );
  const selected = all.filter((step) => step[3]?.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1');
  assert.equal(selected.length, 1);
  assert.equal(selected[0][0], 'diagnostics');
  assert.equal(selected[0][2][0], 'tools/view-plugins/integration/verify-diagnostic-pages.mjs');
  for (const [owner, , , env] of all)
    if (owner !== 'diagnostics') assert.equal(env?.FORGEAX_BROWSER_CI_LIGHTWEIGHT, undefined);
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const section = workflow.match(
    /^ {2}view-integration-shards:\n[\s\S]*?(?=^ {2}view-integration:)/m,
  )?.[0];
  assert.ok(section);
  assert.match(section, /FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1'/);
});
