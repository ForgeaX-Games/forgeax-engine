import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { test } from 'node:test';
import { BaseSequencer } from 'vitest/node';
import { DAWN_COMPACT_TEST_FILES } from '../dawn-compact-roster.mjs';
import { DAWN_GATE_GROUPS, DAWN_GATE_SHARDS } from '../dawn-gate-roster.mjs';
import {
  dawnVitestArgs,
  selectDawnGroups,
  selectDawnShard,
  validateDawnGateRoster,
} from '../run-dawn-gate.mjs';

const root = resolve('.');
const selectors = ['FORGEAX_DAWN_ISOLATED', 'FORGEAX_DAWN_COMPACT', 'FORGEAX_DAWN_PARTITION'];

function listDawnFiles(extraEnv = {}) {
  const env = { ...process.env };
  for (const key of selectors) delete env[key];
  const output = execFileSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'list', '--project=dawn', '--filesOnly', '--json'],
    { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60_000 },
  );
  return JSON.parse(output)
    .map(({ file }) => relative(root, file).replaceAll('\\', '/'))
    .sort();
}

test('actual Vitest discovery conserves every Dawn file across execution groups', () => {
  const owners = validateDawnGateRoster();
  const ordinary = listDawnFiles();
  assert.ok(ordinary.length > 0, 'the ordinary gate must execute tests');
  const all = listDawnFiles({
    FORGEAX_DAWN_ISOLATED: '1',
    FORGEAX_DAWN_COMPACT: '1',
    FORGEAX_DAWN_PARTITION: 'roster-audit',
  });
  for (const file of ordinary) assert.ok(!owners.has(file), `duplicate ordinary owner: ${file}`);
  const planned = [...ordinary, ...owners.keys()].sort();
  assert.deepEqual(planned, all, 'every discovered file must execute exactly once');
});

test('each group keeps its admission and native lifetime boundary', () => {
  const ids = DAWN_GATE_GROUPS.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const group of DAWN_GATE_GROUPS) {
    assert.ok(dawnVitestArgs(group).includes('--passWithNoTests=false'));
    if (group.id.startsWith('compact-')) assert.equal(group.env.FORGEAX_DAWN_COMPACT, '1');
    else if (group.vitestShard === undefined && group.id !== 'direct-light') {
      assert.equal(group.env.FORGEAX_DAWN_ISOLATED, '1');
    }
    assert.equal(dawnVitestArgs(group).includes('--no-isolate'), group.id.startsWith('heavy-'));
    if (group.id.startsWith('heavy-')) {
      assert.equal(group.files.length, 1);
      assert.ok(dawnVitestArgs(group).includes('--retry=0'));
      assert.ok(dawnVitestArgs(group).includes('--bail=1'));
    }
  }
  assert.equal(ids.filter((id) => id === 'gpu-timing').length, 1);
});

test('compact files remain complete and unique across three existing native lanes', () => {
  const groups = DAWN_GATE_GROUPS.filter(({ id }) => id.startsWith('compact-'));
  assert.equal(groups.length, 3);
  const files = groups.flatMap(({ files }) => files);
  assert.equal(new Set(files).size, files.length);
  assert.deepEqual(files.toSorted(), [...DAWN_COMPACT_TEST_FILES].sort());
  const lanes = groups.map(({ id }) => DAWN_GATE_SHARDS.findIndex((lane) => lane.includes(id)));
  assert.deepEqual(lanes.toSorted(), [0, 1, 3]);
  assert.equal(new Set(lanes).size, 3);
});

test('at most four Dawn jobs cover every complete native group exactly once', () => {
  const ids = DAWN_GATE_SHARDS.flat();
  assert.equal(DAWN_GATE_SHARDS.length, 4);
  assert.equal(ids.length, DAWN_GATE_GROUPS.length, 'each group must have exactly one lane');
  assert.equal(new Set(ids).size, DAWN_GATE_GROUPS.length);
  assert.deepEqual(new Set(ids), new Set(DAWN_GATE_GROUPS.map((group) => group.id)));
  for (const [index, lane] of DAWN_GATE_SHARDS.entries()) {
    assert.deepEqual(
      selectDawnShard(`${index + 1}/4`).map((group) => group.id),
      DAWN_GATE_GROUPS.filter((group) => lane.includes(group.id)).map((group) => group.id),
    );
    assert.equal(lane.filter((id) => id.startsWith('ordinary-')).length, 1);
  }
  assert.throws(() => selectDawnShard('0/4'), /outside/);
  assert.throws(() => selectDawnShard('1/8'), /outside/);
  assert.throws(() => selectDawnGroups('ordinary-1', '1/4'), /mutually exclusive/);
});

test('the measured specular AA owner has headroom outside ordinary discovery', () => {
  const group = selectDawnGroups('specular-aa')[0];
  assert.deepEqual(group.files, ['packages/runtime/src/__tests__/specular-aa.dawn.test.ts']);
  assert.ok(selectDawnShard('3/4').some(({ id }) => id === group.id));
  assert.ok(!listDawnFiles().includes(group.files[0]));
});

test('the ordinary project quarters partition Vitest discovery', async () => {
  const ordinaryPartitions = DAWN_GATE_GROUPS.filter((group) => group.vitestShard !== undefined);
  assert.deepEqual(
    ordinaryPartitions.map(({ id, vitestShard }) => [id, vitestShard]),
    [
      ['ordinary-1', '1/4'],
      ['ordinary-2', '2/4'],
      ['ordinary-3', '3/4'],
      ['ordinary-4', '4/4'],
    ],
  );
  for (const group of ordinaryPartitions) {
    assert.deepEqual(group.files, []);
    assert.equal(group.retryMode, 'vitest-dawn');
    assert.ok(dawnVitestArgs(group).includes(`--shard=${group.vitestShard}`));
  }
  for (const group of DAWN_GATE_GROUPS.filter((candidate) => candidate.vitestShard === undefined)) {
    assert.ok(!dawnVitestArgs(group).some((arg) => arg.startsWith('--shard')));
  }
  const ordinary = listDawnFiles();
  const specifications = ordinary.map((file) => ({ moduleId: resolve(root, file) }));
  const partitions = [];
  for (const { vitestShard } of ordinaryPartitions) {
    const [index, count] = vitestShard.split('/').map(Number);
    const sequencer = new BaseSequencer({ config: { root, shard: { index, count } } });
    partitions.push(
      ...(await sequencer.shard(specifications)).map(({ moduleId }) =>
        relative(root, moduleId).replaceAll('\\', '/'),
      ),
    );
  }
  assert.equal(new Set(partitions).size, partitions.length, 'Vitest shards must not overlap');
  assert.deepEqual(
    [...partitions].sort(),
    ordinary,
    'Vitest shards must conserve ordinary discovery',
  );
});

test('local, PR and Linux nightly execute the same complete gate', () => {
  const command = JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:dawn'];
  assert.match(command, /node scripts\/ci\/run-dawn-gate\.mjs$/);
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/nightly.yml']) {
    const workflow = readFileSync(file, 'utf8');
    const start = workflow.indexOf('      - name: Vitest dawn project');
    assert.ok(start >= 0);
    const remaining = workflow.slice(start);
    const nextStep = remaining.indexOf('\n      - name:', 1);
    const step = remaining.slice(0, nextStep === -1 ? undefined : nextStep);
    assert.match(
      step,
      /run:(?: node | >-\s+node scripts\/ci\/run-with-runner-cpu-affinity\.mjs --\s+node )scripts\/ci\/run-dawn-gate\.mjs(?: --shard [^\n]+)?/,
    );
    assert.match(step, /NODE_OPTIONS: --max-old-space-size=4096/);
    assert.equal(step.includes("FORGEAX_DAWN_LIGHTWEIGHT: '1'"), file.endsWith('/ci.yml'));
  }
});

test('complete native owners balance the measured four-lane tails', () => {
  const placement = new Map(
    DAWN_GATE_SHARDS.flatMap((lane, index) => lane.map((id) => [id, index + 1])),
  );
  for (const id of [
    'ordinary-1',
    'compact-1',
    'gi-3',
    'gi-4',
    'heavy-4',
    'gi-6',
    'gpu-timing',
    'heavy-7',
    'heavy-8',
    'vfx-mesh',
    'gi-5',
  ])
    assert.equal(placement.get(id), 1);
  for (const id of [
    'ordinary-2',
    'feature-depth',
    'heavy-6',
    'transmission',
    'compact-2',
    'material-publication',
    'shadow-fields',
  ])
    assert.equal(placement.get(id), 2);
  for (const id of [
    'ordinary-3',
    'heavy-3',
    'heavy-9',
    'timing-lifecycle',
    'heavy-5',
    'heavy-2',
    'gi-1',
    'specular-aa',
  ])
    assert.equal(placement.get(id), 3);
  for (const id of [
    'ordinary-4',
    'compact-3',
    'renderer',
    'screen-probe',
    'vfx-depth',
    'gi-2',
    'direct-light',
    'surface-pipelines',
    'heavy-1',
  ])
    assert.equal(placement.get(id), 4);
});

// Exact e9b completed owners. Direct Light is censored after three partitions;
// its earlier complete345.463s receipt remains an estimate, not this head's PASS.
test('whole-group placement reserves two minutes of the original job budget', () => {
  const seconds = {
    'ordinary-1': 317.792,
    'ordinary-2': 546.466,
    'ordinary-3': 882.133,
    'ordinary-4': 280.966,
    'compact-1': 98.424,
    'compact-2': 93.266,
    'compact-3': 71.269,
    'surface-pipelines': 193.008,
    renderer: 23.194,
    'material-publication': 23.67,
    'feature-depth': 80.596,
    'vfx-depth': 89.324,
    transmission: 186.826,
    'vfx-mesh': 85.47,
    'timing-lifecycle': 22.045,
    'gpu-timing': 17.749,
    'heavy-1': 13.005,
    'heavy-2': 28.643,
    'heavy-3': 35.79,
    'heavy-4': 22.126,
    'heavy-5': 22.358,
    'heavy-6': 28.251,
    'heavy-7': 20.75,
    'heavy-8': 31.226,
    'heavy-9': 30.218,
    'shadow-fields': 138.913,
    'specular-aa': 70.601,
    'gi-1': 120.399,
    'gi-2': 171.066,
    'gi-3': 68.506,
    'gi-4': 118.777,
    'gi-5': 199.761,
    'gi-6': 73.374,
    'screen-probe': 66.001,
    'direct-light': 345.463,
  };
  for (const [index, lane] of DAWN_GATE_SHARDS.entries()) {
    // All four e9b consumers admit the strict core receipt without source cooking.
    const projected = 0.728 + 1.15 * lane.reduce((sum, id) => sum + seconds[id], 0);
    assert.ok(
      projected < 1500,
      `lane ${index + 1}: ${projected}s leaves insufficient job headroom`,
    );
  }
});

// Complete380 owners, including every shadow/feature/transmission/light partition.
test('complete 380 costs reduce the critical native lane without dropping owners', () => {
  const { complete380Epoch } = JSON.parse(
    readFileSync(resolve('scripts/ci/evidence/workload-audit-2026-10-06.json'), 'utf8'),
  );
  const seconds = complete380Epoch.completeOwnerCostsSeconds;
  assert.deepEqual(Object.keys(seconds).sort(), DAWN_GATE_GROUPS.map((group) => group.id).sort());
  const totals = DAWN_GATE_SHARDS.map((lane) => lane.reduce((sum, id) => sum + seconds[id], 0));
  const previousPeak = Math.max(...complete380Epoch.dawnLanes.map((lane) => lane.nativeSeconds));
  assert.ok(Math.max(...totals) < previousPeak - 200, `projected complete lanes: ${totals}`);
  for (const total of totals) assert.ok(0.728 + 1.15 * total < 1500);
});

test('the final06 censored tail retains the original job headroom in its estimate', () => {
  const evidence = JSON.parse(
    readFileSync('scripts/ci/evidence/final06-dawn-placement-2026-10-07.json', 'utf8'),
  );
  const costs = evidence.planningCostsSeconds;
  assert.deepEqual(Object.keys(costs).sort(), DAWN_GATE_GROUPS.map((group) => group.id).sort());
  for (const [index, lane] of DAWN_GATE_SHARDS.entries()) {
    const total = lane.reduce((sum, id) => sum + costs[id], 0);
    assert.ok(
      0.728 + 1.15 * total < 1500,
      `lane ${index + 1}: ${total}s has insufficient modeled headroom`,
    );
  }
});
