#!/usr/bin/env node
// M7 browser/driver device-loss gate: crash Chrome's GPU process through the
// DevTools protocol, observe the real GPUDevice.lost -> Renderer health channel,
// recover through the public Renderer.recover() API, and prove the same World
// renders again with fresh RHI capture artifacts.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const appRoot = resolve(repoRoot, 'apps', 'hello', 'cube');
const artifactDir = resolve(
  process.env.FORGEAX_M7_ARTIFACT_DIR ??
    resolve(repoRoot, '.forgeax-gauntlet', 'hello-m7-backend-recovery', 'browser-device-loss'),
);
mkdirSync(artifactDir, { recursive: true });

const vite = spawn(
  process.execPath,
  [resolve(appRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '0'],
  {
    cwd: appRoot,
    env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let baseUrl;
vite.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(`[vite] ${text}`);
  baseUrl ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
});
vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

let browser;
try {
  const deadline = Date.now() + 30_000;
  while (baseUrl === undefined && Date.now() < deadline) await sleep(200);
  if (baseUrl === undefined) throw new Error('Vite did not become ready in 30s');

  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(`${baseUrl}/?m7-device-loss=1`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  await page.waitForFunction(
    () => typeof globalThis.__forgeaxM7DeviceRecovery?.health === 'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1500);

  const readState = () =>
    page.evaluate(() => {
      const probe = globalThis.__forgeaxM7DeviceRecovery;
      if (probe === undefined) throw new Error('M7 device-loss probe hook is missing');
      return {
        health: probe.health(),
        entityCount: probe.entityCount(),
        transitions: probe.healthTransitions(),
      };
    });
  const waitForHealth = async (reason) => {
    const healthDeadline = Date.now() + 30_000;
    let last;
    while (Date.now() < healthDeadline) {
      try {
        last = await readState();
        if (last.health?.reason === reason) return last;
      } catch {
        // GPU-process restart can briefly stall page evaluation; keep polling.
      }
      await sleep(250);
    }
    throw new Error(`renderer health did not reach ${reason}: ${JSON.stringify(last)}`);
  };

  const captureFrame = async (label) => {
    console.log(`[m7-browser-device-loss] capture start: ${label} debug=${JSON.stringify(await page.evaluate(() => ({
      debug: globalThis.__forgeaxM7DeviceRecovery.debug(),
      capture: typeof globalThis.__forgeax?.captureFrame,
    })))}\n`);
    const capture = await Promise.race([
      page.evaluate(async () => {
        const captureFn = globalThis.__forgeax?.captureFrame;
        return typeof captureFn === 'function' ? await captureFn(1) : null;
      }),
      sleep(20_000).then(() => {
        throw new Error(`RHI capture timed out after 20s: ${label}`);
      }),
    ]);
    if (capture === null) throw new Error(`RHI capture hook missing for ${label}`);
    for (const field of ['tapePath', 'reportPath']) {
      if (typeof capture[field] !== 'string' || capture[field].length === 0) {
        throw new Error(`${label} capture missing ${field}`);
      }
    }
    const resolveArtifact = (relativePath) => {
      const inApp = resolve(appRoot, relativePath);
      if (existsSync(inApp)) return inApp;
      const inRepo = resolve(repoRoot, relativePath);
      if (existsSync(inRepo)) return inRepo;
      throw new Error(`${label} capture artifact missing: ${relativePath}`);
    };
    const tapePath = resolveArtifact(capture.tapePath);
    const reportPath = resolveArtifact(capture.reportPath);
    const copiedTape = resolve(artifactDir, `${label}.tape.bin`);
    const copiedReport = resolve(artifactDir, `${label}.report.json`);
    copyFileSync(tapePath, copiedTape);
    copyFileSync(reportPath, copiedReport);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const result = {
      runId: capture.runId,
      tapePath: copiedTape,
      reportPath: copiedReport,
      eventCount: report.events?.length ?? 0,
      drawCount: report.events?.filter((event) => event.kind === 'draw' || event.kind === 'drawIndexed').length ?? 0,
    };
    console.log(`[m7-browser-device-loss] capture done: ${label} draws=${result.drawCount} events=${result.eventCount}`);
    return result;
  };

  const canvas = page.locator('#app');
  const beforeState = await waitForHealth('alive');
  console.log(`[m7-browser-device-loss] before health=${beforeState.health.reason} entities=${beforeState.entityCount}`);
  const beforeCapture = await captureFrame('before-loss');
  const beforePng = resolve(artifactDir, 'before-loss.png');
  await canvas.screenshot({ path: beforePng });

  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Browser.crashGpuProcess');
  const lostState = await waitForHealth('device-lost');
  console.log(`[m7-browser-device-loss] lost health=${lostState.health.reason}`);
  const lostReason = lostState.health?.detail?.lostReason;
  if (lostReason !== 'unknown') throw new Error(`expected driver loss reason=unknown, got ${lostReason}`);
  if (lostState.health?.recoverable !== true) throw new Error('device-lost state was not recoverable');

  console.log('[m7-browser-device-loss] recover start');
  const recovery = await Promise.race([
    page.evaluate(() => globalThis.__forgeaxM7DeviceRecovery.recover()),
    sleep(15_000).then(() => {
      throw new Error('renderer.recover timed out after 15s');
    }),
  ]);
  console.log(`[m7-browser-device-loss] recover done: ${JSON.stringify(recovery)}`);
  if (recovery?.ok !== true) throw new Error(`renderer.recover failed: ${JSON.stringify(recovery)}`);
  await page.waitForTimeout(2000);
  const afterState = await waitForHealth('alive');
  console.log(`[m7-browser-device-loss] after health=${afterState.health.reason} entities=${afterState.entityCount}`);
  if (afterState.entityCount !== beforeState.entityCount) {
    throw new Error(`World entity count changed across recovery: ${beforeState.entityCount} -> ${afterState.entityCount}`);
  }
  const afterDraw = await Promise.race([
    page.evaluate(() => globalThis.__forgeaxM7DeviceRecovery.drawOnce()),
    sleep(15_000).then(() => {
      throw new Error('public renderer.draw timed out after recovery');
    }),
  ]);
  if (afterDraw?.ok !== true) throw new Error(`public renderer.draw failed after recovery: ${JSON.stringify(afterDraw)}`);
  console.log('[m7-browser-device-loss] public renderer.draw after recovery: ok');
  const afterPng = resolve(artifactDir, 'after-recover.png');
  await canvas.screenshot({ path: afterPng });

  const readPng = (path) => {
    const png = PNG.sync.read(readFileSync(path));
    let nonBlackPixels = 0;
    for (let index = 0; index < png.data.length; index += 4) {
      if (png.data[index] > 8 || png.data[index + 1] > 8 || png.data[index + 2] > 8) nonBlackPixels++;
    }
    return { width: png.width, height: png.height, nonBlackPixels };
  };
  const beforeVisual = readPng(beforePng);
  const afterVisual = readPng(afterPng);
  if (afterVisual.nonBlackPixels < 1000) throw new Error(`recovered canvas is visually empty: ${JSON.stringify(afterVisual)}`);

  const transitions = afterState.transitions.map((snapshot) => snapshot.reason);
  if (!transitions.includes('device-lost') || !transitions.includes('alive')) {
    throw new Error(`health transition oracle missing device-lost/alive: ${JSON.stringify(transitions)}`);
  }
  const result = {
    driverCommand: 'Browser.crashGpuProcess',
    before: { ...beforeState, capture: beforeCapture, visual: beforeVisual },
    lost: lostState,
    recovery,
    after: { ...afterState, draw: afterDraw, visual: afterVisual },
    transitions,
    pageErrors,
    consoleErrors: consoleErrors.filter((message) => message.includes('device-lost')),
  };
  writeFileSync(resolve(artifactDir, 'device-loss-summary.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `[m7-browser-device-loss] PASS - driver=Browser.crashGpuProcess lost=${lostReason} ` +
      `recovered=true entities=${afterState.entityCount} transitions=${transitions.join('>')} ` +
      `beforeDraws=${beforeCapture.drawCount} afterDraw=true ` +
      `afterNonBlack=${afterVisual.nonBlackPixels} artifacts=${artifactDir}`,
  );
} catch (error) {
  console.error(`[m7-browser-device-loss] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (browser !== undefined) await browser.close();
  vite.kill('SIGTERM');
}
