#!/usr/bin/env node
// Real Chrome/WebGPU M3 live pipeline evidence for Learn Render 4.5.
// The page already owns the public installPipelineByKey, resize listener, and
// RHI-debug capture hook; this smoke drives those browser-visible surfaces.

import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeReferencePng } from '../../../../shared/png-codec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(APP_ROOT, '.forgeax-debug', 'm3-browser-live'),
);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const viteProc = spawn('pnpm', ['-F', '@forgeax/app-learn-render-4-advanced-opengl-5-framebuffers', 'dev'], {
  cwd: REPO_ROOT,
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let portUrl;
viteProc.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(`[vite] ${text}`);
  portUrl ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
});
viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

function decodePixels(base64) {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function pixelStats(pixels) {
  let nonBlack = 0;
  let maxChannel = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const max = Math.max(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0);
    if (max > 16) nonBlack++;
    maxChannel = Math.max(maxChannel, max);
  }
  return { nonBlack, maxChannel };
}

function changedPixels(before, after) {
  if (before.width !== after.width || before.height !== after.height) return null;
  let changed = 0;
  for (let i = 0; i < before.pixels.length; i += 4) {
    const delta = Math.abs((before.pixels[i] ?? 0) - (after.pixels[i] ?? 0))
      + Math.abs((before.pixels[i + 1] ?? 0) - (after.pixels[i + 1] ?? 0))
      + Math.abs((before.pixels[i + 2] ?? 0) - (after.pixels[i + 2] ?? 0));
    if (delta > 12) changed++;
  }
  return changed;
}

function writeCapturePng(label, capture) {
  const path = resolve(ARTIFACT_DIR, `${label}.png`);
  writeFileSync(path, writeReferencePng(capture.pixels, capture.width, capture.height));
  return path;
}

function resolveArtifact(path) {
  if (typeof path !== 'string') throw new Error('capture path is not a string');
  if (path.startsWith('/')) return path;
  const inApp = resolve(APP_ROOT, path);
  if (existsSync(inApp)) return inApp;
  return resolve(REPO_ROOT, path);
}

async function capture(page, label) {
  const result = await page.evaluate(async () => {
    const captureFrame = globalThis.__forgeax?.captureFrame;
    const readPixels = globalThis.__captureFramebuffers;
    if (typeof captureFrame !== 'function') throw new Error('window.__forgeax.captureFrame is unavailable');
    if (typeof readPixels !== 'function') throw new Error('window.__captureFramebuffers is unavailable');
    const tape = await captureFrame(1);
    const raw = await readPixels();
    const pixels = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    let binary = '';
    const chunk = 0x2000;
    for (let i = 0; i < pixels.length; i += chunk) {
      binary += String.fromCharCode(...pixels.subarray(i, i + chunk));
    }
    const canvas = document.querySelector('#app');
    return {
      tape,
      pixelsB64: btoa(binary),
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
      hud: document.querySelector('#hud')?.textContent ?? '',
    };
  });
  const pixels = decodePixels(result.pixelsB64);
  if (result.width <= 0 || result.height <= 0 || pixels.length !== result.width * result.height * 4) {
    throw new Error(`invalid ${label} capture dimensions: ${JSON.stringify(result)}`);
  }
  const value = {
    width: result.width,
    height: result.height,
    hud: result.hud,
    pixels,
    tape: result.tape,
  };
  const pngPath = writeCapturePng(label, value);
  return { ...value, pngPath, stats: pixelStats(pixels) };
}

try {
  const deadline = Date.now() + 30_000;
  while (!portUrl && Date.now() < deadline) await sleep(200);
  if (!portUrl) throw new Error('vite did not become ready in 30s');

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--ignore-gpu-blocklist',
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404')) consoleErrors.push(message.text());
    });

    await page.goto(`${portUrl}/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelector('#hud')?.textContent === 'passthrough'
        && (document.querySelector('#app')?.getAttribute('width') ?? '') !== '0',
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(500);

    const baseline = await capture(page, 'pipeline-passthrough');
    await page.keyboard.press('2');
    await page.waitForFunction(() => document.querySelector('#hud')?.textContent === 'inversion', undefined, { timeout: 10_000 });
    await page.waitForTimeout(500);
    const inversion = await capture(page, 'pipeline-inversion');

    await page.setViewportSize({ width: 640, height: 360 });
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector('#app');
        return canvas instanceof HTMLCanvasElement && canvas.width === 640 && canvas.height === 360;
      },
      undefined,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(500);
    const resized = await capture(page, 'pipeline-inversion-resized');

    await page.keyboard.press('6');
    await page.waitForFunction(() => document.querySelector('#hud')?.textContent === 'edge-detection', undefined, { timeout: 10_000 });
    await page.waitForTimeout(500);
    const edge = await capture(page, 'pipeline-edge-resized');

    const switchDelta = changedPixels(baseline, inversion);
    const edgeDelta = changedPixels(resized, edge);
    const tapePath = resolveArtifact(edge.tape?.tapePath);
    const reportPath = resolveArtifact(edge.tape?.reportPath);
    const rhiDir = resolve(ARTIFACT_DIR, 'rhi');
    mkdirSync(rhiDir, { recursive: true });
    const retainedTape = resolve(rhiDir, 'edge-frame.tape.bin');
    const retainedReport = resolve(rhiDir, 'edge-frame.report.json');
    copyFileSync(tapePath, retainedTape);
    copyFileSync(reportPath, retainedReport);

    const cliPath = resolve(REPO_ROOT, 'packages/rhi-debug/dist/cli.mjs');
    const summaryRaw = execFileSync('node', [cliPath, 'summary', retainedTape], { encoding: 'utf8' });
    const summary = JSON.parse(summaryRaw);
    const drawIdx = Math.max(0, (summary.draws?.length ?? 1) - 1);
    const inspectRaw = execFileSync('node', [cliPath, 'inspect-offline', retainedTape, String(drawIdx), '--fields=bindings,drawCall,rt'], { encoding: 'utf8' });
    const inspect = JSON.parse(inspectRaw);
    writeFileSync(resolve(rhiDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(resolve(rhiDir, 'inspect.json'), `${JSON.stringify(inspect, null, 2)}\n`);
    writeFileSync(resolve(ARTIFACT_DIR, 'browser-live.json'), `${JSON.stringify({
      baseline: { width: baseline.width, height: baseline.height, hud: baseline.hud, stats: baseline.stats },
      inversion: { width: inversion.width, height: inversion.height, hud: inversion.hud, stats: inversion.stats },
      resized: { width: resized.width, height: resized.height, hud: resized.hud, stats: resized.stats },
      edge: { width: edge.width, height: edge.height, hud: edge.hud, stats: edge.stats },
      switchDelta,
      edgeDelta,
      tape: retainedTape,
      report: retainedReport,
      draws: summary.draws?.length ?? 0,
      inspectedDraw: drawIdx,
    }, null, 2)}\n`);

    await page.close();
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    if (baseline.hud !== 'passthrough' || inversion.hud !== 'inversion' || edge.hud !== 'edge-detection') {
      throw new Error(`HUD did not track public pipeline switches: ${baseline.hud}, ${inversion.hud}, ${edge.hud}`);
    }
    if (switchDelta === null || switchDelta < 1000 || edgeDelta === null || edgeDelta < 1000) {
      throw new Error(`pipeline pixel deltas too small: switch=${switchDelta}, edge=${edgeDelta}`);
    }
    if (resized.width !== 640 || resized.height !== 360) throw new Error(`resize dimensions wrong: ${resized.width}x${resized.height}`);
    if (!Array.isArray(summary.draws) || summary.draws.length === 0 || inspect.drawCall === undefined) {
      throw new Error(`RHI inspect missing draw evidence: draws=${summary.draws?.length ?? 0}`);
    }
    console.log(`[m3-programmable] browser live artifacts: baseline=${baseline.pngPath} inversion=${inversion.pngPath} resized=${resized.pngPath} edge=${edge.pngPath}`);
    console.log(`[m3-programmable] browser live RHI: tape=${retainedTape} draws=${summary.draws.length} inspectedDraw=${drawIdx}`);
    console.log(`[m3-programmable] browser live pipeline: PASS switchChangedPixels=${switchDelta} edgeChangedPixels=${edgeDelta} resized=${resized.width}x${resized.height}`);
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(`[m3-programmable] browser live pipeline: FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  viteProc.kill('SIGTERM');
  await sleep(300);
}
