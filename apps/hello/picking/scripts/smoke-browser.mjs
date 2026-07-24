#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ARTIFACT_DIR = resolve(HERE, '..', '.forgeax-debug', 'dom-input-pick');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-picking', 'dev'], {
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
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    const pageErrors = [];
    const consoleErrors = [];
    const logs = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      logs.push(message.text());
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForSelector('#app', { timeout: 10_000 });
    await page.waitForTimeout(2_000);

    const beforePath = resolve(ARTIFACT_DIR, 'before-click.png');
    const hitPath = resolve(ARTIFACT_DIR, 'after-hit.png');
    const missPath = resolve(ARTIFACT_DIR, 'after-miss.png');
    await page.screenshot({ path: beforePath, clip: { x: 300, y: 200, width: 200, height: 200 } });

    await page.mouse.click(400, 300);
    await page.waitForTimeout(500);
    if (!logs.some((line) => line.startsWith('[picking] hit entity='))) {
      throw new Error(`center click did not produce a pick hit; logs=${JSON.stringify(logs)}`);
    }
    await page.screenshot({ path: hitPath, clip: { x: 300, y: 200, width: 200, height: 200 } });

    await page.mouse.click(1, 1);
    await page.waitForTimeout(500);
    if (!logs.includes('[picking] miss (no entity under pointer)')) {
      throw new Error(`corner click did not produce a pick miss; logs=${JSON.stringify(logs)}`);
    }
    await page.screenshot({ path: missPath, clip: { x: 300, y: 200, width: 200, height: 200 } });

    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    const unexpectedConsoleErrors = consoleErrors.filter((line) => !line.includes('404'));
    if (unexpectedConsoleErrors.length > 0) {
      throw new Error(`console errors: ${unexpectedConsoleErrors.join(' | ')}`);
    }

    const before = PNG.sync.read(readFileSync(beforePath));
    const hit = PNG.sync.read(readFileSync(hitPath));
    const changedPixels = pixelmatch(before.data, hit.data, undefined, before.width, before.height, {
      threshold: 0.1,
    });
    if (changedPixels < 20) {
      throw new Error(`hit click changed only ${changedPixels} pixels in the canvas capture`);
    }

    console.log(`[smoke-browser] artifacts: before=${beforePath} hit=${hitPath} miss=${missPath}`);
    console.log(`[smoke-browser] PASS - real browser center hit and corner miss drove DOM input through pick; changedPixels=${changedPixels}.`);
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
