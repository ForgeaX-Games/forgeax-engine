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
  const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(`console: ${message.text()}`);
    else if (message.type() === 'warning') console.warn(`[browser] ${message.text()}`);
  });
  page.on('requestfailed', (request) => console.error(`[browser] request failed ${request.url()} ${request.failure()?.errorText ?? ''}`));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  try {
    await page.waitForFunction(() => globalThis.__bevyRotateToCursorReady === true, null, { timeout: 30000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      ready: (globalThis).__bevyRotateToCursorReady === true,
      webgpu: 'gpu' in navigator,
      canvas: document.querySelector('#app')?.getBoundingClientRect().toJSON(),
      body: document.body.textContent,
    }));
    console.error(`[smoke-browser] ready timeout; diagnostics=${errors.join(' | ') || 'none'} state=${JSON.stringify(diagnostics)}`);
    throw error;
  }
  await page.mouse.move(80, 90);
  await page.screenshot({ path: 'artifacts/rotate-to-cursor-browser-left.png' });
  await page.mouse.move(240, 90);
  await page.screenshot({ path: 'artifacts/rotate-to-cursor-browser-right.png' });
  console.log(`[smoke-browser] ready=1 errors=${errors.length}`);
  if (errors.length > 0) throw new Error(errors.join(' | '));
  console.log('[smoke-browser] PASS - cursor-facing sprite reached the running-system ready marker');
  await browser.close();
} finally {
  vite.kill('SIGTERM');
  await delay(100);
}
