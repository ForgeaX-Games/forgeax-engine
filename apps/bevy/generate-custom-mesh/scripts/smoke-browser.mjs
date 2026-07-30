#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = Number(process.env.PORT ?? 5176);
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
  try {
    await page.waitForFunction(() => globalThis.__bevyGenerateCustomMeshReady === true, null, { timeout: 30000 });
  } catch (error) {
    console.error(`[smoke-browser] ready timeout; diagnostics=${errors.join(' | ') || 'none'}`);
    throw error;
  }
  await page.waitForTimeout(1000);
  const before = await page.evaluate(() => globalThis.__bevyGenerateCustomMeshState.toggles);
  await page.keyboard.down('Space');
  await page.waitForTimeout(250);
  await page.keyboard.up('Space');
  await page.waitForFunction((value) => globalThis.__bevyGenerateCustomMeshState.toggles === value + 1, before);
  const after = await page.evaluate(() => ({ toggles: globalThis.__bevyGenerateCustomMeshState.toggles, uvMode: globalThis.__bevyGenerateCustomMeshState.uvMode }));
  await page.screenshot({ path: 'artifacts/generate-custom-mesh-browser.png' });
  if (errors.length > 0) throw new Error(errors.join(' | '));
  if (after.uvMode !== 'lower') throw new Error(`UV toggle failed: ${JSON.stringify(after)}`);
  console.log(`[smoke-browser] PASS - ready=1 toggles=${after.toggles} uvMode=${after.uvMode}`);
  await browser.close();
} finally {
  vite.kill('SIGTERM');
  await delay(100);
}
