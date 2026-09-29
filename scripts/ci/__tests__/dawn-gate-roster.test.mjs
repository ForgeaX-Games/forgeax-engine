import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { test } from 'node:test';
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
    if (group.id === 'compact') assert.equal(group.env.FORGEAX_DAWN_COMPACT, '1');
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

test('four Dawn lanes cover every group exactly once', () => {
  const ids = DAWN_GATE_SHARDS.flat();
  assert.equal(DAWN_GATE_SHARDS.length, 4);
  assert.equal(new Set(ids).size, DAWN_GATE_GROUPS.length);
  assert.deepEqual(new Set(ids), new Set(DAWN_GATE_GROUPS.map((group) => group.id)));
  for (const [index, lane] of DAWN_GATE_SHARDS.entries()) {
    assert.deepEqual(
      selectDawnShard(`${index + 1}/4`).map((group) => group.id),
      lane,
    );
  }
  // The four longest groups own separate lanes.
  for (const [index, id] of ['ordinary-1', 'ordinary-2', 'direct-light', 'compact'].entries()) {
    assert.ok(DAWN_GATE_SHARDS[index].includes(id));
  }
  assert.ok(DAWN_GATE_SHARDS[3].includes('shadow-fields'));
  assert.throws(() => selectDawnShard('0/4'), /outside/);
  assert.throws(() => selectDawnShard('1/3'), /outside/);
  assert.throws(() => selectDawnGroups('ordinary-1', '1/4'), /mutually exclusive/);
});

test('the ordinary project halves partition Vitest discovery', () => {
  const halves = DAWN_GATE_GROUPS.filter((group) => group.vitestShard !== undefined);
  assert.deepEqual(
    halves.map(({ id, vitestShard }) => [id, vitestShard]),
    [
      ['ordinary-1', '1/2'],
      ['ordinary-2', '2/2'],
    ],
  );
  for (const group of halves) {
    assert.deepEqual(group.files, []);
    assert.equal(group.retryMode, 'vitest-dawn');
    assert.ok(dawnVitestArgs(group).includes(`--shard=${group.vitestShard}`));
  }
  for (const group of DAWN_GATE_GROUPS.filter((candidate) => candidate.vitestShard === undefined)) {
    assert.ok(!dawnVitestArgs(group).some((arg) => arg.startsWith('--shard')));
  }
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
    assert.match(step, /run: node scripts\/ci\/run-dawn-gate\.mjs(?: --shard [^\n]+)?/);
    assert.match(step, /NODE_OPTIONS: --max-old-space-size=4096/);
    assert.equal(step.includes("FORGEAX_DAWN_LIGHTWEIGHT: '1'"), file.endsWith('/ci.yml'));
  }
});
