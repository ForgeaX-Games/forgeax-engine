import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(workflow, /node scripts\/ci\/run-split-vitest-coverage\.mjs/);
  assert.match(workflow, /--group-size=4[\s\S]*?--max-workers=1/);
  assert.match(
    readFileSync(resolve('scripts/ci/run-split-vitest-coverage.mjs'), 'utf8'),
    /--maxWorkers=\$\{maxWorkers\}[\s\S]*?--typecheck[\s\S]*?--coverage/,
  );
  assert.doesNotMatch(workflow, /heavy-(?:32g|256g)/i);
});

test('vitest-browser splits the full browser suite into bounded fresh processes', () => {
  assert.match(packageManifest, /run-split-vitest-browser\.mjs --group-size=4 --max-workers=1/);
  const browserRunner = readFileSync(resolve('scripts/ci/run-split-vitest-browser.mjs'), 'utf8');
  assert.match(browserRunner, /--project=browser/);
  assert.match(browserRunner, /--maxWorkers=\$\{maxWorkers\}/);
  assert.match(browserRunner, /FORGEAX_BROWSER_ENTITY_VISIBILITY: '0'/);
  assert.doesNotMatch(workflow, /heavy-(?:32g|256g)/i);
  assert.match(
    workflow.slice(
      workflow.indexOf('  vitest-browser:\n'),
      workflow.indexOf('  shared-inputs-browser:\n'),
    ),
    /NODE_OPTIONS: --max-old-space-size=4096/,
  );
});

test('CI harness materialization uses a blob-filtered docs-only clone', () => {
  const materializeSteps = workflow.match(
    /- name: Materialize harness documentation[\s\S]*?FORGEAX_HARNESS_SPARSE_DOCS: '1'/g,
  );
  assert.equal(materializeSteps?.length, 2);
  assert.match(
    readFileSync(resolve('scripts/sync-harness.mjs'), 'utf8'),
    /--filter=blob:none[\s\S]*--sparse/,
  );
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
  assert.match(smokeFleet, /timeout-minutes: 30/);

  const sharedStart = workflow.indexOf('  shared-inputs-browser:\n');
  const sharedInputs = workflow.slice(
    sharedStart,
    workflow.indexOf('  smoke-fleet:\n', sharedStart),
  );
  assert.match(sharedInputs, /timeout-minutes: 20/);
  assert.doesNotMatch(sharedInputs, /Cache Playwright browsers/);

  const vitestStart = workflow.indexOf('  vitest-browser:\n');
  const vitestBrowser = workflow.slice(
    vitestStart,
    workflow.indexOf('  shared-inputs-browser:\n', vitestStart),
  );
  assert.match(vitestBrowser, /timeout-minutes: 25/);
  assert.doesNotMatch(vitestBrowser, /Cache Playwright browsers/);
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
    4,
  );
  assert.equal(
    (
      workflow.match(
        /uses: \.\/\.github\/actions\/upload-optional-artifact\n\s+timeout-minutes: 2/g,
      ) ?? []
    ).length,
    4,
  );
});
