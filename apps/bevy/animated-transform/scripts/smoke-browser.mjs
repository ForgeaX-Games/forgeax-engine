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
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(`console: ${message.text()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => globalThis.__bevyAnimatedTransformReady === true, undefined, { timeout: 30000 });
  const early = await page.evaluate(() => globalThis.__bevyAnimatedTransformSnapshot());
  await page.waitForTimeout(500);
  const late = await page.evaluate(() => globalThis.__bevyAnimatedTransformSnapshot());
  await page.screenshot({ path: 'artifacts/animated-transform-browser.png' });
  if (errors.length > 0) throw new Error(errors.join(' | '));
  const moved = Math.abs(late.planet.pos[0] - early.planet.pos[0]) > 0.01;
  const rotated = Math.abs(late.orbitController.quat[1] - early.orbitController.quat[1]) > 0.01;
  const scaled = Math.abs(late.satellite.scale[0] - early.satellite.scale[0]) > 0.01;
  if (!moved || !rotated || !scaled) throw new Error(`animation failed: ${JSON.stringify({ early, late })}`);
  console.log(`[smoke-browser] PASS - moved=${moved} rotated=${rotated} scaled=${scaled}`);
  await browser.close();
} finally {
  vite.kill('SIGTERM');
  await delay(100);
}
