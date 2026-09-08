import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
const benchWorkflow = readFileSync(resolve('.github/workflows/bench.yml'), 'utf8');
const nativeRayQueryWorkflow = readFileSync(
  resolve('.github/workflows/native-ray-query.yml'),
  'utf8',
);
const postMergeMonitor = readFileSync(resolve('.github/workflows/post-merge-monitor.yml'), 'utf8');
const mesaVulkanAction = readFileSync(
  resolve('.github/actions/install-mesa-vulkan-drivers/action.yml'),
  'utf8',
);
const collectathonSmoke = readFileSync(
  resolve('apps/collectathon/scripts/smoke-browser.mjs'),
  'utf8',
);
const uiAuthoringSmoke = readFileSync(
  resolve('apps/preview/scripts/smoke-ui-authoring.mjs'),
  'utf8',
);
const webkitCapabilityProbe = readFileSync(
  resolve('scripts/ci/probe-playwright-webkit.mjs'),
  'utf8',
);
const webkitColorLightingProbe = readFileSync(
  resolve('scripts/dev-verify/verify-webkit-color-lighting.mjs'),
  'utf8',
);
const webkitHelloTriangleProbe = readFileSync(
  resolve('scripts/dev-verify/verify-webkit-hello-triangle.mjs'),
  'utf8',
);
const colorLightingMain = readFileSync(resolve('apps/parity/color-lighting/src/main.ts'), 'utf8');

function jobSection(name) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing ${name}`);
  const remaining = workflow.slice(start);
  const nextJob = remaining.slice(1).search(/\n {2}[a-z][\w-]+:/);
  return remaining.slice(0, nextJob === -1 ? undefined : nextJob + 1);
}

test('private-repository CI has one trusted runner/control path', () => {
  assert.doesNotMatch(workflow, /IS_FORK_PR/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.repo\.full_name/);
  assert.doesNotMatch(workflow, /github-hosted-linux-x64/);
  assert.doesNotMatch(workflow, /fork PR/i);
  assert.match(
    jobSection('coverage-pnpm'),
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "heavy"\]'\) \}\}/,
  );
  assert.doesNotMatch(jobSection('coverage-pnpm'), /github\.event\.pull_request/);
});

test('coverage and perf ownership are not duplicated in primary-pnpm', () => {
  const primary = jobSection('primary-pnpm');
  assert.doesNotMatch(primary, /Vitest unit/);
  assert.doesNotMatch(primary, /vitest-unit-out\.json/);
  assert.doesNotMatch(primary, /--project=ecs-perf/);
  assert.match(jobSection('coverage-pnpm'), /Vitest coverage \(v8\) \+ typecheck/);
  assert.doesNotMatch(jobSection('coverage-pnpm'), /--project=ecs-perf/);
  assert.match(jobSection('coverage-perf'), /ECS performance ratio gates \(uninstrumented\)/);
  assert.match(jobSection('coverage-perf'), /--project=ecs-perf/);
});

test('collectathon browser boot uses the trusted Linux WebGPU capability', () => {
  assert.doesNotMatch(
    workflow,
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "ubuntu"\]'\) \}\}/,
    'CI must not require the dedicated ubuntu runner label',
  );
  assert.doesNotMatch(
    workflow,
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64"\]'\) \}\}/,
    'CI must require an explicit capacity label',
  );
  const collectathon = jobSection('collectathon-boot-e2e');
  assert.match(
    collectathon,
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "heavy"\]'\) \}\}/,
  );
  assert.doesNotMatch(collectathon, /macos-latest/);
  assert.match(collectathon, /install-mesa-vulkan-drivers/);
  assert.match(collectathon, /install-playwright-chrome-beta/);
  assert.match(collectathon, /FORGEAX_CHROME_CHANNEL: chrome-beta/);
  assert.match(collectathon, /FORGEAX_COLLECTATHON_OFFSCREEN: ['"]1['"]/);
  assert.match(collectathonSmoke, /chromeChannel === 'chrome-beta'/);
  assert.match(collectathonSmoke, /FORGEAX_COLLECTATHON_OFFSCREEN/);
  assert.match(collectathonSmoke, /device\.createTexture/);
  assert.match(collectathonSmoke, /--use-vulkan=swiftshader/);
  assert.match(collectathonSmoke, /--disable-vulkan-surface/);
});

test('resource-intensive WebGPU/browser gates use the heavy capacity pool', () => {
  const heavySelector =
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "heavy"\]'\) \}\}/;
  for (const name of [
    'vitest-browser',
    'shared-inputs-browser',
    'smoke-fleet',
    'bevy-smoke-fleet',
    'vitest-dawn',
    'webkit-fallback',
    'metrics-validate-browser',
    'metrics-validate-runtime',
    'metrics-validate',
    'collectathon-boot-e2e',
    'coverage-pnpm',
  ]) {
    const actualJob = name === 'vitest-browser' ? 'vitest-browser-shard' : name;
    assert.match(jobSection(actualJob), heavySelector, `${name} must use the heavy pool`);
    if (name === 'vitest-browser') {
      assert.match(
        jobSection('vitest-browser-shard'),
        /matrix:\n\s+shard: \[0, 1, 2, 3\]/,
        'vitest-browser must retain its four heavy matrix legs',
      );
    }
  }
  const sharedInputsBrowser = jobSection('shared-inputs-browser');
  assert.doesNotMatch(
    sharedInputsBrowser,
    /playwright install chromium/,
    'shared-inputs-browser must not provision a second browser beside its canonical Chrome Beta carrier',
  );
  assert.match(
    sharedInputsBrowser,
    /name: UI authoring preview\/capture probe\n\s+env:\n\s+FORGEAX_CHROME_CHANNEL: chrome-beta/,
    'the UI authoring probe must reuse the canonical Chrome Beta carrier',
  );
  assert.match(uiAuthoringSmoke, /process\.env\.FORGEAX_CHROME_CHANNEL/);
  assert.match(uiAuthoringSmoke, /chromeChannel \? \{ channel: chromeChannel \} : \{\}/);
});

test('each browser carrier owns its multithread capability evidence', () => {
  const multithread = jobSection('multithread-browser-benchmark');
  const webkit = jobSection('webkit-fallback');
  assert.match(multithread, /run-capability-matrix\.mjs --browser=chrome/);
  assert.doesNotMatch(multithread, /install(?:-deps)? webkit/);
  assert.match(webkit, /run-capability-matrix\.mjs\s+--browser=webkit/);
});

test('WebKit provisions host libraries only after a real launch probe fails', () => {
  const webkit = jobSection('webkit-fallback');
  assert.match(
    webkit,
    /PLAYWRIGHT_BROWSERS_PATH: \$\{\{ github\.workspace \}\}\/\.cache\/ms-playwright-webkit/,
  );
  assert.match(webkit, /name: Cache Playwright WebKit browser/);
  assert.match(webkit, /key: playwright-webkit-/);
  assert.match(webkit, /name: Probe Playwright WebKit host capability/);
  assert.doesNotMatch(webkit, /continue-on-error/);
  assert.match(webkit, /echo "available=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(webkit, /echo "available=false" >> "\$GITHUB_OUTPUT"/);
  assert.match(
    webkit,
    /name: Install Playwright WebKit system deps when capability is absent\n\s+if: steps\.probe-webkit-host\.outputs\.available != 'true'/,
  );
  assert.match(webkit, /FORGEAX_APT_ARCHIVE_MIRROR=ubuntu-mirrorlist/);
  assert.match(webkit, /name: Verify Playwright WebKit host capability/);
  assert.match(webkitCapabilityProbe, /webkit\.launch\(\{ headless: true \}\)/);
  assert.match(webkitCapabilityProbe, /navigator\.userAgent/);
});

test('WebKit color-lighting cases isolate browser processes and retry only WASM crashes', () => {
  assert.match(webkitColorLightingProbe, /for \(const caseId of CASE_IDS\)/);
  const isolatedCaseStart = webkitColorLightingProbe.indexOf(
    'const runIsolatedCase = async (caseId)',
  );
  const isolatedCaseEnd = webkitColorLightingProbe.indexOf(
    'const mergeCaseResults =',
    isolatedCaseStart,
  );
  assert.notEqual(isolatedCaseStart, -1);
  assert.notEqual(isolatedCaseEnd, -1);
  const isolatedCase = webkitColorLightingProbe.slice(isolatedCaseStart, isolatedCaseEnd);
  assert.match(isolatedCase, /webkit\.launch\(\{ headless \}\)/);
  assert.match(isolatedCase, /browser\.newContext\(\{ noDefaultViewport: true \}\)/);
  assert.match(webkitColorLightingProbe, /runCaseWithRetry\(caseId\)/);
  assert.match(webkitColorLightingProbe, /runWithRetry\(/);
  assert.match(webkitColorLightingProbe, /retryable: !ok && crash !== null/);
  assert.doesNotMatch(webkitColorLightingProbe, /runIsolatedCase\(browser, caseId\)/);
  assert.doesNotMatch(
    webkitColorLightingProbe,
    /page\.evaluate\(async \(\) => window\.__colorLightingWebkitParity/,
  );
  assert.match(colorLightingMain, /requestedCaseId\?: string/);
  assert.match(
    colorLightingMain,
    /sentinelCases\.filter\(\(sceneCase\) => sceneCase\.caseId === requestedCaseId\)/,
  );
});

test('WebKit hello-triangle uses owner readiness instead of a fixed timeout sleep', () => {
  assert.match(webkitHelloTriangleProbe, /window\.__learnRenderBootstrapComplete === true/);
  assert.match(webkitHelloTriangleProbe, /Promise\.race\(\[/);
  assert.match(webkitHelloTriangleProbe, /readinessFailed/);
  assert.doesNotMatch(webkitHelloTriangleProbe, /Date\.now\(\) \+ TIMEOUT_MS/);
});

test('app shards declare the pinned asset source dependency instead of runner residue', () => {
  for (const name of ['app-shard-0', 'app-shard-1', 'app-shard-2']) {
    const shard = jobSection(name);
    assert.match(
      shard,
      new RegExp(`submodules: ${name === 'app-shard-1' ? 'recursive' : 'false'}`),
    );
    assert.match(shard, /name: Materialize pinned app asset sources/);
    assert.match(shard, /git submodule update --init --recursive --depth 1 forgeax-engine-assets/);
  }
});

test('native compilation declares its container capacity and compiler prerequisites', () => {
  assert.match(
    nativeRayQueryWorkflow,
    /node scripts\/ci\/verify-runner-pool-capacity\.mjs --pool heavy/,
  );
  assert.match(nativeRayQueryWorkflow, /apt-get install --yes \\\n\s+build-essential \\/);
});

test('CI preserves main evidence while PR runs may be superseded', () => {
  assert.match(
    workflow,
    /group:\s*\$\{\{\s*github\.workflow\s*\}\}\s*-\s*\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*&&\s*github\.ref\s*\|\|\s*github\.run_id\s*\}\}/,
    'ci must share a group only for pull-request runs',
  );
  assert.match(
    workflow,
    /cancel-in-progress:\s*true/,
    'ci must cancel the older member of a shared pull-request group',
  );
  for (const [name, source] of [
    ['bench', benchWorkflow],
    ['post-merge-monitor', postMergeMonitor],
  ]) {
    assert.doesNotMatch(
      source,
      /cancel-in-progress:\s*true/,
      `${name} must not preempt prior runs`,
    );
    assert.match(source, /cancel-in-progress:\s*false/, `${name} must declare preserve semantics`);
  }
});

test('browser jobs use the workflow as the sole concurrency owner', () => {
  for (const name of [
    'vitest-browser-shard',
    'shared-inputs-browser',
    'multithread-browser-benchmark',
  ]) {
    assert.doesNotMatch(
      jobSection(name),
      /\n\s+concurrency:/,
      `${name} must not create a second cross-run pending queue`,
    );
  }
});

test('post-merge issue lookup retries transient GitHub API transport failures', () => {
  const start = postMergeMonitor.indexOf('  - name: List existing open post-merge issues');
  assert.notEqual(start, -1, 'missing post-merge issue lookup step');
  const section = postMergeMonitor.slice(start);
  const nextStep = section.slice(1).search(/\n {6}- name:/);
  const lookup = section.slice(0, nextStep === -1 ? undefined : nextStep + 1);
  assert.match(lookup, /retries: 3/);
  assert.match(lookup, /retry-exempt-status-codes: 400,401,403,404,422/);
});

test('post-merge failure issues retain failed job and step evidence', () => {
  const start = postMergeMonitor.indexOf('  - name: Open or comment tracking issue on failure');
  assert.notEqual(start, -1, 'missing post-merge failure issue step');
  const section = postMergeMonitor.slice(start);
  assert.match(section, /retries: 3/);
  assert.match(section, /github\.rest\.actions\.listJobsForWorkflowRun/);
  assert.match(section, /\*\*failed jobs \/ steps\*\*:/);
  assert.match(section, /github\.rest\.issues\.createComment/);
  assert.match(section, /github\.rest\.issues\.create\(/);
});

test('Mesa install avoids empty cache poisoning and retries transient apt failures', () => {
  assert.match(mesaVulkanAction, /host already has a lavapipe ICD/);
  assert.match(mesaVulkanAction, /id: mesa-host/);
  assert.match(mesaVulkanAction, /if: \$\{\{ steps\.mesa-host\.outputs\.available != 'true' \}\}/);
  assert.match(mesaVulkanAction, /mesa-vulkan-drivers-deb-v2-/);
  assert.match(mesaVulkanAction, /Acquire::Retries=3/);
  assert.match(mesaVulkanAction, /Acquire::http::Timeout=30/);
  assert.match(mesaVulkanAction, /Acquire::https::Timeout=30/);
  assert.match(mesaVulkanAction, /Dir::Etc::sourceparts=-/);
  assert.match(mesaVulkanAction, /ubuntu\.sources/);
  assert.match(mesaVulkanAction, /update_attempts=3/);
  assert.match(mesaVulkanAction, /apt index refresh failed; retrying/);
  assert.match(mesaVulkanAction, /download_attempts=3/);
  assert.match(mesaVulkanAction, /package download failed; retrying/);
  assert.match(mesaVulkanAction, /lvp_icd\*\.json/);
});

test('Chrome Beta retries change the failing apt archive route', () => {
  const chromeBetaAction = readFileSync(
    resolve('.github/actions/install-playwright-chrome-beta/action.yml'),
    'utf8',
  );
  const aptWrapper = readFileSync(resolve('scripts/ci/with-apt-ubuntu-sources.sh'), 'utf8');
  assert.match(chromeBetaAction, /FORGEAX_APT_ARCHIVE_MIRROR=ubuntu-mirrorlist/);
  assert.match(chromeBetaAction, /retrying .* with Ubuntu mirror fallback/);
  assert.match(aptWrapper, /mirror:\/\/mirrors\.ubuntu\.com\/mirrors\.txt/);
  assert.match(aptWrapper, /synthesized Ubuntu \$ubuntu_codename archive projection/);
  assert.match(aptWrapper, /archive\.ubuntu\.com\/ubuntu/);
  assert.match(aptWrapper, /security\.ubuntu\.com\/ubuntu/);
  assert.match(aptWrapper, /Suites: \$ubuntu_codename \$\{ubuntu_codename\}-updates/);
  assert.match(aptWrapper, /unsupported FORGEAX_APT_ARCHIVE_MIRROR value/);
});
