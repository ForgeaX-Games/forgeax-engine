#!/usr/bin/env node
// P7 Preview contract smoke: the host transports only game-owned projections,
// renderer health/recovery, and the existing RHI capture path. The browser
// global is intentionally cleared by the normal Preview dispose message.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_INSPECTION_DIR ?? resolve(ROOT, '.forgeax-debug/inspection-recovery'));
const PORT = Number.parseInt(process.env.FORGEAX_INSPECTION_PORT ?? '5199', 10);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const server = spawn('pnpm', ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
const badResponses = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) badResponses.push(`${response.status()} ${response.url()}`);
});

const readInspection = () => page.evaluate(() => {
  const inspection = globalThis.__forgeaxPreviewInspection;
  if (!inspection) throw new Error('Preview inspection global is unavailable');
  return inspection;
});

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/?game=game-default`, { waitUntil: 'networkidle', timeout: 2_000 });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`preview did not boot: ${serverOutput}\n${String(error)}`);
      await sleep(250);
    }
  }
  await page.waitForTimeout(1_500);

  const listed = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.list());
  if (!listed || listed.actions.length < 4 || listed.reads.length < 2) throw new Error(`projection list incomplete: ${JSON.stringify(listed)}`);
  const before = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!before.ok || before.value.state.phase !== 'Play') throw new Error(`baseline projection failed: ${JSON.stringify(before)}`);
  const fbxBefore = before.value.fbxSkinnedTarget;
  if (
    fbxBefore?.available !== true ||
    fbxBefore.jointCount < 50 ||
    fbxBefore.clipGuid !== '019ecd87-179b-71f7-b9f8-4c8518326b65' ||
    Math.abs(fbxBefore.scale[0] - 0.03) > 0.001
  ) {
    throw new Error(`FBX skin target contract failed: ${JSON.stringify(fbxBefore)}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'before.png') });

  const orbit = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.set-view', { mode: 'orbit' }));
  const afterOrbit = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!orbit.ok || !afterOrbit.ok || afterOrbit.value.viewMode !== 'orbit') throw new Error(`view projection failed: ${JSON.stringify({ orbit, afterOrbit })}`);
  if (afterOrbit.value.fbxSkinnedTarget.animationTime === fbxBefore.animationTime) throw new Error('FBX animation time did not advance');

  const hit = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.trigger-hit'));
  await page.waitForTimeout(150);
  const afterHit = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!hit.ok || !afterHit.ok || afterHit.value.fbxSkinnedTarget.hitPulses !== 1) {
    throw new Error(`FBX hit loop failed: ${JSON.stringify({ hit, afterHit })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'after-hit.png') });

  const invalidState = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.invalid-state'));
  if (!invalidState.ok || invalidState.value.errorCode !== 'invalid-variant') throw new Error(`invalid state witness failed: ${JSON.stringify(invalidState)}`);
  const missingRead = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('missing.read'));
  if (missingRead.ok || missingRead.error.code !== 'projection-read-not-found') throw new Error(`missing read did not fail structurally: ${JSON.stringify(missingRead)}`);

  const resetRequest = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.reset'));
  await page.waitForTimeout(250);
  const afterReset = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!resetRequest.ok || !afterReset.ok || afterReset.value.state.phase !== 'Play' || afterReset.value.state.resetTransitions < 1) {
    throw new Error(`reset projection failed: ${JSON.stringify({ resetRequest, afterReset })}`);
  }

  const health = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.renderer.health());
  if (health.reason !== 'alive') throw new Error(`unexpected renderer health: ${JSON.stringify(health)}`);
  const recoverHealthy = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.renderer.recover());
  if (recoverHealthy.ok || recoverHealthy.error.code !== 'recover-not-needed') throw new Error(`healthy recover did not refuse structurally: ${JSON.stringify(recoverHealthy)}`);

  const capture = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.captureFrame(1));
  if (!capture.ok || typeof capture.value?.runId !== 'string') throw new Error(`RHI capture failed: ${JSON.stringify(capture)}`);
  const capturedRun = capture.value.runId;
  const tapeResponse = await fetch(`http://127.0.0.1:${PORT}/__forgeax-debug/artifact?runId=${encodeURIComponent(capturedRun)}&file=frame-0.tape.bin`);
  const reportResponse = await fetch(`http://127.0.0.1:${PORT}/__forgeax-debug/artifact?runId=${encodeURIComponent(capturedRun)}&file=frame-0.report.json`);
  if (!tapeResponse.ok || !reportResponse.ok) throw new Error(`capture artifacts unavailable: tape=${tapeResponse.status} report=${reportResponse.status}`);
  writeFileSync(resolve(ARTIFACT_DIR, 'frame-0.tape.bin'), Buffer.from(await tapeResponse.arrayBuffer()));
  const capturedReportText = await reportResponse.text();
  writeFileSync(resolve(ARTIFACT_DIR, 'frame-0.report.json'), capturedReportText);
  const capturedReport = JSON.parse(capturedReportText);
  const skinPipelines = new Set(
    capturedReport.events
      .filter((event) => event.kind === 'createRenderPipeline')
      .filter((event) => {
        const buffer = event.desc?.vertex?.buffers?.[0];
        const attributes = buffer?.attributes ?? [];
        return (
          buffer?.arrayStride === 72 &&
          attributes.some((attribute) => attribute.shaderLocation === 4 && attribute.format === 'uint16x4') &&
          attributes.some((attribute) => attribute.shaderLocation === 5 && attribute.format === 'float32x4')
        );
      })
      .map((event) => event.handleId),
  );
  let activePipeline;
  const hasVisibleFbxDraw = capturedReport.events.some((event) => {
    if (event.kind === 'setPipeline') activePipeline = event.pipelineHandleId;
    return event.kind === 'drawIndexed' && event.indexCount >= 9000 && skinPipelines.has(activePipeline);
  });
  if (!hasVisibleFbxDraw) throw new Error(`captured frame did not contain a skinned FBX draw: pipelines=${JSON.stringify([...skinPipelines])}`);
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'after-recovery.png') });

  await page.evaluate(() => window.postMessage({ type: 'VAG_PREVIEW_DISPOSE' }, '*'));
  await page.waitForTimeout(50);
  const cleared = await page.evaluate(() => globalThis.__forgeaxPreviewInspection === undefined);
  if (!cleared) throw new Error('Preview inspection global survived Stop');

  const report = { listed, before, orbit, afterOrbit, hit, afterHit, invalidState, missingRead, resetRequest, afterReset, health, recoverHealthy, capture, cleared, pageErrors, consoleErrors, badResponses, serverOutput };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (badResponses.length > 0) throw new Error(`bad responses: ${badResponses.join(' | ')}`);
  const actionableConsoleErrors = consoleErrors.filter((line) => !line.includes('favicon') && !line.includes('Failed to load resource'));
  if (actionableConsoleErrors.length > 0) throw new Error(`console errors: ${actionableConsoleErrors.join(' | ')}`);
  console.log(`[inspection-recovery] PASS actions=${listed.actions.length} reads=${listed.reads.length} phase=${afterReset.value.state.phase} resetTransitions=${afterReset.value.state.resetTransitions} capture=${capture.value.runId} cleared=${cleared}`);
  console.log(`[inspection-recovery] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await sleep(300);
}
