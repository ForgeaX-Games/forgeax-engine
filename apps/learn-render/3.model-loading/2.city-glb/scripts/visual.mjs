#!/usr/bin/env node
// Playwright visual sentinel for the city-glb dev-path render.
// Launches chrome-beta with WebGPU (swiftshader) flags, spawns the vite dev
// server, waits for window.__citySceneReady, and screenshots to ./screenshot.png.
//
// Usage:
//   node scripts/visual.mjs [outfile.png]

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO_ROOT = resolve(HERE, '..');
const OUT_PNG = resolve(DEMO_ROOT, process.argv[2] ?? 'screenshot.png');
const DEV_PORT = 5184;
const DEV_URL = `http://127.0.0.1:${DEV_PORT}`;
const READY_TIMEOUT_MS = 420_000;
const VIEWPORT_W = 1280;
const VIEWPORT_H = 720;

async function main() {
  mkdirSync(dirname(OUT_PNG), { recursive: true });

  const devProc = spawnDev();

  const { default: waitOn } = await import('wait-on');
  try {
    await waitOn({ resources: [`tcp:127.0.0.1:${DEV_PORT}`], timeout: 60_000 });
  } catch (_err) {
    devProc.kill('SIGTERM');
    console.error('[visual] FAIL - dev server did not start within 60s');
    process.exit(1);
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome-beta',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--disable-vulkan-surface',
      '--ignore-gpu-blocklist',
    ],
  });

  let exitCode = 0;
  try {
    const ctx = await browser.newContext({ viewport: { width: VIEWPORT_W, height: VIEWPORT_H } });
    const page = await ctx.newPage();

    page.on('console', (msg) => {
      process.stderr.write(`[console.${msg.type()}] ${msg.text()}\n`);
    });
    page.on('pageerror', (err) => {
      process.stderr.write(`[pageerror] ${err.message}\n`);
    });

    page.setDefaultTimeout(READY_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(READY_TIMEOUT_MS);
    await page.goto(DEV_URL, { waitUntil: 'commit' });
    await page.waitForFunction('window.__citySceneReady === true', { timeout: READY_TIMEOUT_MS });
    // Extra frames for on-demand texture import + GPU warm-up.
    await page.waitForTimeout(6000);

    await page.screenshot({ path: OUT_PNG, fullPage: false });
    const png = readFileSync(OUT_PNG);
    console.warn(`[visual] screenshot -> ${OUT_PNG} (${png.length} bytes)`);
    if (png.length < 20_000) {
      console.error(`[visual] WARN - PNG ${png.length} bytes (likely blank canvas)`);
    }
  } catch (err) {
    console.error('[visual] FAIL -', err instanceof Error ? err.message : String(err));
    exitCode = 1;
  } finally {
    await browser.close();
    devProc.kill('SIGTERM');
    setTimeout(() => {
      if (devProc.exitCode === null) devProc.kill('SIGKILL');
    }, 3000);
  }

  process.exit(exitCode);
}

function spawnDev() {
  const child = spawn('npx', ['vite', '--port', String(DEV_PORT), '--host', '127.0.0.1'], {
    cwd: DEMO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));
  return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
