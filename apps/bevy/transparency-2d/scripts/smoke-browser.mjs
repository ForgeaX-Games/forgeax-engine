#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = Number(process.env.PORT ?? 5174);
const vite = spawn('pnpm', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
try {
  await delay(1000);
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(`console: ${message.text()}`); });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  try {
    await page.waitForFunction(() => globalThis.__bevyTransparency2dReady === true, null, { timeout: 30000 });
  } catch (error) {
    console.error(`[smoke-browser] ready timeout; diagnostics=${errors.join(' | ') || 'none'}`);
    throw error;
  }
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'artifacts/transparency-2d-browser.png' });
  const canvasSize = await page.locator('canvas').evaluate((element) => ({ width: element.width, height: element.height }));
  if (canvasSize.width <= 0 || canvasSize.height <= 0) throw new Error(`invalid canvas size: ${JSON.stringify(canvasSize)}`);
  console.log(`[smoke-browser] ready=1 canvas=${canvasSize.width}x${canvasSize.height}`);
  if (errors.length > 0) throw new Error(errors.join(' | '));
  console.log('[smoke-browser] PASS - Chrome loaded transparency_2d and reached the running-system ready marker');
  await browser.close();
} finally {
  vite.kill('SIGTERM');
  await delay(100);
}
