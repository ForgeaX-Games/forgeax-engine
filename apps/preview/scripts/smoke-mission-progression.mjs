#!/usr/bin/env node
// Player-visible proof for the authored three-step mission. It intentionally
// refuses inspection score actions: the unlock must come from real projectile
// hits, then the HUD action must apply the GUID target profile, a second real
// hit must open the authored three-target relay. A wrong target must not
// advance it, and one real hit per active target must unlock extraction. The
// player must then meet the authored beacon too early, collect exactly three
// uniquely authored EnergyCores through real controller/physics overlap, and
// return to the beacon to enter typed Victory. The existing FBX companion must
// visibly mark the RedBox interval. Victory must
// freeze Play-owned mutation while preserving the final score; the same Reset
// transaction must restore prepared WebM/TTF/atlas state and support a second
// complete player cycle and replay.
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
    missionPhase: shadow?.querySelector('[data-ui-slot="mission"]')?.getAttribute('data-phase') ?? null,
    assetStatus: text('[data-ui-slot="asset-lab-status"]'),
    target: text('[data-ui-slot="target-status"]'),
    charge: text('[data-ui-slot="charge-label"]'),
    chargeState: shadow?.querySelector('[data-ui-slot="charge"]')?.getAttribute('data-state') ?? null,
    combo: text('[data-ui-slot="combo"]'),
    profileButton: profile?.outerHTML ?? null,
    profileDisabled: profile?.hasAttribute('disabled') ?? null,
    fbxButtonDisabled: shadow?.querySelector('[data-ui-action="fbx-companion"]')?.hasAttribute('disabled') ?? null,
    assetButtonsDisabled: [...shadow?.querySelectorAll('.asset-control') ?? []].every((button) => button.hasAttribute('disabled')),
  };
});
const readSnapshot = () => page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
const readRenderEvidence = () => page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence?.snapshot());
const holdKey = async (key, duration = 90) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(duration);
  await page.keyboard.up(key);
};
const screenshot = (name) => page.screenshot({ path: resolve(ARTIFACT_DIR, `${name}.png`) });
const originalPickup = (snapshot) => snapshot.healthPickup?.pickups?.find((pickup) => pickup.authoredLocalId === 26);

const assertPressure = (counterattack, tier, label) => {
  if (counterattack?.pressureTier !== tier
    || !(counterattack.patrolSpeed > 0)
    || !(counterattack.chaseSpeed > 0)
    || !(counterattack.pursuitRadius > 0)) {
    throw new Error(`${label} did not project the derived pressure contract: ${JSON.stringify(counterattack)}`);
  }
};

const probeActiveMotion = async (beforeSnapshot, label) => {
  const before = beforeSnapshot.counterattack;
  if (!before.hazardActive || before.hazardMode !== 'chase' || !Array.isArray(before.hazardPosition)) {
    throw new Error(`${label} did not expose a live chasing BouncyBall: ${JSON.stringify(before)}`);
  }
  await page.waitForTimeout(120);
  const afterSnapshot = await readSnapshot();
  const after = afterSnapshot?.value?.counterattack;
  assertPressure(after, before.pressureTier, label);
  if (!after?.hazardActive || after.hazardMode !== 'chase' || !Array.isArray(after.hazardPosition)) {
    throw new Error(`${label} stopped live pursuit during the motion probe: ${JSON.stringify(after)}`);
  }
  const displacement = Math.hypot(
    after.hazardPosition[0] - before.hazardPosition[0],
    after.hazardPosition[2] - before.hazardPosition[2],
  );
  const elapsed = afterSnapshot.value.state.simulationSeconds - beforeSnapshot.state.simulationSeconds;
  if (displacement <= 0.05 || elapsed <= 0 || displacement / elapsed > before.chaseSpeed * 1.15) {
    throw new Error(`${label} motion did not obey the tier chase speed: ${JSON.stringify({ before, after, displacement, elapsed })}`);
  }
  return { before, after, displacement, elapsed, measuredSpeed: displacement / elapsed };
};

const drivePlayerTo = async (target, label, timeout = 12_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot();
    const position = snapshot?.value?.counterattack?.playerPosition;
    if (!Array.isArray(position)) throw new Error(`${label} has no player pose: ${JSON.stringify(snapshot)}`);
    if (snapshot.value.state.phase !== 'Play') return snapshot;
    const dx = target[0] - position[0];
    const dz = target[1] - position[2];
    if (Math.hypot(dx, dz) <= 0.42) return snapshot;
    const keys = [];
    if (dx < -0.18) keys.push('a');
    if (dx > 0.18) keys.push('d');
    if (dz < -0.18) keys.push('w');
    if (dz > 0.18) keys.push('s');
    for (const key of keys) await page.keyboard.down(key);
    await page.waitForTimeout(90);
    for (const key of keys) await page.keyboard.up(key);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(await readSnapshot())}`);
};

const waitForExtraction = async (predicate, label, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot();
    if (snapshot?.ok && predicate(snapshot.value.extraction, snapshot.value)) return snapshot;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(await readSnapshot())}`);
};

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
  await page.waitForFunction(() => globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'game-default.snapshot') ?? false, undefined, { timeout: 60_000, polling: 100 });
  await page.waitForFunction(async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.phase === 'Play', undefined, { timeout: 60_000, polling: 100 });
  await page.waitForTimeout(500);

  await holdKey('r');
  await page.waitForTimeout(350);
  const baseline = { snapshot: await readSnapshot(), hud: await readHud() };
  assertPressure(baseline.snapshot?.value?.counterattack, 0, 'cold baseline');
  const baselinePickup = baseline.snapshot?.ok ? originalPickup(baseline.snapshot.value) : undefined;
  if (!baseline.snapshot?.ok || baseline.hud.mission !== 'Mission 1/3 · Score 50 · 0/50' || baseline.hud.profileDisabled !== true || baseline.snapshot.value.targetProfile?.active !== 'original' || baselinePickup?.available !== true || baselinePickup.sensor !== true || baselinePickup.physicsReady !== true) {
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
  const authoredAimPoints = [
    [304, 379],
    [659, 208], [649, 208], [669, 208],
    [640, 176], [630, 176], [650, 176], [640, 166], [640, 186],
  ];
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
  const yellowAimPoints = [
    [520, 420], [540, 420], [500, 420], [520, 400], [520, 440],
    [556, 339], [546, 339], [566, 339], [556, 329], [556, 349],
  ];
  for (const [x, y] of precisionAimPoints) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(260);
    const precisionAttempt = await readSnapshot();
    if (precisionAttempt?.value?.targetProfile?.precisionHits >= 1) break;
  }
  await page.waitForTimeout(300);
  const relayStarted = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!relayStarted.snapshot?.ok || relayStarted.snapshot.value.targetProfile?.active !== 'profile' || relayStarted.snapshot.value.targetProfile?.precisionHits !== 1 || relayStarted.snapshot.value.targetProfile?.precisionComplete !== true || relayStarted.snapshot.value.targetRelay?.status !== 'active' || relayStarted.snapshot.value.targetRelay?.currentStep !== 1 || relayStarted.snapshot.value.targetRelay?.acceptedHits !== 0 || relayStarted.hud.missionComplete !== 'false' || relayStarted.hud.mission !== 'Relay 1/3 · BlueBall · hit active target' || !relayStarted.hud.target?.startsWith('TARGET · BlueBall · ') || !relayStarted.hud.assetStatus?.includes('Target profile active')) {
    throw new Error(`precision hit did not open relay: ${JSON.stringify({ unlocked, profileActive, relayStarted })}`);
  }
  await screenshot('relay-blue-ready');

  const rejectedBefore = relayStarted.snapshot.value.targetRelay.rejectedHits;
  for (const [x, y] of [[304, 379], [294, 379], [314, 379], [304, 369], [304, 389]]) {
    await fireAt(x, y);
    const attempt = await readSnapshot();
    if ((attempt?.value?.targetRelay?.rejectedHits ?? rejectedBefore) > rejectedBefore) break;
  }
  const wrongTarget = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!wrongTarget.snapshot?.ok || wrongTarget.snapshot.value.targetRelay?.currentStep !== 1 || wrongTarget.snapshot.value.targetRelay?.acceptedHits !== 0 || wrongTarget.snapshot.value.targetRelay?.rejectedHits <= rejectedBefore || wrongTarget.hud.mission !== 'Relay 1/3 · BlueBall · hit active target') {
    throw new Error(`wrong target advanced relay: ${JSON.stringify({ relayStarted, wrongTarget })}`);
  }
  await screenshot('relay-wrong-target-rejected');

  const hitRelayTarget = async (points, acceptedBefore) => {
    for (let pass = 0; pass < 3; pass++) {
      for (const [x, y] of points) {
        await fireAt(x, y);
        const attempt = await readSnapshot();
        if ((attempt?.value?.targetRelay?.acceptedHits ?? acceptedBefore) > acceptedBefore) return attempt;
      }
    }
    return readSnapshot();
  };
  const completeExtraction = async (prefix, rewardKind) => {
    const unlockedExtraction = await waitForExtraction(
      (extraction, snapshot) => snapshot.state.phase === 'Play'
        && snapshot.targetRelay.status === 'complete'
        && extraction.status === 'collecting'
        && extraction.collected === 0,
      `${prefix} extraction unlock`,
    );
    assertPressure(unlockedExtraction.value.counterattack, 0, `${prefix} extraction baseline`);
    await drivePlayerTo([0, 0], `${prefix} barrier aim baseline`);
    let barrierOpened;
    for (const point of [[365, 233], [355, 233], [375, 233], [365, 223], [365, 243]]) {
      await page.keyboard.down('c');
      await page.waitForTimeout(900);
      await page.mouse.click(point[0], point[1]);
      await page.waitForTimeout(80);
      await page.keyboard.up('c');
      await page.waitForTimeout(250);
      const candidate = await readSnapshot();
      if (candidate?.value?.barrierRoute?.opens === 1) {
        barrierOpened = candidate;
        break;
      }
    }
    if (!barrierOpened?.ok
      || barrierOpened.value.barrierRoute.active
      || barrierOpened.value.barrierRoute.activeVisual
      || barrierOpened.value.barrierRoute.damagingContact
      || barrierOpened.value.barrierRoute.physicsReady) {
      throw new Error(`${prefix} charged barrier route did not open: ${JSON.stringify(barrierOpened)}`);
    }
    await screenshot(`${prefix}-barrier-open`);
    await drivePlayerTo([0, -4.5], `${prefix} early beacon`);
    const refused = await waitForExtraction(
      (extraction) => extraction.refusedContacts === 1 && extraction.collected === 0,
      `${prefix} early beacon refusal`,
    );
    await screenshot(`${prefix}-beacon-refused`);

    const authoredCoreRoutes = [
      [[-2.5, -2.5]],
      [[4, 1.5]],
      [[4, 5.8], [-5, 5.8], [-5, 4]],
    ];
    const collections = [];
    const pressureEvidence = [];
    let previousPressure = unlockedExtraction.value.counterattack;
    for (let index = 0; index < authoredCoreRoutes.length; index++) {
      for (const [waypointIndex, waypoint] of authoredCoreRoutes[index].entries()) {
        await drivePlayerTo(waypoint, `${prefix} EnergyCore ${index + 1} waypoint ${waypointIndex + 1}`);
      }
      const collected = await waitForExtraction(
        (extraction) => extraction.collected === index + 1
          && extraction.cores.filter((core) => core.available).length === authoredCoreRoutes.length - index - 1,
        `${prefix} EnergyCore ${index + 1} collection`,
      );
      const tier = index + 1;
      assertPressure(collected.value.counterattack, tier, `${prefix} EnergyCore ${tier}`);
      const pressure = collected.value.counterattack;
      if (pressure.patrolSpeed <= previousPressure.patrolSpeed
        || pressure.chaseSpeed <= previousPressure.chaseSpeed
        || pressure.pursuitRadius <= previousPressure.pursuitRadius
        || pressure.chaseSpeed > unlockedExtraction.value.counterattack.chaseSpeed * 1.5) {
        throw new Error(`${prefix} EnergyCore ${tier} did not strictly raise bounded pressure: ${JSON.stringify({ previousPressure, pressure })}`);
      }
      const collectionHud = await readHud();
      if (!collectionHud.mission?.includes(`Threat ${tier}/3`)
        || !collected.value.worldScoreText?.text?.includes(`THREAT ${tier}/3`)) {
        throw new Error(`${prefix} EnergyCore ${tier} did not announce pressure through HUD/world feedback: ${JSON.stringify({ collectionHud, worldScoreText: collected.value.worldScoreText })}`);
      }
      pressureEvidence.push({ tier, counterattack: collected.value.counterattack, hud: collectionHud });
      previousPressure = pressure;
      collections.push(collected);
      await screenshot(`${prefix}-core-${index + 1}`);
    }
    const ready = collections.at(-1);
    if (!ready?.value?.extraction?.active
      || ready.value.extraction.status !== 'ready'
      || ready.value.extraction.collectedMask !== 7
      || ready.value.extraction.deferredDespawns !== 3
      || ready.value.extraction.wrongContacts < 1
      || !ready.value.extraction.beacon.activeVisual) {
      throw new Error(`${prefix} exact extraction activation failed: ${JSON.stringify(ready)}`);
    }
    await screenshot(`${prefix}-beacon-active`);
    const rewardPosition = rewardKind === 'shield' ? [-1.5, -2.8] : [1.5, -2.8];
    await drivePlayerTo(rewardPosition, `${prefix} ${rewardKind} reward pedestal`);
    const reward = await waitForExtraction(
      (_extraction, snapshot) => snapshot.rewardChoice?.state === `${rewardKind}-ready`
        && snapshot.rewardChoice?.selections === 1,
      `${prefix} ${rewardKind} reward choice`,
    );
    if (reward.value.rewardChoice.pedestals.length !== 2
      || reward.value.rewardChoice.pedestals.some((pedestal) => !pedestal.physicsReady)) {
      throw new Error(`${prefix} authored reward sensors failed: ${JSON.stringify(reward)}`);
    }
    await screenshot(`${prefix}-${rewardKind}-ready`);
    let rewardEffect;
    if (rewardKind === 'shield') {
      const maxTierMotion = await probeActiveMotion(reward.value, `${prefix} Shield-armed max tier`);
      const healthBefore = reward.value.counterattack.playerHealth;
      rewardEffect = await waitForExtraction(
        (_extraction, snapshot) => snapshot.rewardChoice?.state === 'consumed'
          && snapshot.rewardChoice?.shieldConsumptions === 1
          && snapshot.counterattack.playerHealth === healthBefore
          && snapshot.counterattack.cooldown > 0,
        `${prefix} Shield block`,
        15_000,
      );
      const nextDamage = await waitForExtraction(
        (_extraction, snapshot) => snapshot.counterattack.playerHealth === healthBefore - 1,
        `${prefix} post-Shield damage`,
        15_000,
      );
      rewardEffect = { maxTierMotion, blocked: rewardEffect, nextDamage };
    } else {
      const spawnedBefore = reward.value.projectiles.spawned;
      await holdKey('c', 950);
      rewardEffect = await waitForExtraction(
        (_extraction, snapshot) => snapshot.rewardChoice?.state === 'consumed'
          && snapshot.rewardChoice?.overchargeConsumptions === 1
          && snapshot.projectiles.spawned > spawnedBefore
          && snapshot.projectiles.impactScales.includes(5),
        `${prefix} Overcharge charged projectile`,
      );
    }
    await screenshot(`${prefix}-${rewardKind}-consumed`);
    await drivePlayerTo([0, -4.5], `${prefix} active beacon`);
    const victory = await waitForExtraction(
      (extraction, snapshot) => snapshot.state.phase === 'Victory'
        && extraction.victoryRequests === 1
        && extraction.collected === 3,
      `${prefix} extraction Victory`,
    );
    return { unlockedExtraction, barrierOpened, refused, collections, pressureEvidence, ready, reward, rewardEffect, victory };
  };
  await hitRelayTarget([[627, 297], [617, 297], [637, 297], [627, 287], [627, 307]], 0);
  const redVariation = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!redVariation.snapshot?.ok || redVariation.snapshot.value.targetRelay?.status !== 'active' || redVariation.snapshot.value.targetRelay?.currentStep !== 2 || redVariation.snapshot.value.targetRelay?.acceptedHits !== 1 || redVariation.snapshot.value.targetRelay?.activeTargetName !== 'RedBox' || redVariation.snapshot.value.targetRelay?.variationActive !== true || redVariation.snapshot.value.fbxSkinnedTarget?.companionActive !== true || redVariation.snapshot.value.visibility?.effective !== 'hidden' || redVariation.hud.mission !== 'Relay 2/3 · RedBox · hit active target') {
    throw new Error(`BlueBall did not advance to visible RedBox variation: ${JSON.stringify({ wrongTarget, redVariation })}`);
  }
  await screenshot('relay-red-fbx-variation');

  await hitRelayTarget(precisionAimPoints, 1);
  const yellowReady = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!yellowReady.snapshot?.ok || yellowReady.snapshot.value.targetRelay?.status !== 'active' || yellowReady.snapshot.value.targetRelay?.currentStep !== 3 || yellowReady.snapshot.value.targetRelay?.acceptedHits !== 2 || yellowReady.snapshot.value.targetRelay?.activeTargetName !== 'YellowPillar' || yellowReady.snapshot.value.targetRelay?.variationActive !== false || yellowReady.snapshot.value.fbxSkinnedTarget?.companionActive !== false || (yellowReady.snapshot.value.fbxSkinnedTarget?.hitPulses ?? 0) < 1 || yellowReady.hud.mission !== 'Relay 3/3 · YellowPillar · hit active target') {
    throw new Error(`RedBox did not advance to YellowPillar through the FBX hit path: ${JSON.stringify({ redVariation, yellowReady })}`);
  }
  await screenshot('relay-yellow-ready');

  // Carry the existing media/font/atlas variations into Victory so the one
  // Reset transaction must restore them together with the gameplay state.
  await openAssetLab();
  await hudHost().locator('[data-ui-action="video-texture"]').click();
  await hudHost().locator('[data-ui-action="font-source"]').click();
  await hudHost().locator('[data-ui-action="sprite-atlas"]').click();
  await page.waitForTimeout(250);
  const preparedVariations = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!preparedVariations.snapshot?.ok || preparedVariations.snapshot.value.videoTexture?.active !== 'video' || preparedVariations.snapshot.value.worldScoreText?.fontSource !== 'ttf-plugin' || preparedVariations.snapshot.value.spriteAtlas?.active !== true) {
    throw new Error(`guided variations were not active before Victory: ${JSON.stringify(preparedVariations)}`);
  }

  await hitRelayTarget(yellowAimPoints, 2);
  const extractionCycle = await completeExtraction('first', 'shield');
  const completed = { snapshot: await readSnapshot(), render: await readRenderEvidence(), hud: await readHud() };
  const completedScore = Number.parseInt(completed.hud.score?.replace(/\D/g, '') ?? '0', 10);
  if (!completed.snapshot?.ok || completed.snapshot.value.state?.phase !== 'Victory' || completed.snapshot.value.state?.victoryTransitions !== 1 || completed.snapshot.value.targetRelay?.status !== 'complete' || completed.snapshot.value.targetRelay?.acceptedHits !== 3 || completed.snapshot.value.targetRelay?.cleared !== 3 || completed.snapshot.value.targetRelay?.rejectedHits < 1 || completed.snapshot.value.targetRelay?.activeTarget !== null || completed.snapshot.value.extraction?.collected !== 3 || completed.snapshot.value.extraction?.collectedMask !== 7 || completed.snapshot.value.extraction?.active !== true || completed.snapshot.value.extraction?.victoryRequests !== 1 || completed.hud.missionComplete !== 'true' || completed.hud.missionPhase !== 'Victory' || completed.hud.mission !== `Victory · Final score ${completedScore} · R to replay` || completed.hud.assetButtonsDisabled !== true || completedScore <= unlockedScore) {
    throw new Error(`active extraction beacon did not enter typed Victory: ${JSON.stringify({ yellowReady, extractionCycle, completed })}`);
  }
  await screenshot('victory-final-score');

  // Victory must ignore player movement, charge, shooting, collision feedback,
  // score, relay, and extraction mutation while its UI actions stay disabled.
  await holdKey('w', 240);
  await holdKey('c', 240);
  await holdKey('f');
  await page.waitForTimeout(500);
  const frozen = { snapshot: await readSnapshot(), render: await readRenderEvidence(), hud: await readHud() };
  if (!frozen.snapshot?.ok || frozen.snapshot.value.state?.phase !== 'Victory' || frozen.snapshot.value.state?.fixedTicks !== completed.snapshot.value.state?.fixedTicks || frozen.hud.score !== completed.hud.score || frozen.hud.mission !== completed.hud.mission || JSON.stringify(frozen.snapshot.value.counterattack) !== JSON.stringify(completed.snapshot.value.counterattack) || JSON.stringify(frozen.snapshot.value.targetRelay) !== JSON.stringify(completed.snapshot.value.targetRelay) || JSON.stringify(frozen.snapshot.value.extraction) !== JSON.stringify(completed.snapshot.value.extraction) || JSON.stringify(frozen.snapshot.value.rewardChoice) !== JSON.stringify(completed.snapshot.value.rewardChoice) || JSON.stringify(frozen.snapshot.value.targetHealth) !== JSON.stringify(completed.snapshot.value.targetHealth) || JSON.stringify(frozen.snapshot.value.targetDisabling) !== JSON.stringify(completed.snapshot.value.targetDisabling) || JSON.stringify(frozen.snapshot.value.hitStreak) !== JSON.stringify(completed.snapshot.value.hitStreak) || JSON.stringify(frozen.snapshot.value.healthPickup) !== JSON.stringify(completed.snapshot.value.healthPickup) || JSON.stringify(frozen.snapshot.value.projectiles) !== JSON.stringify(completed.snapshot.value.projectiles) || JSON.stringify(frozen.render?.deferredCommands) !== JSON.stringify(completed.render?.deferredCommands) || JSON.stringify(frozen.render?.characterController?.position) !== JSON.stringify(completed.render?.characterController?.position) || frozen.snapshot.value.videoTexture?.active !== 'video' || frozen.hud.chargeState !== completed.hud.chargeState) {
    throw new Error(`Victory did not freeze Play mutation: ${JSON.stringify({ completed, frozen })}`);
  }
  await screenshot('victory-frozen');

  await holdKey('r');
  await page.waitForFunction(async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.phase === 'Play', undefined, { timeout: 5_000, polling: 50 });
  const reset = { snapshot: await readSnapshot(), hud: await readHud() };
  const resetFont = reset.snapshot.value.worldScoreText;
  const resetFontColor = resetFont?.color ?? [];
  const resetPickup = reset.snapshot?.ok ? originalPickup(reset.snapshot.value) : undefined;
  if (!reset.snapshot?.ok || reset.snapshot.value.state?.phase !== 'Play' || reset.snapshot.value.state?.resetTransitions !== (baseline.snapshot.value.state?.resetTransitions ?? 0) + 1 || reset.snapshot.value.counterattack?.pressureTier !== baseline.snapshot.value.counterattack?.pressureTier || reset.snapshot.value.counterattack?.patrolSpeed !== baseline.snapshot.value.counterattack?.patrolSpeed || reset.snapshot.value.counterattack?.chaseSpeed !== baseline.snapshot.value.counterattack?.chaseSpeed || reset.snapshot.value.counterattack?.pursuitRadius !== baseline.snapshot.value.counterattack?.pursuitRadius || reset.snapshot.value.targetProfile?.active !== 'original' || reset.snapshot.value.targetProfile?.precisionHits !== 0 || reset.snapshot.value.targetProfile?.precisionComplete !== false || reset.snapshot.value.targetRelay?.status !== 'locked' || reset.snapshot.value.targetRelay?.currentStep !== 0 || reset.snapshot.value.targetRelay?.acceptedHits !== 0 || reset.snapshot.value.targetRelay?.rejectedHits !== 0 || reset.snapshot.value.extraction?.status !== 'locked' || reset.snapshot.value.extraction?.collected !== 0 || reset.snapshot.value.extraction?.collectedMask !== 0 || reset.snapshot.value.extraction?.refusedContacts !== 0 || reset.snapshot.value.extraction?.victoryRequests !== 0 || reset.snapshot.value.extraction?.cores?.length !== 3 || reset.snapshot.value.extraction.cores.some((core) => !core.available || !core.sensor || !core.physicsReady) || reset.snapshot.value.extraction?.beacon?.activeVisual !== false || reset.snapshot.value.rewardChoice?.state !== 'none' || reset.snapshot.value.rewardChoice?.selections !== 0 || reset.snapshot.value.rewardChoice?.shieldConsumptions !== 0 || reset.snapshot.value.rewardChoice?.overchargeConsumptions !== 0 || reset.snapshot.value.rewardChoice?.pedestals?.length !== 2 || reset.snapshot.value.rewardChoice.pedestals.some((pedestal) => !pedestal.physicsReady) || resetPickup?.available !== true || resetPickup.sensor !== true || resetPickup.physicsReady !== true || resetPickup.admittedCollections !== 0 || resetPickup.deferredDespawns !== 0 || reset.snapshot.value.videoTexture?.active !== 'original' || reset.snapshot.value.videoTexture?.hitReactions !== 0 || reset.snapshot.value.videoTexture?.lastHitPlayhead !== null || reset.snapshot.value.spriteAtlas?.active !== false || reset.snapshot.value.spriteAtlas?.animatedShots !== 0 || reset.snapshot.value.spriteAtlas?.animatedHits !== 0 || reset.snapshot.value.fbxSkinnedTarget?.companionActive !== false || reset.snapshot.value.fbxSkinnedTarget?.hitPulses !== 0 || reset.snapshot.value.visibility?.effective !== 'visible' || resetFont?.fontSource !== 'legacy-pack' || Math.abs((resetFont?.fontSize ?? 0) - 0.024) > 1e-5 || Math.abs((resetFontColor[0] ?? 0) - 1) > 1e-5 || Math.abs((resetFontColor[1] ?? 0) - 0.8) > 1e-5 || Math.abs((resetFontColor[2] ?? 0) - 0.2) > 1e-5 || reset.hud.score !== 'Score  0' || reset.hud.mission !== 'Mission 1/3 · Score 50 · 0/50' || reset.hud.missionPhase !== 'Play' || reset.hud.profileDisabled !== true || reset.hud.fbxButtonDisabled !== true || reset.hud.missionComplete !== 'false' || reset.hud.target !== 'TARGET · RedBox · 100/100 HP · +10') {
    throw new Error(`mission reset failed: ${JSON.stringify(reset)}`);
  }
  await screenshot('mission-reset');

  // Re-enter the exact player path and complete a second Victory, then replay
  // once more to prove that the transaction remains reusable.
  for (const [x, y] of authoredAimPoints) {
    if (Number.parseInt((await readHud()).score?.replace(/\D/g, '') ?? '0', 10) >= 50) break;
    await fireAt(x, y);
  }
  await hudHost().locator('[data-ui-action="target-profile"]').click();
  await page.waitForTimeout(250);
  for (const [x, y] of precisionAimPoints) {
    await fireAt(x, y);
    const attempt = await readSnapshot();
    if (attempt?.value?.targetRelay?.status === 'active') break;
  }
  await hitRelayTarget([[627, 297], [617, 297], [637, 297], [627, 287], [627, 307]], 0);
  await hitRelayTarget(precisionAimPoints, 1);
  await hitRelayTarget(yellowAimPoints, 2);
  const secondExtractionCycle = await completeExtraction('second', 'overcharge');
  await page.waitForFunction(async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.victoryTransitions === 2, undefined, { timeout: 5_000, polling: 50 });
  const secondVictory = { snapshot: await readSnapshot(), hud: await readHud() };
  const secondScore = Number.parseInt(secondVictory.hud.score?.replace(/\D/g, '') ?? '0', 10);
  if (!secondVictory.snapshot?.ok || secondVictory.snapshot.value.state?.phase !== 'Victory' || secondVictory.snapshot.value.targetRelay?.status !== 'complete' || secondVictory.snapshot.value.targetRelay?.acceptedHits !== 3 || secondVictory.snapshot.value.extraction?.collected !== 3 || secondVictory.snapshot.value.extraction?.victoryRequests !== 1 || secondVictory.hud.mission !== `Victory · Final score ${secondScore} · R to replay` || secondScore < 50) {
    throw new Error(`second player cycle did not re-enter Victory: ${JSON.stringify({ reset, secondExtractionCycle, secondVictory })}`);
  }
  await screenshot('victory-second-cycle');

  await holdKey('r');
  await page.waitForFunction(async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.phase === 'Play', undefined, { timeout: 5_000, polling: 50 });
  const secondReset = { snapshot: await readSnapshot(), hud: await readHud() };
  const secondResetPickup = secondReset.snapshot?.ok ? originalPickup(secondReset.snapshot.value) : undefined;
  if (!secondReset.snapshot?.ok || secondReset.snapshot.value.state?.resetTransitions !== (baseline.snapshot.value.state?.resetTransitions ?? 0) + 2 || secondReset.snapshot.value.counterattack?.pressureTier !== baseline.snapshot.value.counterattack?.pressureTier || secondReset.snapshot.value.counterattack?.patrolSpeed !== baseline.snapshot.value.counterattack?.patrolSpeed || secondReset.snapshot.value.counterattack?.chaseSpeed !== baseline.snapshot.value.counterattack?.chaseSpeed || secondReset.snapshot.value.counterattack?.pursuitRadius !== baseline.snapshot.value.counterattack?.pursuitRadius || secondReset.snapshot.value.targetRelay?.status !== 'locked' || secondReset.snapshot.value.extraction?.status !== 'locked' || secondReset.snapshot.value.extraction?.collected !== 0 || secondReset.snapshot.value.extraction?.cores?.some((core) => !core.available || !core.sensor || !core.physicsReady) || secondResetPickup?.available !== true || secondResetPickup.sensor !== true || secondResetPickup.physicsReady !== true || secondReset.hud.score !== 'Score  0' || secondReset.hud.mission !== 'Mission 1/3 · Score 50 · 0/50') {
    throw new Error(`second replay did not restore Play: ${JSON.stringify(secondReset)}`);
  }
  await screenshot('mission-second-reset');

  if (pageErrors.length > 0 || consoleErrors.length > 0 || badResponses.length > 0) throw new Error(`browser diagnostics failed: ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
  writeReport('passed', { baseline, lockedAttempt, firstHit, unlocked, profileActive, relayStarted, wrongTarget, redVariation, yellowReady, preparedVariations, extractionCycle, completed, frozen, reset, secondExtractionCycle, secondVictory, secondReset });
  console.log(`Mission progression smoke PASS (${MODE}): score=${unlockedScore} precision=hit relay=3/3 pressure=0>1>2>3 maxTierMotion=live reward=Shield+Overcharge-x5 extraction=3/3 victory=frozen replay=2x secondScore=${secondScore} reset=exact`);
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
