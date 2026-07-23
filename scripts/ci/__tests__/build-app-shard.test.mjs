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

test('shared producer builds both plugin dependency closures before invoking Vite', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const producer = workflow.slice(
    workflow.indexOf('  shared-app-inputs:'),
    workflow.indexOf('\n  app-shard-0:', workflow.indexOf('  shared-app-inputs:')),
  );
  const build = producer.indexOf('name: Build shared producer plugin dependencies');
  const invoke = producer.indexOf('node scripts/ci/build-shared-app-inputs.mjs');
  assert.ok(build >= 0, 'shared producer must build plugin dependencies');
  assert.ok(invoke > build, 'shared producer must build plugins before invoking the producer');
  assert.match(
    producer.slice(build, invoke),
    /pnpm --filter @forgeax\/engine-vite-plugin-pack\.\.\. build/,
  );
  assert.match(
    producer.slice(build, invoke),
    /pnpm --filter @forgeax\/engine-vite-plugin-shader\.\.\. build/,
  );
});

test('shared producer provisions wgpu-wasm before plugin closure', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const producer = workflow.slice(
    workflow.indexOf('  shared-app-inputs:'),
    workflow.indexOf('\n  app-shard-0:', workflow.indexOf('  shared-app-inputs:')),
  );
  const cache = producer.indexOf('name: Cache wgpu-wasm pkg/ (content-keyed)');
  const provision = producer.indexOf(
    'name: Build wgpu-wasm (release/cache first, compile only if absent)',
  );
  const install = producer.indexOf('name: Install shared producer dependencies');
  const plugins = producer.indexOf('name: Build shared producer plugin dependencies');
  assert.ok(cache >= 0, 'shared producer must cache wgpu-wasm');
  assert.ok(provision > cache, 'wgpu-wasm build must follow its cache step');
  assert.ok(provision >= 0, 'shared producer must provision wgpu-wasm');
  assert.ok(install > provision, 'dependencies must install after wgpu-wasm provisioning');
  assert.ok(plugins > provision, 'plugin closure must build after wgpu-wasm provisioning');
  assert.match(producer.slice(cache, provision), /actions\/cache@v5/);
  assert.match(producer.slice(provision, install), /ensure-wasm\.mjs/);
  assert.match(producer.slice(provision, install), /bash packages\/wgpu-wasm\/build\.sh/);
  assert.match(producer.slice(provision, install), /GH_TOKEN: \$\{\{ secrets\.GHA \}\}/);
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

test('repair: bounds each shard build with the shared machine-adaptive runner', () => {
  const planner = readFileSync(plannerPath, 'utf8');
  const runner = readFileSync(join(repoRoot, 'scripts', 'build-apps.mjs'), 'utf8');
  assert.match(planner, /sharedInputManifest/);
  assert.match(planner, /--shared-input-manifest/);
  assert.match(runner, /const sharedManifestIndex = process\.argv\.indexOf/);
  assert.match(runner, /apps\.flatMap\(\(app\) => \['--filter', `\.\/apps\/\$\{app\}`\]\)/);
  assert.match(runner, /--workspace-concurrency=\$\{n\}/);
  const workflow = readFileSync(workflowPath, 'utf8');
  for (const shardIndex of [0, 1, 2]) {
    assert.match(
      workflow,
      new RegExp(
        `Build shard apps\\n        run: node scripts/ci/build-app-shard\\.mjs --shard-count 3 --shard-index ${shardIndex}`,
      ),
    );
  }
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

test('repair: shards hydrate successful core artifact IDs with deterministic transport staggering', () => {
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
      /node scripts\/ci\/download-artifact-with-retry\.mjs[\s\S]*?--artifact-ids "\$\{\{ needs\.core-build\.outputs\.core_artifact_id \}\}"[\s\S]*?--stagger-seconds /,
      `app-shard-${shardIndex} must pass every successful core job output by exact ID`,
    );
    assert.match(
      shard,
      new RegExp(`--stagger-seconds ${shardIndex * 10}`),
      `app-shard-${shardIndex} must have its deterministic transfer start`,
    );
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
    (workflow.match(/name: shared-app-inputs-a\$\{\{ github\.run_attempt \}\}/g) ?? []).length,
    1,
  );
  assert.match(workflow, /name: provenance-shared-app-inputs-a\$\{\{ github\.run_attempt \}\}/);
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
      /download-artifact-with-retry\.mjs[\s\S]*?--artifact-ids "\$\{\{ needs\.shared-app-inputs\.outputs\.shared_artifact_id \}\}"[\s\S]*?--path shared-app-inputs/,
    );
    assert.match(shard, /Hydrate declared shared app inputs/);
    assert.match(shard, /download-artifact-with-retry\.mjs/);
    assert.doesNotMatch(
      shard,
      /name: shared-(?:asset-pack|engine-shaders)-a\$\{\{ github\.run_attempt \}\}/,
    );
  }
});

test('repair: every build-artifact consumer uses the verified retry transport', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  for (const [job, output] of [
    ['primary-pnpm', 'artifact_ids'],
    ['coverage-pnpm', 'artifact_ids'],
    ['vitest-browser', 'artifact_ids'],
    ['smoke-fleet', 'artifact_ids'],
    ['bevy-smoke-fleet', 'artifact_ids'],
    ['portability-bun', 'artifact_ids'],
    ['metrics-validate', 'artifact_ids'],
    ['collectathon-boot-e2e', 'artifact_ids'],
  ]) {
    const start = workflow.indexOf(`  ${job}:`);
    const remaining = workflow.slice(start);
    const nextJob = remaining.search(/\n {2}[a-z][\w-]+:/);
    const section = remaining.slice(0, nextJob === -1 ? undefined : nextJob);
    assert.match(
      section,
      new RegExp(
        `node scripts/ci/download-artifact-with-retry\\.mjs[\\s\\S]*?--artifact-ids "\\$\\{\\{ needs\\.build-artifacts\\.outputs\\.${output} \\}\\}" --path \\.`,
      ),
      `${job} must hydrate exact build-artifact IDs through the verified retry transport`,
    );
    assert.match(section, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(section, /permissions:\n {6}actions: read\n {6}contents: read/);
  }
});

test('repair: aggregate producers use exact artifact IDs with bounded retry transport', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const sections = [
    {
      job: 'build-artifacts',
      ids: 'needs\\.app-shard-0\\.outputs\\.app_dist_artifact_id.*needs\\.app-shard-1\\.outputs\\.app_dist_artifact_id.*needs\\.app-shard-2\\.outputs\\.app_dist_artifact_id',
      path: 'shard-reports',
    },
    {
      job: 'cache-warm',
      ids: 'needs\\.app-shard-0\\.outputs\\.app_dist_artifact_id.*needs\\.app-shard-1\\.outputs\\.app_dist_artifact_id.*needs\\.app-shard-2\\.outputs\\.app_dist_artifact_id',
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
  const start = workflow.indexOf('  coverage-pnpm:');
  const remaining = workflow.slice(start);
  const nextJob = remaining.slice(1).search(/\n {2}[a-z][\w-]+:/);
  const section = remaining.slice(0, nextJob === -1 ? undefined : nextJob + 1);
  assert.match(section, /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64"\]'\) \}\}/);
  assert.doesNotMatch(section, /github\.event\.pull_request\.head\.repo/);
  assert.match(
    section,
    /--coverage --project='@forgeax\/\*' --project=hello-triangle --project=unit/,
  );
  assert.match(section, /name: ECS performance ratio gates \(uninstrumented\)/);
  assert.match(section, /--project=ecs-perf/);
});

test('repair: core-only consumers hydrate exact IDs without the app aggregate barrier', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  for (const job of ['vitest-dawn', 'webkit-fallback']) {
    const start = workflow.indexOf(`  ${job}:`);
    assert.notEqual(start, -1, `missing ${job}`);
    const remaining = workflow.slice(start);
    const nextJob = remaining.slice(1).search(/\n {2}[a-z][\w-]+:/);
    const section = remaining.slice(0, nextJob === -1 ? undefined : nextJob + 1);
    assert.match(section, /needs: \[core-build, post-merge-gate\]/);
    assert.match(section, /needs\.core-build\.result == 'success'/);
    assert.match(
      section,
      /--artifact-ids "\$\{\{ needs\.core-build\.outputs\.core_artifact_id \}\}" --path \./,
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
        /cp -a node_modules\/\.cache\/forgeax-ddc shard-transfer\/ddc[\s\S]*?rm -f shard-transfer\/ddc\/ddc-warm-status\.json/g,
      )?.length,
      3,
      'shard transfers must exclude merged DDC status from each payload',
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
