#!/usr/bin/env node
// Player-visible proof for the authored three-step mission. It intentionally
// refuses inspection score actions: the unlock must come from real projectile
// hits, then the HUD action must apply the GUID target profile, a second real
// hit must complete the precision step, the guided WebM panel must replay its
// authored hit playhead on another real hit, the guided atlas must animate a
// real projectile hit, the imported TTF must change the world-score consequence
// on another real hit, the hidden FBX companion must replace the same scored
// target and replay its animation on a real hit, and R must restore the first step.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_MISSION_PROGRESS_DIR ?? resolve(ROOT, '.forgeax-debug/mission-progression'));
const PORT = Number.parseInt(process.env.FORGEAX_MISSION_PROGRESS_PORT ?? '5224', 10);
const MODE = process.env.FORGEAX_MISSION_PROGRESS_MODE ?? 'dev';
const ORIGIN = `http://127.0.0.1:${PORT}`;
mkdirSync(ARTIFACT_DIR, { recursive: true });

const server = spawn(
  'pnpm',
  MODE === 'production'
    ? ['--filter', '@forgeax/preview', 'exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort']
    : ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

const pageErrors = [];
const consoleErrors = [];
const badResponses = [];
let browser;
let page;

const hudHost = () => page.locator('[data-ui-asset]').filter({ has: page.locator('[data-ui-slot="mission"]') }).first();
const openAssetLab = async () => {
  const details = hudHost().locator('details.asset-lab');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
};
const readHud = () => hudHost().evaluate((host) => {
  const shadow = host.shadowRoot;
  const text = (selector) => shadow?.querySelector(selector)?.textContent ?? null;
  const profile = shadow?.querySelector('[data-ui-action="target-profile"]');
  return {
    score: text('[data-ui-slot="score"]'),
    mission: text('[data-ui-slot="mission"]'),
    missionComplete: shadow?.querySelector('[data-ui-slot="mission"]')?.getAttribute('data-complete') ?? null,
    assetStatus: text('[data-ui-slot="asset-lab-status"]'),
    target: text('[data-ui-slot="target-status"]'),
    profileButton: profile?.outerHTML ?? null,
    profileDisabled: profile?.hasAttribute('disabled') ?? null,
    fbxButtonDisabled: shadow?.querySelector('[data-ui-action="fbx-companion"]')?.hasAttribute('disabled') ?? null,
  };
});
const readSnapshot = () => page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
const holdKey = async (key, duration = 90) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(duration);
  await page.keyboard.up(key);
};
const screenshot = (name) => page.screenshot({ path: resolve(ARTIFACT_DIR, `${name}.png`) });

function writeReport(status, extra = {}) {
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({ status, mode: MODE, ...extra, pageErrors, consoleErrors, badResponses, serverOutput }, null, 2)}\n`);
}

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/`);
      if (response.ok) break;
    } catch {
      // Vite is still starting.
    }
    await sleep(250);
  }
  if (Date.now() >= deadline) throw new Error(`Preview server did not start: ${serverOutput}`);

  browser = await chromium.launch({
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--use-vulkan=swiftshader',
      '--disable-vulkan-surface',
      '--ignore-gpu-blocklist',
      '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`${message.text()} @ ${message.location().url}`); });
  page.on('response', (response) => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) badResponses.push(`${response.status()} ${response.url()}`); });

  await page.goto(`${ORIGIN}/?game=game-default`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'game-default.snapshot') ?? false, undefined, { timeout: 30_000, polling: 100 });
  await page.waitForFunction(async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.phase === 'Play', undefined, { timeout: 30_000, polling: 100 });
  await page.waitForTimeout(500);

  await holdKey('r');
  await page.waitForTimeout(350);
  const baseline = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!baseline.snapshot?.ok || baseline.hud.mission !== 'Mission 1/3 · Score 50 · 0/50' || baseline.hud.profileDisabled !== true || baseline.snapshot.value.targetProfile?.active !== 'original') {
    throw new Error(`mission baseline failed: ${JSON.stringify(baseline)}`);
  }
  await screenshot('mission-locked');

  // A disabled public button is the first guard. The same action is also
  // guarded in the ECS-owned action adapter for keyboard/inspection callers.
  await hudHost().locator('[data-ui-action="target-profile"]').evaluate((button) => (button instanceof HTMLButtonElement ? button.click() : undefined));
  await page.waitForTimeout(150);
  const lockedAttempt = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!lockedAttempt.snapshot?.ok || lockedAttempt.snapshot.value.targetProfile?.active !== 'original' || lockedAttempt.hud.score !== 'Score  0' || lockedAttempt.hud.missionComplete !== 'false') {
    throw new Error(`locked profile action bypassed mission: ${JSON.stringify(lockedAttempt)}`);
  }

  // The authored scoring bodies are dynamic physics entities, so a target can
  // drift after a hit. Fire through the real canvas path at the initial
  // authored target points in quick succession; each click still goes through
  // pointer picking, projectile simulation, collision feedback, and score.
  // This keeps the smoke deterministic without mutating score or ECS state.
  const fireAt = async (x, y) => {
    await page.mouse.click(x, y);
    await page.waitForTimeout(260);
  };
  const firstHit = { snapshot: await readSnapshot(), hud: await readHud() };
  // Avoid the RedBox precision target until mission 3: it must remain at its
  // authored profile point for the following precision-hit proof.
  const authoredAimPoints = [[304, 379], [627, 297], [556, 339], [304, 379], [627, 297], [556, 339]];
  for (const [x, y] of authoredAimPoints) {
    if (Number.parseInt((await readHud()).score?.replace(/\D/g, '') ?? '0', 10) >= 50) break;
    await fireAt(x, y);
  }
  const unlocked = { snapshot: await readSnapshot(), hud: await readHud() };
  const unlockedScore = Number.parseInt(unlocked.hud.score?.replace(/\D/g, '') ?? '0', 10);
  if (!unlocked.snapshot?.ok || unlockedScore < 50 || unlocked.hud.mission !== 'Mission 2/3 · Press P to apply the authored target profile' || unlocked.hud.profileDisabled !== false || unlocked.snapshot.value.targetProfile?.active !== 'original') {
    throw new Error(`real hits did not unlock mission: ${JSON.stringify({ firstHit, unlocked })}`);
  }
  await screenshot('mission-unlocked');

  await hudHost().locator('[data-ui-action="target-profile"]').evaluate((button) => (button instanceof HTMLButtonElement ? button.click() : undefined));
  await page.waitForTimeout(350);
  const profileActive = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!profileActive.snapshot?.ok || profileActive.snapshot.value.targetProfile?.active !== 'profile' || profileActive.snapshot.value.targetProfile?.precisionHits !== 0 || profileActive.snapshot.value.targetProfile?.precisionComplete !== false || profileActive.snapshot.value.targetProfile?.rotationSpeed !== 0.18 || profileActive.hud.missionComplete !== 'false' || profileActive.hud.mission !== 'Mission 3/3 · Hit the rotating precision target' || !profileActive.hud.target?.startsWith('TARGET · RedBox · ') || !profileActive.hud.target?.includes('+20 · PRECISION MOTION') || !profileActive.hud.assetStatus?.includes('Target profile active')) {
    throw new Error(`profile did not open precision step: ${JSON.stringify({ unlocked, profileActive })}`);
  }
  await screenshot('mission-precision-ready');

  // The RedBox is stable at this authored viewport. This real canvas click
  // exercises pointer picking, deferred projectile simulation, target
  // feedback, and the profile-owned precision completion callback.
  // The target rotates around its authored center; sweep the small visible
  // footprint so the proof remains a real pointer shot even when the first
  // frame lands on a rotating edge.
  const precisionAimPoints = [[566, 214], [550, 204], [566, 204], [582, 204], [550, 214], [582, 214], [550, 224], [566, 224], [582, 224]];
  for (const [x, y] of precisionAimPoints) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(260);
    const precisionAttempt = await readSnapshot();
    if (precisionAttempt?.value?.targetProfile?.precisionHits >= 1) break;
  }
  await page.waitForTimeout(300);
  const completed = { snapshot: await readSnapshot(), hud: await readHud() };
  const completedScore = Number.parseInt(completed.hud.score?.replace(/\D/g, '') ?? '0', 10);
  if (!completed.snapshot?.ok || completed.snapshot.value.targetProfile?.active !== 'profile' || completed.snapshot.value.targetProfile?.precisionHits !== 1 || completed.snapshot.value.targetProfile?.precisionComplete !== true || completed.snapshot.value.targetProfile?.rotationSpeed !== 0.18 || completed.hud.missionComplete !== 'true' || completed.hud.mission !== 'Mission complete · Precision hit confirmed · R to replay' || !completed.hud.target?.startsWith('TARGET · RedBox · ') || !completed.hud.target?.includes('+20 · PRECISION MOTION') || completedScore <= unlockedScore || !completed.hud.assetStatus?.includes('Target profile active')) {
    throw new Error(`precision hit did not complete mission: ${JSON.stringify({ unlocked, profileActive, completed })}`);
  }
  await screenshot('mission-complete');

  // The imported FBX path is mission-gated and must become a visible player
  // consequence on the same scored RedBox, not just a loaded scene snapshot.
  await openAssetLab();
  await hudHost().locator('[data-ui-action="fbx-companion"]').click();
  await page.waitForTimeout(150);
  const fbxEnabled = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!fbxEnabled.snapshot?.ok || fbxEnabled.snapshot.value.fbxSkinnedTarget?.available !== true || fbxEnabled.snapshot.value.fbxSkinnedTarget?.companionActive !== true || fbxEnabled.snapshot.value.fbxSkinnedTarget?.targetEntity === null || fbxEnabled.snapshot.value.visibility?.effective !== 'hidden' || !fbxEnabled.hud.assetStatus?.includes('FBX target companion active')) {
    throw new Error(`guided FBX companion did not replace the scored presentation: ${JSON.stringify({ completed, fbxEnabled })}`);
  }
  const fbxEnabledScore = Number.parseInt(fbxEnabled.hud.score?.replace(/\D/g, '') ?? '0', 10);
  let fbxHitAttempt;
  for (const [x, y] of precisionAimPoints) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(180);
    const attempt = { snapshot: await readSnapshot(), hud: await readHud() };
    if ((attempt.snapshot?.value?.fbxSkinnedTarget?.hitPulses ?? 0) >= 1) {
      fbxHitAttempt = attempt;
      break;
    }
  }
  await page.waitForTimeout(300);
  const fbxHit = fbxHitAttempt ?? { snapshot: await readSnapshot(), hud: await readHud() };
  const fbxHitScore = Number.parseInt(fbxHit.hud.score?.replace(/\D/g, '') ?? '0', 10);
  if (!fbxHit.snapshot?.ok || fbxHit.snapshot.value.fbxSkinnedTarget?.companionActive !== true || (fbxHit.snapshot.value.fbxSkinnedTarget?.hitPulses ?? 0) < 1 || fbxHitScore <= fbxEnabledScore || !fbxHit.hud.assetStatus?.includes('animated hit confirmed')) {
    throw new Error(`guided FBX companion did not replay on a real hit: ${JSON.stringify({ fbxEnabled, fbxHit })}`);
  }
  await screenshot('fbx-companion-guided-hit');

  // Guided Asset Lab presentations share one scored target. Restore the
  // authored RedBox before the next variation so its fixed aim points remain
  // a deterministic player path rather than relying on a moving companion.
  await openAssetLab();
  await hudHost().locator('[data-ui-action="fbx-companion"]').click();
  await page.waitForTimeout(150);
  const fbxRestored = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!fbxRestored.snapshot?.ok || fbxRestored.snapshot.value.fbxSkinnedTarget?.companionActive !== false || fbxRestored.snapshot.value.visibility?.effective !== 'visible' || !fbxRestored.hud.assetStatus?.includes('FBX target companion restored')) {
    throw new Error(`guided FBX companion did not restore the scored target: ${JSON.stringify({ fbxHit, fbxRestored })}`);
  }

  // The WebM entry is a guided consequence, not only a loader toggle. Enable
  // the existing pooled panel, then use the real projectile path to prove that
  // target feedback seeks and replays its deterministic hit context.
  await openAssetLab();
  await hudHost().locator('[data-ui-action="video-texture"]').click();
  await page.waitForTimeout(120);
  const videoEnabled = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!videoEnabled.snapshot?.ok || videoEnabled.snapshot.value.videoTexture?.active !== 'video' || videoEnabled.snapshot.value.videoTexture?.hitReactions !== 0 || videoEnabled.snapshot.value.videoTexture?.lastHitPlayhead !== null || !videoEnabled.hud.assetStatus?.includes('WebM target panel active')) {
    throw new Error(`guided WebM panel did not enable: ${JSON.stringify({ completed, videoEnabled })}`);
  }
  const guidedAimPoints = [[566, 214], [304, 379], [627, 297], [556, 339], [566, 214], [304, 379], [627, 297], [556, 339]];
  for (const [x, y] of guidedAimPoints) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(260);
    const videoAttempt = await readSnapshot();
    if ((videoAttempt?.value?.videoTexture?.hitReactions ?? 0) >= 1) break;
  }
  await page.waitForTimeout(300);
  const videoHit = { snapshot: await readSnapshot(), hud: await readHud() };
  const videoHitScore = Number.parseInt(videoHit.hud.score?.replace(/\D/g, '') ?? '0', 10);
  if (!videoHit.snapshot?.ok || videoHit.snapshot.value.videoTexture?.active !== 'video' || (videoHit.snapshot.value.videoTexture?.hitReactions ?? 0) < 1 || videoHit.snapshot.value.videoTexture?.lastHitPlayhead !== 0.35 || videoHitScore <= completedScore || !videoHit.hud.assetStatus?.includes('hit context replayed')) {
    throw new Error(`guided WebM panel did not react to a real hit: ${JSON.stringify({ completed, videoEnabled, videoHit })}`);
  }
  await screenshot('video-guided-hit-context');

  // The named TTF path must change the same pooled GlyphText consequence, not
  // merely report a loader toggle. A real scored hit proves the imported font
  // handle and its authored presentation reach the world-space label.
  await openAssetLab();
  await hudHost().locator('[data-ui-action="font-source"]').click();
  await page.waitForTimeout(120);
  const fontEnabled = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!fontEnabled.snapshot?.ok || fontEnabled.snapshot.value.worldScoreText?.fontSource !== 'ttf-plugin' || fontEnabled.snapshot.value.worldScoreText?.fontSize <= 0.024 || !fontEnabled.hud.assetStatus?.includes('imported glyph metrics on next hit')) {
    throw new Error(`guided TTF font did not enable: ${JSON.stringify({ completed, fontEnabled })}`);
  }
  const fontEnabledScore = Number.parseInt(fontEnabled.hud.score?.replace(/\D/g, '') ?? '0', 10);
  for (const [x, y] of guidedAimPoints) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(260);
    const fontAttempt = await readSnapshot();
    const fontAttemptScore = Number.parseInt((await readHud()).score?.replace(/\D/g, '') ?? '0', 10);
    if (fontAttemptScore > fontEnabledScore && fontAttempt?.value?.worldScoreText?.fontSource === 'ttf-plugin' && fontAttempt.value.worldScoreText.active === true) break;
  }
  await page.waitForTimeout(300);
  const fontHit = { snapshot: await readSnapshot(), hud: await readHud() };
  const fontHitScore = Number.parseInt(fontHit.hud.score?.replace(/\D/g, '') ?? '0', 10);
  const fontWorldScore = fontHit.snapshot?.value.worldScoreText;
  const fontHitStatus = fontHit.hud.assetStatus ?? '';
  const fontHitStatusOk = fontHitStatus.includes('imported glyph metrics on scored hit') || fontHitStatus.includes('hit context replayed');
  if (!fontHit.snapshot?.ok || fontHitScore <= completedScore || fontWorldScore?.fontSource !== 'ttf-plugin' || fontWorldScore.active !== true || !/^\+\d+$/.test(fontWorldScore.text) || fontWorldScore.fontSize <= 0.024 || fontWorldScore.color?.[2] <= fontWorldScore.color?.[0] || !fontHitStatusOk) {
    throw new Error(`guided TTF font did not change a real score consequence: ${JSON.stringify({ completed, fontEnabled, fontHit })}`);
  }
  await screenshot('font-guided-score');

  // The named guided asset path must produce a visible consequence in the same mission:
  // enable the existing GUID-backed atlas, observe a frame advance on a real projectile,
  // then confirm that projectile still reaches the normal hit/score/VFX/audio owner.
  await openAssetLab();
  await hudHost().locator('[data-ui-action="sprite-atlas"]').click();
  await page.waitForTimeout(120);
  const atlasEnabled = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!atlasEnabled.snapshot?.ok || atlasEnabled.snapshot.value.spriteAtlas?.active !== true || atlasEnabled.snapshot.value.spriteAtlas?.animatedShots !== 0 || atlasEnabled.snapshot.value.spriteAtlas?.animatedHits !== 0 || !atlasEnabled.hud.assetStatus?.includes('fire to confirm')) {
    throw new Error(`guided atlas did not enable: ${JSON.stringify(atlasEnabled)}`);
  }
  const atlasAimPoints = [[566, 214], [550, 204], [566, 204], [582, 204], [550, 214], [582, 214], [550, 224], [566, 224], [582, 224], [304, 379], [627, 297], [556, 339]];
  let atlasFrame1;
  for (const [x, y] of atlasAimPoints) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(150);
    const attempt = { snapshot: await readSnapshot(), hud: await readHud() };
    if (atlasFrame1 === undefined && attempt.snapshot?.value?.spriteAtlas?.animatedShots >= 1) atlasFrame1 = attempt;
    if (attempt.snapshot?.value?.spriteAtlas?.animatedHits >= 1) break;
  }
  const atlasFrame1Value = atlasFrame1;
  await page.waitForTimeout(180);
  const atlasFrame2 = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!atlasFrame1Value?.snapshot?.ok || !atlasFrame2.snapshot?.ok || atlasFrame1Value.snapshot.value.spriteAtlas?.active !== true || atlasFrame1Value.snapshot.value.spriteAtlas?.animatedShots < 1 || atlasFrame1Value.snapshot.value.spriteAtlas?.trackedEntities < 1 || atlasFrame2.snapshot.value.spriteAtlas?.frame === atlasFrame1Value.snapshot.value.spriteAtlas?.frame) {
    throw new Error(`guided atlas animation did not advance on a real shot: ${JSON.stringify({ atlasEnabled, atlasFrame1: atlasFrame1Value, atlasFrame2 })}`);
  }
  await page.waitForTimeout(750);
  const atlasHit = { snapshot: await readSnapshot(), hud: await readHud() };
  const atlasHitScore = Number.parseInt(atlasHit.hud.score?.replace(/\D/g, '') ?? '0', 10);
  const atlasEnabledScore = Number.parseInt(atlasEnabled.hud.score?.replace(/\D/g, '') ?? '0', 10);
  const atlasHitStatus = atlasHit.hud.assetStatus ?? '';
  const atlasHitStatusOk = atlasHitStatus.includes('animated hit confirmed') || atlasHitStatus.includes('hit context replayed');
  if (!atlasHit.snapshot?.ok || atlasHit.snapshot.value.spriteAtlas?.active !== true || atlasHit.snapshot.value.spriteAtlas?.animatedHits < 1 || atlasHitScore <= atlasEnabledScore || !atlasHitStatusOk) {
    throw new Error(`guided atlas projectile did not complete the shared hit path: ${JSON.stringify({ completed, fontHit, atlasEnabled, atlasFrame1: atlasFrame1Value, atlasFrame2, atlasHit })}`);
  }
  await screenshot('atlas-guided-hit');

  await holdKey('r');
  await page.waitForTimeout(350);
  const reset = { snapshot: await readSnapshot(), hud: await readHud() };
  const resetFont = reset.snapshot.value.worldScoreText;
  const resetFontColor = resetFont?.color ?? [];
  if (!reset.snapshot?.ok || reset.snapshot.value.targetProfile?.active !== 'original' || reset.snapshot.value.targetProfile?.precisionHits !== 0 || reset.snapshot.value.targetProfile?.precisionComplete !== false || reset.snapshot.value.videoTexture?.active !== 'original' || reset.snapshot.value.videoTexture?.hitReactions !== 0 || reset.snapshot.value.videoTexture?.lastHitPlayhead !== null || reset.snapshot.value.spriteAtlas?.active !== false || reset.snapshot.value.spriteAtlas?.animatedShots !== 0 || reset.snapshot.value.spriteAtlas?.animatedHits !== 0 || reset.snapshot.value.fbxSkinnedTarget?.companionActive !== false || reset.snapshot.value.fbxSkinnedTarget?.hitPulses !== 0 || reset.snapshot.value.visibility?.effective !== 'visible' || resetFont?.fontSource !== 'legacy-pack' || Math.abs((resetFont?.fontSize ?? 0) - 0.024) > 1e-5 || Math.abs((resetFontColor[0] ?? 0) - 1) > 1e-5 || Math.abs((resetFontColor[1] ?? 0) - 0.8) > 1e-5 || Math.abs((resetFontColor[2] ?? 0) - 0.2) > 1e-5 || reset.hud.score !== 'Score  0' || reset.hud.mission !== 'Mission 1/3 · Score 50 · 0/50' || reset.hud.profileDisabled !== true || reset.hud.fbxButtonDisabled !== true || reset.hud.missionComplete !== 'false' || reset.hud.target !== 'TARGET · RedBox · 100/100 HP · +10') {
    throw new Error(`mission reset failed: ${JSON.stringify(reset)}`);
  }
  await screenshot('mission-reset');

  if (pageErrors.length > 0 || consoleErrors.length > 0 || badResponses.length > 0) throw new Error(`browser diagnostics failed: ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
  writeReport('passed', { baseline, lockedAttempt, firstHit, unlocked, profileActive, completed, videoEnabled, videoHit, fontEnabled, fontHit, atlasEnabled, atlasFrame1, atlasFrame2, atlasHit, fbxEnabled, fbxHit, fbxRestored, reset });
  console.log(`Mission progression smoke PASS (${MODE}): score=${unlockedScore} precision=hit video=context font=hit atlas=hit fbx=hit scoreAfter=${Math.max(atlasHitScore, fbxHitScore)} reset=locked`);
  console.log(`artifacts=${ARTIFACT_DIR}`);
} catch (error) {
  writeReport('failed', { error: String(error) });
  throw new Error(`${String(error)}\nBrowser evidence: ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
} finally {
  await browser?.close();
  if (server.pid !== undefined) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
  }
  await sleep(300);
}
