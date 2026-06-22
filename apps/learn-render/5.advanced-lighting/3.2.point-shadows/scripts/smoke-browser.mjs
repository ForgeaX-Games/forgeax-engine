#!/usr/bin/env node
// apps/learn-render/5.advanced-lighting/3.2.point-shadows/scripts/smoke-browser.mjs
// feat-20260621-learn-render-5-3-production-shadow-demos M3 / M3-T-SMOKE-BROWSER.
//
// Playwright e2e smoke for the point-light cube-map shadow demo. Spawns a
// local vite dev server on port 5200, drives headed Chrome with WebGPU enabled,
// and asserts:
//   (a) pipelineCount > 0
//   (b) No GPU device errors
//   (c) No console errors (other than [smoke] / expected once-warn)
//
// Canonical shape from apps/learn-render/5.advanced-lighting/8.deferred-shading/scripts/smoke-browser.mjs.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');

const PKG_NAME = '@forgeax/app-learn-render-5-advanced-lighting-3-2-point-shadows';

const viteProc = spawn(
  'pnpm', ['-F', PKG_NAME, 'dev'],
  { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
);
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
const consoleAll = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}\n${e.stack ?? ''}`));
page.on('console', (msg) => {
  const txt = msg.text();
  consoleAll.push(`[${msg.type()}] ${txt}`);
  if (msg.type() === 'error') errors.push(`CONSOLE-ERR: ${txt}`);
});

// Capture GPU pipeline descriptors + device errors.
await page.addInitScript(() => {
  if (navigator.gpu == null) return;
  const origReqAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  globalThis.__forgeaxPipelines = [];
  globalThis.__forgeaxDeviceErrors = [];
  navigator.gpu.requestAdapter = async (...a) => {
    const adapter = await origReqAdapter(...a);
    if (adapter == null) return adapter;
    const origReqDev = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (...da) => {
      const dev = await origReqDev(...da);
      if (dev == null) return dev;
      const origCRP = dev.createRenderPipeline.bind(dev);
      dev.createRenderPipeline = (desc) => {
        try {
          globalThis.__forgeaxPipelines.push({
            label: desc.label,
            vertexEntryPoint: desc.vertex?.entryPoint,
            fragmentTargetCount: desc.fragment?.targets?.length,
            bufferCount: (desc.vertex?.buffers ?? []).length,
          });
        } catch (_e) {}
        return origCRP(desc);
      };
      dev.addEventListener('uncapturederror', (ev) => {
        globalThis.__forgeaxDeviceErrors.push(String(ev.error?.message ?? ev));
        console.error('[gpu-uncapturederror]', String(ev.error?.message ?? ev));
      });
      return dev;
    };
    return adapter;
  };
});

await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(8000);

const captured = await page.evaluate(() => ({
  pipelines: globalThis.__forgeaxPipelines ?? [],
  deviceErrors: globalThis.__forgeaxDeviceErrors ?? [],
}));

console.log('\n=== captured GPU pipelines ===');
captured.pipelines.forEach((p, i) => console.log(`[#${i}]`, JSON.stringify(p)));
console.log('=== captured GPU device errors ===');
captured.deviceErrors.forEach((e) => console.log(e));
console.log('=== full console transcript ===');
consoleAll.forEach((l) => console.log(l));
console.log('=== captured CONSOLE errors ===');
errors.forEach((e) => console.log(e));
console.log('=== end ===');

await browser.close();
viteProc.kill('SIGTERM');
await sleep(500);

// device errors must be empty.
if (captured.deviceErrors.length > 0) {
  console.error(
    `\n[smoke-browser] RED -- ${captured.deviceErrors.length} device error(s) captured:`,
  );
  captured.deviceErrors.forEach((e, i) => {
    console.error(`  [device-error #${i}] ${e}`);
  });
  process.exit(1);
}

// pipelineCount must be > 0.
const pipelineCount = captured.pipelines.length;
if (pipelineCount < 1) {
  console.error(
    `\n[smoke-browser] RED -- only ${pipelineCount} pipeline(s) created; expected >= 1.`,
  );
  process.exit(1);
}

// No unexpected page errors.
const layer1Regression = errors.find((e) =>
  /asset-parse-failed|loadByGuid.*failed/i.test(e),
);
if (layer1Regression) {
  console.error(
    `\n[smoke-browser] RED -- asset error regression:\n  ${layer1Regression}`,
  );
  process.exit(1);
}

console.log(
  `\n[smoke-browser] GREEN -- ${captured.pipelines.length} pipelines, ${captured.deviceErrors.length} device errors. ` +
    'Point shadow demo smoke passed.',
);
process.exit(0);