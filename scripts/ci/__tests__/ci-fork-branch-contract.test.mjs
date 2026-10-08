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
const collectathonDawnSmoke = readFileSync(
  resolve('apps/collectathon/scripts/smoke-dawn.mjs'),
  'utf8',
);
const collectathonMain = readFileSync(resolve('apps/collectathon/src/main.ts'), 'utf8');
const uiAuthoringSmoke = readFileSync(
  resolve('apps/preview/scripts/smoke-ui-authoring.mjs'),
  'utf8',
);
const chromiumFallbackCapabilityProbe = readFileSync(
  resolve('scripts/ci/probe-playwright-chromium-webgl2.mjs'),
  'utf8',
);
const fxaaBrowserSmoke = readFileSync(resolve('apps/hello/fxaa/scripts/smoke-browser.mjs'), 'utf8');
const fxaaMipmapBrowserSmoke = readFileSync(
  resolve('apps/hello/fxaa/scripts/smoke-mipmap-browser.mjs'),
  'utf8',
);
const webkitColorLightingProbe = readFileSync(
  resolve('scripts/dev-verify/verify-webkit-color-lighting.mjs'),
  'utf8',
);
const r5StabilityProbe = readFileSync(
  resolve('scripts/dev-verify/verify-webkit-r5-stability.mjs'),
  'utf8',
);
const webkitHelloTriangleProbe = readFileSync(
  resolve('scripts/dev-verify/verify-webkit-hello-triangle.mjs'),
  'utf8',
);
const colorLightingMain = readFileSync(resolve('apps/parity/color-lighting/src/main.ts'), 'utf8');
const rhiDebugVerify = readFileSync(resolve('apps/shared/scripts/rhi-debug-verify.mjs'), 'utf8');
const multiUvRhiSmoke = readFileSync(
  resolve('apps/hello-multi-uv/scripts/smoke-browser-rhi.mjs'),
  'utf8',
);
const multiUvComposedSmoke = readFileSync(
  resolve('apps/hello-multi-uv/scripts/smoke-browser-composed.mjs'),
  'utf8',
);
const framebuffersLiveSmoke = readFileSync(
  resolve('apps/learn-render/4.advanced-opengl/5.framebuffers/scripts/smoke-browser-live.mjs'),
  'utf8',
);
const framebuffersBrowserSmoke = readFileSync(
  resolve('apps/learn-render/4.advanced-opengl/5.framebuffers/scripts/smoke-browser.mjs'),
  'utf8',
);
const framebuffersCycleSmoke = readFileSync(
  resolve('apps/learn-render/4.advanced-opengl/5.framebuffers/scripts/smoke-browser-cycle.mjs'),
  'utf8',
);

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
    jobSection('coverage-pnpm-shard'),
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "heavy"\]'\) \}\}/,
  );
  assert.doesNotMatch(jobSection('coverage-pnpm-shard'), /github\.event\.pull_request/);
});

test('coverage and perf ownership are not duplicated in primary-pnpm', () => {
  const primary = jobSection('primary-pnpm');
  assert.doesNotMatch(primary, /Vitest unit/);
  assert.doesNotMatch(primary, /vitest-unit-out\.json/);
  assert.doesNotMatch(primary, /--project=ecs-perf/);
  assert.match(
    jobSection('coverage-pnpm-shard'),
    /Vitest coverage \(v8\) \(bounded runtime children\)/,
  );
  assert.doesNotMatch(jobSection('coverage-pnpm-shard'), /--project=ecs-perf/);
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
  assert.doesNotMatch(collectathonSmoke, /--disable-vulkan-surface/);
});

test('collectathon browser boot uses bounded Vite readiness diagnostics', () => {
  assert.match(collectathonSmoke, /const MAX_VITE_READINESS_TIMEOUT_MS = 180_000/);
  assert.match(collectathonSmoke, /FORGEAX_COLLECTATHON_VITE_READINESS_TIMEOUT_MS \?\? '90000'/);
  assert.match(collectathonSmoke, /viteProc\.once\('error'/);
  assert.match(collectathonSmoke, /viteProc\.once\('exit'/);
  assert.match(collectathonSmoke, /spawnError: viteSpawnError/);
  assert.match(collectathonSmoke, /exit: viteExit/);
  assert.match(collectathonSmoke, /output: viteOutput/);
});

test('collectathon Dawn smoke paces the heavy queue without weakening the 60-frame gate', () => {
  assert.match(collectathonDawnSmoke, /for \(let i = 0; i < SMOKE_MIN_FRAMES; i\+\+\)/);
  assert.match(
    collectathonDawnSmoke,
    /if \(sharedDevice && i % 16 === 15\) \{[\s\S]*?await sharedDevice\.queue\.onSubmittedWorkDone\(\);/,
  );
  assert.match(
    collectathonDawnSmoke,
    /\nif \(sharedDevice\) await sharedDevice\.queue\.onSubmittedWorkDone\(\);\nconsole\.log\(`\[smoke\] frames=/,
  );
  assert.match(collectathonDawnSmoke, /SMOKE_MIN_FRAMES/);
  const smokeFleet = jobSection('smoke-fleet');
  const collectathonStep = smokeFleet.slice(
    smokeFleet.indexOf('name: Collectathon headless smoke'),
  );
  assert.match(collectathonStep, /cgroup_snapshot before/);
  assert.match(collectathonStep, /trap 'status=\$\?; cgroup_snapshot after/);
  assert.match(collectathonStep, /cgroup-\$\{phase\} current=\$\{current\} peak=\$\{peak\}/);
});

test('collectathon assembles its development AssetRegistry with the scoped Pack binding', () => {
  assert.match(
    collectathonMain,
    /const runtimeDevBinding = import\.meta\.env\.DEV \? runtimeBinding : undefined;/,
  );
  assert.match(
    collectathonMain,
    /\.\.\.\(runtimeDevBinding === undefined \? \{\} : \{ assetRuntimeBinding: runtimeDevBinding \}\)/,
  );
});

test('shared RHI-debug capture forwards the configured Chrome channel', () => {
  assert.match(rhiDebugVerify, /const chromeChannel = process\.env\.FORGEAX_CHROME_CHANNEL/);
  assert.match(rhiDebugVerify, /const browserHeadless = !\['0', 'false'\]/);
  assert.match(rhiDebugVerify, /headless: browserHeadless/);
  assert.match(
    rhiDebugVerify,
    /\.\.\.\(chromeChannel === undefined \? \{\} : \{ channel: chromeChannel \}\)/,
  );
  assert.doesNotMatch(rhiDebugVerify, /channel: 'chrome'/);
  assert.match(rhiDebugVerify, /buildFrameModel, decodeTape, replayDeviceRequest/);
  assert.match(rhiDebugVerify, /bootstrapDawn\(\s*label,\s*tape,\s*dawnSelection,?\s*\)/);
  assert.match(
    rhiDebugVerify,
    /export async function bootstrapDawn\(label, tape, options = \{\}\)/,
  );
  assert.match(rhiDebugVerify, /replayDeviceRequest\(tape, adapter\.features, adapter\.limits\)/);
  assert.match(rhiDebugVerify, /requestReplayDeviceForTape\(adapterRes\.value, tape\)/);
  assert.doesNotMatch(
    rhiDebugVerify,
    /maxUniformBufferBindingSize: 262144|maxUniformBufferBindingSize: 262_144/,
  );
  assert.match(multiUvRhiSmoke, /bootstrapDawn\('m3-browser-rhi', parsedTape\)/);
  assert.match(multiUvComposedSmoke, /bootstrapDawn\(label, parsedTape\)/);
  assert.match(framebuffersLiveSmoke, /bootstrapDawn\('m3-programmable', tape\)/);
  assert.match(framebuffersBrowserSmoke, /browserReplayHook: '__replayFramebuffersCapture'/);
  assert.match(framebuffersBrowserSmoke, /pixelVerdictOwner: 'browser-fresh'/);
  for (const source of [framebuffersLiveSmoke, framebuffersCycleSmoke]) {
    assert.match(source, /const browserHeadless = !\['0', 'false'\]/);
    assert.match(source, /headless: browserHeadless/);
    assert.match(source, /FORGEAX_CHROME_CHANNEL/);
    assert.match(source, /--use-vulkan=swiftshader/);
    assert.doesNotMatch(source, /--disable-vulkan-surface/);
    assert.match(source, /createOwnedProcessGroupStopper/);
    assert.match(source, /detached: process\.platform !== 'win32'/);
    assert.match(source, /FORGEAX_RHI_DEBUG_VITE_READINESS_TIMEOUT_MS \?\? '120000'/);
  }
  for (const flag of [
    '--use-vulkan=swiftshader',
    '--disable-gpu-driver-bug-workarounds',
    '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
  ]) {
    assert.match(rhiDebugVerify, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(
    workflow,
    /name: Directional CSM Browser WebGPU smoke \(M5 MVD\)[\s\S]*?--mode=rhi-debug[\s\S]*?smoke:browser/,
  );
  assert.match(
    workflow,
    /name: Upload directional CSM pixel evidence on failure[\s\S]*?if: failure\(\)[\s\S]*?actions\/upload-artifact@v4[\s\S]*?frame\.rhitape[\s\S]*?live\.png[\s\S]*?replay\.png[\s\S]*?compare\.png[\s\S]*?include-hidden-files:\s*true/,
  );
});

test('resource-intensive WebGPU/browser gates use the heavy capacity pool', () => {
  const heavySelector =
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "heavy"\]'\) \}\}/;
  for (const name of [
    'vitest-browser',
    'directional-csm-browser',
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
    const actualJob =
      name === 'vitest-browser' || name === 'coverage-pnpm' ? `${name}-shard` : name;
    assert.match(jobSection(actualJob), heavySelector, `${name} must use the heavy pool`);
    if (name === 'vitest-browser') {
      assert.match(
        jobSection('vitest-browser-shard'),
        /matrix:\n(?:\s*#.*\n)*\s+shard: \[0, 1, 2, 3, 4, 5\]/,
        'vitest-browser must retain six productive heavy matrix legs',
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
    /name: UI authoring preview\/capture probe\n\s+env:\n\s+FORGEAX_CHROME_CHANNEL: chrome-beta\n[\s\S]*?run: xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0 pnpm --filter @forgeax\/preview smoke:ui-authoring/,
    'the UI authoring probe must reuse the canonical Chrome Beta carrier',
  );
  assert.match(uiAuthoringSmoke, /process\.env\.FORGEAX_CHROME_CHANNEL/);
  assert.match(uiAuthoringSmoke, /chromeChannel \? \{ channel: chromeChannel \} : \{\}/);
  assert.match(uiAuthoringSmoke, /process\.env\.FORGEAX_BROWSER_HEADLESS/);
  assert.match(uiAuthoringSmoke, /--enable-unsafe-webgpu/);
  assert.match(uiAuthoringSmoke, /--use-vulkan=swiftshader/);
});

test('each browser carrier owns its capability evidence', () => {
  const multithread = jobSection('multithread-browser-benchmark');
  const fallback = jobSection('webkit-fallback');
  assert.match(multithread, /run-capability-matrix\.mjs --browser=chrome/);
  assert.doesNotMatch(multithread, /install(?:-deps)? webkit/);
  assert.match(fallback, /probe-playwright-chromium-webgl2\.mjs/);
  assert.doesNotMatch(fallback, /run-capability-matrix\.mjs\s+--browser=webkit/);
});

test('Chromium fallback uses the pinned Chrome Beta carrier for admission and gates', () => {
  const fallback = jobSection('webkit-fallback');
  assert.doesNotMatch(fallback, /PLAYWRIGHT_BROWSERS_PATH/);
  assert.doesNotMatch(fallback, /Install Playwright Chromium fallback binary/);
  assert.match(fallback, /name: Install Playwright Chrome Beta \(for Chromium WebGL2 fallback\)/);
  assert.match(fallback, /uses: \.\/\.github\/actions\/install-playwright-chrome-beta/);
  assert.match(fallback, /cache-scope: \$\{\{ env\.CACHE_RUNNER_SCOPE \}\}/);
  const probeStepStart = fallback.indexOf('name: Probe Chrome Beta WebGL2 fallback capability');
  assert.notEqual(probeStepStart, -1, 'missing Chrome Beta capability probe step');
  const probeStepEnd = fallback.indexOf('\n      - name:', probeStepStart + 1);
  assert.notEqual(probeStepEnd, -1, 'capability probe must have a bounded workflow step');
  const probeStep = fallback.slice(probeStepStart, probeStepEnd);
  assert.match(probeStep, /env:\n\s+FORGEAX_CHROME_CHANNEL: chrome-beta/);
  assert.doesNotMatch(fallback, /continue-on-error/);
  assert.match(chromiumFallbackCapabilityProbe, /chromium\.launch\(launchOptions\)/);
  const executableSelection = chromiumFallbackCapabilityProbe.indexOf(
    'if (configuredExecutable !== undefined)',
  );
  const channelSelection = chromiumFallbackCapabilityProbe.indexOf(
    'else if (configuredChannel !== undefined)',
  );
  assert.ok(
    executableSelection >= 0 && executableSelection < channelSelection,
    'explicit executable must take precedence over the Chrome channel',
  );
  assert.match(
    chromiumFallbackCapabilityProbe,
    /configuredExecutable = process\.env\.FORGEAX_CHROMIUM_EXECUTABLE/,
  );
  assert.match(
    chromiumFallbackCapabilityProbe,
    /configuredChannel = process\.env\.FORGEAX_CHROME_CHANNEL/,
  );
  assert.match(
    chromiumFallbackCapabilityProbe,
    /carrierLaunchOptions = \{ executablePath: configuredExecutable \}/,
  );
  assert.match(
    chromiumFallbackCapabilityProbe,
    /carrierLaunchOptions = \{ channel: configuredChannel \}/,
  );
  assert.match(
    chromiumFallbackCapabilityProbe,
    /carrier = \{ kind: 'playwright-managed-chromium', value: null \}/,
  );
  const evidenceStart = chromiumFallbackCapabilityProbe.indexOf('const evidence = {');
  assert.notEqual(evidenceStart, -1, 'capability probe must build structured evidence');
  const evidenceEnd = chromiumFallbackCapabilityProbe.indexOf('\n  };', evidenceStart);
  assert.notEqual(evidenceEnd, -1, 'capability evidence must have a bounded shape');
  const evidenceSource = chromiumFallbackCapabilityProbe.slice(evidenceStart, evidenceEnd);
  assert.match(evidenceSource, /\n[ ]{4}carrier,/);
  assert.doesNotMatch(evidenceSource, /\n[ ]{4}channel:/);
  assert.match(chromiumFallbackCapabilityProbe, /navigator\.userAgent/);
  assert.match(chromiumFallbackCapabilityProbe, /--disable-features=WebGPU/);
  assert.match(chromiumFallbackCapabilityProbe, /--no-sandbox/);
  assert.match(chromiumFallbackCapabilityProbe, /requestAdapter\(\)/);
  assert.match(chromiumFallbackCapabilityProbe, /webgpuAdapterStatus/);
  assert.match(chromiumFallbackCapabilityProbe, /getContext\('webgl2'\)/);
  assert.match(chromiumFallbackCapabilityProbe, /probe\.webgpuAdapterStatus === 'available'/);
  assert.match(chromiumFallbackCapabilityProbe, /probe\.webgpuAdapterStatus === 'error'/);
  assert.match(chromiumFallbackCapabilityProbe, /!probe\.webgl2/);
  assert.match(fxaaBrowserSmoke, /launchOptions\.channel = process\.env\.FORGEAX_BROWSER_CHANNEL/);
  assert.match(
    fxaaMipmapBrowserSmoke,
    /launchOptions\.channel = process\.env\.FORGEAX_BROWSER_CHANNEL/,
  );
  assert.match(r5StabilityProbe, /channel: process\.env\.FORGEAX_CHROME_CHANNEL/);
  assert.match(webkitColorLightingProbe, /channel: process\.env\.FORGEAX_CHROME_CHANNEL/);
  assert.doesNotMatch(fallback, /install(?:-deps)? webkit/);
});

test('Chromium WebGL2 fallback launches explicitly opt into SwiftShader', () => {
  const fallback = jobSection('webkit-fallback');
  for (const [label, source] of [
    ['FXAA direct/clustered', fxaaBrowserSmoke],
    ['FXAA mipmap', fxaaMipmapBrowserSmoke],
    ['R5 stability', r5StabilityProbe],
    ['Chromium WebGL2 capability probe', chromiumFallbackCapabilityProbe],
  ]) {
    assert.match(source, /--enable-unsafe-swiftshader/, `${label} must opt into SwiftShader`);
  }
  assert.equal(
    (webkitColorLightingProbe.match(/--enable-unsafe-swiftshader/g) ?? []).length,
    2,
    'color-lighting must cover its parity and opt-in transport Chromium launches',
  );
  assert.match(fallback, /FORGEAX_BROWSER_HEADLESS: ['"]0['"]/);
  assert.match(fallback, /FORGEAX_BROWSER_CHANNEL: chrome-beta/);
  assert.match(fallback, /FORGEAX_CHROME_CHANNEL: chrome-beta/);
  assert.match(
    fxaaMipmapBrowserSmoke,
    /launchOptions\.channel = process\.env\.FORGEAX_BROWSER_CHANNEL/,
  );
  assert.match(
    fallback,
    /run: xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0 FORGEAX_FALLBACK_BROWSER=chromium DEV_SERVER_URL=/,
  );
  assert.match(
    fallback,
    /run: xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0 FORGEAX_FALLBACK_BROWSER=chromium URL=/,
  );
  assert.match(r5StabilityProbe, /const browserHeadless = !\['0', 'false'\]/);
  assert.match(r5StabilityProbe, /headless: browserHeadless/);
});

test('Chromium fallback color-lighting cases isolate browser processes and retry only WASM crashes', () => {
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
  assert.match(isolatedCase, /browserType\.launchServer\(browserLaunchOptions\)/);
  assert.match(isolatedCase, /browser\.newContext\(\{ noDefaultViewport: true \}\)/);
  assert.match(webkitColorLightingProbe, /runCaseWithRetry\(caseId\)/);
  assert.match(webkitColorLightingProbe, /runWithRetry\(/);
  assert.match(
    webkitColorLightingProbe,
    /retryable: !ok && \(crash !== null \|\| browserStall \|\| freshBrowserRetry\)/,
  );
  assert.doesNotMatch(webkitColorLightingProbe, /runIsolatedCase\(browser, caseId\)/);
  assert.doesNotMatch(
    webkitColorLightingProbe,
    /page\.evaluate\(async \(\) => window\.__colorLightingWebkitParity/,
  );
  assert.match(colorLightingMain, /requestedCaseId\?: string/);
  assert.match(colorLightingMain, /requires WebGPU adapter absence/);
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

test('app shards use authenticated source checkout and verified assets without runner residue', () => {
  for (const name of ['app-shard-0', 'app-shard-1', 'app-shard-2']) {
    const shard = jobSection(name);
    assert.match(shard, /submodules: false/);
    assert.match(shard, /run: node scripts\/ci\/prepare-assets-checkout\.mjs/);
    assert.match(shard, /token: \$\{\{ secrets\.GHA \}\}/);
    assert.doesNotMatch(shard, /name: Materialize pinned app asset sources/);
    assert.doesNotMatch(
      shard,
      /git submodule update --init --recursive --depth 1 forgeax-engine-assets/,
    );
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
  const playwrightRetry = readFileSync(
    resolve('scripts/ci/install-playwright-system-deps-with-retry.sh'),
    'utf8',
  );
  assert.match(chromeBetaAction, /FORGEAX_APT_ARCHIVE_MIRROR=ubuntu-https/);
  assert.match(chromeBetaAction, /FORGEAX_APT_ARCHIVE_MIRROR=ubuntu-kernel-mirror/);
  assert.match(chromeBetaAction, /retrying .* with Ubuntu mirror fallback/);
  assert.match(playwrightRetry, /FORGEAX_APT_ARCHIVE_MIRROR=ubuntu-https/);
  assert.match(playwrightRetry, /FORGEAX_APT_ARCHIVE_MIRROR=ubuntu-kernel-mirror/);
  assert.match(aptWrapper, /mirrors\.edge\.kernel\.org\/ubuntu/);
  assert.match(aptWrapper, /synthesized Ubuntu \$ubuntu_codename archive projection/);
  assert.match(aptWrapper, /archive\.ubuntu\.com\/ubuntu/);
  assert.match(aptWrapper, /security\.ubuntu\.com\/ubuntu/);
  assert.match(aptWrapper, /Suites: \$ubuntu_codename \$\{ubuntu_codename\}-updates/);
  assert.match(aptWrapper, /unsupported FORGEAX_APT_ARCHIVE_MIRROR value/);
});
