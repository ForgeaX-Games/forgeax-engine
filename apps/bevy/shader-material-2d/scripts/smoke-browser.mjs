#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = Number(process.env.PORT ?? 5175);
const vite = spawn('pnpm', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
const viteOutput = [];
vite.stdout.on('data', (chunk) => viteOutput.push(String(chunk)));
vite.stderr.on('data', (chunk) => viteOutput.push(String(chunk)));

async function waitForServer(url) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) return;
    } catch {
      // Vite is still compiling; keep polling rather than assuming a fixed startup time.
    }
    await delay(250);
  }
  throw new Error(`Vite did not start at ${url}; output=${viteOutput.join('').trim() || 'none'}`);
}

try {
  await waitForServer(`http://127.0.0.1:${port}/`);
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  try {
    await page.waitForFunction(() => globalThis.__bevyShaderMaterial2dReady === true, null, { timeout: 30000 });
  } catch (error) {
    throw new Error(`ready timeout; diagnostics=${errors.join(' | ') || 'none'}; cause=${error instanceof Error ? error.message : String(error)}`);
  }
  await page.screenshot({ path: 'artifacts/shader-material-2d-browser.png' });
  if (errors.length > 0) throw new Error(errors.join(' | '));
  console.log('[smoke-browser] PASS - Chrome loaded shader_material_2d and reached the running-system ready marker');
  await browser.close();
} finally {
  vite.kill('SIGTERM');
  await delay(100);
}
