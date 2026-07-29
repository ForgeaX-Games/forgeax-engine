#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = Number(process.env.PORT ?? 5174);
const vite = spawn('pnpm', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
try {
  await delay(1000);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  try {
    await page.waitForFunction(() => globalThis.__bevyMesh2dAlphaModeReady === true, null, { timeout: 30000 });
  } catch (error) {
    console.error(`[smoke-browser] ready timeout; diagnostics=${errors.join(' | ') || 'none'}`);
    throw error;
  }
  await page.screenshot({ path: 'artifacts/mesh2d-alpha-mode-browser.png' });
  console.log(`[smoke-browser] ready=1 canvas=${await page.locator('canvas').getAttribute('width')}x${await page.locator('canvas').getAttribute('height')}`);
  if (errors.length > 0) throw new Error(errors.join(' | '));
  console.log('[smoke-browser] PASS - Chrome loaded mesh2d alpha mode and reached the running-system ready marker');
  await browser.close();
} finally {
  vite.kill('SIGTERM');
  await delay(100);
}
