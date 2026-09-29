import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const taaCarrierModule = pathToFileURL(resolve('apps/hello/taa/scripts/smoke-carrier.mjs')).href;

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
const inputPreparationSource = readFileSync(resolve('scripts/ci/prepare-ci-inputs.mjs'), 'utf8');

test('CI job status conditions release superseded PR runs on cancellation', () => {
  const jobConditions = [...workflow.matchAll(/^ {4}if: ([^\n]*(?:\n {6}\S[^\n]*)*)/gm)];
  assert.ok(jobConditions.length > 0);
  for (const [condition] of jobConditions) {
    assert.doesNotMatch(condition, /\balways\(\)/, condition);
  }
  // Cleanup must still run when its owning job is cancelled.
  assert.match(workflow, /name: Stop hello-fxaa dev server\n {8}if: always\(\)/);
});
const realGpuWorkflow = readFileSync(
  resolve('.github/workflows/gpu-pass-timing-real-gpu.yml'),
  'utf8',
);
const benchWorkflow = readFileSync(resolve('.github/workflows/bench.yml'), 'utf8');
const packageManifest = readFileSync(resolve('package.json'), 'utf8');
test('local Dawn entrypoint uses the complete shared gate', () => {
  const command = JSON.parse(packageManifest).scripts['test:dawn'];
  assert.match(command, /node scripts\/ci\/run-dawn-gate\.mjs$/);
  assert.doesNotMatch(command, /FORGEAX_DAWN_LIGHTWEIGHT/);
});

const vitestConfig = readFileSync(resolve('vitest.config.ts'), 'utf8');
const entityVisibilityDawnTest = readFileSync(
  resolve('apps/hello/entity-visibility/__tests__/visibility.dawn.test.ts'),
  'utf8',
);
const pointLightShadowDawnTest = readFileSync(
  resolve('packages/runtime/src/__tests__/point-light-shadow.dawn.test.ts'),
  'utf8',
);
const featureDepthMaterialFixture = readFileSync(
  resolve('packages/runtime/src/__tests__/feature-depth-material.fixture.ts'),
  'utf8',
);
const dawnPartitionRunner = readFileSync(resolve('scripts/ci/run-dawn-partitions.mjs'), 'utf8');
const shaderPluginSource = readFileSync(
  resolve('packages/vite-plugin-shader/src/index.ts'),
  'utf8',
);
const sdkVerifySource = readFileSync(resolve('scripts/forgeax/verify-sdk.mjs'), 'utf8');
const pixelParityBench = readFileSync(resolve('scripts/bench/pixel-parity.mjs'), 'utf8');
const colorLightingBench = readFileSync(resolve('scripts/bench/color-lighting-parity.mjs'), 'utf8');
const shadowFieldsObservable = readFileSync(
  resolve('packages/runtime/src/__tests__/shadow-fields-observable.dawn.test.ts'),
  'utf8',
);
const browserVitestConfig = readFileSync(resolve('config/vitest-browser-project.ts'), 'utf8');
const liveSyncScript = readFileSync(resolve('packages/devkit/scripts/check-live-sync.mjs'), 'utf8');
const liveDevSource = readFileSync(resolve('packages/devkit/src/live-dev.ts'), 'utf8');
const devkitHostSource = readFileSync(resolve('packages/devkit/src/host.ts'), 'utf8');
const capturePolicyScript = readFileSync(
  resolve('packages/devkit/scripts/check-capture-policy.mjs'),
  'utf8',
);
const previewTemplatesSmoke = readFileSync(
  resolve('apps/preview/scripts/smoke-templates.mjs'),
  'utf8',
);
const sharedInputsBrowserSmoke = readFileSync(
  resolve('apps/learn-render/4.advanced-opengl/3.blending/scripts/smoke-shared-inputs-browser.mjs'),
  'utf8',
);
const ssrMainSource = readFileSync(resolve('apps/hello/ssr/src/main.ts'), 'utf8');
const browserOnerrorGate = readFileSync(resolve('apps/shared/src/onerror-gate.ts'), 'utf8');
const browserInstancingAcceptance = readFileSync(
  resolve('apps/parity/instancing-static/src/__tests__/instances.browser.test.ts'),
  'utf8',
);
const browserGpuDrivenView = readFileSync(
  resolve('packages/render/src/__tests__/gpu-driven-view.browser.test.ts'),
  'utf8',
);
const browserDirectLight = readFileSync(
  resolve('apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.browser.test.ts'),
  'utf8',
);
const browserProvider = readFileSync(resolve('config/vitest-browser-provider.ts'), 'utf8');
const uploadWithRetry = readFileSync(
  resolve('.github/actions/upload-artifact-with-retry/action.yml'),
  'utf8',
);
const uploadOptionalArtifact = readFileSync(
  resolve('.github/actions/upload-optional-artifact/action.yml'),
  'utf8',
);

test('TAA carrier timeout preserves actions and bounds process lifetime', () => {
  const success = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { withTimeout } from ${JSON.stringify(taaCarrierModule)};
const value = await withTimeout('value', () => 42, 35_000);
if (value !== 42) throw new Error('value was not preserved: ' + value);
try {
  await withTimeout('reject', () => Promise.reject(new Error('sentinel')), 35_000);
  throw new Error('action rejection was not propagated');
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'sentinel') throw error;
}`,
    ],
    { encoding: 'utf8', timeout: 2_000 },
  );
  assert.equal(success.error, undefined, success.error?.message);
  assert.equal(success.status, 0, success.stderr || success.stdout);

  const timeout = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { withTimeout } from ${JSON.stringify(taaCarrierModule)};
try {
  await withTimeout('hang', () => new Promise(() => {}), 50);
  process.exitCode = 1;
} catch (error) {
  process.exitCode = error instanceof Error && error.message === 'hang timed out after 50ms' ? 0 : 2;
}`,
    ],
    { encoding: 'utf8', timeout: 2_000 },
  );
  assert.equal(timeout.error, undefined, timeout.error?.message);
  assert.equal(timeout.status, 0, timeout.stderr || timeout.stdout);
});
const mesaVulkanAction = readFileSync(
  resolve('.github/actions/install-mesa-vulkan-drivers/action.yml'),
  'utf8',
);
const dawnPrepareAction = readFileSync(
  resolve('.github/actions/prepare-dawn-device-limits/action.yml'),
  'utf8',
);
test('coverage-pnpm-shard splits Vitest coverage into bounded fresh processes', () => {
  const coverageStart = workflow.indexOf('  coverage-pnpm-shard:\n');
  const coverage = workflow.slice(
    coverageStart,
    workflow.indexOf('  coverage-perf:\n', coverageStart),
  );
  assert.match(coverage, /timeout-minutes: 45/);
  assert.match(coverage, /node scripts\/ci\/run-split-vitest-coverage\.mjs/);
  assert.match(coverage, /--group-size=8[\s\S]*?--group-concurrency=auto[\s\S]*?--max-workers=1/);
  assert.doesNotMatch(coverage, /--skip-typecheck/);
  assert.match(coverage, /matrix:\n\s+shard: \[0, 1, 2\]/);
  assert.match(coverage, /--shard-index=\$\{\{ matrix\.shard \}\}[\s\S]*?--shard-count=3/);
  assert.match(coverage, /name: coverage-shard-\$\{\{ matrix\.shard \}\}/);
  const mergeStart = workflow.indexOf('  coverage-pnpm:\n');
  const merge = workflow.slice(mergeStart, workflow.indexOf('  coverage-perf:\n', mergeStart));
  assert.ok(mergeStart > coverageStart, 'coverage-pnpm must merge after its shards');
  assert.match(merge, /needs: \[coverage-pnpm-shard, post-merge-gate\]/);
  assert.doesNotMatch(merge, /needs\.coverage-pnpm-shard\.result == 'success' &&/);
  assert.match(merge, /if: needs\.coverage-pnpm-shard\.result != 'success'[\s\S]*?exit 1/);
  assert.match(merge, /--artifact-pattern "coverage-shard-\*"\n\s+--expected-count 3/);
  assert.match(merge, /--merge-shards=coverage-shards/);
  assert.match(merge, /check-vitest-passed-or-fail\.mjs vitest-coverage-out\.json/);
  const coverageRunner = readFileSync(resolve('scripts/ci/run-split-vitest-coverage.mjs'), 'utf8');
  assert.match(coverageRunner, /--typecheck\.only/);
  assert.match(coverageRunner, /options\.coverage && options\.typecheck/);
  assert.match(coverageRunner, /--typecheck\.enabled=false[\s\S]*?--coverage/);
  assert.doesNotMatch(workflow, /heavy-(?:32g|256g)/i);
});

test('Bun package build uses the dependency graph instead of workspace enumeration order', () => {
  const portabilityStart = workflow.indexOf('  portability-bun:\n');
  assert.notEqual(portabilityStart, -1);
  const portability = workflow.slice(portabilityStart);
  assert.match(portability, /FORGEAX_PACKAGE_BUILD_RUNNER: bun/);
  assert.match(portability, /FORGEAX_BUILD_NO_TASK_CACHE: '1'/);
  assert.match(portability, /run: node scripts\/build-packages\.mjs/);
  assert.doesNotMatch(portability, /bun run --filter '\.\/packages\/\*'/);
});

test('vitest-browser splits the full browser suite into bounded fresh processes', () => {
  assert.match(packageManifest, /run-split-vitest-browser\.mjs --group-size=8 --max-workers=1/);
  const browserRunner = readFileSync(resolve('scripts/ci/run-split-vitest-browser.mjs'), 'utf8');
  assert.match(browserRunner, /--project=browser/);
  assert.match(browserRunner, /--maxWorkers=\$\{maxWorkers\}/);
  assert.match(browserRunner, /--shard-count/);
  assert.match(browserRunner, /selectedGroups/);
  assert.match(browserRunner, /runBrowserCommand/);
  assert.match(browserRunner, /browserGroupTimeoutMs = 300_000/);
  assert.match(browserRunner, /timeoutMs: groupTimeoutMs/);
  assert.match(browserRunner, /directLightBrowserGroupTimeoutMs = 420_000/);
  assert.match(browserRunner, /instancingStaticBrowserGroupTimeoutMs = 900_000/);
  assert.match(browserRunner, /instancingStaticBrowserFile/);
  assert.match(
    browserRunner,
    /group\.includes\(instancingStaticBrowserFile\)[\s\S]*?instancingStaticBrowserGroupTimeoutMs/,
  );
  assert.match(browserRunner, /withBrowserHeapLimit/);
  assert.match(browserRunner, /max-old-space-size=4096/);
  assert.match(browserRunner, /isRetryableOutput\('vitest', first\.output\)/);
  assert.equal(
    existsSync(
      resolve(
        'apps/learn-render/4.advanced-opengl/9.instancing/src/__tests__/onerror-gate.browser.test.ts',
      ),
    ),
    false,
  );
  assert.match(
    workflow,
    /Run authoritative Dawn roster shard[\s\S]*?--shard-index \$\{\{ matrix\.group \}\}/,
  );
  assert.doesNotMatch(workflow, /run-hello-learn-render-smoke-roster\.mjs/);
  assert.match(browserRunner, /const preview = files\.filter/);
  assert.match(browserRunner, /FORGEAX_BROWSER_ENTITY_VISIBILITY: '0'/);
  assert.match(browserRunner, /file\.startsWith\('apps\/preview\/'\)/);
  assert.match(browserRunner, /FORGEAX_BROWSER_PACK_READINESS: producerReadiness/);
  assert.match(browserRunner, /excludedDirectories = new Set\(\[[^\]]*artifacts/);
  assert.match(
    browserVitestConfig,
    /process\.env\.FORGEAX_BROWSER_PACK_READINESS === 'before-consume'[\s\S]*'on-demand'/,
  );
  assert.match(browserVitestConfig, /'\*\*\/artifacts\/\*\*'/);
  assert.doesNotMatch(workflow, /heavy-(?:32g|256g)/i);
  const browserShardStart = workflow.indexOf('  vitest-browser-shard:\n');
  const browserShard = workflow.slice(
    browserShardStart,
    workflow.indexOf('  vitest-browser:\n', browserShardStart),
  );
  assert.match(browserShard, /NODE_OPTIONS: --max-old-space-size=4096/);
  assert.match(browserShard, /--group-size=8/);
  assert.match(browserShard, /matrix:\n(?:\s*#.*\n)*\s+shard: \[0, 1, 2, 3\]/);
  assert.match(browserShard, /--shard-index=\$\{\{ matrix\.shard \}\}/);
  assert.match(browserShard, /--shard-count=4/);
  assert.match(browserShard, /FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1'/);
  assert.match(browserShard, /FORGEAX_BROWSER_FIXED_SMOKE: '1'/);
  assert.match(browserShard, /if: matrix\.shard == 0/);
});

test('browser and Dawn PR profiles reduce redundant waits while preserving lifecycle evidence', () => {
  assert.match(browserOnerrorGate, /FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' \? 300 : 500/);
  assert.match(
    browserInstancingAcceptance,
    /const LIGHTWEIGHT = import\.meta\.env\.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1';[\s\S]*?const FRAME_COUNT = LIGHTWEIGHT \? 24 : 600;/,
  );
  assert.match(browserGpuDrivenView, /const lifecycleFrames = 60/);
  assert.match(browserDirectLight, /FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' \? 24 : 60/);

  const gpuDrivenDawn = readFileSync(
    resolve('packages/render/src/__tests__/gpu-driven-view.dawn.test.ts'),
    'utf8',
  );
  assert.match(gpuDrivenDawn, /runGpuDrivenViewLifecycleEvidence\(\)[\s\S]*frames: 60/);
  const directLightDawn = readFileSync(
    resolve('apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.dawn.test.ts'),
    'utf8',
  );
  assert.match(directLightDawn, /FORGEAX_DAWN_LIGHTWEIGHT === '1' \? 2 : 60/);
});

test('browser smoke keeps separate cold-start and live-sync completion budgets', () => {
  const browserJobs = [
    workflow.slice(
      workflow.indexOf('  shared-inputs-browser:\n'),
      workflow.indexOf('  multithread-browser-benchmark:\n'),
    ),
    workflow.slice(
      workflow.indexOf('  vitest-browser-shard:\n'),
      workflow.indexOf('  vitest-browser:\n'),
    ),
  ];
  for (const job of browserJobs) {
    assert.match(job, /FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1'/);
    assert.match(job, /FORGEAX_BROWSER_CI_VIEWPORT_WIDTH: '320'/);
    assert.match(job, /FORGEAX_BROWSER_CI_VIEWPORT_HEIGHT: '180'/);
    assert.match(job, /FORGEAX_BROWSER_CI_SETTLE_FRAMES: '2'/);
    assert.match(job, /FORGEAX_DEV_PACK_READINESS: on-demand/);
  }
  assert.match(liveDevSource, /const LIVE_DEV_STARTUP_TIMEOUT_MS = 300_000;/);
  assert.match(liveSyncScript, /const START_COMMAND_TIMEOUT_MS = 330_000;/);
  assert.match(
    liveSyncScript,
    /timeout: args\[0\] === 'start' \? START_COMMAND_TIMEOUT_MS : 180_000/,
  );
  assert.match(liveSyncScript, /async function ready\(previous, timeout = 150_000\)/);
  assert.match(devkitHostSource, /FORGEAX_DEV_PACK_READINESS === 'on-demand'/);
  assert.match(devkitHostSource, /producerReadiness/);
  assert.match(liveDevSource, /FORGEAX_BROWSER_CI_VIEWPORT_WIDTH/);
  assert.match(capturePolicyScript, /FORGEAX_BROWSER_CI_VIEWPORT_HEIGHT/);
  assert.match(previewTemplatesSmoke, /TEMPLATE_SETTLE_FRAMES/);
  assert.match(previewTemplatesSmoke, /TEMPLATE_VIEWPORT/);
  assert.match(sharedInputsBrowserSmoke, /settleMs = lightweight \? 250 : 1_000/);
  assert.match(sharedInputsBrowserSmoke, /browserViewport/);
  assert.match(ssrMainSource, /FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' \? 8 : 60/);
  assert.match(browserOnerrorGate, /__forgeaxBrowserOnerrorGate = sectionName/);
  assert.match(ssrMainSource, /browserOnerrorGate !== 'hello-ssr'/);
  assert.match(
    ssrMainSource,
    /defaultResolution = .*FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' \? 128 : 512/,
  );
});

test('multithread benchmark materializes only its executable app root', () => {
  const benchmarkStart = workflow.indexOf('  multithread-browser-benchmark:\n');
  const benchmarkEnd = workflow.indexOf('  smoke-fleet:\n', benchmarkStart);
  assert.notEqual(benchmarkStart, -1);
  assert.notEqual(benchmarkEnd, -1);
  const benchmark = workflow.slice(benchmarkStart, benchmarkEnd);
  const materializeStart = benchmark.indexOf(
    '      - name: Materialize shared app shader manifests',
  );
  const materializeEnd = benchmark.indexOf('\n      - name:', materializeStart + 1);
  assert.notEqual(materializeStart, -1);
  assert.notEqual(materializeEnd, -1);
  const materialize = benchmark.slice(materializeStart, materializeEnd);
  const appRoot = 'apps/hello/multithreaded-execution';
  assert.ok(existsSync(resolve(appRoot, 'package.json')));
  assert.match(benchmark, /@forgeax\/hello-multithreaded-execution/);
  assert.match(benchmark, /timeout-minutes: 30/);
  assert.match(benchmark, /--mode=multithread-smoke/);
  assert.match(benchmark, /--mode=benchmark/);
  assert.match(benchmark, /prepare-ci-inputs\.mjs --consumer multithread-browser-benchmark/);
  assert.match(
    benchmark,
    /build-apps\.mjs apps\/hello\/multithreaded-execution\s+--shared-input-manifest shared-app-inputs\/manifest\.json/,
  );
  assert.ok(benchmark.indexOf('Build executable multithread app once') < materializeStart);
  for (const owner of ['bench-threshold-self-test', 'smoke-browser', 'bench-browser'])
    assert.ok(benchmark.includes(`exec node scripts/${owner}.mjs`));
  assert.doesNotMatch(
    benchmark,
    /multithreaded-execution (?:smoke:browser|bench:production|build)\b/,
  );

  assert.deepEqual(
    [...materialize.matchAll(/--app-root\s+(\S+)/g)].map((match) => match[1]),
    [appRoot],
  );
  assert.doesNotMatch(
    materialize,
    /node scripts\/ci\/materialize-app-shader-manifests\.mjs\s+--root \.\s+--shared-input-manifest shared-app-inputs\/manifest\.json\s*$/,
  );
});

test('directional CSM browser smoke is an isolated producer with an explicit retry contract', () => {
  const csmStart = workflow.indexOf('  directional-csm-browser:\n');
  const csm = workflow.slice(csmStart, workflow.indexOf('  vitest-browser-shard:\n', csmStart));
  assert.notEqual(csmStart, -1);
  assert.match(csm, /needs: \[core-build, shared-app-inputs, post-merge-gate\]/);
  assert.match(csm, /timeout-minutes: 30/);
  assert.match(csm, /prepare-ci-inputs\.mjs --consumer directional-csm-browser/);
  assert.match(csm, /--artifact-ids .*needs\.core-build\.outputs\.core_artifact_id/);
  assert.match(csm, /needs\.shared-app-inputs\.outputs\.shared_artifact_id/);
  assert.match(csm, /FORGEAX_SHARED_APP_INPUTS_MANIFEST:/);
  assert.match(csm, /--input-fingerprint .*needs\.shared-app-inputs\.outputs\.input_fingerprint/);
  assert.match(csm, /run-browser-gate-with-retry\.mjs[\s\S]*?--mode=rhi-debug/);
  assert.match(
    csm,
    /pnpm --filter '@forgeax\/app-learn-render-5-advanced-lighting-3-3-csm'[\s\S]*?smoke:browser/,
  );
  assert.match(csm, /FORGEAX_CHROME_CHANNEL: chrome-beta/);
  assert.match(csm, /xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0/);

  const shardStart = workflow.indexOf('  vitest-browser-shard:\n');
  const shard = workflow.slice(shardStart, workflow.indexOf('  vitest-browser:\n', shardStart));
  assert.doesNotMatch(shard, /app-learn-render-5-advanced-lighting-3-3-csm/);

  const aggregateStart = workflow.indexOf('  vitest-browser:\n');
  const aggregate = workflow.slice(
    aggregateStart,
    workflow.indexOf('  shared-inputs-browser:\n', aggregateStart),
  );
  assert.match(aggregate, /vitest-browser-shard, directional-csm-browser/);
  assert.match(aggregate, /needs\.vitest-browser-shard\.result.*success/);
  assert.match(aggregate, /needs\.directional-csm-browser\.result.*success/);
});

test('headed Vitest Chromium pages use a background target on every host without changing headless policy', () => {
  assert.match(browserVitestConfig, /playwrightWithBackgroundPages/);
  assert.match(vitestConfig, /playwrightWithBackgroundPages/);
  assert.match(browserProvider, /Target\.createTarget/);
  assert.match(browserProvider, /background: true/);
  assert.doesNotMatch(browserProvider, /process\.platform/);
  assert.match(browserProvider, /project\.config\.browser\.headless === false/);
  assert.match(browserProvider, /FORGEAX_BROWSER_BACKGROUND/);
  assert.match(
    browserVitestConfig,
    /headless: process\.env\.FORGEAX_BROWSER_HEADLESS !== '0' && !!process\.env\.CI/,
  );
  assert.match(vitestConfig, /headless: !!process\.env\.CI/);
});

test('Dawn direct-light matrix is excluded from the named project and opted in by its partition runner', () => {
  assert.match(
    vitestConfig,
    /DIRECT_LIGHT_DAWN_TEST_FILE[\s\S]*?from '\.\/scripts\/ci\/dawn-gate-roster\.mjs'/,
  );
  assert.match(vitestConfig, /FORGEAX_DAWN_PARTITION/);
  assert.match(
    vitestConfig,
    /\.\.\.\(RUNNING_DIRECT_LIGHT_PARTITION \? \[\] : \[DIRECT_LIGHT_DAWN_TEST_FILE\]\)/,
  );
  const directLightRunner = readFileSync(resolve('scripts/ci/run-direct-light-dawn.mjs'), 'utf8');
  assert.match(directLightRunner, /FORGEAX_DAWN_PARTITION: partition\.id/);
  const directLightTest = readFileSync(
    resolve('apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.dawn.test.ts'),
    'utf8',
  );
  assert.match(
    directLightTest,
    /const SPOT_SHADOW_CAPTURE_FRAMES = process\.env\.FORGEAX_DAWN_LIGHTWEIGHT === ['"]1['"] \? 2 : 60;/,
    'fresh direct-light partitions must use the bounded 2-frame producer warmup',
  );
  assert.match(directLightTest, /SPOT_SHADOW_HEAVY_TEST_TIMEOUT_MS[\s\S]*600_000/);
  assert.match(
    directLightTest,
    /captures independent HDRP producer evidence[\s\S]*\}, SPOT_SHADOW_HEAVY_TEST_TIMEOUT_MS\);/,
    'the HDRP producer roster must use the partition-aware heavy-test timeout',
  );
  assert.equal(
    (directLightTest.match(/\}, SPOT_SHADOW_HEAVY_TEST_TIMEOUT_MS\);/g) ?? []).length,
    4,
  );
});

test('Dawn device-limit preload is installed only after checkout', () => {
  assert.match(dawnPrepareAction, /GITHUB_WORKSPACE.*patch-dawn-device-limits\.mjs/);
  assert.match(dawnPrepareAction, /GITHUB_PATH/);
  assert.match(dawnPrepareAction, /printf 'PATH=%s\\n'/);
  assert.match(dawnPrepareAction, /BASH_ENV/);
  assert.match(dawnPrepareAction, /GITHUB_ENV/);
  assert.match(dawnPrepareAction, /NODE_OPTIONS/);
  assert.match(dawnPrepareAction, /exec "\$real_node" "\$@"/);
  for (const jobName of [
    'primary-pnpm',
    'directional-csm-browser',
    'smoke-fleet',
    'bevy-smoke-fleet',
    'vitest-dawn',
    'metrics-validate-browser',
    'metrics-validate-runtime',
  ]) {
    const start = workflow.indexOf(`  ${jobName}:\n`);
    assert.notEqual(start, -1, `missing ${jobName}`);
    const nextJobOffset = workflow.slice(start + 3).search(/\n {2}[A-Za-z][A-Za-z0-9-]*:\n/);
    const nextJob = nextJobOffset === -1 ? -1 : start + 3 + nextJobOffset;
    const job = workflow.slice(start, nextJob === -1 ? workflow.length : nextJob);
    const install = job.indexOf('Install (frozen)');
    const prepare = job.indexOf('prepare-dawn-device-limits');
    assert.ok(install >= 0 && prepare > install, `${jobName} must prepare after install`);
    assert.doesNotMatch(job.slice(0, install), /patch-dawn-device-limits/);
  }
});

test('primary pin reachability restores every independently prepared submodule', () => {
  const start = workflow.indexOf('  primary-pnpm:\n');
  const end = workflow.indexOf('\n  coverage-pnpm-shard:\n', start);
  const primary = workflow.slice(start, end);
  const assets = primary.indexOf('node scripts/ci/prepare-assets-checkout.mjs');
  const wgpu = primary.indexOf('node scripts/ci/prepare-wgpu-checkout.mjs');
  const pins = primary.indexOf('python3 scripts/forgeax/check_submodule_pins.py --repo .');
  assert.ok(start >= 0 && end > start, 'primary-pnpm must have a bounded workflow block');
  assert.ok(assets >= 0 && wgpu > assets && pins > wgpu);
});

test('Dawn heavy renderer lanes keep only lifecycle work fresh', () => {
  assert.match(
    packageManifest,
    /"test:dawn": "FORGEAX_PACKAGE_BUILD_CONCURRENCY=2 pnpm build:engine &&/,
    'the local Dawn gate must use a bounded package-only engine build',
  );
  assert.doesNotMatch(
    packageManifest,
    /"test:dawn": "pnpm -r build &&/,
    'the local Dawn gate must not recursively build every demo application',
  );
  assert.match(
    entityVisibilityDawnTest,
    /const ENTITY_VISIBILITY_DAWN_TEST_TIMEOUT_MS = 120_000;/,
    'the entity-visibility Dawn smoke needs a bounded cold-start budget',
  );
  assert.equal(
    (entityVisibilityDawnTest.match(/ENTITY_VISIBILITY_DAWN_TEST_TIMEOUT_MS/g) ?? []).length,
    2,
    'the entity-visibility timeout must be applied to exactly one real Dawn smoke',
  );
  assert.match(
    pointLightShadowDawnTest,
    /const POINT_LIGHT_SHADOW_DAWN_TEST_TIMEOUT_MS = 120_000;/,
    'the point-light-shadow Dawn e2e needs a bounded cold-start budget',
  );
  assert.equal(
    (pointLightShadowDawnTest.match(/POINT_LIGHT_SHADOW_DAWN_TEST_TIMEOUT_MS/g) ?? []).length,
    2,
    'the point-light-shadow timeout must be applied to exactly one real Dawn smoke',
  );
  assert.match(shaderPluginSource, /engineShaderManifestCache/);
  assert.match(shaderPluginSource, /buildEngineShaderManifestUncached/);
  const dawnStart = workflow.indexOf('  vitest-dawn:\n');
  const dawnJob = workflow.slice(
    dawnStart,
    workflow.indexOf('  vitest-dawn-required:\n', dawnStart),
  );
  assert.match(
    dawnJob,
    /needs: \[core-build, shared-app-inputs, post-merge-gate\][\s\S]*?needs\.shared-app-inputs\.result == 'success'/,
    'the Dawn gate must consume the shared shader producer rather than rebuild its manifest per process',
  );
  assert.match(dawnJob, /FORGEAX_SHARED_APP_INPUTS_MANIFEST: .*shared-app-inputs\/manifest\.json/);
  assert.match(dawnJob, /needs\.shared-app-inputs\.outputs\.shared_artifact_id/);
  assert.match(dawnJob, /prepare-ci-inputs\.mjs --consumer vitest-dawn/);
  assert.match(dawnJob, /--artifact-ids .*needs\.core-build\.outputs\.core_artifact_id/);
  assert.match(
    dawnJob,
    /--input-fingerprint .*needs\.shared-app-inputs\.outputs\.input_fingerprint/,
  );
  assert.match(dawnJob, /timeout-minutes: 25/);
  assert.match(dawnJob, /shard: \[1, 2, 3, 4\]/);
  assert.match(dawnJob, /--shard "\$\{\{ matrix\.shard \}\}\/4"/);
  assert.match(vitestConfig, /from '\.\/scripts\/ci\/dawn-gate-roster\.mjs'/);
  assert.match(vitestConfig, /\.\.\.\(RUNNING_DAWN_ISOLATED \? \[\] : DAWN_ISOLATED_TEST_FILES\)/);
  assert.match(vitestConfig, /\.\.\.\(RUNNING_DAWN_COMPACT \? \[\] : DAWN_COMPACT_TEST_FILES\)/);
  assert.match(dawnJob, /FORGEAX_DAWN_LIGHTWEIGHT: ['"]1['"]/);
  assert.match(dawnJob, /NODE_OPTIONS: --max-old-space-size=4096/);
  assert.match(dawnJob, /run: node scripts\/ci\/run-dawn-gate\.mjs --shard/);
  assert.match(dawnJob, /uses: \.\/\.github\/actions\/prepare-xdg-runtime/);
  assert.match(dawnPartitionRunner, /runBrowserCommand/);
  assert.match(dawnPartitionRunner, /--testNamePattern/);
  for (const kind of ['billboard', 'ribbon', 'trail', 'beam', 'mesh']) {
    assert.match(dawnPartitionRunner, new RegExp(`['"]${kind}['"]`));
  }
  const fence = featureDepthMaterialFixture.indexOf('await device.queue.onSubmittedWorkDone()');
  const detach = featureDepthMaterialFixture.indexOf(
    'await vfx.detachWorld({ world: attachedWorld })',
  );
  const rendererDispose = featureDepthMaterialFixture.indexOf('renderer?.dispose();');
  assert.ok(
    fence >= 0 && fence < detach && detach < rendererDispose,
    'Dawn fixture teardown must drain submitted work before destroying renderer state',
  );
  assert.match(
    featureDepthMaterialFixture,
    /layout\.location \+ \(layout\.allInputs \? 3 : inputLane\)/,
    'the four-lane VFX fixture must keep particle input at lane 3 instead of colliding with lane 0',
  );
  assert.match(
    readFileSync(
      resolve('packages/render/bench/gpu-pass-timing/__tests__/gpu-pass-timing.dawn.test.ts'),
      'utf8',
    ),
    /const frameCount = process\.env\.FORGEAX_DAWN_LIGHTWEIGHT === ['"]1['"] \? 12 : 60;/,
    'GPU pass timing retains the full local window and a bounded CI window',
  );
  assert.match(
    readFileSync(resolve('apps/hello/entity-visibility/__tests__/visibility.dawn.test.ts'), 'utf8'),
    /const frameCount = process\.env\.FORGEAX_DAWN_LIGHTWEIGHT === ['"]1['"] \? 12 : 60;/,
    'entity visibility retains the full local window and a bounded CI window',
  );
  assert.match(
    readFileSync(resolve('apps/hello/scene-nesting/__tests__/scene-nesting.dawn.test.ts'), 'utf8'),
    /const TARGET_FRAMES = process\.env\.FORGEAX_DAWN_LIGHTWEIGHT === ['"]1['"] \? 24 : 60;/,
    'scene nesting retains the full local window and a bounded CI window',
  );
  const extendedCaseCarrier = readFileSync(
    resolve('apps/parity/color-lighting/src/compare/extended-case-carrier.ts'),
    'utf8',
  );
  assert.match(
    extendedCaseCarrier,
    /const DAWN_LIGHTWEIGHT = \([\s\S]*?globalThis[\s\S]*?FORGEAX_DAWN_LIGHTWEIGHT === ['"]1['"];/,
    'browser-loaded parity carriers must read the optional Node flag through globalThis',
  );
  assert.match(
    extendedCaseCarrier,
    /frameCount: DAWN_LIGHTWEIGHT \? 4 : 12,/,
    'extended-lighting carriers must keep the bounded CI frame window without a browser process global',
  );
  assert.match(
    shadowFieldsObservable,
    /const SHADOW_FIELDS_RENDER_FRAMES = LIGHTWEIGHT_DAWN \? 12 : 60;/,
    'the isolated shadow-field lane must retain a bounded CI frame window',
  );
  assert.match(
    shadowFieldsObservable,
    /const WIDTH = LIGHTWEIGHT_DAWN \? 128 : 256;[\s\S]*?const HEIGHT = LIGHTWEIGHT_DAWN \? 128 : 256;/,
    'the isolated shadow-field lane must lower its readback target only under the explicit CI flag',
  );
  assert.match(
    shadowFieldsObservable,
    /if \(i % 16 === 15\) await dev\.queue\.onSubmittedWorkDone\(\);/,
    'shadow-field frames must periodically drain native Dawn work',
  );
  assert.match(shadowFieldsObservable, /mapSize: mapSize \?\? 1024,[\s\S]*?cascadeCount: 1,/);
  assert.match(shadowFieldsObservable, /renderConfig\(true, 0\.005, 0\.05, 3, 256\)/);
  assert.match(shadowFieldsObservable, /renderConfig\(true, 0\.005, 0\.05, 3, 2048\)/);
  assert.match(
    dawnPartitionRunner,
    /'--retry=0'/,
    'native timeouts must not overlap in-process retries',
  );
  const artifactContract = JSON.parse(
    readFileSync(resolve('scripts/ci/build-artifact-contract.json'), 'utf8'),
  );
  assert.deepEqual(artifactContract.consumers['vitest-dawn'].requiredArtifactClasses, [
    'engine-dist',
    'wasm-runtime',
    'shared-asset-pack',
    'shared-engine-shaders',
  ]);
  assert.ok(artifactContract.sharedInputs.readOnlyConsumers.includes('vitest-dawn'));
});

test('heavy browser gates rely on workflow cancellation and retry only declared instability', () => {
  const vitestStart = workflow.indexOf('  vitest-browser-shard:\n');
  const vitestBrowser = workflow.slice(
    vitestStart,
    workflow.indexOf('  vitest-browser:\n', vitestStart),
  );
  const sharedStart = workflow.indexOf('  shared-inputs-browser:\n');
  const sharedInputs = workflow.slice(
    sharedStart,
    workflow.indexOf('  multithread-browser-benchmark:\n', sharedStart),
  );
  const benchmarkStart = workflow.indexOf('  multithread-browser-benchmark:\n');
  const benchmark = workflow.slice(
    benchmarkStart,
    workflow.indexOf('  smoke-fleet:\n', benchmarkStart),
  );
  for (const block of [vitestBrowser, sharedInputs, benchmark])
    assert.doesNotMatch(block, /\n\s+concurrency:/);
  assert.doesNotMatch(vitestBrowser, /run-browser-gate-with-retry\.mjs\s+--mode=vitest/);
  assert.match(vitestBrowser, /node scripts\/ci\/run-split-vitest-browser\.mjs/);
  assert.match(benchmark, /run-browser-gate-with-retry\.mjs\s+\\\n\s+--mode=benchmark\s+\\\n\s+--/);
  assert.match(
    benchmark,
    /run-browser-gate-with-retry\.mjs\s+\\\n\s+--mode=multithread-smoke\s+\\\n\s+--/,
  );
  assert.match(benchmark, /run-with-runner-cpu-affinity\.mjs/);
  assert.doesNotMatch(sharedInputs, /multithreaded-execution|--mode=benchmark/);
  const benchmarkScript = readFileSync(
    resolve('apps/hello/multithreaded-execution/scripts/bench-browser.mjs'),
    'utf8',
  );
  assert.match(benchmarkScript, /\[multithreaded benchmark\] performance verdict failed/);
  assert.match(
    benchmarkScript,
    /diagnostic\.report\?\.fault\?\.code === 'app-execution-deadline-exceeded'/,
  );
  assert.match(benchmarkScript, /diagnostic\.report\?\.fault\?\.detail\?\.phase === 'frame'/);
  assert.match(benchmarkScript, /reason: 'transient-frame-deadline-after-healthy-progress'/);
});

test('FXAA owned dev server allows the cold Vite startup budget', () => {
  const shardStart = workflow.indexOf('  vitest-browser-shard:\n');
  const shard = workflow.slice(shardStart, workflow.indexOf('  vitest-browser:\n', shardStart));
  const serverStart = shard.indexOf('- name: Start hello-fxaa dev server (owned background)');
  const server = shard.slice(
    serverStart,
    shard.indexOf('- name: Hello FXAA dark-gradient Browser WebGPU smoke (direct)', serverStart),
  );
  assert.match(server, /--timeout-ms 180000/);

  const fallbackStart = workflow.indexOf('  webkit-fallback:\n');
  const fallback = workflow.slice(
    fallbackStart,
    workflow.indexOf('  portability-bun:\n', fallbackStart),
  );
  const fallbackServerStart = fallback.indexOf(
    '- name: Start hello-fxaa dev server (owned background)',
  );
  const fallbackServer = fallback.slice(
    fallbackServerStart,
    fallback.indexOf(
      '- name: Hello FXAA dark-gradient Chromium WebGL2 smoke (direct)',
      fallbackServerStart,
    ),
  );
  assert.match(fallbackServer, /--timeout-ms 180000/);
});

test('Chromium fallback reuses the immutable shader projection before Vite startup', () => {
  const fallbackStart = workflow.indexOf('  webkit-fallback:\n');
  const fallback = workflow.slice(
    fallbackStart,
    workflow.indexOf('  portability-bun:\n', fallbackStart),
  );
  assert.match(fallback, /needs: \[core-build, shared-app-inputs, post-merge-gate\]/);
  assert.match(fallback, /needs\.core-build\.outputs\.core_artifact_id/);
  assert.match(fallback, /needs\.shared-app-inputs\.outputs\.shared_artifact_id/);
  assert.match(fallback, /prepare-ci-inputs\.mjs --consumer webkit-fallback/);
  assert.match(fallback, /FORGEAX_SHARED_APP_INPUTS_MANIFEST:/);
  assert.match(
    fallback,
    /--input-fingerprint .*needs\.shared-app-inputs\.outputs\.input_fingerprint/,
  );
  const contract = JSON.parse(readFileSync(resolve('scripts/ci/build-artifact-contract.json')));
  assert.deepEqual(contract.consumers['webkit-fallback'].requiredArtifactClasses, [
    'engine-dist',
    'wasm-runtime',
    'shared-engine-shaders',
  ]);
  assert.ok(contract.sharedInputs.readOnlyConsumers.includes('webkit-fallback'));
});

test('Vitest browser shard reuses the immutable shader projection before M16 startup', () => {
  const shardStart = workflow.indexOf('  vitest-browser-shard:\n');
  const shard = workflow.slice(shardStart, workflow.indexOf('  vitest-browser:\n', shardStart));
  assert.match(shard, /needs: \[core-build, shared-app-inputs, post-merge-gate\]/);
  assert.match(shard, /--artifact-ids .*needs\.core-build\.outputs\.core_artifact_id/);
  assert.match(shard, /needs\.shared-app-inputs\.outputs\.shared_artifact_id/);
  assert.match(shard, /prepare-ci-inputs\.mjs --consumer vitest-browser/);
  assert.match(
    shard,
    /FORGEAX_SHARED_APP_INPUTS_MANIFEST: \$\{\{ github\.workspace \}\}\/shared-app-inputs\/manifest\.json/,
  );
  assert.match(shard, /--input-fingerprint .*needs\.shared-app-inputs\.outputs\.input_fingerprint/);
  const contract = JSON.parse(readFileSync(resolve('scripts/ci/build-artifact-contract.json')));
  assert.deepEqual(contract.consumers['vitest-browser'].requiredArtifactClasses, [
    'engine-dist',
    'wasm-runtime',
    'shared-engine-shaders',
  ]);
  assert.ok(contract.sharedInputs.readOnlyConsumers.includes('vitest-browser'));
});

test('metrics producers have enough bounded wall-clock budget for full evidence', () => {
  const browserStart = workflow.indexOf('  metrics-validate-browser:\n');
  const browser = workflow.slice(
    browserStart,
    workflow.indexOf('  metrics-validate-runtime:\n', browserStart),
  );
  assert.match(browser, /timeout-minutes: 45/);
  assert.match(browser, /Run color-lighting parity matrix/);
  assert.match(
    browser,
    /- name: Prepare XDG runtime directory[\s\S]*?uses: \.\/\.github\/actions\/prepare-xdg-runtime/,
    'the metrics browser producer must provide a private XDG runtime directory before Dawn children start',
  );
  assert.match(
    browser,
    /- name: Run pixel parity benches \(all fixtures\)[\s\S]*?BENCH_TARGET: all[\s\S]*?pnpm bench:pixel-parity/,
    'both pixel parity reports must be produced by one all-target runner invocation',
  );
  assert.match(
    browser,
    /- name: Run color-lighting parity matrix[\s\S]*?FORGEAX_DAWN_LIGHTWEIGHT: ['"]1['"][\s\S]*?pnpm bench:color-lighting-parity/,
    'the metrics color-lighting producer must opt into the bounded Dawn warmup',
  );
  assert.doesNotMatch(
    browser,
    /Run pixel parity bench \(parity-standard-lanes\)/,
    'the standard-lanes pixel bench must not be a second workflow step',
  );
  assert.match(pixelParityBench, /const BENCH_TARGET_ALL = ['"]all['"];/);
  assert.match(pixelParityBench, /for \(const targetName of BENCH_TARGET_NAMES\)/);
  assert.match(pixelParityBench, /writeReport\(result, targetConfig\)/);
  assert.match(colorLightingBench, /--project=parity/);
  assert.match(colorLightingBench, /--typecheck\.enabled=false/);
  assert.match(colorLightingBench, /timedStage\('direct-light-dawn'/);
  assert.match(colorLightingBench, /FORGEAX_DAWN_PARTITION_SCOPE: ['"]producer['"]/);
  assert.match(
    colorLightingBench,
    /FORGEAX_DAWN_COMPACT: ['"]1['"][\s\S]*?FORGEAX_PARITY_TRANSPARENCY_ARTIFACT/,
    'the auxiliary Dawn command must opt back into its explicitly selected compact transparency carrier',
  );
  assert.match(colorLightingBench, /timedStage\('m4-closure'/);
  assert.match(
    colorLightingBench,
    /spawn\(\s*process\.execPath,[\s\S]*node_modules\/vite\/bin\/vite\.js[\s\S]*'preview',[\s\S]*'127\.0\.0\.1'/,
    'the parity bench must terminate Vite directly so pnpm does not convert normal cleanup SIGTERM into a failure',
  );
  assert.doesNotMatch(
    colorLightingBench,
    /spawn\(\s*['"]pnpm['"],[\s\S]*['"]preview['"]/,
    'the preview carrier must not be a nested pnpm process',
  );

  const runtimeStart = workflow.indexOf('  metrics-validate-runtime:\n');
  const runtime = workflow.slice(
    runtimeStart,
    workflow.indexOf('  metrics-validate:\n', runtimeStart),
  );
  assert.match(runtime, /timeout-minutes: 90/);
  assert.match(runtime, /Run hello-lod-occlusion GPU frame samples producer/);
  assert.match(
    runtime,
    /run-with-runner-cpu-affinity\.mjs --\s+node scripts\/ci\/run-lod-performance-with-retry\.mjs --\s+pnpm --filter @forgeax\/hello-lod-occlusion bench:json/,
    'the runtime metrics producer must bind to the declared cgroup CPU budget before sampling',
  );
});

test('GPU timing keeps default CI on the no-GPU contract and isolates real-GPU evidence', () => {
  const contractStart = workflow.indexOf('  gpu-pass-timing-contract:\n');
  const contract = workflow.slice(
    contractStart,
    workflow.indexOf('  cost-reporter:\n', contractStart),
  );

  assert.notEqual(contractStart, -1);
  assert.match(contract, /name: gpu-pass-timing-contract/);
  assert.match(
    contract,
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "standard"\]'\) \}\}/,
  );
  assert.match(contract, /Verify standard runner capacity[\s\S]*--pool standard/);
  assert.match(contract, /gpu-pass-timing\.rhi-null\.unit\.test\.ts/);
  assert.match(contract, /gpu-pass-timing-contract\.unit\.test\.ts/);
  assert.match(contract, /artifact-validator\.unit\.test\.ts/);
  assert.match(contract, /run-gpu-pass-timing-with-runner-admission\.test\.mjs/);
  assert.doesNotMatch(contract, /gpu-pass-timing:bench|Install Mesa Vulkan/);
  assert.doesNotMatch(workflow, /run_gpu_pass_timing/);
  assert.doesNotMatch(workflow, / {2}gpu-pass-timing-benchmark:\n/);
  assert.doesNotMatch(workflow, / {2}gpu-pass-timing-final:\n/);

  assert.match(realGpuWorkflow, /workflow_dispatch:/);
  assert.match(realGpuWorkflow, /ci_run_id:/);
  assert.match(realGpuWorkflow, /ci_run_attempt:/);
  assert.match(
    realGpuWorkflow,
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "gpu", "standard"\]'\) \}\}/,
  );
  assert.match(realGpuWorkflow, /Verify standard runner capacity[\s\S]*--pool standard/);
  assert.match(realGpuWorkflow, /Require a physical GPU device/);
  assert.match(realGpuWorkflow, /core-build-a\$\{\{ inputs\.ci_run_attempt \}\}\*/);
  assert.match(realGpuWorkflow, /shared-app-inputs-a\$\{\{ inputs\.ci_run_attempt \}\}\*/);
  assert.match(realGpuWorkflow, /engine-prerequisite-build-manifest\.json/);
  assert.match(realGpuWorkflow, /run-gpu-pass-timing-with-runner-admission\.mjs/);
  assert.match(realGpuWorkflow, /needs: \[gpu-pass-timing-benchmark\]/);
  assert.match(realGpuWorkflow, /if: always\(\)/);
  assert.match(realGpuWorkflow, /report\.backend\?\.kind !== 'webgpu'/);
  assert.match(realGpuWorkflow, /report\.backend\?\.realGpu !== true/);
  assert.match(realGpuWorkflow, /zeroCgroupThrottledTimeDelta/);
  assert.match(realGpuWorkflow, /thresholdPercent !== 10/);
  assert.match(realGpuWorkflow, /thresholdPercent !== 20/);
  assert.match(realGpuWorkflow, /report\.offPath/);
  assert.doesNotMatch(realGpuWorkflow, /Install Mesa Vulkan|continue-on-error/);
  assert.doesNotMatch(realGpuWorkflow, /pnpm test:browser|pnpm test:dawn|smoke-fleet/);
});

test('every heavy job verifies its actual cgroup capacity before doing work', () => {
  const jobStarts = [...workflow.matchAll(/^ {2}([a-z0-9-]+):\n/gm)];
  const heavyJobs = [];
  for (let index = 0; index < jobStarts.length; index++) {
    const start = jobStarts[index];
    const block = workflow.slice(start.index, jobStarts[index + 1]?.index ?? workflow.length);
    if (!block.includes('self-hosted", "Linux", "X64", "heavy')) continue;
    heavyJobs.push(start[1]);
    assert.match(
      block,
      /node scripts\/ci\/verify-runner-pool-capacity\.mjs --pool heavy/,
      `${start[1]} must reject a mislabeled undersized runner`,
    );
    const setupNode = block.indexOf('- name: Setup Node.js');
    const capacityGuard = block.indexOf('Verify heavy runner capacity');
    const install = Math.min(
      ...['- name: Install (frozen)', '- name: Install dependencies']
        .map((marker) => block.indexOf(marker))
        .filter((index) => index >= 0),
    );
    assert.ok(
      setupNode >= 0 && capacityGuard > setupNode && capacityGuard < install,
      `${start[1]} must check capacity after Node setup and before dependency installation`,
    );
  }
  assert.equal(heavyJobs.length, 19);
  assert.ok(heavyJobs.includes('vitest-browser-shard'));
  assert.ok(heavyJobs.includes('auto-exposure-feature-evidence'));
});

test('hello-taa PR CI uses simulation lanes and does not require physical GPU admission', () => {
  assert.doesNotMatch(workflow, /hello-taa-performance-admission/);
  assert.doesNotMatch(workflow, /smoke:performance:admission|native-performance-admission/);
  assert.doesNotMatch(workflow, /macos-15-xlarge/);
  const start = workflow.indexOf('  smoke-fleet:\n');
  const end = workflow.indexOf('  smoke-fleet-required-context:\n', start);
  const block = workflow.slice(start, end);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(block, /Hello-taa headless smoke \(dawn-node \+ lavapipe WebGPU\)/);
  assert.doesNotMatch(block, /Hello-taa browser serialization and raster smoke/);
  assert.match(block, /Hello-taa CPU-WebGL2 static admission contract/);
  assert.match(block, /Hello-taa Motion Blur falsifier evidence/);
  assert.match(
    block,
    /Hello-taa Motion Blur falsifier evidence[\s\S]*?FORGEAX_TAA_FALSIFIER_PROFILE: ci[\s\S]*?SMOKE_FALSIFY_CONCURRENCY: 1/,
    'PR smoke-fleet must use the bounded TAA falsifier profile without GPU oversubscription',
  );
  assert.match(
    workflow,
    /Hello-taa Motion Blur falsifier evidence[\s\S]*?FORGEAX_BROWSER_LAUNCH_ARGS: --use-vulkan=swiftshader --use-angle=swiftshader/,
    'The TAA CI witness must select the same software adapter as browser shards',
  );
  assert.match(block, /Hello-taa temporal Motion Blur correctness evidence/);
  assert.match(block, /pnpm --filter @forgeax\/hello-taa smoke:performance/);
});

test('smoke-fleet builds hello-taa before its performance consumer runs', () => {
  const start = workflow.indexOf('  smoke-fleet:\n');
  const end = workflow.indexOf('  smoke-fleet-required-context:\n', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = workflow.slice(start, end);
  const build = block.indexOf('name: Build hello-taa smoke consumer');
  const smoke = block.indexOf('pnpm --filter @forgeax/hello-taa smoke');
  const performance = block.indexOf('pnpm --filter @forgeax/hello-taa smoke:performance');
  assert.ok(build >= 0, 'smoke-fleet must materialize a complete hello-taa dist');
  assert.ok(smoke >= 0 && build < smoke, 'hello-taa build must precede Dawn smoke');
  assert.ok(
    performance >= 0 && build < performance,
    'hello-taa build must precede smoke:performance',
  );
});

test('shared-inputs browser reuses the immutable producer instead of recooking the corpus', () => {
  const buildArtifacts = workflow.slice(
    workflow.indexOf('  build-artifacts:\n'),
    workflow.indexOf('  cache-warm:\n'),
  );
  const sharedInputs = workflow.slice(
    workflow.indexOf('  shared-inputs-browser:\n'),
    workflow.indexOf('  multithread-browser-benchmark:\n'),
  );
  assert.match(
    buildArtifacts,
    /shared_artifact_id: \$\{\{ needs\.shared-app-inputs\.outputs\.shared_artifact_id \}\}/,
  );
  assert.doesNotMatch(buildArtifacts, /full_shared_artifact_id/);
  assert.match(
    buildArtifacts,
    /shared_input_fingerprint: \$\{\{ needs\.shared-app-inputs\.outputs\.input_fingerprint \}\}/,
  );
  assert.match(sharedInputs, /needs: \[core-build, shared-app-inputs, post-merge-gate\]/);
  assert.match(sharedInputs, /prepare-ci-inputs\.mjs --consumer shared-inputs-browser/);
  assert.match(sharedInputs, /--artifact-ids .*needs\.core-build\.outputs\.core_artifact_id/);
  assert.match(
    sharedInputs,
    /--shared-artifact-id .*needs\.shared-app-inputs\.outputs\.shared_artifact_id/,
  );
  assert.match(
    sharedInputs,
    /--input-fingerprint .*needs\.shared-app-inputs\.outputs\.input_fingerprint/,
  );
  assert.match(
    sharedInputsBrowserSmoke,
    /const injected = process\.env\.FORGEAX_SHARED_APP_INPUTS_MANIFEST;/,
  );
  assert.match(
    sharedInputsBrowserSmoke,
    /if \(injected === undefined\) return buildSharedInputs\(sharedRoot\);/,
  );
  assert.match(sharedInputsBrowserSmoke, /FORGEAX_SHARED_APP_INPUTS_MANIFEST: manifest/);
  assert.match(sharedInputsBrowserSmoke, /FORGEAX_SHARED_APP_INPUTS_MODE: 'catalog-only'/);
  assert.doesNotMatch(sharedInputs, /full_shared_artifact_id/);
  const contract = JSON.parse(readFileSync(resolve('scripts/ci/build-artifact-contract.json')));
  assert.deepEqual(contract.consumers['shared-inputs-browser'].requiredArtifactClasses, [
    'engine-dist',
    'wasm-runtime',
    'shared-engine-shaders',
  ]);
});

test('shared-inputs live sync inherits the producer manifest at job scope', () => {
  const sharedStart = workflow.indexOf('  shared-inputs-browser:\n');
  const sharedEnd = workflow.indexOf('  multithread-browser-benchmark:\n', sharedStart);
  assert.notEqual(sharedStart, -1);
  assert.notEqual(sharedEnd, -1);
  const sharedInputs = workflow.slice(sharedStart, sharedEnd);
  const envStart = sharedInputs.indexOf('    env:\n');
  const stepsStart = sharedInputs.indexOf('    steps:\n');
  assert.ok(
    envStart >= 0 && envStart < stepsStart,
    'shared-inputs-browser must define job env before steps',
  );
  const jobEnv = sharedInputs.slice(envStart, stepsStart);
  assert.match(
    jobEnv,
    /FORGEAX_SHARED_APP_INPUTS_MANIFEST: \$\{\{ github\.workspace \}\}\/shared-app-inputs\/manifest\.json/,
    'live sync must inherit the manifest produced by shared-app-inputs',
  );

  const blendingStart = sharedInputs.indexOf(
    '      - name: Blending shared-inputs preview/HMR probe\n',
  );
  const captureStart = sharedInputs.indexOf(
    '      - name: DevKit capture observation and validation contract\n',
  );
  assert.ok(blendingStart >= 0 && blendingStart < captureStart);
  assert.doesNotMatch(
    sharedInputs.slice(blendingStart, captureStart),
    /FORGEAX_SHARED_APP_INPUTS_MANIFEST:/,
    'the producer manifest must not be scoped only to the blending step',
  );

  const verify = sharedInputs.indexOf(
    'node scripts/ci/prepare-ci-inputs.mjs --consumer shared-inputs-browser',
  );
  const sync = sharedInputs.indexOf('pnpm --filter @forgeax/engine-devkit smoke:sync');
  assert.ok(
    verify >= 0 && verify < sync,
    'live sync must run after the shared artifact is verified',
  );
  assert.match(sharedInputs, /timeout-minutes: 45/);
});

test('SDK source smoke reuses the source build shader projection without git metadata', () => {
  assert.match(
    sdkVerifySource,
    /FORGEAX_SHARED_APP_INPUTS_MANIFEST: resolve\(sourceRoot, 'shared-build-inputs\/manifest\.json'\)/,
  );
  assert.match(shaderPluginSource, /FORGEAX_SOURCE_SHA\?\.trim\(\)/);
  assert.match(shaderPluginSource, /stdio: \['ignore', 'pipe', 'ignore'\]/);
});

test('read-only shader consumers prepare verified inputs before materializing them', () => {
  for (const [job, nextJob] of [
    ['primary-pnpm', 'coverage-pnpm-shard'],
    ['coverage-pnpm-shard', 'coverage-pnpm'],
    ['multithread-browser-benchmark', 'smoke-fleet'],
    ['smoke-fleet', 'smoke-fleet-required-context'],
    ['bevy-smoke-fleet', 'bevy-smoke-fleet-required-context'],
    ['collectathon-boot-e2e', 'gpu-pass-timing-contract'],
    ['gpu-pass-timing-contract', 'cost-reporter'],
  ]) {
    const start = workflow.indexOf(`  ${job}:\n`);
    const end = workflow.indexOf(`  ${nextJob}:\n`, start);
    const block = workflow.slice(start, end);
    const consumer =
      job === 'gpu-pass-timing-contract'
        ? 'primary-pnpm'
        : job === 'coverage-pnpm-shard'
          ? 'coverage-pnpm'
          : job;
    const prepare = block.indexOf(`prepare-ci-inputs.mjs --consumer ${consumer}`);
    const materialize = block.indexOf('materialize-app-shader-manifests.mjs');
    assert.ok(start >= 0 && end > start, `${job} must have a bounded workflow block`);
    assert.ok(prepare >= 0 && prepare < materialize, `${job} must prepare before materializing`);
    assert.match(block, /--artifact-ids/);
    assert.match(block, /--shared-artifact-id/);
    assert.match(block, /--input-fingerprint/);
    assert.match(block, /--shared-input-manifest shared-app-inputs\/manifest\.json/);
    if (job === 'smoke-fleet' || job === 'bevy-smoke-fleet') {
      assert.match(
        block,
        /FORGEAX_SHARED_APP_INPUTS_MANIFEST: \$\{\{ github\.workspace \}\}\/shared-app-inputs\/manifest\.json/,
        `${job} must reuse the shared shader projection for read-only Vite consumers`,
      );
    }
  }
  assert.match(
    inputPreparationSource,
    /if \(needsShared\) await invoke\(\['scripts\/ci\/unpack-shared-app-inputs\.mjs', '--root', stage\]\)/,
  );
  assert.match(inputPreparationSource, /'scripts\/ci\/verify-build-artifact-input\.mjs'/);
  assert.match(inputPreparationSource, /await verify\('restore'\);\s+await publish\(\);/);
  assert.match(inputPreparationSource, /await rebuild\(\);\s+await verify\('build'\);/);
  const primaryM4Start = workflow.indexOf('      - name: Hello M4 interactive simulation smoke');
  const primaryM4 = workflow.slice(
    primaryM4Start,
    workflow.indexOf('      # tweak-', primaryM4Start),
  );
  assert.match(
    primaryM4,
    /FORGEAX_SHARED_APP_INPUTS_MANIFEST: \$\{\{ github\.workspace \}\}\/shared-app-inputs\/manifest\.json/,
  );
  const realGpuUnpack = realGpuWorkflow.indexOf('unpack-shared-app-inputs.mjs');
  const realGpuMaterialize = realGpuWorkflow.indexOf('materialize-app-shader-manifests.mjs');
  assert.ok(realGpuUnpack >= 0 && realGpuUnpack < realGpuMaterialize);
  assert.match(realGpuWorkflow, /--archive shared-app-inputs\.tar\.gz/);
});

test('CI harness materialization uses a blob-filtered docs-only clone', () => {
  const materializeSteps = workflow.match(
    /- name: Materialize harness documentation[\s\S]*?FORGEAX_HARNESS_SPARSE_DOCS: '1'/g,
  );
  assert.equal(materializeSteps?.length, 2);
  assert.equal(
    (workflow.match(/node scripts\/ci\/materialize-harness-docs\.mjs/g) ?? []).length,
    2,
  );
  const syncHarness = readFileSync(resolve('scripts/sync-harness.mjs'), 'utf8');
  assert.match(syncHarness, /--filter=blob:none[\s\S]*--sparse/);
  assert.match(syncHarness, /\['fetch', '--quiet', '--depth=1', 'origin', 'main'\]/);
});

test('browser WebGPU project bounds workers to protect the shared device', () => {
  assert.match(browserVitestConfig, /maxWorkers: 1/);
});

test('Dawn project uses one worker to protect the shared software Vulkan backend', () => {
  const dawnProject = vitestConfig.slice(vitestConfig.indexOf("name: 'dawn'"));
  assert.match(dawnProject, /maxWorkers: 1/);
});

test('Dawn PR roster and RenderScene perf keep CI workloads bounded', () => {
  const dawnStart = workflow.indexOf('  vitest-dawn:\n');
  const dawn = workflow.slice(dawnStart, workflow.indexOf('  vitest-dawn-required:\n', dawnStart));
  assert.match(dawn, /run: node scripts\/ci\/run-dawn-gate\.mjs --shard/);

  const coverageStart = workflow.indexOf('  coverage-perf:\n');
  const coverage = workflow.slice(
    coverageStart,
    workflow.indexOf('  directional-csm-browser:\n', coverageStart),
  );
  assert.match(coverage, /FORGEAX_RENDER_PERF_LIGHTWEIGHT: ['"]1['"]/);
  assert.match(coverage, /--project=render-perf/);
});

test('ECS performance project keeps benchmark contention inside a bounded timeout', () => {
  const ecsPerfProject = vitestConfig.slice(vitestConfig.indexOf("name: 'ecs-perf'"));
  assert.match(ecsPerfProject, /testTimeout: 30000/);
});

test('cold Ubuntu smoke and browser jobs keep their real runtime budget', () => {
  const smokeStart = workflow.indexOf('  smoke-fleet:\n');
  const smokeFleet = workflow.slice(
    smokeStart,
    workflow.indexOf('  smoke-fleet-required-context:\n', smokeStart),
  );
  assert.match(smokeFleet, /timeout-minutes: 60/);
  assert.match(smokeFleet, /prepare-ci-inputs\.mjs --consumer smoke-fleet/);
  assert.match(inputPreparationSource, /timeoutMs = 20 \* 60_000/);
  assert.match(inputPreparationSource, /const deadline = Date\.now\(\) \+ 60_000;/);
  assert.match(smokeFleet, /- name: Run authoritative Dawn roster shard\n\s+timeout-minutes: 45/);
  assert.match(smokeFleet, /DAWN_SMOKE_ENTRY_TIMEOUT_MS: 300000/);
  assert.match(
    smokeFleet,
    /Learn-render framebuffers Dawn smoke[\s\S]*?pnpm --filter @forgeax\/app-learn-render-4-advanced-opengl-5-framebuffers smoke\n/,
  );
  assert.match(
    smokeFleet,
    /Learn-render framebuffers M4 reentry_m4_t2 browser evidence[\s\S]*?xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0[\s\S]*?run-browser-gate-with-retry\.mjs[\s\S]*?--mode=rhi-debug[\s\S]*?smoke:browser/,
  );
  assert.match(
    smokeFleet,
    /Learn-render framebuffers M4 reentry_m4_t3 live evidence[\s\S]*?xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0[\s\S]*?run-browser-gate-with-retry\.mjs[\s\S]*?--mode=rhi-debug[\s\S]*?smoke:browser-live/,
  );
  assert.match(
    smokeFleet,
    /Learn-render framebuffers M4 reentry_m4_t3 live evidence[\s\S]*?if: matrix\.group == 1 && github\.event_name == 'workflow_dispatch' && inputs\.run_m4_live_evidence == true/,
  );
  assert.match(smokeFleet, /Upload M4 browser diagnostics[\s\S]*?if: always\(\)/);
  assert.doesNotMatch(smokeFleet, /run-hello-learn-render-smoke-roster\.mjs/);

  const sharedStart = workflow.indexOf('  shared-inputs-browser:\n');
  const sharedInputs = workflow.slice(
    sharedStart,
    workflow.indexOf('  multithread-browser-benchmark:\n', sharedStart),
  );
  assert.match(sharedInputs, /timeout-minutes: 45/);
  assert.doesNotMatch(sharedInputs, /Cache Playwright browsers/);

  const vitestShardStart = workflow.indexOf('  vitest-browser-shard:\n');
  const vitestBrowserShard = workflow.slice(
    vitestShardStart,
    workflow.indexOf('  vitest-browser:\n', vitestShardStart),
  );
  assert.doesNotMatch(vitestBrowserShard, /Cache Playwright browsers/);
  assert.match(vitestBrowserShard, /timeout-minutes: 45/);
});

test('the VFX GPU benchmark has one owner after the smoke fleet releases the device', () => {
  const smokeStart = workflow.indexOf('  smoke-fleet:\n');
  const smokeFleet = workflow.slice(
    smokeStart,
    workflow.indexOf('  smoke-fleet-required-context:\n', smokeStart),
  );
  assert.doesNotMatch(smokeFleet, /VFX Batch B performance protocol|vfx-batch-b\.mjs/);

  const metricsStart = workflow.indexOf('  metrics-validate:\n');
  const metrics = workflow.slice(
    metricsStart,
    workflow.indexOf('  collectathon-boot-e2e:\n', metricsStart),
  );
  assert.match(metrics, /needs: \[[^\]]*smoke-fleet[^\]]*\]/);
  assert.match(metrics, /needs\.smoke-fleet\.result == 'success'/);
  assert.match(metrics, /run: pnpm metrics:run/);

  const artifactContract = JSON.parse(
    readFileSync(resolve('scripts/ci/build-artifact-contract.json'), 'utf8'),
  );
  const metricsTiming = artifactContract.timingRoster.find(
    (entry) => entry.jobIdentity === 'metrics-validate',
  );
  assert.ok(metricsTiming);
  assert.ok(metricsTiming.allowedNonArtifactPrerequisites.includes('smoke-fleet'));
});

test('self-hosted setup-node steps do not transfer the pnpm store archive', () => {
  const setupNodeSteps = workflow.match(/uses: actions\/setup-node@v5/g) ?? [];
  const disabledStoreCaches = workflow.match(/^\s+package-manager-cache: false$/gm) ?? [];
  assert.equal(disabledStoreCaches.length, setupNodeSteps.length);
  assert.doesNotMatch(workflow, /package-manager-cache:\s*true/);
});

test('the self-hosted bench setup-node also avoids the pnpm store archive', () => {
  const setupNodeSteps = benchWorkflow.match(/uses: actions\/setup-node@v5/g) ?? [];
  const disabledStoreCaches = benchWorkflow.match(/^\s+package-manager-cache: false$/gm) ?? [];
  assert.equal(setupNodeSteps.length, 1);
  assert.equal(disabledStoreCaches.length, setupNodeSteps.length);
  assert.doesNotMatch(benchWorkflow, /package-manager-cache:\s*true/);
});

test('informational math bench keeps its result in the summary without an artifact upload', () => {
  assert.match(benchWorkflow, /Run vitest bench \(math\)/);
  assert.match(benchWorkflow, /GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(benchWorkflow, /upload-artifact/);
});

test('Mesa installation supports root self-hosted runners without sudo', () => {
  assert.match(mesaVulkanAction, /command -v sudo/);
  assert.match(mesaVulkanAction, /\[ "\$\(id -u\)" -eq 0 \]/);
  assert.match(mesaVulkanAction, /run_privileged\(\) \{ "\$@"; \}/);
  assert.doesNotMatch(mesaVulkanAction, /sudo (?:dpkg|apt-get)/);
});

test('coverage-pnpm uploads diagnostics only after a failed test run', () => {
  const perfGuard = workflow.indexOf('- name: Perf-budget regression guard - coverage path');
  const diagnosticUpload = workflow.indexOf('- name: Upload coverage diagnostics on failure');
  assert.ok(perfGuard >= 0 && diagnosticUpload > perfGuard);
  assert.match(
    workflow,
    /- name: Upload coverage diagnostics on failure[\s\S]*?if: failure\(\)[\s\S]*?uses: \.\/\.github\/actions\/upload-optional-artifact/,
  );
  assert.doesNotMatch(uploadOptionalArtifact, /continue-on-error:/);
  assert.match(
    uploadWithRetry,
    /id: upload[\s\S]*?continue-on-error: true[\s\S]*?if: steps\.upload\.outcome == 'failure'/,
  );
  assert.equal(uploadWithRetry.match(/continue-on-error: true/g)?.length, 2);
  assert.equal(uploadWithRetry.match(/ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: '60000'/g)?.length, 2);
  const optionalUploads = (
    workflow.match(/uses: \.\/\.github\/actions\/upload-optional-artifact/g) ?? []
  ).length;
  assert.ok(optionalUploads > 0);
  assert.equal(
    (
      workflow.match(
        /uses: \.\/\.github\/actions\/upload-optional-artifact\n\s+timeout-minutes: 2/g,
      ) ?? []
    ).length,
    optionalUploads,
  );
  assert.equal(
    uploadOptionalArtifact.match(/ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: '60000'/g)?.length,
    1,
  );
});

test('every CI checkout uses the producer product commit', () => {
  const checkouts = workflow.split(/uses: actions\/checkout@v5\n/).slice(1);
  assert.ok(checkouts.length > 0);
  for (const checkout of checkouts) {
    const inputs = checkout.split(/\n {6}-|\n {2}\S/)[0];
    assert.match(
      inputs,
      /ref: \$\{\{ env\.EXPECTED_PRODUCT_SHA \}\}/,
      'artifact consumers must not combine the implicit PR merge ref with head-SHA producer outputs',
    );
  }
});

test('the 60-frame visibility oracle bounds shadow texels and does not overlap timed-out retries', () => {
  const smoke = readFileSync(
    resolve('apps/hello/entity-visibility/scripts/smoke-dawn.mjs'),
    'utf8',
  );
  assert.match(smoke, /cascadeCount: 1, mapSize: 256, shadowDistance: 20/);
  assert.match(smoke, /runVisibilityDawnSmoke\(\{ frames = 60 \}/);
  assert.match(
    readFileSync(resolve('apps/hello/entity-visibility/__tests__/visibility.dawn.test.ts'), 'utf8'),
    /retry: 0/,
  );
});
