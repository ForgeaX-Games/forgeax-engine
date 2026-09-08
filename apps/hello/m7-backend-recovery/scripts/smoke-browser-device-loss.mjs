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
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';

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
        ...probe.state(),
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
      page.evaluate(async (captureLabel) => {
        const captureFn = globalThis.__forgeax?.captureFrame;
        if (typeof captureFn !== 'function') return null;
        const captured = await captureFn();
        if (!captured.ok) return captured;
        const runId = `m7-${captureLabel}-${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
        const response = await fetch(`/__forgeax-debug/tape?runId=${encodeURIComponent(runId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-forgeax-rhitape' },
          body: captured.value.bytes,
        });
        const payload = await response.json();
        if (!response.ok) return { ok: false, error: payload };
        return {
          ok: true,
          value: { ...payload, source: 'rhi.capture', digest: captured.value.digest, runId },
        };
      }, label),
      sleep(20_000).then(() => {
        throw new Error(`RHI capture timed out after 20s: ${label}`);
      }),
    ]);
    if (capture === null) throw new Error(`RHI capture hook missing for ${label}`);
    if (!capture.ok) throw new Error(`${label} capture failed: ${JSON.stringify(capture.error)}`);
    if (capture.value?.kind !== 'rhi-tape' || typeof capture.value.path !== 'string' || typeof capture.value.digest !== 'string') {
      throw new Error(`${label} capture returned an invalid ArtifactRef: ${JSON.stringify(capture)}`);
    }
    const candidates = [
      capture.value.path,
      resolve(appRoot, capture.value.path),
      resolve(repoRoot, capture.value.path),
    ];
    const source = candidates.find((path) => existsSync(path));
    if (source === undefined) throw new Error(`${label} single tape artifact missing: ${capture.value.path}`);
    const artifactPath = resolve(artifactDir, `${label}.rhitape`);
    copyFileSync(source, artifactPath);
    const tape = decodeTape(new Uint8Array(readFileSync(artifactPath)));
    if (!tape.ok) throw new Error(`${label} tape decode failed: ${tape.error.code} (${tape.error.hint})`);
    const model = buildFrameModel(tape.value);
    const result = {
      ...capture.value,
      path: artifactPath,
      eventCount: tape.value.events.length,
      workCount: model.works.length,
    };
    console.log(`[m7-browser-device-loss] capture done: ${label} works=${result.workCount} events=${result.eventCount}`);
    return result;
  };

  const canvas = page.locator('#app');
  const unexpectedErrors = () => ({
    pageErrors: [...pageErrors],
    consoleErrors: consoleErrors.filter((message) => !message.includes('[RhiError device-lost]')),
  });
  const assertNoUnexpectedErrors = (label) => {
    const errors = unexpectedErrors();
    if (errors.pageErrors.length !== 0 || errors.consoleErrors.length !== 0) {
      throw new Error(`${label} unexpected browser errors: ${JSON.stringify(errors)}`);
    }
  };
  const assertSame = (label, left, right) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      throw new Error(`${label} changed: before=${JSON.stringify(left)} after=${JSON.stringify(right)}`);
    }
  };
  const recover = () =>
    Promise.race([
      page.evaluate(() => globalThis.__forgeaxM7DeviceRecovery.recover()),
      sleep(15_000).then(() => {
        throw new Error('renderer.recover timed out after 15s');
      }),
    ]);
  const drawOnce = () =>
    Promise.race([
      page.evaluate(() => globalThis.__forgeaxM7DeviceRecovery.drawOnce()),
      sleep(15_000).then(() => {
        throw new Error('public renderer.draw timed out after recovery');
      }),
    ]);

  const beforeState = await waitForHealth('alive');
  console.log(
    `[m7-browser-device-loss] before health=${beforeState.health.reason} ` +
      `world=${beforeState.worldIdentity} renderer=${beforeState.rendererIdentity} ` +
      `device=${beforeState.deviceIdentity} entities=${beforeState.cpu.entityCount}`,
  );
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
  if (lostState.worldIdentity !== beforeState.worldIdentity) throw new Error('World identity changed at device loss');
  if (lostState.rendererIdentity !== beforeState.rendererIdentity) throw new Error('Renderer identity changed at device loss');
  if (lostState.deviceIdentity !== beforeState.deviceIdentity) throw new Error('device identity changed before recovery');
  assertSame('CPU scene at device loss', beforeState.cpu, lostState.cpu);

  const adapterRequestsBeforeRefusal = lostState.adapterRequestCount;
  const deviceRequestsBeforeRefusal = lostState.deviceRequestCount;
  const transitionsBeforeRefusal = lostState.transitions.length;
  await page.evaluate(() => globalThis.__forgeaxM7DeviceRecovery.armDeviceRefusal());
  const armedState = await readState();
  if (armedState.deviceRefusalRemaining !== 1) throw new Error('device refusal did not arm');
  console.log('[m7-browser-device-loss] first recover: requestDevice refusal armed');
  const refusedRecovery = await recover();
  console.log(`[m7-browser-device-loss] first recover result: ${JSON.stringify(refusedRecovery)}`);
  const refusedError = refusedRecovery?.error;
  if (refusedRecovery?.ok !== false || refusedError?.code !== 'recover-device-unavailable') {
    throw new Error(`expected recover-device-unavailable, got ${JSON.stringify(refusedRecovery)}`);
  }
  if (refusedError.expected !== 'requestDevice failed or threw') {
    throw new Error(`unexpected refusal expected field: ${JSON.stringify(refusedError)}`);
  }
  if (refusedError.hint !== 'retry recover() after a host-chosen delay; device creation is driver-dependent') {
    throw new Error(`unexpected refusal hint field: ${JSON.stringify(refusedError)}`);
  }
  await page.waitForTimeout(1000);
  const afterRefusal = await readState();
  if (afterRefusal.health?.reason !== 'device-lost') throw new Error('device refusal changed health to alive');
  assertSame('World identity after device refusal', beforeState.worldIdentity, afterRefusal.worldIdentity);
  assertSame('Renderer identity after device refusal', beforeState.rendererIdentity, afterRefusal.rendererIdentity);
  assertSame('device identity after device refusal', beforeState.deviceIdentity, afterRefusal.deviceIdentity);
  assertSame('CPU scene after device refusal', beforeState.cpu, afterRefusal.cpu);
  if (afterRefusal.adapterRequestCount !== adapterRequestsBeforeRefusal + 1) {
    throw new Error(`unexpected adapter retry/background loop: ${JSON.stringify(afterRefusal)}`);
  }
  if (afterRefusal.deviceRequestCount !== deviceRequestsBeforeRefusal + 1) {
    throw new Error(`requestDevice was retried or skipped: ${JSON.stringify(afterRefusal)}`);
  }
  if (afterRefusal.deviceRefusalCount !== 1 || afterRefusal.deviceRefusalRemaining !== 0) {
    throw new Error(`requestDevice refusal was not one-shot: ${JSON.stringify(afterRefusal)}`);
  }
  if (afterRefusal.transitions.length !== transitionsBeforeRefusal) {
    throw new Error(`device refusal published an unexpected health transition: ${JSON.stringify(afterRefusal)}`);
  }
  const refusedDraw = await drawOnce();
  if (refusedDraw?.ok !== false || refusedDraw.error?.code !== 'rhi-not-available') {
    throw new Error(`device-lost draw was not blocked without publication: ${JSON.stringify(refusedDraw)}`);
  }
  assertNoUnexpectedErrors('after device refusal');

  await page.evaluate(() => globalThis.__forgeaxM7DeviceRecovery.clearDeviceRefusal());
  const clearedState = await readState();
  if (clearedState.deviceRefusalRemaining !== 0) throw new Error('device refusal did not clear');
  console.log('[m7-browser-device-loss] second recover: requestDevice refusal cleared');
  const retryRecovery = await recover();
  console.log(`[m7-browser-device-loss] second recover result: ${JSON.stringify(retryRecovery)}`);
  if (retryRecovery?.ok !== true) throw new Error(`renderer.recover retry failed: ${JSON.stringify(retryRecovery)}`);
  await page.waitForTimeout(2000);
  const afterRetry = await waitForHealth('alive');
  console.log(
    `[m7-browser-device-loss] after retry health=${afterRetry.health.reason} ` +
      `world=${afterRetry.worldIdentity} renderer=${afterRetry.rendererIdentity} ` +
      `device=${afterRetry.deviceIdentity} entities=${afterRetry.cpu.entityCount}`,
  );
  assertSame('World identity after retry', beforeState.worldIdentity, afterRetry.worldIdentity);
  assertSame('Renderer identity after retry', beforeState.rendererIdentity, afterRetry.rendererIdentity);
  assertSame('CPU scene after retry', beforeState.cpu, afterRetry.cpu);
  if (afterRetry.deviceIdentity === beforeState.deviceIdentity) {
    throw new Error('successful retry kept the stale device identity');
  }
  if (
    afterRetry.adapterRequestCount !== afterRefusal.adapterRequestCount + 1 ||
    afterRetry.deviceRequestCount !== afterRefusal.deviceRequestCount + 1 ||
    afterRetry.deviceRefusalCount !== 1
  ) {
    throw new Error(`retry adapter/device acquisition was not exactly one fresh request: ${JSON.stringify(afterRetry)}`);
  }
  if (afterRetry.deviceRefusalRemaining !== 0) throw new Error('device refusal remained enabled after retry');

  const afterDraw = await drawOnce();
  if (afterDraw?.ok !== true) throw new Error(`public renderer.draw failed after retry: ${JSON.stringify(afterDraw)}`);
  console.log('[m7-browser-device-loss] public renderer.draw after retry: ok');
  const afterCapture = await captureFrame('after-retry');
  if (afterCapture.workCount === 0) throw new Error(`fresh retry capture has no work events: ${JSON.stringify(afterCapture)}`);
  if (afterCapture.runId === beforeCapture.runId) throw new Error('retry capture reused the pre-loss capture run');
  const afterPng = resolve(artifactDir, 'after-retry.png');
  await canvas.screenshot({ path: afterPng });

  const thirdRecovery = await page.evaluate(() => globalThis.__forgeaxM7DeviceRecovery.recover());
  console.log(`[m7-browser-device-loss] third recover result: ${JSON.stringify(thirdRecovery)}`);
  if (
    thirdRecovery?.ok !== false ||
    thirdRecovery.error?.code !== 'recover-not-needed' ||
    thirdRecovery.error?.expected !== 'renderer is healthy; call health() first to confirm degraded state before calling recover()' ||
    thirdRecovery.error?.hint !== 'call health() first to confirm degraded state before calling recover()'
  ) {
    throw new Error(`expected recover-not-needed while alive, got ${JSON.stringify(thirdRecovery)}`);
  }
  const disposeResult = await page.evaluate(() => globalThis.__forgeaxM7DeviceRecovery.disposeTwice());
  if (disposeResult?.ok !== true) throw new Error(`repeated renderer.dispose failed: ${JSON.stringify(disposeResult)}`);
  await page.waitForTimeout(500);

  const readPng = (path) => {
    const png = PNG.sync.read(readFileSync(path));
    let nonBlackPixels = 0;
    for (let index = 0; index < png.data.length; index += 4) {
      if (png.data[index] > 8 || png.data[index + 1] > 8 || png.data[index + 2] > 8) nonBlackPixels++;
    }
    return { width: png.width, height: png.height, nonBlackPixels };
  };
  const visualDiff = (referencePath, candidatePath) => {
    const reference = PNG.sync.read(readFileSync(referencePath));
    const candidate = PNG.sync.read(readFileSync(candidatePath));
    if (reference.width !== candidate.width || reference.height !== candidate.height) {
      return { meanAbsRgb: Number.POSITIVE_INFINITY, highDeltaRatio: 1 };
    }
    let totalDelta = 0;
    let highDelta = 0;
    const pixelCount = reference.width * reference.height;
    for (let index = 0; index < reference.data.length; index += 4) {
      const delta =
        (Math.abs(reference.data[index] - candidate.data[index]) +
          Math.abs(reference.data[index + 1] - candidate.data[index + 1]) +
          Math.abs(reference.data[index + 2] - candidate.data[index + 2])) /
        3;
      totalDelta += delta;
      if (delta > 20) highDelta += 1;
    }
    return {
      meanAbsRgb: pixelCount === 0 ? Number.POSITIVE_INFINITY : totalDelta / pixelCount,
      highDeltaRatio: pixelCount === 0 ? 1 : highDelta / pixelCount,
    };
  };
  const beforeVisual = readPng(beforePng);
  const afterVisual = readPng(afterPng);
  const pixelDiff = visualDiff(beforePng, afterPng);
  if (beforeVisual.nonBlackPixels < 1000) throw new Error(`baseline canvas is visually empty: ${JSON.stringify(beforeVisual)}`);
  if (afterVisual.nonBlackPixels < 1000) throw new Error(`recovered canvas is visually empty: ${JSON.stringify(afterVisual)}`);
  const contentRatio = afterVisual.nonBlackPixels / beforeVisual.nonBlackPixels;
  if (contentRatio < 0.8 || contentRatio > 1.2) {
    throw new Error(`recovered content changed unexpectedly: before=${JSON.stringify(beforeVisual)} after=${JSON.stringify(afterVisual)}`);
  }
  if (pixelDiff.meanAbsRgb > 45 || pixelDiff.highDeltaRatio > 0.25) {
    throw new Error(`recovered semantic pixels diverged: ${JSON.stringify({ beforeVisual, afterVisual, pixelDiff })}`);
  }

  const transitions = afterRetry.transitions.map((snapshot) => snapshot.reason);
  if (!transitions.includes('device-lost') || !transitions.includes('alive')) {
    throw new Error(`health transition oracle missing device-lost/alive: ${JSON.stringify(transitions)}`);
  }
  assertNoUnexpectedErrors('after retry and dispose');
  const result = {
    driverCommand: 'Browser.crashGpuProcess',
    before: { ...beforeState, capture: beforeCapture, visual: beforeVisual },
    lost: lostState,
    refusedRecovery,
    refusedDraw,
    afterRefusal,
    retryRecovery,
    after: { ...afterRetry, draw: afterDraw, capture: afterCapture, visual: afterVisual },
    thirdRecovery,
    disposeResult,
    transitions,
    pageErrors,
    consoleErrors,
    unexpectedErrors: unexpectedErrors(),
  };
  writeFileSync(resolve(artifactDir, 'device-loss-summary.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `[m7-browser-device-loss] PASS - driver=Browser.crashGpuProcess lost=${lostReason} ` +
      `refusal=recover-device-unavailable(requestDevice) retry=alive sameWorld=${afterRetry.worldIdentity === beforeState.worldIdentity} ` +
      `sameRenderer=${afterRetry.rendererIdentity === beforeState.rendererIdentity} ` +
      `freshDevice=${afterRetry.deviceIdentity !== beforeState.deviceIdentity} ` +
      `entities=${afterRetry.cpu.entityCount} transitions=${transitions.join('>')} ` +
      `beforeWorks=${beforeCapture.workCount} afterWorks=${afterCapture.workCount} ` +
      `afterNonBlack=${afterVisual.nonBlackPixels} pixelMean=${pixelDiff.meanAbsRgb.toFixed(3)} artifacts=${artifactDir}`,
  );
} catch (error) {
  console.error(`[m7-browser-device-loss] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (browser !== undefined) await browser.close();
  vite.kill('SIGTERM');
}
