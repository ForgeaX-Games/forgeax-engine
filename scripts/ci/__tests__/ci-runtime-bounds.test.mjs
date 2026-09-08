import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
const benchWorkflow = readFileSync(resolve('.github/workflows/bench.yml'), 'utf8');
const packageManifest = readFileSync(resolve('package.json'), 'utf8');
const vitestConfig = readFileSync(resolve('vitest.config.ts'), 'utf8');
const browserVitestConfig = readFileSync(resolve('vitest-browser-project.ts'), 'utf8');
const uploadWithRetry = readFileSync(
  resolve('.github/actions/upload-artifact-with-retry/action.yml'),
  'utf8',
);
const uploadOptionalArtifact = readFileSync(
  resolve('.github/actions/upload-optional-artifact/action.yml'),
  'utf8',
);
const mesaVulkanAction = readFileSync(
  resolve('.github/actions/install-mesa-vulkan-drivers/action.yml'),
  'utf8',
);

test('coverage-pnpm splits Vitest coverage into bounded fresh processes', () => {
  const coverageStart = workflow.indexOf('  coverage-pnpm:\n');
  const coverage = workflow.slice(
    coverageStart,
    workflow.indexOf('  coverage-perf:\n', coverageStart),
  );
  assert.match(coverage, /timeout-minutes: 45/);
  assert.match(coverage, /node scripts\/ci\/run-split-vitest-coverage\.mjs/);
  assert.match(coverage, /--group-size=4[\s\S]*?--group-concurrency=auto[\s\S]*?--max-workers=1/);
  assert.match(
    readFileSync(resolve('scripts/ci/run-split-vitest-coverage.mjs'), 'utf8'),
    /--maxWorkers=\$\{maxWorkers\}[\s\S]*?--typecheck[\s\S]*?--coverage/,
  );
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
  assert.match(packageManifest, /run-split-vitest-browser\.mjs --group-size=4 --max-workers=1/);
  const browserRunner = readFileSync(resolve('scripts/ci/run-split-vitest-browser.mjs'), 'utf8');
  assert.match(browserRunner, /--project=browser/);
  assert.match(browserRunner, /--maxWorkers=\$\{maxWorkers\}/);
  assert.match(browserRunner, /--shard-count/);
  assert.match(browserRunner, /selectedGroups/);
  assert.match(browserRunner, /runBrowserCommand/);
  assert.match(browserRunner, /isRetryableOutput\('vitest', first\.output\)/);
  assert.doesNotMatch(browserRunner, /isolatedInstancingBrowserTest/);
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
    /Hello-learn-render-4\.9-instancing smoke[\s\S]*?@forgeax\/app-learn-render-4-advanced-opengl-9-instancing' smoke/,
  );
  assert.match(browserRunner, /const preview = files\.filter/);
  assert.match(browserRunner, /FORGEAX_BROWSER_ENTITY_VISIBILITY: '0'/);
  assert.match(browserRunner, /file\.startsWith\('apps\/preview\/'\)/);
  assert.match(browserRunner, /FORGEAX_BROWSER_PACK_READINESS: producerReadiness/);
  assert.match(browserRunner, /excludedDirectories = new Set\(\[.*artifacts/);
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
  assert.match(browserShard, /matrix:\n\s+shard: \[0, 1, 2, 3\]/);
  assert.match(browserShard, /--shard-index=\$\{\{ matrix\.shard \}\}/);
  assert.match(browserShard, /if: matrix\.shard == 0/);
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
  assert.equal(heavyJobs.length, 14);
  assert.ok(heavyJobs.includes('vitest-browser-shard'));
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
  assert.match(sharedInputs, /--path shared-app-inputs/);
  assert.match(sharedInputs, /--shared-input-manifest shared-app-inputs\/manifest\.json/);
  assert.match(sharedInputs, /--shared-input-mode catalog-only/);
  assert.match(sharedInputs, /needs\.build-artifacts\.outputs\.shared_artifact_id/);
  assert.doesNotMatch(sharedInputs, /full_shared_artifact_id/);
  const contract = JSON.parse(readFileSync(resolve('scripts/ci/build-artifact-contract.json')));
  assert.deepEqual(contract.consumers['shared-inputs-browser'].requiredArtifactClasses, [
    'engine-dist',
    'wasm-runtime',
  ]);
});

test('CI harness materialization uses a blob-filtered docs-only clone', () => {
  const materializeSteps = workflow.match(
    /- name: Materialize harness documentation[\s\S]*?FORGEAX_HARNESS_SPARSE_DOCS: '1'/g,
  );
  assert.equal(materializeSteps?.length, 2);
  const syncHarness = readFileSync(resolve('scripts/sync-harness.mjs'), 'utf8');
  assert.match(syncHarness, /--filter=blob:none[\s\S]*--sparse/);
  assert.match(syncHarness, /\['fetch', '--quiet', '--depth=1', 'origin', 'main'\]/);
});

test('browser WebGPU project bounds workers to protect the shared device', () => {
  assert.match(browserVitestConfig, /maxWorkers: 1/);
});

test('Dawn project bounds forks to protect the shared software Vulkan backend', () => {
  const dawnProject = vitestConfig.slice(vitestConfig.indexOf("name: 'dawn'"));
  assert.match(dawnProject, /maxWorkers: 2/);
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
  assert.match(smokeFleet, /timeout-minutes: 45/);

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

test('Mesa installation supports root self-hosted runners without sudo', () => {
  assert.match(mesaVulkanAction, /command -v sudo/);
  assert.match(mesaVulkanAction, /\[ "\$\(id -u\)" -eq 0 \]/);
  assert.match(mesaVulkanAction, /run_privileged\(\) \{ "\$@"; \}/);
  assert.doesNotMatch(mesaVulkanAction, /sudo (?:dpkg|apt-get)/);
});

test('coverage-pnpm uploads diagnostics only after a failed test run', () => {
  assert.match(
    workflow,
    /- name: Upload coverage diagnostics on failure[\s\S]*?if: failure\(\)[\s\S]*?uses: \.\/\.github\/actions\/upload-optional-artifact/,
  );
  assert.doesNotMatch(workflow, /^\s+continue-on-error: true$/m);
  assert.match(
    uploadOptionalArtifact,
    /continue-on-error: true[\s\S]*?uses: actions\/upload-artifact@v6/,
  );
  assert.match(
    uploadWithRetry,
    /id: upload[\s\S]*?continue-on-error: true[\s\S]*?if: steps\.upload\.outcome == 'failure'/,
  );
  assert.equal(uploadWithRetry.match(/continue-on-error: true/g)?.length, 2);
  assert.equal(uploadWithRetry.match(/ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: '60000'/g)?.length, 3);
  assert.equal(
    (workflow.match(/uses: \.\/\.github\/actions\/upload-optional-artifact/g) ?? []).length,
    5,
  );
  assert.equal(
    (
      workflow.match(
        /uses: \.\/\.github\/actions\/upload-optional-artifact\n\s+timeout-minutes: 2/g,
      ) ?? []
    ).length,
    5,
  );
  assert.equal(
    uploadOptionalArtifact.match(/ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: '60000'/g)?.length,
    1,
  );
});
