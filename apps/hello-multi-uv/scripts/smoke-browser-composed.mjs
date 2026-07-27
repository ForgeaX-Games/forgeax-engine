#!/usr/bin/env node
// M3 composed browser gate: drive the public custom RenderGraph, multi-UV
// material, texture, post-process, resize, and RHI selectors in one live scene.
// The falsifier keeps both material handles on one compiled variant.

import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(APP_ROOT, '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(APP_ROOT, '.forgeax-debug', 'm3-composed'),
);
mkdirSync(ARTIFACT_DIR, { recursive: true });

function decodePng(buffer) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const start = pos + 8;
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8];
      colorType = buffer[start + 9];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }
    pos = start + length + 4;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported screenshot PNG: bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let rawPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++];
    const rowStart = y * stride;
    const previousStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const source = raw[rawPos++];
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const above = y > 0 ? pixels[previousStart + x] : 0;
      const upperLeft = x >= channels && y > 0 ? pixels[previousStart + x - channels] : 0;
      let value;
      switch (filter) {
        case 0: value = source; break;
        case 1: value = source + left; break;
        case 2: value = source + above; break;
        case 3: value = source + ((left + above) >> 1); break;
        case 4: {
          const predictor = left + above - upperLeft;
          const pa = Math.abs(predictor - left);
          const pb = Math.abs(predictor - above);
          const pc = Math.abs(predictor - upperLeft);
          value = source + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft);
          break;
        }
        default: throw new Error(`unsupported PNG filter ${filter}`);
      }
      pixels[rowStart + x] = value & 0xff;
    }
  }
  return { width, height, pixels, channels };
}

function changedPixels(before, after) {
  if (before.width !== after.width || before.height !== after.height) return null;
  let changed = 0;
  const channels = Math.min(before.channels, after.channels);
  for (let i = 0; i < before.pixels.length; i += before.channels) {
    const delta = Math.abs((before.pixels[i] ?? 0) - (after.pixels[i] ?? 0))
      + Math.abs((before.pixels[i + 1] ?? 0) - (after.pixels[i + 1] ?? 0))
      + Math.abs((before.pixels[i + 2] ?? 0) - (after.pixels[i + 2] ?? 0));
    if (delta > 12) changed++;
  }
  return { changed, channels };
}

async function waitForVite(proc) {
  let portUrl;
  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`[vite] ${text}`);
    portUrl ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
  });
  proc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));
  const deadline = Date.now() + 30_000;
  while (!portUrl && Date.now() < deadline) await sleep(200);
  if (!portUrl) throw new Error('vite did not become ready in 30s');
  return portUrl;
}

async function select(page, id, value, status) {
  await page.selectOption(id, value);
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.textContent === expected,
    {
      selector: status,
      expected:
        id === '#pipeline-select'
          ? `M3_PIPELINE=${value}`
          : value === 'false'
            ? 'M3_MULTI_UV_VARIANT=false'
            : `M3_${id === '#post-select' ? 'POST_EFFECT' : 'MULTI_UV_VARIANT'}=${value}`,
    },
    { timeout: 10_000 },
  );
  await page.waitForTimeout(700);
}

async function capture(page, label) {
  const canvas = page.locator('#app');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error(`canvas bounding box missing for ${label}`);
  const pngPath = resolve(ARTIFACT_DIR, `${label}.png`);
  await page.locator('#variant-control, #pipeline-control, #post-control').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden';
  });
  let png;
  try {
    png = await page.screenshot({ path: pngPath, clip: box });
  } finally {
    await page.locator('#variant-control, #pipeline-control, #post-control').evaluateAll((elements) => {
      for (const element of elements) element.style.visibility = 'visible';
    });
  }
  const decoded = decodePng(png);
  const state = await page.evaluate(() => ({
    variant: document.querySelector('#variant-status')?.textContent ?? '',
    pipeline: document.querySelector('#pipeline-status')?.textContent ?? '',
    post: document.querySelector('#post-status')?.textContent ?? '',
    texture: document.querySelector('#texture-status')?.textContent ?? '',
    canvas: document.querySelector('#app') instanceof HTMLCanvasElement
      ? { width: document.querySelector('#app').width, height: document.querySelector('#app').height }
      : null,
  }));
  return { ...decoded, pngPath, state };
}

async function captureRhi(page, label) {
  const result = await page.evaluate(async () => {
    if (typeof globalThis.__forgeax?.captureFrame !== 'function') {
      throw new Error('window.__forgeax.captureFrame is unavailable');
    }
    return globalThis.__forgeax.captureFrame(1);
  });
  if (typeof result?.tapePath !== 'string' || typeof result?.reportPath !== 'string') {
    throw new Error(`RHI capture did not return tape/report paths: ${JSON.stringify(result)}`);
  }
  const resolveCapturePath = (path) => {
    if (path.startsWith('/')) return path;
    const appPath = resolve(APP_ROOT, path);
    return existsSync(appPath) ? appPath : resolve(REPO_ROOT, path);
  };
  const sourceTape = resolveCapturePath(result.tapePath);
  const sourceReport = resolveCapturePath(result.reportPath);
  const rhiDir = resolve(ARTIFACT_DIR, 'rhi');
  mkdirSync(rhiDir, { recursive: true });
  const tape = resolve(rhiDir, `${label}.tape.bin`);
  const report = resolve(rhiDir, `${label}.report.json`);
  copyFileSync(sourceTape, tape);
  copyFileSync(sourceReport, report);
  const cli = resolve(REPO_ROOT, 'packages/rhi-debug/dist/cli.mjs');
  const summary = JSON.parse(execFileSync('node', [cli, 'summary', tape], { encoding: 'utf8' }));
  const inspectedDraw = Math.max(0, (summary.draws?.length ?? 1) - 1);
  const inspect = JSON.parse(execFileSync('node', [cli, 'inspect-offline', tape, String(inspectedDraw), '--fields=bindings,drawCall,rt'], { encoding: 'utf8' }));
  writeFileSync(resolve(rhiDir, `${label}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(resolve(rhiDir, `${label}.inspect.json`), `${JSON.stringify(inspect, null, 2)}\n`);
  return { tape, report, draws: summary.draws?.length ?? 0, inspectedDraw, inspect };
}

const port = Number(process.env.FORGEAX_BROWSER_PORT ?? 55980) + Math.floor(Math.random() * 20);
const viteProc = spawn(process.execPath, [
  resolve(REPO_ROOT, 'node_modules/vite/bin/vite.js'),
  '--host', '127.0.0.1', '--port', String(port),
], {
  cwd: APP_ROOT,
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let browser;
try {
  const baseUrl = await waitForVite(viteProc);
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) consoleErrors.push(message.text());
  });

  await page.goto(`${baseUrl}/?pipeline=custom&variant=true`, { waitUntil: 'networkidle', timeout: 30_000 });
  try {
    await page.waitForFunction(
      () => document.querySelector('#variant-status')?.textContent === 'M3_MULTI_UV_VARIANT=true'
        && document.querySelector('#pipeline-status')?.textContent === 'M3_PIPELINE=custom'
        && document.querySelector('#post-status')?.textContent === 'M3_POST_EFFECT=passthrough',
      undefined,
      { timeout: 15_000 },
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      body: document.body.innerText,
      variant: document.querySelector('#variant-status')?.textContent ?? null,
      post: document.querySelector('#post-status')?.textContent ?? null,
      html: document.documentElement.outerHTML.slice(0, 1600),
    }));
    throw new Error(`${error instanceof Error ? error.message : String(error)} diagnostic=${JSON.stringify({ ...diagnostic, pageErrors, consoleErrors })}`);
  }
  await page.waitForTimeout(500);
  const liveBaseline = await capture(page, 'live-true-passthrough');
  await select(page, '#variant-select', 'false', '#variant-status');
  await select(page, '#post-select', 'inversion', '#post-status');
  const liveCombined = await capture(page, 'live-false-inversion');
  await select(page, '#post-select', 'passthrough', '#post-status');
  const livePostControl = await capture(page, 'live-false-passthrough');
  const variantDelta = changedPixels(liveBaseline, liveCombined);
  const postDelta = changedPixels(livePostControl, liveCombined);

  await page.setViewportSize({ width: 640, height: 360 });
  await page.waitForFunction(
    () => document.querySelector('#app') instanceof HTMLCanvasElement
      && document.querySelector('#app').width === 640
      && document.querySelector('#app').height === 360,
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(400);
  await select(page, '#post-select', 'inversion', '#post-status');
  const liveResized = await capture(page, 'live-resized-inversion');
  const rhi = await captureRhi(page, 'live-resized-inversion');

  await page.goto(`${baseUrl}/?pipeline=custom&falsify=constant`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector('#variant-status')?.textContent === 'M3_MULTI_UV_VARIANT=true'
      && document.querySelector('#pipeline-status')?.textContent === 'M3_PIPELINE=custom',
    undefined,
    { timeout: 15_000 },
  );
  await select(page, '#post-select', 'inversion', '#post-status');
  const falsifiedTrue = await capture(page, 'falsified-true-inversion');
  await select(page, '#variant-select', 'false', '#variant-status');
  const falsifiedFalse = await capture(page, 'falsified-false-inversion');
  const falsifiedVariantDelta = changedPixels(falsifiedTrue, falsifiedFalse);

  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${baseUrl}/?pipeline=custom&falsify-texture`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector('#variant-status')?.textContent === 'M3_MULTI_UV_VARIANT=true'
      && document.querySelector('#pipeline-status')?.textContent === 'M3_PIPELINE=custom'
      && document.querySelector('#texture-status')?.textContent === 'M3_TEXTURE_BINDING=baseColorTexture+detailTexture',
    undefined,
    { timeout: 15_000 },
  );
  await select(page, '#variant-select', 'false', '#variant-status');
  await select(page, '#post-select', 'inversion', '#post-status');
  const textureFalsified = await capture(page, 'falsified-second-texture-inversion');
  const secondTextureDelta = changedPixels(liveCombined, textureFalsified);

  writeFileSync(resolve(ARTIFACT_DIR, 'browser-composed.json'), `${JSON.stringify({
    live: {
      variantDelta,
      postDelta,
      baseline: { state: liveBaseline.state, png: liveBaseline.pngPath },
      combined: { state: liveCombined.state, png: liveCombined.pngPath },
      resized: { state: liveResized.state, png: liveResized.pngPath },
    },
    falsifier: {
      variantDelta: falsifiedVariantDelta,
      true: falsifiedTrue.state,
      false: falsifiedFalse.state,
      secondTextureDelta,
      secondTexture: textureFalsified.state,
    },
    rhi: { tape: rhi.tape, report: rhi.report, draws: rhi.draws, inspectedDraw: rhi.inspectedDraw },
  }, null, 2)}\n`);

  await page.close();
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
  if (variantDelta === null || variantDelta.changed < 1000) throw new Error(`combined variant delta too small: ${JSON.stringify(variantDelta)}`);
  if (postDelta === null || postDelta.changed < 1000) throw new Error(`post-process delta too small: ${JSON.stringify(postDelta)}`);
  if (liveCombined.state.pipeline !== 'M3_PIPELINE=custom' || liveResized.state.pipeline !== 'M3_PIPELINE=custom') throw new Error('combined post effect left the custom pipeline');
  if (falsifiedVariantDelta === null || falsifiedVariantDelta.changed >= 100) throw new Error(`falsifier did not kill variant delta: ${JSON.stringify(falsifiedVariantDelta)}`);
  if (secondTextureDelta === null || secondTextureDelta.changed < 1000) throw new Error(`second-texture falsifier did not change pixels: ${JSON.stringify(secondTextureDelta)}`);
  if (liveResized.width !== 640 || liveResized.height !== 360) throw new Error(`resize dimensions wrong: ${liveResized.width}x${liveResized.height}`);
  if (rhi.draws === 0 || rhi.inspect?.drawCall === undefined) throw new Error(`RHI draw evidence missing: ${JSON.stringify(rhi)}`);
  console.log(`[m3-composed] PASS pipeline=custom variantChanged=${variantDelta.changed} postChanged=${postDelta.changed} falsifiedVariantChanged=${falsifiedVariantDelta.changed} secondTextureChanged=${secondTextureDelta.changed} resized=${liveResized.width}x${liveResized.height} draws=${rhi.draws} artifacts=${ARTIFACT_DIR}`);
} catch (error) {
  console.error(`[m3-composed] FAIL - ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  viteProc.kill('SIGTERM');
  await sleep(300);
  await browser?.close();
}
