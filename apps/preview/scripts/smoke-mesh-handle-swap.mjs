#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_MESH_HANDLE_DIR ?? resolve(ROOT, 'templates/game-default/.forgeax-debug/mesh-handle-swap'));
const PORT = Number.parseInt(process.env.FORGEAX_MESH_HANDLE_PORT ?? '5190', 10);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const server = spawn('pnpm', ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    await page.goto(`http://127.0.0.1:${PORT}/?render-evidence=1`, { waitUntil: 'networkidle', timeout: 2_000 });
    break;
  } catch (error) {
    if (Date.now() >= deadline) throw new Error(`preview did not boot: ${serverOutput}\n${String(error)}`);
    await sleep(250);
  }
}
await page.waitForTimeout(2_000);
const before = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence?.snapshot());
if (!before?.meshHandleSwap?.available || before.meshHandleSwap.active !== 'original') throw new Error(`mesh handle witness unavailable: ${JSON.stringify(before?.meshHandleSwap)} errors=${JSON.stringify(pageErrors)} server=${serverOutput}`);
await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence?.toggleMeshHandleSwap?.());
await page.waitForTimeout(180);
const toggled = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
if (toggled.meshHandleSwap.active !== 'alternate' || toggled.meshHandleSwap.swaps !== before.meshHandleSwap.swaps + 1) throw new Error(`mesh handle toggle failed: ${JSON.stringify({ before: before.meshHandleSwap, toggled: toggled.meshHandleSwap })}`);
await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.reset());
await page.waitForTimeout(180);
const reset = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
if (reset.meshHandleSwap.active !== 'original') throw new Error(`mesh handle reset failed: ${JSON.stringify(reset.meshHandleSwap)}`);
if (!before.fbxMeshSwap?.available || before.fbxMeshSwap.active !== 'original') throw new Error(`FBX mesh witness unavailable: ${JSON.stringify(before.fbxMeshSwap)} errors=${JSON.stringify(pageErrors)} server=${serverOutput}`);
await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.toggleFbxMeshSwap?.());
await page.waitForTimeout(180);
const fbxToggled = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
if (fbxToggled.fbxMeshSwap.active !== 'fbx' || fbxToggled.fbxMeshSwap.swaps !== before.fbxMeshSwap.swaps + 1) throw new Error(`FBX mesh toggle failed: ${JSON.stringify({ before: before.fbxMeshSwap, toggled: fbxToggled.fbxMeshSwap })}`);
await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.reset());
await page.waitForTimeout(180);
const fbxReset = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
if (fbxReset.fbxMeshSwap.active !== 'original') throw new Error(`FBX mesh reset failed: ${JSON.stringify(fbxReset.fbxMeshSwap)}`);
const report = { before: before.meshHandleSwap, toggled: toggled.meshHandleSwap, reset: reset.meshHandleSwap, fbxBefore: before.fbxMeshSwap, fbxToggled: fbxToggled.fbxMeshSwap, fbxReset: fbxReset.fbxMeshSwap, pageErrors, serverOutput };
writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
if (pageErrors.length > 0) throw new Error(pageErrors.join(' | '));
console.log(`[mesh-handle-swap] PASS builtin=${before.meshHandleSwap.active}->${toggled.meshHandleSwap.active}->${reset.meshHandleSwap.active} fbx=${before.fbxMeshSwap.active}->${fbxToggled.fbxMeshSwap.active}->${fbxReset.fbxMeshSwap.active}`);
console.log(`[mesh-handle-swap] artifacts=${ARTIFACT_DIR}`);
await browser.close();
server.kill('SIGTERM');
