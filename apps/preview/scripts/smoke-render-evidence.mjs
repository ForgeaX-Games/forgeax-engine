#!/usr/bin/env node
// game-default render-evidence smoke.
//
// The browser is the visual oracle for WebGPU canvas output: a 2D drawImage
// readback is deliberately not used because it returns black for an opaque
// WebGPU canvas. The query-gated evidence handle is only installed when the
// URL contains `render-evidence`, so the normal preview surface stays clean.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_RENDER_EVIDENCE_DIR ?? resolve(ROOT, 'templates/game-default/.forgeax-debug/render-evidence'),
);
const PORT = Number.parseInt(process.env.FORGEAX_RENDER_EVIDENCE_PORT ?? '5187', 10);
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
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

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

async function snapshot(name) {
  const path = resolve(ARTIFACT_DIR, `${name}.png`);
  await page.screenshot({ path });
  const png = PNG.sync.read(readFileSync(path));
  return { path, width: png.width, height: png.height, data: png.data };
}

const evidence = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  if (!value) throw new Error('render-evidence handle was not installed');
  return value.snapshot();
});
const baseline = await snapshot('baseline');

const flashBefore = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  value.triggerFlash();
  return value.snapshot();
});
await page.waitForTimeout(60);
const flash = await snapshot('hit-flash');

await page.keyboard.press('r');
await page.waitForTimeout(250);
const resetState = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
const reset = await snapshot('reset');

const recovery = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  let invalidError = '';
  try {
    value.renderer.shader.registerMaterialShader(value.shaderId, { source: value.shaderSource, paramSchema: [] });
  } catch (error) {
    invalidError = error instanceof Error ? error.message : String(error);
  }
  value.renderer.shader.registerMaterialShader('game_default::recovery_probe', {
    source: value.shaderSource,
    paramSchema: [{ name: 'baseColor', type: 'color' }, { name: 'intensity', type: 'f32' }],
  });
  value.triggerFlash();
  return {
    invalidError,
    recovered: value.snapshot().materialShaderIdentifiers.includes('game_default::recovery_probe'),
    afterRecovery: value.snapshot(),
    renderWitness: {
      backend: value.renderer.backend,
      passNames: [...value.renderer.perFramePassNames],
      shaderIds: value.snapshot().materialShaderIdentifiers,
    },
  };
});

const changedPixels = (a, b) => pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.1 });
const flashDelta = changedPixels(baseline, flash);
const resetDelta = changedPixels(baseline, reset);
const report = {
  oracle: 'baseline -> hit-flash changes compositor pixels; R reset returns the baseline; recovery re-triggers the same flash without reload',
  artifacts: { baseline: baseline.path, flash: flash.path, reset: reset.path },
  semantic: { evidence, flashBefore, resetState },
  pixel: { flashDelta, resetDelta },
  recovery,
  pageErrors,
  consoleErrors: consoleErrors.filter((line) => !line.includes('favicon')),
};
writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

try {
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (report.consoleErrors.length > 0) throw new Error(`console errors: ${report.consoleErrors.join(' | ')}`);
  if (evidence.materialShaderIdentifiers?.includes?.('game_default::hit_flash') !== true) throw new Error('hit-flash shader was not registered');
  if (flashBefore.activeFlashCount !== 1 || resetState.activeFlashCount !== 0) throw new Error(`semantic transition failed: ${JSON.stringify({ flashBefore, resetState })}`);
  if (flashDelta < 20) throw new Error(`hit-flash changed only ${flashDelta} pixels`);
  if (resetDelta > 500) throw new Error(`reset drifted ${resetDelta} pixels from baseline`);
  if (recovery.invalidError.length === 0 || recovery.recovered !== true || recovery.afterRecovery.activeFlashCount !== 1) throw new Error(`invalid registration did not recover: ${JSON.stringify(recovery)}`);
  console.log(`[render-evidence] PASS flashDelta=${flashDelta} resetDelta=${resetDelta} invalidRegistration=recovered`);
  console.log(`[render-evidence] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await sleep(300);
}
