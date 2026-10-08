import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const plannerPath = join(repoRoot, 'scripts', 'ci', 'build-app-shard.mjs');
const workflowPath = join(repoRoot, '.github', 'workflows', 'ci.yml');

test('browser probe preserves the verified shared-input contract gates', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const contract = readFileSync(
    join(repoRoot, 'scripts', 'ci', 'build-artifact-contract.json'),
    'utf8',
  );
  assert.match(workflow, /build-shared-app-inputs\.mjs/);
  assert.match(workflow, /input_fingerprint/);
  assert.match(workflow, /provenance-shared-app-inputs/);
  assert.match(contract, /shared-app-inputs/);
  assert.match(contract, /shared-engine-shaders/);
});

test('CI publishes one catalog projection and leaves app publication to each app owner', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const producer = workflow.slice(
    workflow.indexOf('  shared-app-inputs:'),
    workflow.indexOf('\n  app-shard-0:', workflow.indexOf('  shared-app-inputs:')),
  );
  assert.match(producer, /--catalog-only/);
  assert.doesNotMatch(producer, /--projection-out|shared-app-inputs-full/);
  assert.match(
    producer,
    /Pack shared app input projection[\s\S]*?shared-app-inputs-transfer\/shared-app-inputs\.tar\.gz[\s\S]*?name: shared-app-inputs-a\$\{\{ github\.run_attempt \}\}[\s\S]*?compression-level: 0/,
  );
  const planner = readFileSync(plannerPath, 'utf8');
  assert.match(
    planner,
    /\['--shared-input-manifest', resolve\(root, options\.sharedInputManifest\)\]/,
  );
  assert.doesNotMatch(planner, /catalog-only.*env|env: \{[\s\S]*process\.env/);
});

test('shared producer builds the union of all plugin closures once before invoking Vite', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const producer = workflow.slice(
    workflow.indexOf('  shared-app-inputs:'),
    workflow.indexOf('\n  app-shard-0:', workflow.indexOf('  shared-app-inputs:')),
  );
  const build = producer.indexOf('name: Build shared producer plugin dependencies');
  const invoke = producer.indexOf('node scripts/ci/build-shared-app-inputs.mjs');
  assert.ok(build >= 0);
  assert.ok(invoke > build);
  const closure = producer.slice(build, invoke);
  assert.equal([...closure.matchAll(/\bpnpm\b/g)].length, 1, 'common dependencies build once');
  for (const owner of ['vite-plugin-pack', 'vite-plugin-shader', 'audio-webaudio', 'gltf']) {
    assert.ok(closure.includes(`--filter @forgeax/engine-${owner}...`), `${owner} closure lost`);
  }
  assert.match(closure, /--filter @forgeax\/engine-gltf\.\.\. build/);
});

test('shared producer provisions wgpu-wasm before plugin closure', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const producer = workflow.slice(
    workflow.indexOf('  shared-app-inputs:'),
    workflow.indexOf('\n  app-shard-0:', workflow.indexOf('  shared-app-inputs:')),
  );
  const provision = producer.indexOf('uses: ./.github/actions/prepare-wgpu-wasm');
  const install = producer.indexOf('name: Install shared producer dependencies');
  const plugins = producer.indexOf('name: Build shared producer plugin dependencies');
  assert.ok(provision >= 0, 'shared producer must provision verified wgpu-wasm');
  assert.ok(install > provision, 'dependencies must install after wgpu-wasm provisioning');
  assert.ok(plugins > provision, 'plugin closure must build after wgpu-wasm provisioning');
  assert.match(producer.slice(provision, install), /GH_TOKEN: \$\{\{ secrets\.GHA \}\}/);
});

test('collectathon boot consumes the complete FBX WASM producer closure', () => {
  const contract = JSON.parse(
    readFileSync(join(repoRoot, 'scripts', 'ci', 'build-artifact-contract.json'), 'utf8'),
  );
  assert.deepEqual(contract.consumers['collectathon-boot-e2e'].requiredArtifactClasses, [
    'engine-dist',
    'wasm-runtime',
    'wasm-fbx',
    'shared-engine-shaders',
  ]);
  assert.deepEqual(contract.artifactClasses['wasm-fbx'].fileClasses, ['packages/fbx/pkg']);

  const workflow = readFileSync(workflowPath, 'utf8');
  const prerequisite = readFileSync(
    join(repoRoot, 'scripts', 'ci', 'build-editor-prerequisite.mjs'),
    'utf8',
  );
  const coreBuild = workflow.slice(
    workflow.indexOf('  core-build:'),
    workflow.indexOf('\n  shared-app-inputs:', workflow.indexOf('  core-build:')),
  );
  assert.match(coreBuild, /wasm-fbx\) source=packages\/fbx\/pkg/);
  assert.match(prerequisite, /'fbx-wasm': \['fbx-wasm\.mjs', 'fbx-wasm\.wasm'\]/);
});

function fixture(appNames) {
  const root = mkdtempSync(join(tmpdir(), 'app-shard-'));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  mkdirSync(join(root, 'apps'), { recursive: true });
  for (const name of appNames) {
    const appDir = join(root, 'apps', name);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: `@fixture/${name}`, scripts: { build: 'true' } }),
    );
    const shaders = join(appDir, 'dist', 'shaders');
    mkdirSync(shaders, { recursive: true });
    writeFileSync(join(shaders, 'manifest.json'), name);
    mkdirSync(join(appDir, 'report'), { recursive: true });
    writeFileSync(join(appDir, 'report', 'result.txt'), name);
  }
  return root;
}

function runPlanner(root, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [plannerPath, '--root', root, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    return {
      exitCode: error.status ?? 1,
      stdout: error.stdout?.toString().trim() ?? '',
      stderr: error.stderr?.toString().trim() ?? '',
    };
  }
}

function writePackRoster(root, app, guid) {
  mkdirSync(join(root, 'scripts', 'ci'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', 'ci', 'dawn-smoke-roster.json'),
    JSON.stringify({
      schemaVersion: 2,
      roots: ['apps'],
      entries: [
        {
          package: `@fixture/${app}`,
          path: `apps/${app}/package.json`,
          classification: 'run',
          gates: [
            {
              gateId: `${app}/smoke`,
              commandId: 'smoke',
              executionClass: 'sharded',
              commandSource: 'manifest-smokeInvocation',
              artifactRequirements: { packGuids: [guid] },
              commands: [{ commandId: 'smoke', source: 'manifest-smokeInvocation' }],
              oracle: { kind: 'frameReceipt', parserId: 'forgeax-smoke-receipt-v1' },
            },
          ],
        },
      ],
    }),
  );
}

function writePackFixture(root, { packageUrl = null, bodyPath = null } = {}) {
  const app = 'pbr';
  const guid = '019e4a26-3c29-7420-af5d-20f2724a16b0';
  const resolvedBodyPath = bodyPath ?? `${guid}-body.bin`;
  const appDir = join(root, 'apps', app);
  const dist = join(appDir, 'dist');
  mkdirSync(join(dist, 'shaders'), { recursive: true });
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({
      name: `@fixture/${app}`,
      scripts: { build: 'true' },
      forgeax: { smokeInvocation: `pnpm --filter @fixture/${app} smoke` },
    }),
  );
  writeFileSync(join(dist, 'shaders', 'manifest.json'), 'shader');
  const packName = `${guid}.pack-fixture.json`;
  const resolvedPackageUrl = packageUrl ?? `/assets/${packName}`;
  writeFileSync(
    join(dist, 'pack-index.json'),
    JSON.stringify([{ guid, packageUrl: resolvedPackageUrl }]),
  );
  writeFileSync(
    join(dist, 'assets', packName),
    JSON.stringify({
      schemaVersion: '2.0.0',
      assets: [{ guid, artifacts: { body: { path: resolvedBodyPath } } }],
    }),
  );
  writeFileSync(join(dist, 'assets', resolvedBodyPath), 'body');
  writePackRoster(root, app, guid);
}

function shardReport(root, index, count = 3) {
  const result = runPlanner(root, [
    '--shard-count',
    String(count),
    '--shard-index',
    String(index),
    '--dry-run',
  ]);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('t12: derives a stable exact-once roster across three shards', () => {
  const root = fixture(['zeta', 'alpha', 'gamma', 'beta', 'delta', 'epsilon']);
  try {
    const reports = [0, 1, 2].map((index) => shardReport(root, index));
    const covered = reports.flatMap((report) => report.apps).sort();
    assert.deepEqual(covered, ['alpha', 'beta', 'delta', 'epsilon', 'gamma', 'zeta']);
    assert.equal(new Set(covered).size, covered.length);
    assert.deepEqual(shardReport(root, 0), shardReport(root, 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t12: preserves exact-once coverage when the roster is not divisible by three', () => {
  const root = fixture(['five', 'one', 'four', 'two', 'three']);
  try {
    const reports = [0, 1, 2].map((index) => shardReport(root, index));
    assert.deepEqual(reports.flatMap((report) => report.apps).sort(), [
      'five',
      'four',
      'one',
      'three',
      'two',
    ]);
    assert.deepEqual(
      reports.map((report) => report.appCount),
      [2, 2, 1],
    );
    assert.equal(reports[0].loadImbalance, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t12: rejects an out-of-range shard index with a structured error', () => {
  const root = fixture(['one']);
  try {
    const result = runPlanner(root, ['--shard-count', '3', '--shard-index', '3', '--dry-run']);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).code, 'ci-app-shard-index-out-of-range');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared mode rejects a missing declared manifest instead of reading an implicit runner path', () => {
  const root = fixture(['one']);
  try {
    const result = runPlanner(root, [
      '--shard-count',
      '3',
      '--shard-index',
      '0',
      '--shared-input-manifest',
      'missing/manifest.json',
      '--dry-run',
    ]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).code, 'ci-app-shard-shared-input-missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t12: dry-run prints the assigned apps without invoking builds', () => {
  const root = fixture(['alpha', 'beta']);
  try {
    const result = runPlanner(root, ['--shard-count', '3', '--shard-index', '0', '--dry-run']);
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.apps, ['alpha']);
    assert.equal(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').includes('apps/*'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: skipped consumer-built apps are omitted from the shard payload', () => {
  const root = fixture(['alpha', 'beta']);
  try {
    const result = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--omit-transfer-app',
      'alpha',
      '--skip-build-app',
      'alpha',
      '--dry-run',
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.apps, ['alpha', 'beta']);
    assert.deepEqual(report.buildApps, ['beta']);
    assert.deepEqual(report.skippedBuildApps, ['alpha']);
    assert.deepEqual(report.transferApps, ['beta']);
    assert.deepEqual(report.artifactInventory, ['apps/beta/dist/shaders/manifest.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: skipping a build without omitting transfer fails closed', () => {
  const root = fixture(['alpha']);
  try {
    const result = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--skip-build-app',
      'alpha',
      '--dry-run',
    ]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).code, 'ci-app-shard-skip-build-transfer-required');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('consumer-built exclusions follow app assignment when the roster grows', () => {
  for (const names of [
    ['beta', 'gamma'],
    ['alpha', 'beta', 'gamma'],
  ]) {
    const root = fixture(names);
    try {
      const reports = [0, 1, 2].map((index) => {
        const result = runPlanner(root, [
          '--shard-count',
          '3',
          '--shard-index',
          String(index),
          '--omit-transfer-app',
          'beta',
          '--skip-build-app',
          'beta',
          '--dry-run',
        ]);
        assert.equal(result.exitCode, 0, result.stderr || result.stdout);
        return JSON.parse(result.stdout);
      });
      assert.deepEqual(
        reports.flatMap((report) => report.skippedBuildApps),
        ['beta'],
      );
      assert.deepEqual(
        reports.flatMap((report) => report.omittedTransferApps),
        ['beta'],
      );
      assert.deepEqual(
        reports.flatMap((report) => report.buildApps).sort(),
        names.filter((name) => name !== 'beta'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('global consumer-built exclusions reject unknown apps', () => {
  const root = fixture(['alpha']);
  try {
    for (const flag of ['--omit-transfer-app', '--skip-build-app']) {
      const result = runPlanner(root, [flag, 'missing', '--dry-run']);
      assert.notEqual(result.exitCode, 0);
      assert.equal(JSON.parse(result.stdout).app, 'missing');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t12b: derives deterministic repo-relative manifest inventories from every shard roster', () => {
  const root = fixture(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
  try {
    const reports = [0, 1, 2].map((index) => shardReport(root, index));
    const expected = reports.flatMap((report) =>
      report.apps.map((app) => `apps/${app}/dist/shaders/manifest.json`),
    );
    const inventory = reports.flatMap((report) => report.artifactInventory).sort();
    assert.deepEqual(inventory, expected.sort());
    assert.equal(new Set(inventory).size, inventory.length);
    for (const path of inventory) {
      assert.match(path, /^apps\/[^/]+\/dist\/shaders\/manifest\.json$/);
    }
    assert.deepEqual(
      shardReport(root, 0).artifactInventory,
      shardReport(root, 0).artifactInventory,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t12b: emits an empty inventory for an empty shard roster', () => {
  const root = fixture(['alpha']);
  try {
    assert.deepEqual(shardReport(root, 2).artifactInventory, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: projects only roster-declared Pack JSON and body closure from a fresh app dist', () => {
  const root = fixture([]);
  writePackFixture(root);
  const output = join(root, 'shard-output');
  try {
    const result = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--output-dir',
      output,
      '--dry-run',
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.artifactInventory.sort(), [
      'apps/pbr/dist/assets/019e4a26-3c29-7420-af5d-20f2724a16b0-body.bin',
      'apps/pbr/dist/assets/019e4a26-3c29-7420-af5d-20f2724a16b0.pack-fixture.json',
      'apps/pbr/dist/pack-index.json',
      'apps/pbr/dist/shaders/manifest.json',
    ]);
    assert.equal(existsSync(join(output, 'artifacts', 'apps', 'pbr', 'dist', 'assets')), true);
    assert.equal(
      existsSync(join(output, 'artifacts', 'apps', 'pbr', 'dist', 'assets', 'unused.bin')),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: fails closed when a roster-declared Pack path is unsafe or absent', () => {
  for (const options of [{ packageUrl: '../escape.json' }, { bodyPath: 'missing.bin' }]) {
    const root = fixture([]);
    writePackFixture(root, options);
    if (options.bodyPath === 'missing.bin')
      rmSync(join(root, 'apps', 'pbr', 'dist', 'assets', 'missing.bin'));
    try {
      const result = runPlanner(root, ['--shard-count', '1', '--shard-index', '0', '--dry-run']);
      assert.notEqual(result.exitCode, 0);
      assert.match(
        JSON.parse(result.stdout).code,
        /^(?:ci-app-shard-pack-unsafe-path|ci-app-shard-pack-body-missing)$/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('t15: writes only the assigned shard artifact paths to its report output', () => {
  const root = fixture(['alpha', 'beta', 'gamma']);
  const output = join(root, 'shard-output');
  try {
    const alphaManifest = join(root, 'apps', 'alpha', 'dist', 'shaders');
    mkdirSync(alphaManifest, { recursive: true });
    writeFileSync(join(alphaManifest, 'manifest.json'), 'alpha');
    const result = runPlanner(root, [
      '--shard-count',
      '3',
      '--shard-index',
      '0',
      '--output-dir',
      output,
      '--dry-run',
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(
      readFileSync(
        join(output, 'artifacts', 'apps', 'alpha', 'dist', 'shaders', 'manifest.json'),
        'utf8',
      ),
      'alpha',
    );
    assert.equal(existsSync(join(output, 'artifacts', 'apps', 'alpha', 'report')), false);
    assert.equal(existsSync(join(output, 'artifacts', 'apps', 'beta')), false);
    assert.equal(existsSync(join(output, 'artifacts', 'apps', 'gamma')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t15: compacts shared engine rows before uploading shard artifacts', () => {
  const root = fixture(['alpha']);
  const shared = join(root, 'shared-app-inputs');
  const sharedManifest = join(shared, 'shaders', 'manifest.json');
  mkdirSync(join(shared, 'shaders'), { recursive: true });
  writeFileSync(
    join(shared, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      producer: 'shared-app-inputs',
      payload: { engineShaderManifest: 'shared-app-inputs/shaders/manifest.json' },
    }),
  );
  writeFileSync(
    sharedManifest,
    JSON.stringify({
      entries: [{ hash: 'engine', wgsl: 'engine', bindings: '{}', glsl: '' }],
      materialShaders: [],
    }),
  );
  writeFileSync(
    join(root, 'apps', 'alpha', 'dist', 'shaders', 'manifest.json'),
    JSON.stringify({
      entries: [
        { hash: 'engine', wgsl: 'engine', bindings: '{}', glsl: '' },
        { hash: 'custom', wgsl: 'custom', bindings: '{}', glsl: '' },
      ],
      materialShaders: [],
    }),
  );
  const output = join(root, 'shard-output');
  try {
    const result = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--shared-input-manifest',
      'shared-app-inputs/manifest.json',
      '--output-dir',
      output,
      '--dry-run',
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const compact = JSON.parse(
      readFileSync(
        join(output, 'artifacts', 'apps', 'alpha', 'dist', 'shaders', 'manifest.json'),
        'utf8',
      ),
    );
    assert.equal(compact.forgeaxTransport, 'forgeax-app-shader-manifest-delta-v1');
    assert.deepEqual(
      compact.entries.map((entry) => entry.hash),
      ['custom'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('m2: DDC snapshot merge copies complete entries and excludes staging and leases', () => {
  const root = fixture(['alpha']);
  const snapshots = join(root, 'ddc-snapshots');
  const output = join(root, 'ddc-merged');
  mkdirSync(join(snapshots, '0', 'entries', 'aaaa'), { recursive: true });
  mkdirSync(join(snapshots, '0', 'staging', 'attempt'), { recursive: true });
  mkdirSync(join(snapshots, '0', 'lease'), { recursive: true });
  writeFileSync(join(snapshots, '0', 'entries', 'aaaa', 'integrity.json'), 'complete');
  writeFileSync(join(snapshots, '0', 'entries', 'aaaa', 'receipt.json'), 'receipt');
  writeFileSync(join(snapshots, '0', 'staging', 'attempt', 'payload.bin'), 'partial');
  writeFileSync(join(snapshots, '0', 'lease', 'lock'), 'lease');
  try {
    const result = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--merge-ddc',
      '--snapshots-dir',
      snapshots,
      '--ddc-output-dir',
      output,
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(output, 'entries', 'aaaa', 'integrity.json')), true);
    assert.equal(existsSync(join(output, 'staging')), false);
    assert.equal(existsSync(join(output, 'lease')), false);
    const second = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--merge-ddc',
      '--snapshots-dir',
      snapshots,
      '--ddc-output-dir',
      output,
    ]);
    assert.equal(second.exitCode, 0, second.stderr || second.stdout);
    assert.deepEqual(JSON.parse(second.stdout), JSON.parse(result.stdout));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('m2: DDC snapshot merge rejects an entry without receipt and integrity', () => {
  const root = fixture(['alpha']);
  const snapshots = join(root, 'ddc-snapshots');
  const output = join(root, 'ddc-merged');
  mkdirSync(join(snapshots, '0', 'entries', 'bbbb'), { recursive: true });
  writeFileSync(join(snapshots, '0', 'entries', 'bbbb', 'payload.json'), '{}');
  try {
    const result = runPlanner(root, [
      '--shard-count',
      '1',
      '--shard-index',
      '0',
      '--merge-ddc',
      '--snapshots-dir',
      snapshots,
      '--ddc-output-dir',
      output,
    ]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).code, 'ddc-snapshot-entry-incomplete');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: bounds each shard build with the shared machine-adaptive runner', () => {
  const planner = readFileSync(plannerPath, 'utf8');
  const runner = readFileSync(join(repoRoot, 'scripts', 'build-apps.mjs'), 'utf8');
  assert.match(planner, /sharedInputManifest/);
  assert.match(planner, /--shared-input-manifest/);
  assert.match(runner, /process\.argv\.indexOf\('--shared-input-manifest'\)/);
  assert.match(runner, /appBuildConcurrency\(\{ cpus, memoryBytes \}\)/);
  assert.match(runner, /running\.size < maxConcurrent/);
  assert.match(runner, /const sampler = createProcessSampler\(\)/);
  assert.match(runner, /setInterval\(sample, 1_000\)/);
  assert.doesNotMatch(runner, /setInterval\(sample, 250\)/);
  assert.match(runner, /FORGEAX_VITE_REPORT_COMPRESSED_SIZE: '0'/);
  assert.match(runner, /shaderManifestMode: appShardShaderDelta \? 'app-shard-delta' : 'full'/);
  assert.match(planner, /'--app-shard-shader-delta'/);
  assert.match(runner, /createViteBuildInvocation/);
  assert.match(runner, /FORGEAX_SHARED_APP_INPUTS_MANIFEST: sharedInputManifest/);
  assert.match(runner, /runApp\([\s\S]*appBuildEnv/);
  const workflow = readFileSync(workflowPath, 'utf8');
  for (const shardIndex of [0, 1, 2]) {
    const start = workflow.indexOf(`  app-shard-${shardIndex}:`);
    const end = workflow.indexOf(`\n  app-shard-${shardIndex + 1}:`, start);
    const shard = workflow.slice(start, end === -1 ? undefined : end);
    assert.match(shard, new RegExp(`Build shard apps[\\s\\S]*?--shard-index ${shardIndex}`));
  }
  for (const shardIndex of [0, 1, 2]) {
    const shardStart = workflow.indexOf(`  app-shard-${shardIndex}:`);
    const shardEnd = workflow.indexOf(`\n  app-shard-${shardIndex + 1}:`, shardStart);
    const shard = workflow.slice(shardStart, shardEnd === -1 ? undefined : shardEnd);
    assert.match(
      shard,
      /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "heavy"\]'\) \}\}/,
      `app-shard-${shardIndex} must use the heavy runner pool`,
    );
    assert.match(
      shard,
      /Verify heavy runner capacity[\s\S]*--pool heavy/,
      `app-shard-${shardIndex} must verify heavy runner capacity`,
    );
  }
  for (const index of [0, 1, 2]) {
    const start = workflow.indexOf(`  app-shard-${index}:`);
    const shard = workflow.slice(start).split(/\n {2}[\w-]+:/)[0];
    assert.match(shard, /--omit-transfer-app learn-render\/3\.model-loading\/1\.model-loading/);
    assert.match(shard, /--skip-build-app learn-render\/3\.model-loading\/1\.model-loading/);
  }
  const smokeStart = workflow.indexOf('  smoke-fleet:');
  const smoke = workflow.slice(smokeStart);
  assert.doesNotMatch(smoke, /Build consumer-owned Sponza smoke app/);
  assert.match(
    smoke,
    /Hello-learn-render-3-model-loading smoke[\s\S]*?pnpm --filter [^\n]*3-model-loading-1-model-loading[^\n]* build[\s\S]*?pnpm --filter [^\n]*3-model-loading-1-model-loading[^\n]* smoke/,
  );
  assert.doesNotMatch(workflow, /FORGEAX_BUILD_CONCURRENCY/);
});

test('repair: scrubs persistent runner auth before every shard checkout', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const shardJobs = ['app-shard-0', 'app-shard-1', 'app-shard-2'];
  for (const job of shardJobs) {
    const jobStart = workflow.indexOf(`  ${job}:`);
    assert.notEqual(jobStart, -1, `missing ${job}`);
    const jobEnd = workflow.indexOf('\n  app-shard-', jobStart + 1);
    const section = workflow.slice(jobStart, jobEnd === -1 ? undefined : jobEnd);
    assert.match(
      section,
      /Scrub stale global\/system git auth header \(self-hosted\)[\s\S]*?actions\/checkout@v5/,
      `${job} must scrub stale auth before checkout`,
    );
  }
});

test('repair: every app shard uses authenticated source checkout and pinned asset recovery', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  for (const shardIndex of [0, 1, 2]) {
    const start = workflow.indexOf(`  app-shard-${shardIndex}:`);
    const end = workflow.indexOf(`\n  app-shard-${shardIndex + 1}:`, start);
    const shard = workflow.slice(start, end === -1 ? undefined : end);
    assert.match(shard, /actions\/checkout@v5[\s\S]*?submodules: false/);
    assert.match(
      shard,
      /Restore pinned assets checkout[\s\S]*?node scripts\/ci\/prepare-assets-checkout\.mjs/,
    );
    assert.match(shard, /actions\/checkout@v5[\s\S]*?token: \$\{\{ secrets\.GHA \}\}/);
    assert.doesNotMatch(shard, /Materialize pinned app asset sources/);
    assert.doesNotMatch(shard, /git submodule update --init --recursive/);
  }
});

test('repair: shards optionally restore exact producer IDs with bounded source recovery', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(
    workflow,
    /core_artifact_id: \$\{\{ steps\.upload-core-build\.outputs\.artifact-id \}\}/,
  );
  for (const shardIndex of [0, 1, 2]) {
    const start = workflow.indexOf(`  app-shard-${shardIndex}:`);
    const end = workflow.indexOf(`\n  app-shard-${shardIndex + 1}:`, start);
    const shard = workflow.slice(start, end === -1 ? undefined : end);
    assert.match(
      shard,
      /node scripts\/ci\/prepare-ci-inputs\.mjs[\s\S]*?--artifact-ids "\$\{\{ needs\.core-build\.outputs\.core_artifact_id \}\}"/,
      `app-shard-${shardIndex} must pass every successful core job output by exact ID`,
    );
    assert.doesNotMatch(shard, /--stagger-seconds/);
    for (const artifact of ['engine-dist', 'wasm-runtime', 'wasm-fbx', 'wasm-codec']) {
      assert.doesNotMatch(
        shard,
        new RegExp(`name: ${artifact}-core-build-a\\$\\{\\{ github\\.run_attempt \\}\\}`),
        `${artifact} must not infer the producer attempt from the rerun shard attempt`,
      );
      assert.doesNotMatch(
        shard,
        new RegExp(`pattern: ${artifact}-core-build-a\\*`),
        `${artifact} must not merge payloads from multiple core attempts`,
      );
    }
    assert.match(shard, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    assert.ok(
      shard.includes('permissions:\n      actions: read\n      contents: read'),
      `app-shard-${shardIndex} must retain read-only REST artifact access`,
    );
  }
});

test('repair: shards verify shared inputs against the producer output and build-artifacts merges its provenance', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(
    workflow,
    /shared-app-inputs:[\s\S]*?outputs:[\s\S]*?input_fingerprint: \$\{\{ steps\.build-shared-inputs\.outputs\.input_fingerprint \}\}[\s\S]*?shared_artifact_id: \$\{\{ steps\.upload-shared-inputs\.outputs\.artifact-id \}\}/,
  );
  assert.match(workflow, /--github-output "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /id: upload-shared-inputs/);
  assert.equal(
    (workflow.match(/^ {10}name: shared-app-inputs-a\$\{\{ github\.run_attempt \}\}/gm) ?? [])
      .length,
    1,
  );
  assert.doesNotMatch(workflow, /shared-app-inputs-full/);
  assert.match(
    workflow,
    /provenance_payload: \$\{\{ steps\.write-shared-provenance\.outputs\.payload \}\}/,
  );
  assert.doesNotMatch(workflow, /name: Upload shared producer provenance record/);
  assert.doesNotMatch(workflow, /provenance_artifact_id/);
  assert.match(
    workflow,
    /build-artifacts:[\s\S]*?needs: \[core-build, shared-app-inputs, app-shard-0, app-shard-1, app-shard-2\]/,
  );
  assert.doesNotMatch(
    workflow,
    /JSON\.parse\(require\('node:fs'\)\.readFileSync\('shared-app-inputs\/manifest\.json'\)\)\.inputFingerprint/,
  );
  for (const shardIndex of [0, 1, 2]) {
    const start = workflow.indexOf(`  app-shard-${shardIndex}:`);
    const end = workflow.indexOf(`\n  app-shard-${shardIndex + 1}:`, start);
    const shard = workflow.slice(start, end === -1 ? undefined : end);
    assert.match(
      shard,
      /--input-fingerprint "\$\{\{ needs\.shared-app-inputs\.outputs\.input_fingerprint \}\}"/,
    );
    assert.match(
      shard,
      /prepare-ci-inputs\.mjs[\s\S]*?--shared-artifact-id "\$\{\{ needs\.shared-app-inputs\.outputs\.shared_artifact_id \}\}"/,
    );
    assert.match(shard, /Prepare verified CI inputs/);
    assert.doesNotMatch(
      shard,
      /name: shared-(?:asset-pack|engine-shaders)-a\$\{\{ github\.run_attempt \}\}/,
    );
  }
});

test('each input consumer names the preparation owner and exact producer IDs', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const contract = JSON.parse(
    readFileSync(join(repoRoot, 'scripts/ci/build-artifact-contract.json')),
  );
  for (const row of contract.timingRoster.filter((row) => !row.notApplicable)) {
    const start = workflow.indexOf(`  ${row.jobIdentity}:`);
    const remaining = workflow.slice(start);
    const next = remaining.slice(1).search(/\n {2}[a-z][\w-]+:/);
    const section = remaining.slice(0, next === -1 ? undefined : next + 1);
    assert.match(section, /(?:prepare-ci-inputs|download-artifact-with-retry)\.mjs/);
    assert.match(section, /--artifact-ids "\$\{\{ needs\./);
    assert.match(section, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  }
});

test('Bevy smoke fleet does not hydrate app-dist archives it rebuilds locally', () => {
  const contract = JSON.parse(
    readFileSync(join(repoRoot, 'scripts', 'ci', 'build-artifact-contract.json'), 'utf8'),
  );
  assert.deepEqual(contract.consumers['bevy-smoke-fleet'].requiredArtifactClasses, [
    'engine-dist',
    'wasm-runtime',
    'shared-engine-shaders',
  ]);

  const workflow = readFileSync(workflowPath, 'utf8');
  const start = workflow.indexOf('  bevy-smoke-fleet:\n');
  const end = workflow.indexOf('\n  bevy-smoke-fleet-required-context:', start);
  const bevy = workflow.slice(start, end);
  assert.match(bevy, /needs\.core-build\.outputs\.core_artifact_id/);
  assert.match(bevy, /pnpm bevy:smokes[\s\S]*--concurrency auto/);
  assert.match(bevy, /app-dist-0\/1\/2[\s\S]*duplicate/);
});

test('metrics run independently while complete CI still requires Smoke', () => {
  const contract = JSON.parse(
    readFileSync(join(repoRoot, 'scripts', 'ci', 'build-artifact-contract.json'), 'utf8'),
  );
  for (const consumer of [
    'metrics-validate-browser',
    'metrics-validate-runtime',
    'metrics-validate',
  ]) {
    assert.deepEqual(contract.consumers[consumer].requiredArtifactClasses, [
      'engine-dist',
      'wasm-runtime',
      'shared-engine-shaders',
    ]);
    assert.ok(contract.sharedInputs.readOnlyConsumers.includes(consumer));
  }

  const workflow = readFileSync(workflowPath, 'utf8');
  const sectionFor = (job, nextJob) => {
    const start = workflow.indexOf(`  ${job}:`);
    const end = workflow.indexOf(`\n  ${nextJob}:`, start);
    assert.ok(start >= 0, `${job} job must exist`);
    assert.ok(end > start, `${job} job must precede ${nextJob}`);
    return workflow.slice(start, end);
  };
  const browser = sectionFor('metrics-validate-browser', 'metrics-validate-runtime');
  const runtime = sectionFor('metrics-validate-runtime', 'metrics-validate');
  const stableJoin = sectionFor('metrics-validate', 'collectathon-boot-e2e');
  assert.match(
    browser,
    /needs: \[core-build, shared-app-inputs, post-merge-gate, webkit-fallback\]/,
  );
  assert.match(
    runtime,
    /needs: \[core-build, shared-app-inputs, post-merge-gate, bevy-smoke-fleet\]/,
  );
  assert.match(runtime, /needs\.bevy-smoke-fleet\.result == 'success'/);
  assert.doesNotMatch(runtime, /needs\.smoke-fleet\./);
  assert.doesNotMatch(browser, /needs\.smoke-fleet\./);
  assert.match(browser, /needs\.shared-app-inputs\.result == 'success'/);
  assert.doesNotMatch(stableJoin, /needs\.smoke-fleet\./);
  assert.match(
    workflow,
    /needs: \[build-artifacts, primary-pnpm,[^\n]*smoke-fleet[^\n]*metrics-validate/,
  );
  assert.match(
    stableJoin,
    /needs: \[core-build, shared-app-inputs, post-merge-gate, metrics-validate-browser, metrics-validate-runtime\]/,
  );
  for (const section of [browser, runtime, stableJoin]) {
    assert.match(
      section,
      /--artifact-ids "\$\{\{ needs\.core-build\.outputs\.core_artifact_id \}\}"/,
    );
    assert.doesNotMatch(section, /needs\.build-artifacts\.outputs\./);
    assert.doesNotMatch(section, /needs: \[build-artifacts/);
    assert.match(
      section,
      /--shared-artifact-id "\$\{\{ needs\.shared-app-inputs\.outputs\.shared_artifact_id \}\}"/,
    );
    assert.match(
      section,
      /--input-fingerprint "\$\{\{ needs\.shared-app-inputs\.outputs\.input_fingerprint \}\}"/,
    );
  }
  for (const section of [browser, runtime]) {
    assert.match(section, / {4}env:\n {6}FORGEAX_SHARED_APP_INPUTS_MANIFEST:/);
    assert.doesNotMatch(section, /FORGEAX_ENGINE_SHADER_SOURCE_BUILD: ['"]?1/);
  }
  assert.match(browser, /--stage --producer browser/);
  assert.match(runtime, /--stage --producer runtime/);
  assert.match(
    stableJoin,
    /--merge[\s\S]*--browser metrics-validate-browser-evidence[\s\S]*--runtime metrics-validate-runtime-evidence/,
  );
  assert.match(
    stableJoin,
    /name: Build VFX metric fixture\n\s+env:\n\s+FORGEAX_SHARED_APP_INPUTS_MANIFEST:.*shared-app-inputs\/manifest.json\n\s+run: pnpm --filter @forgeax\/hello-boss-lightning build/,
  );
  assert.match(
    stableJoin,
    /name: Detect lavapipe ICD \(for generic Dawn metrics\)[\s\S]*?VK_ICD_FILENAMES=\$ICD_PATH[\s\S]*?VK_DRIVER_FILES=\$ICD_PATH[\s\S]*?name: Run metrics generic runner/,
  );
  assert.match(browser, /name: metrics-validate-browser-evidence-a[\s\S]*?retention-days: 1/);
  assert.match(runtime, /name: metrics-validate-runtime-evidence-a[\s\S]*?retention-days: 1/);
  assert.match(stableJoin, /name: metrics-report[\s\S]*?retention-days: 1/);
  assert.match(stableJoin, /name: metrics-report/);
});

test('repair: portability-bun owns only core artifact classes', () => {
  const contract = JSON.parse(
    readFileSync(join(repoRoot, 'scripts', 'ci', 'build-artifact-contract.json'), 'utf8'),
  );
  assert.deepEqual(contract.consumers['portability-bun'].requiredArtifactClasses, [
    'engine-dist',
    'wasm-runtime',
    'shared-engine-shaders',
  ]);

  const workflow = readFileSync(workflowPath, 'utf8');
  const start = workflow.indexOf('  portability-bun:');
  const end = workflow.indexOf('\n  metrics-validate:', start);
  const section = workflow.slice(start, end);
  assert.match(
    section,
    /--artifact-ids "\$\{\{ needs\.build-artifacts\.outputs\.artifact_ids_portability_bun \}\}"/,
  );
  assert.doesNotMatch(section, /needs\.build-artifacts\.outputs\.artifact_ids"/);
});

test('repair: aggregate producers use exact artifact IDs with bounded retry transport', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const sections = [
    {
      job: 'build-artifacts',
      ids: 'needs\\.app-shard-0\\.outputs\\.app_report_artifact_id.*needs\\.app-shard-1\\.outputs\\.app_report_artifact_id.*needs\\.app-shard-2\\.outputs\\.app_report_artifact_id',
      path: 'shard-reports',
    },
    {
      job: 'cache-warm',
      ids: 'needs\\.app-shard-0\\.outputs\\.app_ddc_artifact_id.*needs\\.app-shard-1\\.outputs\\.app_ddc_artifact_id.*needs\\.app-shard-2\\.outputs\\.app_ddc_artifact_id',
      path: 'ddc-snapshots',
    },
  ];
  for (const { job, ids, path } of sections) {
    const start = workflow.indexOf(`  ${job}:`);
    const remaining = workflow.slice(start);
    const nextJob = remaining.slice(1).search(/\n {2}[a-z][\w-]+:/);
    const section = remaining.slice(0, nextJob === -1 ? undefined : nextJob + 1);
    assert.match(section, /permissions:\n {6}actions: read\n {6}contents: read/);
    assert.match(section, /node scripts\/ci\/download-artifact-with-retry\.mjs/);
    assert.match(section, new RegExp(ids), `${job} must list every shard producer ID`);
    assert.match(section, new RegExp(`--path ${path}`));
    assert.doesNotMatch(section, /actions\/download-artifact/);
  }
});

test('repair: trusted coverage owns the perf ratio gate outside instrumentation', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const sectionFor = (job) => {
    const start = workflow.indexOf(`  ${job}:`);
    const remaining = workflow.slice(start);
    const nextJob = remaining.slice(1).search(/\n {2}[a-z][\w-]+:/);
    return remaining.slice(0, nextJob === -1 ? undefined : nextJob + 1);
  };
  const coverage = sectionFor('coverage-pnpm-shard');
  const perf = sectionFor('coverage-perf');
  assert.match(
    coverage,
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "heavy"\]'\) \}\}/,
  );
  assert.doesNotMatch(coverage, /github\.event\.pull_request\.head\.repo/);
  assert.match(coverage, /node scripts\/ci\/run-split-vitest-coverage\.mjs/);
  assert.match(coverage, /--group-size=8/);
  assert.match(coverage, /--group-concurrency=auto/);
  assert.match(coverage, /--max-workers=1/);
  assert.doesNotMatch(coverage, /--skip-typecheck/);
  assert.doesNotMatch(coverage, /--project=ecs-perf/);
  assert.match(perf, /name: ECS performance ratio gates \(uninstrumented\)/);
  assert.match(perf, /--project=ecs-perf/);
});

test('repair: core consumers hydrate exact IDs without the app aggregate barrier', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  for (const job of ['vitest-dawn', 'webkit-fallback']) {
    const start = workflow.indexOf(`  ${job}:`);
    assert.notEqual(start, -1, `missing ${job}`);
    const remaining = workflow.slice(start);
    const nextJob = remaining.slice(1).search(/\n {2}[a-z][\w-]+:/);
    const section = remaining.slice(0, nextJob === -1 ? undefined : nextJob + 1);
    assert.match(section, /needs: \[core-build, shared-app-inputs, post-merge-gate\]/);
    assert.match(section, /needs\.shared-app-inputs\.result == 'success'/);
    assert.match(section, /needs\.core-build\.result == 'success'/);
    assert.match(
      section,
      /--artifact-ids "\$\{\{ needs\.core-build\.outputs\.core_artifact_id \}\}"/,
    );
    assert.doesNotMatch(section, /needs: \[build-artifacts/);
    assert.doesNotMatch(section, /needs\.build-artifacts\.outputs/);
  }
});

test('repair: main release publishers consume their exact core artifact without the app barrier', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  for (const job of [
    'publish-fbx-wasm-release',
    'publish-wgpu-wasm-release',
    'publish-basis-wasm-release',
  ]) {
    const start = workflow.indexOf(`  ${job}:`);
    assert.notEqual(start, -1, `missing ${job}`);
    const remaining = workflow.slice(start);
    const nextJob = remaining.slice(1).search(/\n {2}[a-z][\w-]+:/);
    const section = remaining.slice(0, nextJob === -1 ? undefined : nextJob + 1);
    assert.match(section, /needs: core-build/, `${job} must wait only for its producer`);
    assert.match(
      section,
      /node scripts\/ci\/download-artifact-with-retry\.mjs[\s\S]*?--artifact-ids "\$\{\{ needs\.core-build\.outputs\.core_artifact_id \}\}" --path build-output\//,
      `${job} must hydrate its successful core upload by exact ID`,
    );
    assert.match(section, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(section, /permissions:\n {6}actions: read\n {6}contents: write/);
    assert.doesNotMatch(section, /needs: build-artifacts/);
    assert.doesNotMatch(section, /actions\/download-artifact/);
  }
});

test('repair: stages core classes at their consumer extraction roots', () => {
  const root = fixture([]);
  try {
    const workflow = readFileSync(workflowPath, 'utf8');
    assert.equal(workflow.includes('path: ci-artifacts/core'), true);
    assert.equal(workflow.includes('name: engine-dist\n          path: packages/*/dist'), false);
    assert.equal(
      workflow.includes('name: wasm-runtime\n          path: packages/wgpu-wasm/pkg'),
      false,
    );
    assert.equal(workflow.includes('name: wasm-fbx\n          path: packages/fbx/pkg'), false);
    assert.equal(workflow.includes('name: wasm-codec\n          path: packages/codec/pkg'), false);

    const sources = {
      'packages/runtime/dist/index.mjs': 'runtime',
      'packages/wgpu-wasm/pkg/wgpu_wasm.js': 'wgpu',
      'packages/fbx/pkg/fbx-wasm.mjs': 'fbx',
      'packages/codec/pkg/basis.mjs': 'codec',
    };
    for (const [relative, contents] of Object.entries(sources)) {
      const source = join(root, relative);
      mkdirSync(join(source, '..'), { recursive: true });
      writeFileSync(source, contents);
    }

    const classes = [
      ['engine-dist', 'packages'],
      ['wasm-runtime', 'packages/wgpu-wasm/pkg'],
      ['wasm-fbx', 'packages/fbx/pkg'],
      ['wasm-codec', 'packages/codec/pkg'],
    ];
    const extraction = join(root, 'download');
    for (const [, source] of classes) {
      const stage = join(root, 'ci-artifacts', 'core', source);
      mkdirSync(join(stage, '..'), { recursive: true });
      cpSync(join(root, source), stage, { recursive: true });
    }
    const archive = join(root, 'core.tar');
    execFileSync('tar', ['-C', join(root, 'ci-artifacts', 'core'), '-cf', archive, '.']);
    mkdirSync(extraction, { recursive: true });
    execFileSync('tar', ['-C', extraction, '-xf', archive]);

    for (const relative of Object.keys(sources)) {
      assert.equal(existsSync(join(extraction, relative)), true, relative);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: packages each shard at the extraction root with pairwise-disjoint app payloads', () => {
  const root = fixture(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']);
  try {
    const workflow = readFileSync(workflowPath, 'utf8');
    assert.equal(workflow.includes('path: shard-transfer'), true);
    assert.equal(
      workflow.match(
        /Stage shard transfer artifact[\s\S]*?rm -rf shard-transfer[\s\S]*?cp -a shard-output\/artifacts/g,
      )?.length,
      3,
      'each shard must clear its reused transfer directory before staging a new payload',
    );
    assert.equal(
      workflow.match(
        /cp -a node_modules\/\.cache\/forgeax-ddc shard-ddc-transfer\/ddc[\s\S]*?rm -f shard-ddc-transfer\/ddc\/ddc-warm-status\.json/g,
      )?.length,
      3,
      'shard DDC transfers must exclude merged DDC status from each payload',
    );
    assert.equal(
      workflow.match(/path: shard-report-transfer/g)?.length,
      3,
      'shard reports must have a dedicated lightweight transfer artifact',
    );
    assert.equal(
      workflow.includes('shard-output/artifacts/apps/*/dist/shaders/manifest.json'),
      false,
    );
    assert.equal(workflow.includes('shard-output/artifacts/apps/*/report'), false);
    for (const app of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
      const manifest = join(root, 'apps', app, 'dist', 'shaders');
      mkdirSync(manifest, { recursive: true });
      writeFileSync(join(manifest, 'manifest.json'), app);
      mkdirSync(join(root, 'apps', app, 'report'), { recursive: true });
      writeFileSync(join(root, 'apps', app, 'report', 'result.txt'), app);
    }

    const extractedInventories = [];
    for (const shardIndex of [0, 1, 2]) {
      const output = join(root, `shard-output-${shardIndex}`);
      const result = runPlanner(root, [
        '--shard-count',
        '3',
        '--shard-index',
        String(shardIndex),
        '--output-dir',
        output,
        '--dry-run',
      ]);
      assert.equal(result.exitCode, 0, result.stderr || result.stdout);

      const archive = join(root, `app-shard-${shardIndex}.tar`);
      const extraction = join(root, `download-${shardIndex}`);
      // Mirrors upload-artifact's archive root: the staged artifacts directory
      // itself is the payload, so consumers receive apps/ at their repo root.
      execFileSync('tar', ['-C', join(output, 'artifacts'), '-cf', archive, '.']);
      mkdirSync(extraction, { recursive: true });
      execFileSync('tar', ['-C', extraction, '-xf', archive]);

      const report = JSON.parse(result.stdout);
      for (const relative of report.artifactInventory) {
        assert.equal(existsSync(join(extraction, relative)), true, relative);
        assert.equal(existsSync(join(extraction, 'shard-output', 'artifacts', relative)), false);
      }
      extractedInventories.push(report.artifactInventory);
    }

    const allPaths = extractedInventories.flat();
    assert.equal(
      new Set(allPaths).size,
      allPaths.length,
      'shard payloads must be pairwise disjoint',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t14: merges snapshots, reports cold-path state, and skips an exact cache hit', () => {
  const root = fixture([]);
  const snapshots = join(root, 'snapshots');
  const output = join(root, 'ddc');
  try {
    for (const [index, value] of ['zero', 'one', 'two'].entries()) {
      const directory = join(snapshots, String(index));
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${value}.cache`), value);
    }
    const saved = runPlanner(root, [
      '--merge-ddc',
      '--snapshots-dir',
      snapshots,
      '--ddc-output-dir',
      output,
      '--shard-count',
      '3',
    ]);
    assert.equal(saved.exitCode, 0, saved.stderr || saved.stdout);
    assert.deepEqual(JSON.parse(saved.stdout), {
      outcome: 'saved',
      availableSnapshots: 3,
      shardCount: 3,
      nextRunWouldHit: true,
    });
    assert.equal(readFileSync(join(output, 'zero.cache'), 'utf8'), 'zero');
    assert.equal(readFileSync(join(output, 'one.cache'), 'utf8'), 'one');
    assert.equal(readFileSync(join(output, 'two.cache'), 'utf8'), 'two');

    const partialSnapshots = join(root, 'partial-snapshots');
    mkdirSync(join(partialSnapshots, '0'), { recursive: true });
    writeFileSync(join(partialSnapshots, '0', 'partial.cache'), 'partial');
    const partial = runPlanner(root, [
      '--merge-ddc',
      '--snapshots-dir',
      partialSnapshots,
      '--ddc-output-dir',
      output,
      '--shard-count',
      '3',
    ]);
    assert.equal(partial.exitCode, 0, partial.stderr || partial.stdout);
    assert.deepEqual(JSON.parse(partial.stdout), {
      outcome: 'partial',
      availableSnapshots: 1,
      shardCount: 3,
      nextRunWouldHit: true,
    });
    assert.equal(readFileSync(join(output, 'partial.cache'), 'utf8'), 'partial');

    const hit = runPlanner(root, ['--merge-ddc', '--cache-hit', '--ddc-output-dir', output]);
    assert.equal(hit.exitCode, 0, hit.stderr || hit.stdout);
    assert.deepEqual(JSON.parse(hit.stdout), {
      outcome: 'skipped',
      availableSnapshots: 0,
      shardCount: 3,
      nextRunWouldHit: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// PR consumers can recover acceleration inputs from source. Main publication
// requires the exact producer bytes, so a failed upload must fail its owner.
test('core transfer is mandatory for main WASM publication', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const upload = workflow
    .split('- name: Upload core build transfer artifact')[1]
    .split('- name:')[0];
  assert.match(
    upload,
    /required: \$\{\{ github.event_name == 'push' && github.ref == 'refs\/heads\/main' && 'true' \|\| 'false' \}\}/,
  );
});
