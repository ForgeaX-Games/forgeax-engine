#!/usr/bin/env node
// hello-debug-draw browser smoke: real createApp(canvas) auto-attach path.
// The normal case proves the runtime overlay reaches a live WebGPU canvas and
// survives a backing/CSS resize; the falsifier runs the same page with shape
// calls disabled and must read zero foreground pixels at both sizes.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ARTIFACT_DIR = resolve(HERE, '..', '.forgeax-debug', 'runtime-auto-attach');
const CANVAS_CLIP = { x: 0, y: 64, width: 256, height: 192 };
const RESIZED_CANVAS_CLIP = { x: 0, y: 64, width: 384, height: 192 };
const FOREGROUND_CHANNEL_MIN = 24;

mkdirSync(ARTIFACT_DIR, { recursive: true });

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-debug-draw', 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let portUrl;
viteProc.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(`[vite] ${text}`);
  portUrl ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1];
});
viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

function foregroundStats(path) {
  const image = PNG.sync.read(readFileSync(path));
  let foreground = 0;
  let maxChannel = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const channel = Math.max(image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0);
    if (channel >= FOREGROUND_CHANNEL_MIN) foreground++;
    maxChannel = Math.max(maxChannel, channel);
  }
  return { foreground, maxChannel, width: image.width, height: image.height };
}

async function runCase(browser, query, label) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(`${portUrl}/?mode=runtime${query}`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  await page.waitForFunction(
    () => document.querySelector('#debug-draw-hud')?.textContent?.includes('runtime'),
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(500);

  const path = resolve(ARTIFACT_DIR, `${label}.png`);
  await page.screenshot({ path, clip: CANVAS_CLIP });

  const resized = await page.evaluate(() => {
    const canvas = document.querySelector('#app');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Canvas #app not found');
    canvas.width = 384;
    canvas.height = 192;
    canvas.style.width = '384px';
    canvas.style.height = '192px';
    return { width: canvas.width, height: canvas.height };
  });
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('#app');
      return canvas instanceof HTMLCanvasElement && canvas.width === 384 && canvas.height === 192;
    },
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(500);

  const resizedPath = resolve(ARTIFACT_DIR, `${label}-resized.png`);
  await page.screenshot({ path: resizedPath, clip: RESIZED_CANVAS_CLIP });
  await page.close();

  if (pageErrors.length > 0) throw new Error(`${label} page errors: ${pageErrors.join(' | ')}`);
  if (consoleErrors.length > 0) throw new Error(`${label} console errors: ${consoleErrors.join(' | ')}`);
  return {
    path,
    stats: foregroundStats(path),
    resizedPath,
    resizedStats: foregroundStats(resizedPath),
    resized,
  };
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
    const normal = await runCase(browser, '', 'runtime');
    if (normal.stats.foreground < 100 || normal.stats.maxChannel < 128) {
      throw new Error(`runtime overlay produced too few foreground pixels: ${JSON.stringify(normal.stats)}`);
    }
    if (normal.resized.width !== 384 || normal.resized.height !== 192) {
      throw new Error(`resize did not apply to canvas: ${JSON.stringify(normal.resized)}`);
    }
    if (normal.resizedStats.foreground < 100 || normal.resizedStats.maxChannel < 128) {
      throw new Error(
        `resized runtime overlay produced too few foreground pixels: ${JSON.stringify(normal.resizedStats)}`,
      );
    }

    const falsified = await runCase(browser, '&falsify=1', 'runtime-falsified');
    if (falsified.stats.foreground !== 0 || falsified.resizedStats.foreground !== 0) {
      throw new Error(
        `falsified runtime overlay produced foreground pixels: ${JSON.stringify({
          initial: falsified.stats,
          resized: falsified.resizedStats,
        })}`,
      );
    }

    console.log(
      `[smoke-browser] artifacts: normal=${normal.path} normalResized=${normal.resizedPath} falsified=${falsified.path} falsifiedResized=${falsified.resizedPath}`,
    );
    console.log(
      `[smoke-browser] PASS - createApp(canvas) auto-attached app.debugDraw and survived live resize; normalForeground=${normal.stats.foreground}, normalResizedForeground=${normal.resizedStats.foreground}, falsifiedForeground=${falsified.stats.foreground}, falsifiedResizedForeground=${falsified.resizedStats.foreground}.`,
    );
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(`[smoke-browser] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  viteProc.kill('SIGTERM');
  await sleep(300);
}
