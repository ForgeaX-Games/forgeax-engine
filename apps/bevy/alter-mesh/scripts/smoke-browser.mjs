#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = Number(process.env.PORT ?? 5177);
const vite = spawn('pnpm', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
vite.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));
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
  page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(`console: ${message.text()}`); });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => globalThis.__bevyAlterMeshReady === true, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.keyboard.down('Space');
  await page.waitForTimeout(250);
  await page.keyboard.up('Space');
  await page.waitForFunction(() => globalThis.__bevyAlterMeshState.swaps === 1);
  await page.keyboard.down('Enter');
  await page.waitForTimeout(250);
  await page.keyboard.up('Enter');
  await page.waitForFunction(() => globalThis.__bevyAlterMeshState.mutations === 1);
  const state = await page.evaluate(() => ({ rightMesh: globalThis.__bevyAlterMeshState.rightMesh, altered: globalThis.__bevyAlterMeshState.altered }));
  await page.screenshot({ path: 'artifacts/alter-mesh-browser.png' });
  if (errors.length > 0) throw new Error(errors.join(' | '));
  if (state.rightMesh !== 'sphere' || state.altered !== true) throw new Error(`input handling failed: ${JSON.stringify(state)}`);
  console.log(`[smoke-browser] PASS - rightMesh=${state.rightMesh} altered=${state.altered}`);
  await browser.close();
} finally {
  vite.kill('SIGTERM');
  await delay(100);
}
