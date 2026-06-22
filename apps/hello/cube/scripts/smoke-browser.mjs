// smoke-browser.mjs -- feat-20260617-rhi-debug-layered-browser-capture (M4 / w22)
//
// Playwright e2e for the RHI-debug browser capture path on apps/hello/cube.
// Spawns a local vite dev server with FORGEAX_ENGINE_RHI_DEBUG=1, drives headed
// Chrome with WebGPU, calls `window.__forgeax.captureFrame(1)`, and asserts the
// returned object carries { runId, tapePath, reportPath } and that the two
// on-disk artefacts (.forgeax-debug/<runId>/frame-0.{tape.bin,report.json})
// exist with a parseable report (AC-08).
//
// Why a separate script (not the dawn smoke): smoke-dawn.mjs walks
// createRenderer + a hand-built World and never touches the create-app guard,
// the vite-plugin-rhi-debug POST /__forgeax-debug/tape endpoint, or the
// browser capture-browser round-trip. The captureFrame affordance only exists
// when (a) the demo bootstraps via createApp (hello-cube main.ts does, M4 /
// w22) AND (b) FORGEAX_ENGINE_RHI_DEBUG=1 reaches the guard via the vite plugin
// define + the spawned env. Only the browser path exercises
// JSON.stringify(tape) -> fetch(POST) -> assembleReport -> fs write.
//
// Invocation: `FORGEAX_ENGINE_RHI_DEBUG=1 pnpm -F @forgeax/hello-cube smoke:browser`
// (the script sets the env on the spawned vite itself, so a bare
// `pnpm -F @forgeax/hello-cube smoke:browser` also works).
//
// Exit codes:
//   0 = green (captureFrame returned 3 fields AND both artefacts exist + parse)
//   1 = red (regression detected)
//   2 = harness error (vite did not boot / playwright launch failed)
//
// Local-only gate today; CI inclusion gated on a Chrome-with-WebGPU runner
// (plan-strategy §5.2 / OOS, mirrors apps/hello/skin/scripts/smoke-browser.mjs).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/hello/cube/scripts -> apps/hello/cube -> apps/hello -> apps -> repo root.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-cube', 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
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
console.log(`[smoke-browser] using ${portUrl}`);

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--ignore-gpu-blocklist',
    ],
  });
} catch (e) {
  console.error(`FAIL: could not launch headed Chrome with WebGPU: ${e?.message ?? e}`);
  viteProc.kill('SIGTERM');
  process.exit(2);
}

const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`CONSOLE-ERR: ${msg.text()}`);
});

await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30000 });
// Let the rAF loop run a few frames so the recorder has frame-marks to capture.
await page.waitForTimeout(3000);

// Assert the guard mounted the capture affordance (createApp + FORGEAX_ENGINE_RHI_DEBUG=1).
const hasCapture = await page.evaluate(
  () => typeof globalThis.__forgeax?.captureFrame === 'function',
);
if (!hasCapture) {
  console.error(
    '\n[smoke-browser] RED -- window.__forgeax.captureFrame is not a function. ' +
      'Suspect: demo did not bootstrap via createApp, or FORGEAX_ENGINE_RHI_DEBUG=1 ' +
      'did not reach the create-app guard (vite-plugin-rhi-debug define / spawned env).',
  );
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}

let captured;
try {
  captured = await page.evaluate(async () => {
    const r = await globalThis.__forgeax.captureFrame(1);
    return r;
  });
} catch (e) {
  console.error(`\n[smoke-browser] RED -- captureFrame(1) threw: ${e?.message ?? e}`);
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}

console.log('\n=== captureFrame(1) result ===');
console.log(JSON.stringify(captured, null, 2));
console.log('=== console errors during capture ===');
errors.forEach((e) => console.log(e));

await browser.close();
viteProc.kill('SIGTERM');
await sleep(500);

// (2) three fields non-empty.
const missingFields = ['runId', 'tapePath', 'reportPath'].filter(
  (k) => typeof captured?.[k] !== 'string' || captured[k].length === 0,
);
if (missingFields.length > 0) {
  console.error(
    `\n[smoke-browser] RED -- captureFrame result missing/empty field(s): ${missingFields.join(', ')}. ` +
      `Got: ${JSON.stringify(captured)}`,
  );
  process.exit(1);
}

// (3) tapePath file exists. The dev endpoint writes relative to the vite cwd
// (REPO_ROOT); resolve against it if the returned path is relative.
const tapeAbs = resolve(REPO_ROOT, captured.tapePath);
if (!existsSync(tapeAbs)) {
  console.error(
    `\n[smoke-browser] RED -- tapePath does not exist on disk: ${tapeAbs} ` +
      `(returned ${captured.tapePath}). Suspect: POST /__forgeax-debug/tape did not write the blob.`,
  );
  process.exit(1);
}

// (4) reportPath file exists + JSON parses.
const reportAbs = resolve(REPO_ROOT, captured.reportPath);
if (!existsSync(reportAbs)) {
  console.error(`\n[smoke-browser] RED -- reportPath does not exist on disk: ${reportAbs}`);
  process.exit(1);
}
let report;
try {
  report = JSON.parse(readFileSync(reportAbs, 'utf-8'));
} catch (e) {
  console.error(`\n[smoke-browser] RED -- reportPath is not valid JSON: ${e?.message ?? e}`);
  process.exit(1);
}
if (typeof report !== 'object' || report === null) {
  console.error('\n[smoke-browser] RED -- report JSON is not an object.');
  process.exit(1);
}

console.log(
  `\n[smoke-browser] GREEN -- captureFrame(1) returned { runId, tapePath, reportPath }; ` +
    `tape + report exist on disk and report JSON parses. runId=${captured.runId}`,
);
process.exit(0);
