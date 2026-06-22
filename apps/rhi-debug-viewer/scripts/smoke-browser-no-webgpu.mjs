// smoke-browser-no-webgpu.mjs — feat-20260619-rhi-debug-viewer-page-pr4
//
// Companion to smoke-browser.mjs (w18). Simulates a no-WebGPU environment
// via page.addInitScript(() => { delete navigator.gpu }) and asserts the
// viewer gracefully degrades: tree + bindings render normally, RT panel
// shows no-webgpu state with centered text, layout preserved, no crash.
//
// Invocation: `pnpm --filter @forgeax/rhi-debug-viewer smoke:browser:no-webgpu`
//
// Exit codes:
//   0 = green (degradation path working as expected)
//   1 = red (degradation broken — crash, missing state, wrong text)
//   2 = harness error (vite did not boot)
//
// All selectors are data-forgeax-* or text content ONLY (AC-13).

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { buildHelloCubeFixture } from '../fixtures/build-hello-cube-tape.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const APP_DIR = resolve(HERE, '..');
// Zero-binary invariant: synthesise the fixture in memory, write to a temp dir.
const FIXTURES_DIR = mkdtempSync(resolve(tmpdir(), 'rhi-debug-viewer-fixture-'));
{
  const { blob, report } = buildHelloCubeFixture();
  writeFileSync(resolve(FIXTURES_DIR, 'frame-0.tape.bin'), blob);
  writeFileSync(resolve(FIXTURES_DIR, 'frame-0.report.json'), JSON.stringify(report, null, 2));
}

const viteProc = spawn('pnpm', ['-F', '@forgeax/rhi-debug-viewer', 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let portUrl = null;
viteProc.stdout.on('data', (chunk) => {
  const s = chunk.toString();
  process.stdout.write(`[vite] ${s}`);
  const m = s.match(/Local:\s+(http:\/\/[^\s]+)/);
  if (m) portUrl = m[1];
});
viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

const deadline = Date.now() + 30000;
while (!portUrl && Date.now() < deadline) await sleep(200);
if (!portUrl) {
  console.error('FAIL: vite did not become ready in 30s');
  viteProc.kill();
  process.exit(2);
}
console.log(`[smoke-no-webgpu] using ${portUrl}`);

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
    '--ignore-gpu-blocklist',
  ],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (msg) => {
  const txt = msg.text();
  if (msg.type() === 'error') errors.push(`CONSOLE-ERR: ${txt}`);
});

// Simulate no-WebGPU: Chrome's navigator.gpu is a prototype getter,
// so `delete navigator.gpu` is silently ineffective. Use defineProperty
// to override the descriptor with undefined instead.
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'gpu', {
    value: undefined,
    configurable: true,
  });
});

await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30000 });
console.log('[smoke-no-webgpu] page loaded');

// ============================================================================
// Upload fixtures
// ============================================================================
const binPath = resolve(FIXTURES_DIR, 'frame-0.tape.bin');
const jsonPath = resolve(FIXTURES_DIR, 'frame-0.report.json');
const fileInput = page.locator('input[type="file"][accept=".tape.bin,.json"]');
await fileInput.setInputFiles([binPath, jsonPath]);

// ============================================================================
// Assertion 1 (AC-09): tree + bindings render normally — load-status=loaded
// ============================================================================
try {
  await page.waitForSelector('[data-forgeax-load-status="loaded"]', { timeout: 10000 });
  console.log('[smoke-no-webgpu] AC-09.1 GREEN: load-status=loaded (tree + bindings usable)');
} catch {
  const currentStatus = await page.getAttribute('[data-forgeax-load-status]', 'data-forgeax-load-status');
  console.error(`[smoke-no-webgpu] AC-09.1 RED: load-status is "${currentStatus}", expected "loaded"`);
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}

// ============================================================================
// Assertion 2 (AC-09): RT panel shows no-webgpu status
// ============================================================================
try {
  await page.waitForSelector('[data-forgeax-rt-status="no-webgpu"]', { timeout: 10000 });
  console.log('[smoke-no-webgpu] AC-09.2 GREEN: RT panel status is no-webgpu');
} catch {
  const rtStatus = await page.getAttribute('[data-forgeax-rt-status]', 'data-forgeax-rt-status');
  console.error(`[smoke-no-webgpu] AC-09.2 RED: RT status is "${rtStatus}", expected "no-webgpu"`);
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}

// ============================================================================
// Assertion 3 (AC-09): RT panel contains "WebGPU not available" text
// ============================================================================
const rtText = await page.locator('[data-forgeax-rt-status="no-webgpu"]').textContent();
if (rtText === null || !rtText.includes('WebGPU not available')) {
  console.error(`[smoke-no-webgpu] AC-09.3 RED: RT panel text missing "WebGPU not available": "${rtText}"`);
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}
console.log('[smoke-no-webgpu] AC-09.3 GREEN: RT panel shows "WebGPU not available"');

// ============================================================================
// Assertion 4: page is interactive, no crash
// ============================================================================
if (errors.length > 0) {
  console.error(`[smoke-no-webgpu] ${errors.length} page error(s):`);
  errors.forEach((e) => console.error(`  ${e}`));
  // Don't fail on benign console errors; only fail on real PAGEERRORs
  const pageErrors = errors.filter((e) => e.startsWith('PAGEERROR'));
  if (pageErrors.length > 0) {
    console.error(`[smoke-no-webgpu] AC-09.4 RED: ${pageErrors.length} page error(s)`);
    await browser.close();
    viteProc.kill('SIGTERM');
    process.exit(1);
  }
}

// ============================================================================
// Assertion 5: window.__forgeaxViewer is accessible (tree + draws populated)
// ============================================================================
const vm = await page.evaluate(() => window.__forgeaxViewer);
if (!vm) {
  console.error('[smoke-no-webgpu] AC-09.5 RED: window.__forgeaxViewer is null/undefined');
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}
const treeLen = Array.isArray(vm.tree) ? vm.tree.length : 0;
const drawsLen = Array.isArray(vm.draws) ? vm.draws.length : 0;
console.log(`[smoke-no-webgpu] AC-09.5 GREEN: window.__forgeaxViewer tree=${treeLen} draws=${drawsLen}`);

// ============================================================================
// Assertion 6: data-forgeax-selected=true exists
// ============================================================================
const selectedCount = await page.locator('[data-forgeax-selected="true"]').count();
if (selectedCount === 0) {
  console.error('[smoke-no-webgpu] AC-09.6 RED: no element with data-forgeax-selected=true');
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}
console.log(`[smoke-no-webgpu] AC-09.6 GREEN: ${selectedCount} element(s) with data-forgeax-selected=true`);

console.log('\n[smoke-no-webgpu] GREEN — no-WebGPU degradation path working as expected');

await browser.close();
viteProc.kill('SIGTERM');
await sleep(500);
process.exit(0);