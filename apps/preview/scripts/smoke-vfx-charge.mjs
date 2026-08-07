#!/usr/bin/env node
// Focused game-default VFX composition proof. It exercises both authored Pack v2
// effects without depending on the broader inspection smoke's optional codec
// assertions.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_VFX_CHARGE_DIR ?? resolve(ROOT, '.forgeax-debug/vfx-charge'));
const PORT = Number.parseInt(process.env.FORGEAX_VFX_CHARGE_PORT ?? '5217', 10);
const MODE = process.env.FORGEAX_VFX_CHARGE_MODE ?? 'dev';
mkdirSync(ARTIFACT_DIR, { recursive: true });

const viteArgs = MODE === 'production'
  ? ['--filter', '@forgeax/preview', 'exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort']
  : ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'];
const server = spawn(
  'pnpm',
  viteArgs,
  { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
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

const readSnapshot = () => page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
const runAction = (id) => page.evaluate((actionId) => globalThis.__forgeaxPreviewInspection?.run(actionId), id);

let report;
try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/?game=game-default`, { waitUntil: 'networkidle', timeout: 2_000 });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`Preview did not boot: ${serverOutput}\n${String(error)}`);
      await sleep(250);
    }
  }
  await page.waitForTimeout(1_000);

  const catalog = await page.evaluate(async () => {
    const rows = await (await fetch('/pack-index.json')).json();
    return rows.filter((row) => row.guid === '019e9c00-0000-7000-8000-000000000010' || row.guid === '019e9c00-0000-7000-8000-000000000020');
  });
  if (catalog.length !== 2 || catalog.some((row) => row.kind !== 'particle-effect' || typeof row.packageUrl !== 'string')) {
    throw new Error(`VFX catalog rows failed: ${JSON.stringify(catalog)}`);
  }

  const before = await readSnapshot();
  const baseline = before?.value?.vfxHit;
  if (!before?.ok || baseline?.mode !== 'hit' || baseline?.guid !== '019e9c00-0000-7000-8000-000000000010' || baseline?.emitterCount !== 2 || baseline?.emitterStatuses?.some((status) => status !== 'ready')) {
    throw new Error(`VFX baseline failed: ${JSON.stringify(before)}`);
  }

  const chargeAction = await runAction('game-default.trigger-vfx-charge');
  await page.waitForTimeout(400);
  const afterCharge = await readSnapshot();
  const charge = afterCharge?.value?.vfxHit;
  const chargeKinds = charge?.batchKinds ?? [];
  if (!chargeAction?.ok || !afterCharge?.ok || charge?.mode !== 'charge' || charge?.guid !== '019e9c00-0000-7000-8000-000000000020' || charge?.playing !== true || charge?.seed !== 1 || charge?.triggers !== 1 || charge?.emitterCount !== 2 || charge?.emitterStatuses?.some((status) => status !== 'ready') || !chargeKinds.includes('billboard') || !chargeKinds.includes('mesh') || charge?.alive <= 0 || charge?.bucketCount !== 2 || charge?.readiness !== 'ready' || charge?.errorCode !== null) {
    throw new Error(`VFX charge failed: ${JSON.stringify({ chargeAction, afterCharge })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'charge-active.png') });

  const hitAction = await runAction('game-default.trigger-vfx-hit');
  await page.waitForTimeout(250);
  const afterHit = await readSnapshot();
  const hit = afterHit?.value?.vfxHit;
  if (!hitAction?.ok || !afterHit?.ok || hit?.mode !== 'hit' || hit?.guid !== '019e9c00-0000-7000-8000-000000000010' || hit?.seed !== 2 || hit?.triggers !== 2 || hit?.emitterStatuses?.some((status) => status !== 'ready') || hit?.errorCode !== null) {
    throw new Error(`VFX charge-to-hit switch failed: ${JSON.stringify({ hitAction, afterHit })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'hit-active.png') });

  const resetAction = await runAction('game-default.reset');
  await page.waitForTimeout(250);
  const afterReset = await readSnapshot();
  const reset = afterReset?.value?.vfxHit;
  if (!resetAction?.ok || !afterReset?.ok || reset?.mode !== 'hit' || reset?.guid !== '019e9c00-0000-7000-8000-000000000010' || reset?.playing !== false || reset?.seed !== 0 || reset?.triggers !== 0 || reset?.alive !== 0) {
    throw new Error(`VFX reset failed: ${JSON.stringify({ resetAction, afterReset })}`);
  }

  report = { mode: MODE, catalog, before, chargeAction, afterCharge, hitAction, afterHit, resetAction, afterReset, pageErrors, consoleErrors, badResponses, serverOutput };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  if (pageErrors.length > 0 || consoleErrors.length > 0 || badResponses.length > 0) throw new Error(`VFX browser diagnostics failed: ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
  console.log(`VFX charge smoke PASS (${MODE}): catalog=${catalog.length} chargeAlive=${charge.alive} chargeBuckets=${charge.bucketCount} resetAlive=${reset.alive}`);
} finally {
  await browser.close();
  if (server.pid !== undefined) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* process already exited */ }
  }
}
