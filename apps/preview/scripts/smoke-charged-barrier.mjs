#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const MODE = process.env.FORGEAX_CHARGED_BARRIER_MODE ?? 'dev';
const PORT = Number.parseInt(process.env.FORGEAX_CHARGED_BARRIER_PORT ?? '5243', 10);
const ARTIFACT_DIR = resolve(process.env.FORGEAX_CHARGED_BARRIER_DIR ?? resolve(ROOT, `.forgeax-debug/charged-barrier-${MODE}`));
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
const cycles = [];
let browser;
let page;

const hudHost = () => page.locator('[data-ui-asset]').filter({ has: page.locator('[data-ui-slot="mission"]') }).first();
const readScore = async () => Number.parseInt(
  (await hudHost().locator('[data-ui-slot="score"]').textContent())?.replace(/\D/g, '') ?? '0',
  10,
);
const readSnapshot = async () => {
  const result = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
  if (!result?.ok) throw new Error(`snapshot unavailable: ${JSON.stringify(result)}`);
  return result.value;
};
const holdKey = async (key, duration) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(duration);
  await page.keyboard.up(key);
};
const waitForSnapshot = async (predicate, label, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await readSnapshot();
    if (predicate(latest)) return latest;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(latest)}`);
};
const reset = async () => {
  await holdKey('r', 120);
  await page.waitForFunction(
    async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.phase === 'Play',
    undefined,
    { timeout: 5_000, polling: 50 },
  );
  await page.waitForTimeout(300);
  return readSnapshot();
};
const screenshot = (name) => page.screenshot({ path: resolve(ARTIFACT_DIR, `${name}.png`) });

function assertDormant(snapshot, label) {
  const barrier = snapshot.barrierRoute;
  if (snapshot.state.phase !== 'Play'
    || snapshot.targetRelay.status !== 'locked'
    || barrier.emitterLocalId !== 33 || barrier.barrierLocalId !== 34
    || barrier.active || barrier.activeVisual || barrier.damagingContact || barrier.physicsReady
    || barrier.opens !== 0 || barrier.ordinaryHits !== 0 || barrier.alreadyOpenHits !== 0
    || barrier.acceptedDamageHits !== 0 || barrier.damageCooldown !== 0) {
    throw new Error(`${label} did not restore the authored dormant route: ${JSON.stringify(snapshot)}`);
  }
}

function assertActive(snapshot, label) {
  const barrier = snapshot.barrierRoute;
  if (snapshot.state.phase !== 'Play'
    || barrier.emitterLocalId !== 33 || barrier.barrierLocalId !== 34
    || !barrier.active || !barrier.activeVisual || !barrier.damagingContact || !barrier.physicsReady
    || barrier.opens !== 0 || barrier.ordinaryHits !== 0 || barrier.alreadyOpenHits !== 0
    || barrier.acceptedDamageHits !== 0 || barrier.damageCooldown !== 0) {
    throw new Error(`${label} did not restore the authored active route: ${JSON.stringify(snapshot)}`);
  }
}

async function unlockBarrier(label) {
  const fireAt = async (point) => {
    await page.mouse.click(point[0], point[1]);
    await page.waitForTimeout(260);
  };
  const authoredAimPoints = [
    [304, 379],
    [659, 208], [649, 208], [669, 208],
    [640, 176], [630, 176], [650, 176], [640, 166], [640, 186],
  ];
  for (const point of authoredAimPoints) {
    if (await readScore() >= 50) break;
    await fireAt(point);
  }
  if (await readScore() < 50) throw new Error(`${label} real score unlock failed: ${JSON.stringify(await readSnapshot())}`);
  await hudHost().locator('[data-ui-action="target-profile"]').evaluate(
    (button) => (button instanceof HTMLButtonElement ? button.click() : undefined),
  );
  await page.waitForTimeout(350);

  const precisionAimPoints = [
    [566, 214], [550, 204], [566, 204], [582, 204], [550, 214],
    [582, 214], [550, 224], [566, 224], [582, 224],
  ];
  for (const point of precisionAimPoints) {
    await fireAt(point);
    if ((await readSnapshot()).targetRelay.status === 'active') break;
  }
  const hitRelayTarget = async (points, acceptedBefore) => {
    for (let pass = 0; pass < 3; pass++) {
      for (const point of points) {
        await fireAt(point);
        if ((await readSnapshot()).targetRelay.acceptedHits > acceptedBefore) return;
      }
    }
    throw new Error(`${label} relay hit ${acceptedBefore + 1} failed: ${JSON.stringify(await readSnapshot())}`);
  };
  await hitRelayTarget([[627, 297], [617, 297], [637, 297], [627, 287], [627, 307]], 0);
  await hitRelayTarget(precisionAimPoints, 1);
  await hitRelayTarget([
    [520, 420], [540, 420], [500, 420], [520, 400], [520, 440],
    [556, 339], [546, 339], [566, 339], [556, 329], [556, 349],
  ], 2);
  await drivePlayerTo([0, 0], `${label} emitter aim baseline`);
  return waitForSnapshot(
    (snapshot) => snapshot.targetRelay.status === 'complete' && snapshot.barrierRoute.physicsReady === true,
    `${label} relay-complete barrier activation`,
  );
}

async function prepareActive(label) {
  const dormant = await reset();
  assertDormant(dormant, `${label} dormant baseline`);
  await page.mouse.click(304, 379);
  await page.keyboard.down('f');
  try {
    await waitForSnapshot(
      (snapshot) => snapshot.counterattack.hazardMode === 'disabled',
      `${label} real BouncyBall neutralization`,
      5_000,
    );
  } finally {
    await page.keyboard.up('f');
  }
  const active = await unlockBarrier(label);
  assertActive(active, `${label} active route`);
  return { dormant, active };
}

async function findEmitterAim(cycle) {
  const points = [
    [365, 233], [355, 233], [375, 233], [365, 223], [365, 243],
    [345, 213], [385, 213], [345, 253], [385, 253],
  ];
  for (const point of points) {
    await page.mouse.click(point[0], point[1]);
    await page.waitForTimeout(340);
    const snapshot = await readSnapshot();
    if (snapshot.barrierRoute.ordinaryHits > 0) return { point, snapshot };
  }
  throw new Error(`cycle ${cycle} could not hit the authored emitter: ${JSON.stringify(await readSnapshot())}`);
}

async function drivePlayerTo(target, label, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot();
    const position = snapshot.counterattack.playerPosition;
    if (snapshot.barrierRoute.acceptedDamageHits > 0 || snapshot.state.phase !== 'Play') return snapshot;
    const dx = target[0] - position[0];
    const dz = target[1] - position[2];
    if (Math.hypot(dx, dz) <= 0.14) return snapshot;
    const keys = [];
    if (dx < -0.16) keys.push('a');
    if (dx > 0.16) keys.push('d');
    if (dz < -0.16) keys.push('w');
    if (dz > 0.16) keys.push('s');
    for (const key of keys) await page.keyboard.down(key);
    await page.waitForTimeout(80);
    for (const key of keys) await page.keyboard.up(key);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(await readSnapshot())}`);
}

async function chargedImpact(point) {
  await page.keyboard.down('c');
  await page.waitForTimeout(900);
  await page.mouse.click(point[0], point[1]);
  await page.waitForTimeout(80);
  await page.keyboard.up('c');
}

async function runCycle(cycle) {
  await prepareActive(`cycle ${cycle} ordinary`);
  const normal = await findEmitterAim(cycle);
  if (!normal.snapshot.barrierRoute.active || normal.snapshot.barrierRoute.opens !== 0) {
    throw new Error(`cycle ${cycle} ordinary projectile opened the barrier: ${JSON.stringify(normal.snapshot)}`);
  }
  await screenshot(`${cycle}-ordinary-refused`);

  const contactBaseline = await prepareActive(`cycle ${cycle} contact`);
  const healthBeforeContact = contactBaseline.active.counterattack.playerHealth;
  await drivePlayerTo([-2.5, -1.5], `cycle ${cycle} real barrier contact`);
  const damaged = await waitForSnapshot(
    (snapshot) => snapshot.barrierRoute.acceptedDamageHits === 1,
    `cycle ${cycle} admitted barrier damage`,
  );
  if (damaged.counterattack.playerHealth !== healthBeforeContact - 1 || damaged.barrierRoute.damageCooldown <= 0) {
    throw new Error(`cycle ${cycle} barrier did not use shared one-heart damage admission: ${JSON.stringify(damaged)}`);
  }
  await page.waitForTimeout(350);
  const cooldown = await readSnapshot();
  if (cooldown.counterattack.playerHealth !== healthBeforeContact - 1 || cooldown.barrierRoute.acceptedDamageHits !== 1 || cooldown.barrierRoute.damageCooldown <= 0) {
    throw new Error(`cycle ${cycle} repeated barrier contact escaped shared cooldown: ${JSON.stringify(cooldown)}`);
  }
  await screenshot(`${cycle}-reckless-contact`);

  await prepareActive(`cycle ${cycle} charged`);
  await chargedImpact(normal.point);
  const opened = await waitForSnapshot(
    (snapshot) => snapshot.barrierRoute.opens === 1 && snapshot.barrierRoute.active === false,
    `cycle ${cycle} charged opening`,
  );
  if (opened.barrierRoute.activeVisual || opened.barrierRoute.damagingContact || opened.barrierRoute.physicsReady) {
    throw new Error(`cycle ${cycle} opening did not remove visual and contact together: ${JSON.stringify(opened)}`);
  }
  await screenshot(`${cycle}-charged-open`);

  await chargedImpact(normal.point);
  const duplicate = await waitForSnapshot(
    (snapshot) => snapshot.barrierRoute.alreadyOpenHits === 1,
    `cycle ${cycle} duplicate charged refusal`,
  );
  if (duplicate.barrierRoute.opens !== 1 || duplicate.barrierRoute.active) {
    throw new Error(`cycle ${cycle} duplicate charged hit changed the opened route: ${JSON.stringify(duplicate)}`);
  }

  const restored = await reset();
  assertDormant(restored, `cycle ${cycle} replay`);
  cycles.push({ cycle, aim: normal.point, normal: normal.snapshot, damaged, cooldown, opened, duplicate, restored });
}

function writeReport(status, extra = {}) {
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({ status, mode: MODE, cycles, ...extra, pageErrors, consoleErrors, badResponses, serverOutput }, null, 2)}\n`);
}

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${ORIGIN}/`)).ok) break; } catch { /* Vite is starting. */ }
    await sleep(250);
  }
  if (Date.now() >= deadline) throw new Error(`Preview server did not start: ${serverOutput}`);
  browser = await chromium.launch({
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--use-vulkan=swiftshader', '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--disable-gpu-driver-bug-workarounds', '--disable-dawn-features=disallow_unsafe_apis', '--autoplay-policy=no-user-gesture-required'],
  });
  page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`${message.text()} @ ${message.location().url}`); });
  page.on('response', (response) => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) badResponses.push(`${response.status()} ${response.url()}`); });
  await page.goto(`${ORIGIN}/?game=game-default`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'game-default.snapshot') ?? false, undefined, { timeout: 60_000, polling: 100 });
  await page.waitForFunction(async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.phase === 'Play', undefined, { timeout: 60_000, polling: 100 });
  await page.waitForTimeout(500);
  await runCycle(1);
  await runCycle(2);
  const rendererHealth = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.renderer.health());
  if (rendererHealth?.reason !== 'alive') {
    throw new Error(`renderer health failed: ${JSON.stringify(rendererHealth)}`);
  }
  if (pageErrors.length > 0 || consoleErrors.length > 0 || badResponses.length > 0) {
    throw new Error(`browser diagnostics failed: ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
  }
  writeReport('passed', { rendererHealth });
  console.log(`Charged barrier smoke PASS (${MODE}): ordinary refusal, real contact/cooldown, charged open, duplicate refusal, two resets`);
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
