import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runGroups } from '../../lib/run-bounded-groups.mjs';
import {
  assignCoverageShards,
  buildTypecheckArgs,
  coverageGroupOrder,
  coverageGroups,
  parseArgs,
  projectGroups,
  rerootCoverage,
  validateShardManifests,
} from '../run-split-vitest-coverage.mjs';

test('allows CI coverage to reuse the repository-wide typecheck gate', () => {
  const options = parseArgs([
    '--group-size=8',
    '--group-concurrency=auto',
    '--max-workers=1',
    '--skip-typecheck',
  ]);
  assert.equal(options.coverage, true);
  assert.equal(options.typecheck, false);
  assert.equal(options.groupSize, 8);
  assert.equal(options.groupConcurrency, 'auto');
});

test('runs one typecheck-only preflight over the selected project roster', () => {
  assert.deepEqual(
    buildTypecheckArgs({
      cliPath: '/workspace/node_modules/vitest/vitest.mjs',
      projects: ['@forgeax/engine-ecs', 'unit'],
      maxWorkers: 1,
    }),
    [
      '/workspace/node_modules/vitest/vitest.mjs',
      'run',
      '--project',
      '@forgeax/engine-ecs',
      '--project',
      'unit',
      '--maxWorkers=1',
      '--typecheck.only',
      '--reporter=default',
    ],
  );
});

test('isolates heavy projects while preserving bounded project order', () => {
  const groups = projectGroups(
    [
      '@forgeax/engine-before',
      '@forgeax/engine-devkit',
      '@forgeax/engine-rhi-wgpu',
      '@forgeax/engine-runtime',
      '@forgeax/engine-scene',
      '@forgeax/engine-shader',
      '@forgeax/engine-after',
      '@forgeax/engine-last',
    ],
    5,
  );

  assert.deepEqual(groups, [
    ['@forgeax/engine-before'],
    ['@forgeax/engine-devkit'],
    ['@forgeax/engine-rhi-wgpu'],
    ['@forgeax/engine-runtime'],
    ['@forgeax/engine-scene'],
    ['@forgeax/engine-shader', '@forgeax/engine-after', '@forgeax/engine-last'],
  ]);
  assert.ok(groups.every((group) => group.length <= 5));
  assert.equal(groups.filter((group) => group.includes('@forgeax/engine-rhi-wgpu')).length, 1);
  assert.equal(groups.filter((group) => group.includes('@forgeax/engine-runtime')).length, 1);
  assert.equal(groups.filter((group) => group.includes('@forgeax/engine-devkit')).length, 1);
  assert.equal(
    groups.some(
      (group) =>
        group.includes('@forgeax/engine-rhi-wgpu') && group.includes('@forgeax/engine-runtime'),
    ),
    false,
  );
  assert.equal(
    groups.some(
      (group) =>
        group.includes('@forgeax/engine-devkit') &&
        (group.includes('@forgeax/engine-rhi-wgpu') || group.includes('@forgeax/engine-runtime')),
    ),
    false,
  );
});

test('prioritizes the measured long coverage tail deterministically', () => {
  const groups = coverageGroups(
    ['@forgeax/engine-scene', '@forgeax/engine-vite-plugin-shader', '@forgeax/engine-runtime'],
    8,
  );
  assert.deepEqual(
    groups.map(({ label }) => label),
    [
      '@forgeax/engine-scene,@forgeax/engine-vite-plugin-shader',
      '@forgeax/engine-vite-plugin-shader:packages/vite-plugin-shader/src/__tests__/vite-plugin-shader.unit.test.ts',
      '@forgeax/engine-runtime',
    ],
  );
  assert.deepEqual(coverageGroupOrder(groups), [1, 2, 0]);
});

test('isolates a heavy test file into its own child and excludes it elsewhere', () => {
  const devkitFiles = [
    'packages/devkit/src/__tests__/new-project-workers.e2e.test.ts',
    'packages/devkit/src/__tests__/scene-bootstrap.e2e.test.ts',
  ];
  const groups = coverageGroups(['@forgeax/engine-ecs', '@forgeax/engine-devkit'], 8);
  assert.deepEqual(
    groups.map(({ projects, files, excludes }) => ({ projects, files, excludes })),
    [
      { projects: ['@forgeax/engine-ecs'], files: [], excludes: devkitFiles },
      { projects: ['@forgeax/engine-devkit'], files: [], excludes: devkitFiles },
      { projects: ['@forgeax/engine-devkit'], files: devkitFiles, excludes: [] },
    ],
  );
  const unit = coverageGroups(['@forgeax/engine-devkit'], 8, { isolateFiles: false });
  assert.deepEqual(
    unit.map(({ files, excludes }) => [files, excludes]),
    [[[], []]],
  );
});

test('plans coverage shards by longest processing time with typecheck on shard 0', () => {
  const groups = [100, 90, 80, 70, 10].map((weight, index) => ({
    label: `g${index}`,
    projects: [`p${index}`],
    files: [],
    excludes: [],
    weight,
  }));
  assert.deepEqual(assignCoverageShards(groups, 3), [1, 2, 2, 1, 1]);
  assert.deepEqual(assignCoverageShards(groups, 3, { typecheck: false }), [0, 1, 2, 2, 1]);
  assert.deepEqual(assignCoverageShards(groups, 1), [0, 0, 0, 0, 0]);
});

test('merges only an exact partition of the recomputed coverage roster', () => {
  const expectedGroups = ['a', 'b', 'c'];
  const shard = (shardIndex, groups) => ({ shardIndex, shardCount: 2, expectedGroups, groups });
  validateShardManifests([shard(1, ['c']), shard(0, ['a', 'b'])], expectedGroups);
  assert.throws(
    () => validateShardManifests([shard(0, ['a', 'b'])], expectedGroups),
    /expected 2 shard manifests, found 1.*group c ran 0 times/,
  );
  assert.throws(
    () => validateShardManifests([shard(0, ['a', 'b']), shard(1, ['b', 'c'])], expectedGroups),
    /group b ran 2 times/,
  );
  assert.throws(
    () => validateShardManifests([shard(0, ['a', 'b']), shard(0, ['c'])], expectedGroups),
    /shard indexes must be 0\.\.1 exactly once/,
  );
  assert.throws(
    () => validateShardManifests([shard(0, ['a', 'b']), shard(1, ['c'])], ['a', 'b', 'c', 'd']),
    /planned a different coverage group roster/,
  );
});

test('re-roots shard coverage so runners with different checkouts merge per file', () => {
  const entry = (root) => ({
    [`${root}/packages/math/src/vec3.ts`]: {
      path: `${root}/packages/math/src/vec3.ts`,
      s: { 0: 1 },
    },
  });
  const portable = rerootCoverage(entry('/runner-a/work'), '/runner-a/work', '');
  assert.deepEqual(portable, {
    'packages/math/src/vec3.ts': { path: 'packages/math/src/vec3.ts', s: { 0: 1 } },
  });
  assert.deepEqual(rerootCoverage(portable, '', '/merge/work'), entry('/merge/work'));
  assert.deepEqual(
    rerootCoverage(rerootCoverage(entry('/runner-b/x'), '/runner-b/x', ''), '', '/merge/work'),
    rerootCoverage(portable, '', '/merge/work'),
  );
  assert.throws(
    () => rerootCoverage(entry('/elsewhere'), '/runner-a/work', ''),
    /outside \/runner-a\/work/,
  );
});

test('re-roots the FileCoverage instances an istanbul CoverageMap serializes', () => {
  const rootRequire = createRequire(import.meta.url);
  const providerRequire = createRequire(rootRequire.resolve('@vitest/coverage-v8'));
  const { createCoverageMap } = providerRequire('istanbul-lib-coverage');
  const file = '/runner-a/work/packages/math/src/vec3.ts';
  const map = createCoverageMap({
    [file]: {
      path: file,
      statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
      fnMap: {},
      branchMap: {},
      s: { 0: 1 },
      f: {},
      b: {},
    },
  });
  const portable = rerootCoverage(map.toJSON(), '/runner-a/work', '');
  const merged = createCoverageMap({});
  merged.merge(JSON.parse(JSON.stringify(rerootCoverage(portable, '', '/merge/work'))));
  assert.deepEqual(merged.files(), ['/merge/work/packages/math/src/vec3.ts']);
  assert.equal(merged.getCoverageSummary().statements.covered, 1);
});

test('requires a shard output directory and rejects mixed shard modes', () => {
  const options = parseArgs(['--shard-index=2', '--shard-count=3', '--shard-output-dir=out']);
  assert.equal(options.shardIndex, 2);
  assert.equal(options.shardCount, 3);
  assert.throws(() => parseArgs(['--shard-count=3']), /requires --shard-output-dir/);
  assert.throws(
    () => parseArgs(['--shard-index=3', '--shard-count=3', '--shard-output-dir=out']),
    /below --shard-count/,
  );
  assert.throws(() => parseArgs(['--shard-count=5']), /--shard-count must be an integer/);
  assert.throws(
    () => parseArgs(['--merge-shards=in', '--shard-output-dir=out']),
    /cannot be combined/,
  );
});

test('runs coverage groups at the requested bound and preserves result order', async () => {
  let active = 0;
  let peak = 0;
  const completed = [];
  const groups = [['slow'], ['fast'], ['middle'], ['last']];
  const delays = [30, 5, 15, 1];

  const results = await runGroups({
    groups,
    concurrency: 2,
    runGroupImpl: async (group, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delays[index]));
      active -= 1;
      completed.push(group[0]);
      return `${group[0]}-result`;
    },
  });

  assert.equal(peak, 2);
  assert.notDeepEqual(completed, groups.flat());
  assert.deepEqual(
    results,
    groups.map(([name]) => `${name}-result`),
  );
});

test('executes weighted order while preserving canonical result order', async () => {
  const completed = [];
  const groups = [['small'], ['long'], ['middle']];
  const results = await runGroups({
    groups,
    concurrency: 1,
    order: [1, 2, 0],
    runGroupImpl: async (group, index) => {
      completed.push(index);
      return group[0];
    },
  });

  assert.deepEqual(completed, [1, 2, 0]);
  assert.deepEqual(results, ['small', 'long', 'middle']);
});

test('stops scheduling new groups after the first failure', async () => {
  const started = [];

  await assert.rejects(
    runGroups({
      groups: [['fail'], ['in-flight'], ['must-not-start'], ['also-must-not-start']],
      concurrency: 2,
      runGroupImpl: async ([name]) => {
        started.push(name);
        if (name === 'fail') throw new Error('expected failure');
        await new Promise((resolve) => setTimeout(resolve, 10));
        return name;
      },
    }),
    /expected failure/,
  );

  assert.deepEqual(started, ['fail', 'in-flight']);
});
