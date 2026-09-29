import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assignBrowserGroupsToShards,
  browserGroupRunOrder,
  browserGroupWeight,
  browserProducerReadiness,
  browserTestFiles,
  ciBrowserShardTailSeconds,
  parseArgs,
} from '../run-split-vitest-browser.mjs';

test('floating harness experiments stay outside the Engine browser roster', () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-roster-'));
  try {
    const engine = 'packages/render/src/__tests__/owner.browser.test.ts';
    const experiment = '.forgeax-harness/solo/example/evidence/probe.browser.test.ts';
    for (const file of [engine, experiment]) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), '');
    }
    assert.deepEqual(browserTestFiles(root), [engine]);
    const config = readFileSync('config/vitest-browser-project.ts', 'utf8');
    assert.ok(config.includes("'**/.forgeax-harness/**'"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function dryRunGroups(groupSize = 8) {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/ci/run-split-vitest-browser.mjs',
      '--dry-run',
      `--group-size=${groupSize}`,
      '--shard-count=1',
      '--shard-index=0',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(': ') + 2).split(', '));
}

test('browser discovery excludes floating harness experiments while retaining Engine owners', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-browser-discovery-'));
  const admitted = ['apps/demo/example.browser.test.ts', 'packages/render/example.browser.test.ts'];
  try {
    for (const file of [...admitted, '.forgeax-harness/experiments/probe.browser.test.ts']) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), '');
    }
    assert.deepEqual(browserTestFiles(root).sort(), admitted);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SSAO onerror gate keeps a bounded lavapipe cold-start budget', () => {
  const source = readFileSync(
    'apps/learn-render/5.advanced-lighting/9.ssao/src/__tests__/onerror-gate.browser.test.ts',
    'utf8',
  );
  assert.match(source, /onerrorGate\('learn-render 5\.9 ssao',[\s\S]*90_000\)/);
});

test('hello triangle retains its bootstrap deadline in a fresh process', () => {
  const target =
    'apps/learn-render/1.getting-started/2.hello-triangle/src/__tests__/onerror-gate.browser.test.ts';
  const expected = [
    ...browserTestFiles(),
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts',
  ].sort();
  for (const groupSize of [4, 8, 16]) {
    const groups = dryRunGroups(groupSize);
    assert.deepEqual(groups.flat().sort(), expected);
    assert.deepEqual(
      groups.filter((group) => group.includes(target)),
      [[target]],
    );
  }
  const source = readFileSync(target, 'utf8');
  assert.match(source, /const GATE_TIMEOUT_MS = 30_000;/);
  assert.match(
    source,
    /bootstrapDeadline = performance\.now\(\) \+ GATE_TIMEOUT_MS - GATE_SETTLE_MARGIN_MS;/,
  );
  assert.match(source, /\}, GATE_TIMEOUT_MS\);/);
});

test('preview browser owners are isolated from ordinary bounded groups', () => {
  const groups = dryRunGroups();
  const previewGroup = groups.find((group) =>
    group.some((file) => file.startsWith('apps/preview/')),
  );
  assert.ok(previewGroup);
  assert.deepEqual(previewGroup, ['apps/preview/__tests__/preview.browser.test.ts']);

  const regularGroups = groups.filter((group) => group !== previewGroup);
  assert.ok(regularGroups.every((group) => group.length <= 8));

  const files = groups.flat();
  assert.equal(new Set(files).size, files.length, 'a browser test may belong to only one group');
});

test('solar atmosphere calibration keeps the full roster and a balanced singleton owner', () => {
  const target = 'packages/runtime/src/__tests__/solar-atmosphere-calibration.browser.test.ts';
  const r32float =
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts';
  const groups = dryRunGroups();
  const files = groups.flat();
  const expectedFiles = [...browserTestFiles(), r32float].sort();

  assert.deepEqual([...files].sort(), expectedFiles, 'browser roster must be conserved exactly');
  assert.equal(files.filter((file) => file === target).length, 1);
  assert.deepEqual(
    groups.filter((group) => group.includes(target)),
    [[target]],
    'the measured long-lived solar owner must have a fresh process',
  );

  const assignment = assignBrowserGroupsToShards(groups, 4, 'balanced');
  const totals = [0, 0, 0, 0];
  for (const [index, group] of groups.entries())
    totals[assignment[index]] += browserGroupWeight(group);
  assert.ok(Math.max(...totals) - Math.min(...totals) < 60, `imbalanced seconds: ${totals}`);
  assert.ok(
    browserGroupWeight([target]) >
      browserGroupWeight(['packages/ui/src/preview/probe.browser.test.ts']),
    'the measured solar owner must retain a scheduler reservation',
  );
});

for (const target of [
  'packages/runtime/src/__tests__/material-publication.browser.test.ts',
  'packages/runtime/src/__tests__/render-publication.browser.test.ts',
  'packages/runtime/src/__tests__/standard-gbuffer-replay.browser.test.ts',
  'packages/runtime/src/__tests__/standard-displacement.browser.test.ts',
  'packages/runtime/src/__tests__/decals.browser.test.ts',
  'packages/runtime/src/__tests__/canvas-texture.browser.test.ts',
  'packages/runtime/src/__tests__/lod-transition.browser.test.ts',
  'packages/runtime/src/__tests__/normal-bump.browser.test.ts',
  'packages/runtime/src/__tests__/barrel-distortion-output.browser.test.ts',
  'packages/runtime/src/__tests__/multi-camera.browser.test.ts',
  'packages/render/src/__tests__/ssr-gpu-dispatch.browser.test.ts',
]) {
  test(`${target} keeps its complete journey in a bounded singleton`, () => {
    const expectedFiles = [
      ...browserTestFiles(),
      'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts',
    ].sort();
    for (const groupSize of [8, 16]) {
      const groups = dryRunGroups(groupSize);
      assert.deepEqual(groups.flat().sort(), expectedFiles, 'preserve the exact browser roster');
      assert.deepEqual(
        groups.filter((group) => group.includes(target)),
        [[target]],
        'the measured owner must not consume a shared group deadline',
      );
    }
    const runner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
    assert.match(runner, /const browserGroupTimeoutMs = 300_000;/);
  });
}

test('real multi-camera Worker capture and replacement owns a bounded browser process', () => {
  const target = 'packages/app/__tests__/render-worker-multi-camera.browser.test.ts';
  const groups = dryRunGroups();
  assert.deepEqual(
    groups.filter((group) => group.includes(target)),
    [[target]],
  );
  assert.equal(groups.flat().filter((file) => file === target).length, 1);
});

test('runtime rendering groups retain their roster within four-file process budgets', () => {
  const expected = [
    ...browserTestFiles(),
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts',
  ].sort();
  for (const groupSize of [8, 16]) {
    const groups = dryRunGroups(groupSize);
    assert.deepEqual(groups.flat().sort(), expected);
    for (const group of groups) {
      if (group.some((file) => file.startsWith('packages/runtime/src/__tests__/'))) {
        assert.ok(group.length <= 4, `runtime group exceeds its process budget: ${group}`);
      }
    }
  }
});

test('renderer construction owners retain dedicated process boundaries', () => {
  const groups = dryRunGroups();
  const lifecycleHeavy = groups.filter((group) =>
    group.some((file) =>
      /apps\/learn-render\/5\.advanced-lighting\/(?:6\.hdr|7\.bloom|8\.deferred-shading|9\.ssao)\/src\/__tests__\/onerror-gate\.browser\.test\.ts$/.test(
        file,
      ),
    ),
  );
  assert.equal(lifecycleHeavy.length, 4);
  assert.ok(lifecycleHeavy.every((group) => group.length === 1));
  assert.deepEqual(
    lifecycleHeavy
      .map(
        (group) =>
          group[0]?.match(
            /5\.advanced-lighting\/(?:6\.hdr|7\.bloom|8\.deferred-shading|9\.ssao)\//,
          )?.[0],
      )
      .sort(),
    [
      '5.advanced-lighting/6.hdr/',
      '5.advanced-lighting/7.bloom/',
      '5.advanced-lighting/8.deferred-shading/',
      '5.advanced-lighting/9.ssao/',
    ],
  );
  assert.equal(
    lifecycleHeavy.filter((group) => group.some((file) => file.includes('/7.bloom/'))).length,
    1,
  );
  const thinWrapper = 'packages/app/__tests__/thin-wrapper.browser.test.ts';
  assert.deepEqual(
    groups.filter((group) => group.includes(thinWrapper)),
    [[thinWrapper]],
    'the real createApp(canvas) renderer construction must start from a fresh browser process',
  );
  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /thinWrapperBrowserFile/);
});

test('Wave 1 rendering owners fit within the ordinary browser group budget', () => {
  const groups = dryRunGroups();
  const wave1Files = [
    'packages/runtime/src/__tests__/volumetric-fog-stability.browser.test.ts',
    'packages/runtime/src/__tests__/wave1-dynamic-geometry.browser.test.ts',
    'packages/runtime/src/__tests__/wave1-rendering-materials.browser.test.ts',
    'packages/runtime/src/__tests__/wave1-rendering-p0.browser.test.ts',
    'packages/runtime/src/__tests__/wave1-rendering-recovery.browser.test.ts',
    'packages/runtime/src/__tests__/wave1-shadow-diagnostic.browser.test.ts',
    'packages/runtime/src/__tests__/weapon-spirit-material.browser.test.ts',
    'packages/ui/src/preview/__tests__/capture-determinism.browser.test.ts',
  ];
  const wave1Groups = groups.filter((group) => group.some((file) => wave1Files.includes(file)));
  assert.ok(wave1Groups.every((group) => group.length <= 4));
  assert.deepEqual(
    wave1Groups
      .flat()
      .filter((file) => wave1Files.includes(file))
      .sort(),
    wave1Files.sort(),
    'Wave 1 long owners must be conserved in the bounded groups',
  );
});

test('clipping planes keep their real WebGPU journey within a fresh browser group', () => {
  const target = 'packages/runtime/src/__tests__/clipping-planes.browser.test.ts';
  const groups = dryRunGroups();
  assert.deepEqual(
    groups.filter((group) => group.includes(target)),
    [[target]],
  );
});

test('large instancing acceptance owns an isolated long-lived group', () => {
  const target = 'apps/parity/instancing-static/src/__tests__/instances.browser.test.ts';
  const groups = dryRunGroups();
  assert.deepEqual(
    groups.filter((group) => group.includes(target)),
    [[target]],
  );

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /instancingStaticBrowserFile/);
  assert.match(browserRunner, /instancingStaticBrowserGroupTimeoutMs = 900_000/);
  assert.match(browserRunner, /group\.includes\(instancingStaticBrowserFile\)/);
});

test('IBL demos share one bounded on-demand producer boundary', () => {
  const groups = dryRunGroups();
  const iblFiles = [
    'apps/learn-render/6.pbr/2.ibl-irradiance/src/__tests__/onerror-gate.browser.test.ts',
    'apps/learn-render/6.pbr/3.ibl-specular/src/__tests__/onerror-gate.browser.test.ts',
  ];
  const iblGroup = groups.find((group) => group.includes(iblFiles[0]));
  assert.deepEqual(iblGroup, [
    'apps/hello/topology/src/__tests__/topology.browser.test.ts',
    ...iblFiles,
    'apps/learn-render/6.pbr/4.transmission-refraction/src/__tests__/onerror-gate.browser.test.ts',
  ]);
  assert.ok(iblFiles.every((file) => iblGroup.includes(file)));

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /iblIrradianceBrowserFile/);
  assert.match(browserRunner, /iblSpecularBrowserFile/);
  assert.equal(browserProducerReadiness(iblGroup), 'on-demand');
  assert.doesNotMatch(browserRunner, /advancedLightingSingleton/);
});

test('direct-light browser producer owns an isolated long-lived group', () => {
  const directLightFile =
    'apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.browser.test.ts';
  const groups = dryRunGroups();
  assert.deepEqual(
    groups.filter((group) => group.includes(directLightFile)),
    [[directLightFile]],
  );

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /directLightBrowserFile/);
  assert.match(browserRunner, /directLightBrowserGroupTimeoutMs = 420_000/);
  assert.match(browserRunner, /group\.includes\(directLightBrowserFile\)/);
});

test('color-lighting capture cases stay within the regular browser budget', () => {
  const groups = dryRunGroups(16);
  const colorLightingGroups = groups.filter((group) =>
    group.some((file) => file.startsWith('apps/parity/color-lighting/cases/')),
  );
  assert.ok(colorLightingGroups.length > 1);
  assert.ok(colorLightingGroups.every((group) => group.length <= 4));
  assert.ok(
    colorLightingGroups.every((group) =>
      group.every((file) => file.startsWith('apps/parity/color-lighting/cases/')),
    ),
  );

  const files = groups.flat();
  assert.equal(new Set(files).size, files.length, 'a browser test may belong to only one group');
  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /colorLightingCaseGroupSize = 4/);
});

test('asset-heavy browser owners share one on-demand Pack boundary', () => {
  const groups = dryRunGroups();
  const assetHeavyOwners = groups.filter((group) =>
    group.some((file) =>
      /apps\/learn-render\/6\.pbr\/(?:2\.ibl-irradiance|3\.ibl-specular|4\.transmission-refraction)\//.test(
        file,
      ),
    ),
  );
  assert.equal(assetHeavyOwners.length, 1);
  assert.equal(assetHeavyOwners[0].length, 4);
  assert.ok(
    assetHeavyOwners[0].includes('apps/hello/topology/src/__tests__/topology.browser.test.ts'),
  );
  assert.equal(browserProducerReadiness(assetHeavyOwners[0]), 'on-demand');
});

test('ordinary groups cook on demand while Preview requires its catalog', () => {
  assert.equal(
    browserProducerReadiness(['apps/preview/probe.test.ts'], 'on-demand'),
    'before-consume',
  );
  assert.equal(browserProducerReadiness(['packages/app/probe.test.ts']), 'on-demand');
  assert.equal(
    browserProducerReadiness(['packages/app/probe.test.ts'], 'before-consume'),
    'before-consume',
  );
});

test('Surface provenance owns a singleton with its complete before-consume catalog', () => {
  const target = 'packages/runtime/src/__tests__/surface-standard-pipeline.browser.test.ts';
  const groups = dryRunGroups();
  assert.deepEqual(
    groups.filter((group) => group.includes(target)),
    [[target]],
  );
  assert.equal(browserProducerReadiness([target], 'on-demand'), 'before-consume');
  const runner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(runner, /const surfaceProvenanceBrowserGroupTimeoutMs = 360_000;/);
  assert.match(
    runner,
    /group\.includes\(surfaceProvenanceBrowserFile\)\s*\? surfaceProvenanceBrowserGroupTimeoutMs/,
  );
  assert.match(readFileSync(target, 'utf8'), /timeout: 300_000/);
});

test('lens captures and fresh-device replays own one complete process', () => {
  const target = 'packages/runtime/src/__tests__/lens-effects.browser.test.ts';
  assert.deepEqual(
    dryRunGroups().filter((group) => group.includes(target)),
    [[target]],
  );
});

test('all fifteen shadow contact cases retain three independent five-filter processes', () => {
  const targets = ['column', 'centimeter-1024', 'centimeter-2048'].map(
    (name) => `packages/runtime/src/__tests__/shadow-contact-${name}.browser.test.ts`,
  );
  assert.deepEqual(
    dryRunGroups().filter((group) => group.some((file) => file.includes('/shadow-contact'))),
    targets.sort().map((target) => [target]),
  );
});

test('Render Worker pressure and recovery keep all cases in one independent process', () => {
  const target = 'packages/app/__tests__/render-worker.browser.test.ts';
  assert.deepEqual(
    dryRunGroups().filter((group) => group.includes(target)),
    [[target]],
  );
});

test('Render Worker content owners retain every case in separate complete processes', () => {
  const groups = dryRunGroups();
  for (const name of ['deformation', 'geometry', 'media', 'tiles', 'environment']) {
    const target = `packages/app/__tests__/render-worker-${name}.browser.test.ts`;
    assert.deepEqual(
      groups.filter((group) => group.includes(target)),
      [[target]],
    );
  }
});

test('VFX mesh lighting and consumer recovery keep one complete process', () => {
  const target = 'packages/runtime/src/__tests__/vfx-mesh-lighting.browser.test.ts';
  assert.deepEqual(
    dryRunGroups().filter((group) => group.includes(target)),
    [[target]],
  );
});

test('two host-loss recovery cycles own a fresh complete process', () => {
  const target = 'packages/runtime/src/__tests__/wave1-rendering-recovery.browser.test.ts';
  assert.deepEqual(
    dryRunGroups().filter((group) => group.includes(target)),
    [[target]],
  );
});

test('r32float generation integration is projected into exactly one browser group', () => {
  const target =
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts';
  const groups = dryRunGroups();
  const matchingGroups = groups.filter((group) => group.includes(target));
  assert.equal(matchingGroups.length, 1);
  assert.equal(groups.flat().filter((file) => file === target).length, 1);

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /r32floatCapabilityGenerationTest/);
  const browserProject = readFileSync('config/vitest-browser-project.ts', 'utf8');
  assert.ok(
    browserProject.includes(`'${target}'`),
    'the browser project must admit the scheduled integration file',
  );
});

test('CI browser shards use deterministic cost balancing without dropping groups', () => {
  const groups = dryRunGroups();
  const assignment = assignBrowserGroupsToShards(groups, 4, 'balanced');
  assert.equal(assignment.length, groups.length);
  assert.ok(assignment.every((shard) => Number.isInteger(shard) && shard >= 0 && shard < 4));

  const totals = [0, 0, 0, 0];
  for (const [index, group] of groups.entries())
    totals[assignment[index]] += browserGroupWeight(group);
  const instancing = groups.findIndex((group) =>
    group.includes('apps/parity/instancing-static/src/__tests__/instances.browser.test.ts'),
  );
  assert.ok(Math.max(...totals) - Math.min(...totals) < 60, `imbalanced seconds: ${totals}`);
  assert.notEqual(instancing, -1);

  const directLight = groups.findIndex((group) =>
    group.some((file) => file.includes('direct-light')),
  );
  const reflection = groups.findIndex((group) =>
    group.some((file) => file.includes('render-target-reflection')),
  );
  assert.notEqual(directLight, -1);
  assert.notEqual(reflection, -1);
  // A roster addition can legitimately place these two owners on one shard.
  // LPT promises balanced deterministic assignment, not pairwise separation.
  assert.deepEqual(assignBrowserGroupsToShards(structuredClone(groups), 4, 'balanced'), assignment);

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /--shard-strategy/);
  assert.match(browserRunner, /strategy=\$\{options\.shardStrategy\}/);
});

test('serial CI tails are reserved as concurrency-scaled group seconds', () => {
  const concurrency = 3;
  for (const groupSize of [8, 16]) {
    const groups = dryRunGroups(groupSize);
    const assignment = assignBrowserGroupsToShards(groups, 4, 'balanced', {
      tailSeconds: ciBrowserShardTailSeconds,
      concurrency,
    });
    const groupSeconds = [0, 0, 0, 0];
    for (const [index, group] of groups.entries())
      groupSeconds[assignment[index]] += browserGroupWeight(group);
    assert.ok(
      groupSeconds.every((seconds) => seconds > 0),
      `idle Vitest lane: ${groupSeconds}`,
    );
    const withTails = groupSeconds.map(
      (seconds, shard) => seconds + (ciBrowserShardTailSeconds[shard] ?? 0) * concurrency,
    );
    const largest = Math.max(...groups.map(browserGroupWeight));
    assert.ok(
      Math.max(...withTails) - Math.min(...withTails) <= largest,
      `tail-aware lanes are imbalanced: ${withTails}`,
    );
    assert.ok(groupSeconds[0] < groupSeconds[2] && groupSeconds[1] < groupSeconds[3]);
  }
});

test('CI tail reservations match the shards that run the serial tails', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const job = ci.slice(ci.indexOf('name: vitest-browser-shard-'), ci.indexOf('name: vitest-dawn-'));
  assert.match(job, /FORGEAX_BROWSER_FIXED_SMOKE: '1'/);
  assert.match(job, /--group-concurrency=2\n/);
  assert.match(job, /- name: Verify actual browser test discovery\n\s+if: matrix\.shard == 0\n/);
  assert.match(
    job,
    /- name: Runtime Pack Worker dev\/build JS\/TS browser gate\n\s+if: matrix\.shard == 1\n/,
  );
  assert.equal(ciBrowserShardTailSeconds.length, 2);
});

test('fixed-smoke shard remains a real Vitest lane', () => {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/ci/run-split-vitest-browser.mjs',
      '--dry-run',
      '--group-size=8',
      '--shard-strategy=balanced',
      '--shard-index=0',
      '--shard-count=4',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, FORGEAX_BROWSER_FIXED_SMOKE: '1' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /owns fixed post-Vitest smoke work/);
  assert.match(result.stdout, /^group-/m);
});

test('browser group concurrency defaults to one and is bounded at three lanes', () => {
  assert.equal(parseArgs([]).groupConcurrency, 1);
  assert.equal(parseArgs(['--group-concurrency=2']).groupConcurrency, 2);
  assert.throws(() => parseArgs(['--group-concurrency=4']), /--group-concurrency/);
  assert.throws(() => parseArgs(['--group-concurrency=0']), /--group-concurrency/);
});

test('concurrent browser lanes launch the heaviest selected owners first', () => {
  const groups = [
    ['apps/a.browser.test.ts'],
    ['packages/runtime/src/__tests__/solar-atmosphere-calibration.browser.test.ts'],
    ['apps/b.browser.test.ts', 'apps/c.browser.test.ts'],
    ['apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.browser.test.ts'],
  ];
  const selected = [0, 1, 3];
  assert.equal(browserGroupRunOrder(groups, selected, 1), undefined);
  assert.deepEqual(browserGroupRunOrder(groups, selected, 2), [1, 2, 0]);
});
