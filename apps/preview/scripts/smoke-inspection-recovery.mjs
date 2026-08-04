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
  const profileCatalog = await page.evaluate(async () => {
    const response = await fetch('/pack-index.json');
    const rows = await response.json();
    return rows.find((row) => row.guid === '019e2cc6-0c86-79da-aa76-b0984c86d461');
  });
  if (
    profileCatalog?.kind !== 'game-default-target-profile' ||
    profileCatalog?.name !== 'target-profile.json' ||
    typeof profileCatalog?.packageUrl !== 'string'
  ) {
    throw new Error(`target profile catalog row failed: ${JSON.stringify(profileCatalog)}`);
  }
  const profileBefore = before.value.targetProfile;
  if (
    profileBefore?.available !== true ||
    profileBefore.title !== 'Precision target' ||
    profileBefore.scoreMultiplier !== 2 ||
    profileBefore.active !== 'original'
  ) {
    throw new Error(`target profile load witness failed: ${JSON.stringify(profileBefore)}`);
  }
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

  const videoBefore = before.value.videoTexture;
  if (
    videoBefore?.available !== true ||
    videoBefore.active !== 'original' ||
    videoBefore.kind !== 'video' ||
    videoBefore.url !== '/cutscene.webm'
  ) {
    throw new Error(`WebM asset witness failed: ${JSON.stringify(videoBefore)}`);
  }
  const videoToggle = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-video-texture'));
  await page.waitForTimeout(500);
  const afterVideo = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !videoToggle.ok ||
    !afterVideo.ok ||
    afterVideo.value.videoTexture?.active !== 'video' ||
    afterVideo.value.videoTexture?.swaps !== 1
  ) {
    throw new Error(`WebM toggle failed: ${JSON.stringify({ videoToggle, afterVideo })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'video-active.png') });
  const videoOrbit = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.set-view', { mode: 'orbit' }));
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'video-active-orbit.png') });
  const videoRestore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-video-texture'));
  const afterVideoRestore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !videoRestore.ok ||
    !afterVideoRestore.ok ||
    afterVideoRestore.value.videoTexture?.active !== 'original' ||
    afterVideoRestore.value.videoTexture?.swaps !== 2
  ) {
    throw new Error(`WebM restore failed: ${JSON.stringify({ videoRestore, afterVideoRestore })}`);
  }
  await page.keyboard.down('m');
  await page.waitForTimeout(100);
  await page.keyboard.up('m');
  await page.waitForTimeout(100);
  const afterVideoKey = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!afterVideoKey.ok || afterVideoKey.value.videoTexture?.active !== 'video' || afterVideoKey.value.videoTexture?.swaps !== 3) {
    throw new Error(`WebM keyboard toggle failed: ${JSON.stringify(afterVideoKey)}`);
  }
  await page.keyboard.down('m');
  await page.waitForTimeout(100);
  await page.keyboard.up('m');
  await page.waitForTimeout(100);
  const afterVideoKeyRestore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!afterVideoKeyRestore.ok || afterVideoKeyRestore.value.videoTexture?.active !== 'original' || afterVideoKeyRestore.value.videoTexture?.swaps !== 4) {
    throw new Error(`WebM keyboard restore failed: ${JSON.stringify(afterVideoKeyRestore)}`);
  }

  const jpegBefore = before.value.jpegTexture;
  if (
    jpegBefore?.available !== true ||
    jpegBefore.kind !== 'texture' ||
    jpegBefore.name !== 'wood-container.jpg' ||
    jpegBefore.format !== 'bc7-rgba-unorm-srgb' ||
    jpegBefore.colorSpace !== 'srgb'
  ) {
    throw new Error(`JPEG asset witness failed: ${JSON.stringify(jpegBefore)}`);
  }
  const atlasBefore = before.value.spriteAtlas;
  if (
    atlasBefore?.available !== true ||
    atlasBefore.guid !== '0e8657b1-c0ab-4940-a4f6-27fcd976823c' ||
    atlasBefore.name !== 'walk.atlas.png' ||
    atlasBefore.kind !== 'texture' ||
    atlasBefore.width !== 64 ||
    atlasBefore.height !== 64 ||
    atlasBefore.frameCount !== 4 ||
    atlasBefore.active !== false
  ) {
    throw new Error(`PNG sprite atlas witness failed: ${JSON.stringify(atlasBefore)}`);
  }
  const fontCatalog = await page.evaluate(async () => {
    const response = await fetch('/pack-index.json');
    const rows = await response.json();
    return {
      font: rows.find((row) => row.guid === '57db8d79-bb62-4b2a-8400-67c9601870cd'),
      atlas: rows.find((row) => row.guid === 'd7b931cf-5835-4341-94e7-281939db018e'),
    };
  });
  if (
    fontCatalog.font?.kind !== 'font' ||
    fontCatalog.font?.execution !== 'cooked' ||
    !fontCatalog.font?.sourcePath?.endsWith('DejaVuSansMono.ttf') ||
    fontCatalog.atlas?.kind !== 'texture' ||
    fontCatalog.atlas?.execution !== 'cooked'
  ) {
    throw new Error(`TTF font catalog rows failed: ${JSON.stringify(fontCatalog)}`);
  }
  const fontBefore = before.value.worldScoreText;
  if (fontBefore?.available !== true || fontBefore.fontSource !== 'legacy-pack' || fontBefore.toggles !== 0) {
    throw new Error(`legacy font baseline failed: ${JSON.stringify(fontBefore)}`);
  }
  const fontToggle = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-font-source'));
  const afterFontToggle = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !fontToggle.ok ||
    !afterFontToggle.ok ||
    afterFontToggle.value.worldScoreText?.fontSource !== 'ttf-plugin' ||
    afterFontToggle.value.worldScoreText?.fontGuid !== '57db8d79-bb62-4b2a-8400-67c9601870cd' ||
    afterFontToggle.value.worldScoreText?.toggles !== 1
  ) {
    throw new Error(`TTF font plugin toggle failed: ${JSON.stringify({ fontCatalog, fontBefore, fontToggle, afterFontToggle })}`);
  }
  const fontScore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.trigger-score'));
  await page.waitForTimeout(100);
  const afterFontScore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!fontScore.ok || fontScore.value?.points === null || !afterFontScore.ok || afterFontScore.value.worldScoreText?.active !== true || afterFontScore.value.worldScoreText?.fontSource !== 'ttf-plugin') {
    throw new Error(`TTF font score outcome failed: ${JSON.stringify({ fontScore, afterFontScore })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'ttf-font-active.png') });
  await page.keyboard.down('y');
  await page.waitForTimeout(100);
  await page.keyboard.up('y');
  await page.waitForTimeout(120);
  const fontRestoreKey = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!fontRestoreKey.ok || fontRestoreKey.value.worldScoreText?.fontSource !== 'legacy-pack') {
    throw new Error(`TTF font keyboard restore failed: ${JSON.stringify(fontRestoreKey)}`);
  }
  const atlasToggle = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-sprite-atlas'));
  if (!atlasToggle.ok || atlasToggle.value?.active !== true || atlasToggle.value?.swaps !== 1) {
    throw new Error(`PNG sprite atlas toggle failed: ${JSON.stringify(atlasToggle)}`);
  }
  await page.keyboard.down('f');
  await page.waitForTimeout(90);
  await page.keyboard.up('f');
  await page.waitForTimeout(90);
  const atlasFrame1 = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  await page.waitForTimeout(180);
  const atlasFrame2 = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !atlasFrame1.ok ||
    !atlasFrame2.ok ||
    atlasFrame1.value.spriteAtlas?.active !== true ||
    atlasFrame1.value.spriteAtlas?.trackedEntities < 1 ||
    atlasFrame2.value.spriteAtlas?.frame === atlasFrame1.value.spriteAtlas?.frame
  ) {
    throw new Error(`PNG sprite atlas animation did not advance: ${JSON.stringify({ atlasFrame1, atlasFrame2 })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'sprite-atlas-active.png') });
  await page.keyboard.down('n');
  await page.waitForTimeout(100);
  await page.keyboard.up('n');
  await page.waitForTimeout(120);
  const atlasRestoreKey = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!atlasRestoreKey.ok || atlasRestoreKey.value.spriteAtlas?.active !== false) {
    throw new Error(`PNG sprite atlas keyboard restore failed: ${JSON.stringify(atlasRestoreKey)}`);
  }
  const jpegToggle = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-jpeg-texture'));
  const afterJpeg = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!jpegToggle.ok || !afterJpeg.ok || afterJpeg.value.jpegTexture?.active !== 'jpeg' || afterJpeg.value.jpegTexture?.swaps !== 1) {
    throw new Error(`JPEG toggle failed: ${JSON.stringify({ jpegToggle, afterJpeg })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'jpeg-active.png') });
  const jpegRestore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-jpeg-texture'));
  const afterJpegRestore = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!jpegRestore.ok || !afterJpegRestore.ok || afterJpegRestore.value.jpegTexture?.active !== 'original') {
    throw new Error(`JPEG restore failed: ${JSON.stringify({ jpegRestore, afterJpegRestore })}`);
  }

  const profileToggle = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-target-profile'));
  const afterProfile = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !profileToggle.ok ||
    !afterProfile.ok ||
    afterProfile.value.targetProfile?.active !== 'profile' ||
    afterProfile.value.targetProfile?.swaps !== 1 ||
    afterProfile.value.targetProfile?.baseColor?.[2] !== 1
  ) {
    throw new Error(`target profile action failed: ${JSON.stringify({ profileToggle, afterProfile })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'target-profile-active.png') });
  await page.keyboard.down('p');
  await page.waitForTimeout(100);
  await page.keyboard.up('p');
  await page.waitForTimeout(150);
  const afterProfileKey = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (!afterProfileKey.ok || afterProfileKey.value.targetProfile?.active !== 'original') {
    throw new Error(`target profile keyboard restore failed: ${JSON.stringify(afterProfileKey)}`);
  }

  await page.keyboard.down('b');
  await page.waitForTimeout(100);
  await page.keyboard.up('b');
  await page.waitForTimeout(150);
  const afterVisibilityKey = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !afterVisibilityKey.ok ||
    afterVisibilityKey.value.visibility?.intent !== 'hidden' ||
    afterVisibilityKey.value.visibility?.effective !== 'hidden'
  ) {
    throw new Error(`visibility input loop failed: ${JSON.stringify(afterVisibilityKey)}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'visibility-hidden.png') });
  const visibilityToggle = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.toggle-visibility'));
  const afterVisibilityAction = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
  if (
    !visibilityToggle.ok ||
    !afterVisibilityAction.ok ||
    afterVisibilityAction.value.visibility?.intent !== 'visible' ||
    afterVisibilityAction.value.visibility?.effective !== 'visible'
  ) {
    throw new Error(`visibility inspection action failed: ${JSON.stringify({ visibilityToggle, afterVisibilityAction })}`);
  }

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
  if (
    !resetRequest.ok ||
    !afterReset.ok ||
    afterReset.value.state.phase !== 'Play' ||
    afterReset.value.state.resetTransitions < 1 ||
    afterReset.value.videoTexture?.active !== 'original' ||
    afterReset.value.visibility?.intent !== 'inherited' ||
    afterReset.value.visibility?.effective !== 'visible' ||
    afterReset.value.spriteAtlas?.active !== false ||
    afterReset.value.spriteAtlas?.frame !== 0 ||
    afterReset.value.spriteAtlas?.trackedEntities !== 0
    || afterReset.value.worldScoreText?.fontSource !== 'legacy-pack'
    || afterReset.value.worldScoreText?.toggles !== 0
  ) {
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

  const report = { listed, before, videoBefore, videoToggle, afterVideo, videoOrbit, videoRestore, afterVideoRestore, afterVideoKey, afterVideoKeyRestore, profileCatalog, profileBefore, profileToggle, afterProfile, afterProfileKey, atlasBefore, atlasToggle, atlasFrame1, atlasFrame2, atlasRestoreKey, fontCatalog, fontBefore, fontToggle, afterFontToggle, fontScore, afterFontScore, fontRestoreKey, jpegBefore, jpegToggle, afterJpeg, jpegRestore, afterJpegRestore, afterVisibilityKey, visibilityToggle, afterVisibilityAction, orbit, afterOrbit, hit, afterHit, invalidState, missingRead, resetRequest, afterReset, health, recoverHealthy, capture, cleared, pageErrors, consoleErrors, badResponses, serverOutput };
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
