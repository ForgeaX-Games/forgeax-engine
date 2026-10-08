import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflowPath = resolve(
  import.meta.dirname,
  '../../../.github/workflows/native-ray-query.yml',
);

test('native ray query installs the C linker toolchain before cargo gates', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const prerequisiteStart = workflow.indexOf('      - name: Install native desktop prerequisites');
  const prerequisiteEnd = workflow.indexOf(
    '      - name: Install workspace dependencies',
    prerequisiteStart,
  );
  const prerequisite = workflow.slice(prerequisiteStart, prerequisiteEnd);
  const cargoGate = workflow.indexOf(
    'cargo test --manifest-path packages/rhi-wgpu-native/Cargo.toml',
  );

  assert.notEqual(prerequisiteStart, -1, 'native prerequisite step must exist');
  assert.notEqual(prerequisiteEnd, -1, 'workspace install must follow native prerequisites');
  assert.match(prerequisite, /\bbuild-essential\b/);
  assert.ok(cargoGate > prerequisiteEnd, 'cargo gates must run after the toolchain step');
  assert.match(workflow, /cargo clippy --manifest-path packages\/rhi-wgpu-native\/Cargo\.toml/);
  assert.match(workflow, /pnpm --filter @forgeax\/native-ray-query-triangle-tauri build:desktop/);
});

test('native GI groups conserve every owner and the foundation replay gate', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const job = workflow
    .split('  native-node-gi:\n')[1]
    .split('  native-ray-query-upstream-metal:')[0];
  const roster = [
    ...job.matchAll(/packages\/runtime\/src\/__tests__\/(renderer-[\w-]+\.dawn\.test\.ts)/g),
  ].map((match) => match[1]);
  assert.deepEqual(roster.sort(), [
    'renderer-gi-coverage.dawn.test.ts',
    'renderer-irradiance-field-add.dawn.test.ts',
    'renderer-irradiance-field-clipmap.dawn.test.ts',
    'renderer-irradiance-field-edit.dawn.test.ts',
    'renderer-irradiance-field-residency.dawn.test.ts',
    'renderer-irradiance-field.dawn.test.ts',
    'renderer-screen-probe.dawn.test.ts',
  ]);
  assert.equal(
    job.split('packages/render/src/__tests__/raytracing/irradiance-field-sampling.dawn.test.ts')
      .length,
    2,
  );
  assert.equal(
    job.split('packages/render/src/__tests__/raytracing/screen-probe-support.dawn.test.ts').length,
    2,
  );
  assert.equal(
    job.split('packages/render/src/__tests__/raytracing/screen-probe-order.dawn.test.ts').length,
    2,
  );
  assert.equal(
    workflow.split("- 'packages/render/src/__tests__/raytracing/screen-probe-order.dawn.test.ts'")
      .length,
    3,
  );
  assert.match(job, /artifacts\/screen-probe\/order\/\*/);
  assert.equal(
    job.split('packages/render/src/__tests__/raytracing/world-acceleration-support.dawn.test.ts')
      .length,
    2,
  );
  assert.equal(
    job.split('packages/render/src/__tests__/raytracing/irradiance-field-visibility.dawn.test.ts')
      .length,
    2,
  );
  assert.match(job, /artifacts\/irradiance-field\/visibility\/result-\*\.json/);
  for (const source of ['ray-irradiance-field-sample', 'ray-irradiance-field', 'ray-screen-probe'])
    assert.equal(workflow.split(`- 'packages/shader/src/${source}.wgsl'`).length, 3);
  assert.match(job, /timeout-minutes: 30/);
  assert.match(job, /fail-fast: false/);
  assert.match(job, /--maxWorkers=1 --no-file-parallelism --isolate --retry=0/);
  assert.match(job, /FORGEAX_WEBGPU_NODE: wgpu-native/);
  assert.match(job, /FORGEAX_REQUIRE_NATIVE_RAY_QUERY: '1'/);
  assert.match(
    job,
    /Verify Ray Query capture and bit-exact replay\n\s+if: matrix.group == 'foundation'/,
  );
  assert.match(job, /Upload failing native GI frames\n\s+if: failure\(\) \|\| cancelled\(\)/);
  assert.match(job, /artifacts\/irradiance-field\/dawn\/thin-wall-card-leak\.rhitape/);
  for (const feedback of ['direct', 'feedback'])
    for (const resolution of ['half', 'full'])
      assert.equal(
        job.split(
          `artifacts/irradiance-field/dawn/clipmap-hidden-field-${feedback}-${resolution}.rhitape`,
        ).length,
        2,
        'each cold-generation control must retain its captured native frame',
      );
  assert.match(job, /name: native-node-gi-\$\{\{ matrix.group \}\}-\$\{\{ runner.name \}\}/);
  assert.match(
    job,
    /name: native-node-gi-failing-frames-\$\{\{ matrix.group \}\}-\$\{\{ runner.name \}\}/,
  );
});
