#!/usr/bin/env node
// Same-page Chrome journey for the RenderGraph cycle -> repaired pipeline
// contract. The page exposes only the consumer's public install seam and the
// existing readback hook; no renderer or graph internals are reached here.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeReferencePng } from '../../../../shared/png-codec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const { PNG } = createRequire(resolve(REPO_ROOT, 'packages/rhi-debug/package.json'))('pngjs');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_M24_ARTIFACT_DIR ?? resolve(APP_ROOT, '.forgeax-debug', 'm24-browser-cycle'),
);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const viteProc = spawn(
  'pnpm',
  ['-F', '@forgeax/app-learn-render-4-advanced-opengl-5-framebuffers', 'dev'],
  {
    cwd: REPO_ROOT,
    env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let portUrl;
viteProc.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(`[vite] ${text}`);
  portUrl ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
});
viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

function decodePixels(base64) {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function changedBytes(before, after) {
  if (before.length !== after.length) return before.length + after.length;
  let changed = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed++;
  return changed;
}

function writeCapturePng(label, capture) {
  const path = resolve(ARTIFACT_DIR, `${label}.png`);
  writeFileSync(path, writeReferencePng(capture.pixels, capture.width, capture.height));
  return path;
}

async function captureCanvasScreenshot(page, label) {
  const bytes = await page.locator('#app').screenshot();
  const path = resolve(ARTIFACT_DIR, `${label}.png`);
  writeFileSync(path, bytes);
  return { png: PNG.sync.read(bytes), path };
}

function changedPngPixels(before, after) {
  if (before.width !== after.width || before.height !== after.height) {
    return before.width * before.height + after.width * after.height;
  }
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    if (
      before.data[i] !== after.data[i] ||
      before.data[i + 1] !== after.data[i + 1] ||
      before.data[i + 2] !== after.data[i + 2] ||
      before.data[i + 3] !== after.data[i + 3]
    ) {
      changed += 1;
    }
  }
  return changed;
}

async function capture(page, label) {
  const result = await page.evaluate(async () => {
    const readPixels = globalThis.__captureFramebuffers;
    const api = globalThis.__learnRenderFramebuffers;
    if (typeof readPixels !== 'function') throw new Error('window.__captureFramebuffers is unavailable');
    if (api === undefined) throw new Error('window.__learnRenderFramebuffers is unavailable');
    const raw = await readPixels();
    const pixels = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    let binary = '';
    const chunk = 0x2000;
    for (let i = 0; i < pixels.length; i += chunk) {
      binary += String.fromCharCode(...pixels.subarray(i, i + chunk));
    }
    const canvas = document.querySelector('#app');
    return {
      pixelsB64: btoa(binary),
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
      state: api.getState(),
      hud: document.querySelector('#hud')?.textContent ?? '',
    };
  });
  const pixels = decodePixels(result.pixelsB64);
  if (result.width <= 0 || result.height <= 0 || pixels.length !== result.width * result.height * 4) {
    throw new Error(`invalid ${label} capture dimensions: ${result.width}x${result.height}`);
  }
  const value = {
    width: result.width,
    height: result.height,
    pixels,
    state: result.state,
    hud: result.hud,
  };
  return { ...value, pngPath: writeCapturePng(label, value) };
}

async function installAndCapture(page, method, label) {
  const result = await page.evaluate(async (methodName) => {
    const readPixels = globalThis.__captureFramebuffers;
    const api = globalThis.__learnRenderFramebuffers;
    if (typeof readPixels !== 'function' || api === undefined) throw new Error('public framebuffers seam is unavailable');
    const install = api[methodName]();
    const raw = await readPixels();
    const pixels = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    let binary = '';
    const chunk = 0x2000;
    for (let i = 0; i < pixels.length; i += chunk) {
      binary += String.fromCharCode(...pixels.subarray(i, i + chunk));
    }
    const canvas = document.querySelector('#app');
    return {
      install,
      pixelsB64: btoa(binary),
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
      state: api.getState(),
      hud: document.querySelector('#hud')?.textContent ?? '',
    };
  }, method);
  const pixels = decodePixels(result.pixelsB64);
  const value = {
    width: result.width,
    height: result.height,
    pixels,
    state: result.state,
    hud: result.hud,
    install: result.install,
  };
  return { ...value, pngPath: writeCapturePng(label, value) };
}

try {
  const deadline = Date.now() + 30_000;
  while (!portUrl && Date.now() < deadline) await sleep(200);
  if (!portUrl) throw new Error('vite did not become ready in 30s');

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--ignore-gpu-blocklist',
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404')) consoleErrors.push(message.text());
    });

    await page.goto(`${portUrl}/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelector('#hud')?.textContent === 'passthrough'
        && typeof globalThis.__captureFramebuffers === 'function'
        && typeof globalThis.__learnRenderFramebuffers?.installCyclePipeline === 'function',
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(500);

    const baseline = await capture(page, 'cycle-baseline');
    const paused = await page.evaluate(() => globalThis.__learnRenderFramebuffers?.pause());
    if (paused?.ok !== true) throw new Error(`pause failed: ${JSON.stringify(paused)}`);
    // Repaint once through the public capture seam after cancelling rAF. This
    // makes the comparison anchor the last known-good submission even on
    // browsers that do not retain a swap-chain image while the host loop is
    // paused; the cycle draw itself must still leave this image untouched.
    const pausedBaseline = await capture(page, 'cycle-paused-baseline');
    const healthyCanvas = await captureCanvasScreenshot(page, 'cycle-healthy-canvas');
    const cycle = await installAndCapture(page, 'installCyclePipeline', 'cycle-fault');
    const cycleCanvas = await captureCanvasScreenshot(page, 'cycle-fault-canvas');
    const repaired = await installAndCapture(page, 'installRepairedPipeline', 'cycle-repaired');
    const repairedCanvas = await captureCanvasScreenshot(page, 'cycle-repaired-canvas');
    const resumed = await page.evaluate(() => globalThis.__learnRenderFramebuffers?.resume());
    if (resumed?.ok !== true) throw new Error(`resume failed: ${JSON.stringify(resumed)}`);
    await page.keyboard.press('2');
    await page.waitForFunction(() => document.querySelector('#hud')?.textContent === 'inversion', undefined, { timeout: 10_000 });
    const healthy = await capture(page, 'cycle-healthy-switch');
    const healthyCanvasAfterSwitch = await captureCanvasScreenshot(page, 'cycle-healthy-switch-canvas');
    const cleanup = await page.evaluate(() => {
      const api = globalThis.__learnRenderFramebuffers;
      if (api === undefined) throw new Error('public framebuffers seam is unavailable');
      return { first: api.dispose(), second: api.dispose(), state: api.getState() };
    });

    const cycleNames = cycle.state.cycleDiagnostic?.detail?.cycle ?? [];
    const repairedPasses = repaired.state.lastPassNames ?? [];
    const repairedOrder = repaired.state.repairedPassOrder ?? [];
    const report = {
      baseline: { width: baseline.width, height: baseline.height, hud: baseline.hud },
      cycle: {
        install: cycle.install,
        code: cycle.state.cycleDiagnostic?.code,
        cycle: cycleNames,
        drawSubmitted: cycle.state.cycleDrawSubmitted,
        activePipelineId: cycle.state.activePipelineId,
        healthyCanvasPixelsChanged: changedPngPixels(healthyCanvas.png, cycleCanvas.png),
      },
      repaired: {
        install: repaired.install,
        activePipelineId: repaired.state.activePipelineId,
        drawSubmitted: repaired.state.repairedDrawSubmitted,
        passNames: repairedPasses,
        executeOrder: repairedOrder,
        recoveredBytes: changedBytes(pausedBaseline.pixels, repaired.pixels),
        recoveredCanvasPixelsChanged: changedPngPixels(healthyCanvas.png, repairedCanvas.png),
      },
      healthy: {
        hud: healthy.hud,
        activePipelineId: healthy.state.activePipelineId,
        changedBytes: changedBytes(repaired.pixels, healthy.pixels),
        changedCanvasPixels: changedPngPixels(repairedCanvas.png, healthyCanvasAfterSwitch.png),
      },
      cleanup,
    };
    writeFileSync(resolve(ARTIFACT_DIR, 'browser-cycle.json'), `${JSON.stringify(report, null, 2)}\n`);

    await page.close();
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    if (cycle.state.cycleDiagnostic?.code !== 'cyclic-dependency') throw new Error(`cycle code=${cycle.state.cycleDiagnostic?.code}`);
    if (!cycleNames.includes('cycle-pass-a') || !cycleNames.includes('cycle-pass-b')) throw new Error(`cycle facts=${JSON.stringify(cycleNames)}`);
    if (cycle.state.cycleDrawSubmitted !== false) throw new Error(`cycle submitted=${cycle.state.cycleDrawSubmitted}`);
    if (cycle.state.activePipelineId === repaired.state.activePipelineId) throw new Error('cycle and repaired pipeline IDs were not distinct');
    if (changedPngPixels(healthyCanvas.png, cycleCanvas.png) !== 0) throw new Error('cycle contaminated healthy canvas pixels');
    if (repaired.state.repairedDrawSubmitted !== true) throw new Error(`repaired submitted=${repaired.state.repairedDrawSubmitted}`);
    if (repairedOrder.join('>') !== 'repaired-stage-a>repaired-stage-b') throw new Error(`execute order=${repairedOrder.join('>')}`);
    if (repairedPasses.join('>') !== 'repaired-stage-a>repaired-stage-b>main>post') throw new Error(`pass names=${repairedPasses.join('>')}`);
    if (changedBytes(pausedBaseline.pixels, repaired.pixels) !== 0) throw new Error('repaired pipeline did not recover baseline pixels');
    if (changedPngPixels(healthyCanvas.png, repairedCanvas.png) !== 0) throw new Error('repaired pipeline did not recover healthy canvas');
    if (healthy.hud !== 'inversion' || changedBytes(repaired.pixels, healthy.pixels) === 0) throw new Error('healthy switch did not change post-process pixels');
    if (changedPngPixels(repairedCanvas.png, healthyCanvasAfterSwitch.png) === 0) throw new Error('healthy switch did not change the canvas');
    if (!cleanup.first.ok || !cleanup.second.ok) throw new Error(`cleanup failed: ${JSON.stringify(cleanup)}`);

    console.log(`[m24] browser cycle/recovery: PASS cycle=cyclic-dependency cyclePasses=${cycleNames.join('>')} cycleSubmitted=false repairedPasses=${repairedPasses.join('>')} recoveredBytes=0 healthyChangedBytes=${changedBytes(repaired.pixels, healthy.pixels)} cleanup=idempotent`);
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(`[m24] browser cycle/recovery: FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  viteProc.kill('SIGTERM');
  await sleep(300);
}
