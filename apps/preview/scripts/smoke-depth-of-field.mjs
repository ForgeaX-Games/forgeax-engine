#!/usr/bin/env node
// Focused browser proof for the game-default depth-aware post-process.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_DOF_DIR ?? resolve(ROOT, 'templates/game-default/.forgeax-debug/depth-of-field'));
const PORT = Number.parseInt(process.env.FORGEAX_DOF_PORT ?? '5199', 10);
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
const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
const notFound = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('response', (response) => { if (response.status() === 404) notFound.push(response.url()); });

try {
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
  const snapshot = async (name) => {
    const path = resolve(ARTIFACT_DIR, `${name}.png`);
    await page.screenshot({ path });
    return { path, png: PNG.sync.read(readFileSync(path)) };
  };
  const readEvidence = () => page.evaluate(() => {
    const value = globalThis.__forgeaxGameDefaultRenderEvidence;
    if (!value) throw new Error('render-evidence handle was not installed');
    return value.snapshot();
  });
  const baseline = await readEvidence();
  const off = await snapshot('off');
  const enabled = await page.evaluate(() => {
    const value = globalThis.__forgeaxGameDefaultRenderEvidence;
    value.toggleDepthOfField();
    return value.snapshot();
  });
  await page.waitForTimeout(500);
  const on = await snapshot('on');
  // A second fresh page keeps the pixel oracle isolated from Chrome's
  // screenshot/device lifecycle and proves reset on the actual reset owner.
  const semanticPage = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  await semanticPage.goto(`http://127.0.0.1:${PORT}/?render-evidence=1`, { waitUntil: 'networkidle' });
  await semanticPage.waitForTimeout(1_500);
  const reset = await semanticPage.evaluate(() => {
    const value = globalThis.__forgeaxGameDefaultRenderEvidence;
    value.toggleDepthOfField();
    value.reset();
    return value.snapshot();
  });
  await semanticPage.close();
  const delta = pixelmatch(off.png.data, on.png.data, undefined, off.png.width, off.png.height, { threshold: 0.1 });
  const report = {
    oracle: 'public PostProcessParams toggle changes the real Preview compositor and reset restores the off state',
    semantic: { baseline: baseline.depthOfField, enabled: enabled.depthOfField, reset: reset.depthOfField },
    pixel: { changedPixels: delta },
    artifacts: { off: off.path, on: on.path },
    pageErrors,
    consoleErrors,
    notFound,
  };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (baseline.depthOfField.enabled || baseline.depthOfField.mode !== 'off') throw new Error(`baseline DoF state was not off: ${JSON.stringify(baseline.depthOfField)}`);
  if (!enabled.depthOfField.enabled || enabled.depthOfField.mode !== 'bokeh') throw new Error(`DoF enable transition failed: ${JSON.stringify(enabled.depthOfField)}`);
  if (reset.depthOfField.enabled || reset.depthOfField.mode !== 'off') throw new Error(`DoF reset transition failed: ${JSON.stringify(reset.depthOfField)}`);
  if (delta < 20) throw new Error(`DoF changed only ${delta} compositor pixels`);
  const unexpectedConsoleErrors = consoleErrors.filter((line) => !line.includes('Failed to load resource'));
  if (unexpectedConsoleErrors.length > 0) throw new Error(`console errors: ${unexpectedConsoleErrors.join(' | ')}`);
  if (notFound.some((url) => !url.includes('/__import/') && !url.includes('/__forgeax-ddc/'))) throw new Error(`unexpected 404 responses: ${notFound.join(' | ')}`);
  console.log(`[depth-of-field] PASS changedPixels=${delta} artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await sleep(300);
}
