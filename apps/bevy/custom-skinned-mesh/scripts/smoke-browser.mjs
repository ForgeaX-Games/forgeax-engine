#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const root = resolve(here, '..', '..', '..', '..');
const artifacts = resolve(root, 'apps/bevy/custom-skinned-mesh/artifacts');
mkdirSync(artifacts, { recursive: true });
const port = Number(process.env.PORT ?? 5181);
const vite = spawn(resolve(root, 'node_modules/.bin/vite'), ['--config', resolve(appRoot, 'vite.config.ts'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe'] });
vite.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

try {
  await delay(1000);
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(`console: ${message.text()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForFunction(() => globalThis.__bevyCustomSkinnedMeshReady === true, undefined, { timeout: 30000 });
  const early = await page.evaluate(() => globalThis.__bevyCustomSkinnedMeshSnapshot());
  await page.waitForTimeout(700);
  const late = await page.evaluate(() => globalThis.__bevyCustomSkinnedMeshSnapshot());
  await page.screenshot({ path: resolve(artifacts, 'custom-skinned-mesh-browser.png') });
  await browser.close();
  const changed = Math.abs(late.upperQuat[2] - early.upperQuat[2]) > 0.01 || Math.abs(late.upperQuat[3] - early.upperQuat[3]) > 0.01;
  if (errors.length > 0) throw new Error(errors.join(' | '));
  if (!changed) throw new Error(`joint did not move: ${JSON.stringify({ early, late })}`);
  console.log(`[smoke-browser] PASS - jointChanged=${changed} elapsed=${early.elapsed.toFixed(3)}->${late.elapsed.toFixed(3)}`);
} finally {
  vite.kill('SIGTERM');
  await delay(200);
}
