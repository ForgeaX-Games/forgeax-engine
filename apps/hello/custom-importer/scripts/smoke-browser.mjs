#!/usr/bin/env node
// Browser HMR smoke for the host-importer content path.
//
// This is deliberately a source mutation, not a direct API probe:
//   edit source -> Vite watcher -> explicit full-reload policy -> browser
//   -> dev pack/import route -> loadByGuid -> host-driven scene.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const sourcePath = resolve(appRoot, 'assets/level-1.reel.json');
const artifactDir = resolve(appRoot, '.forgeax-debug/m2-browser-hmr');
const port = Number.parseInt(process.env.FORGEAX_CUSTOM_IMPORTER_PORT ?? '5196', 10);

mkdirSync(artifactDir, { recursive: true });
const originalSource = readFileSync(sourcePath, 'utf8');
const original = JSON.parse(originalSource);
const mutatedTitle = `${original.title} HMR Reloaded`;
const mutated = {
  ...original,
  title: mutatedTitle,
  reels: original.reels.map((reel, index) => ({
    ...reel,
    x: reel.x + (index === 1 ? 0.75 : 0),
  })),
};

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-custom-importer', 'dev'], {
  cwd: repoRoot,
  env: { ...process.env, FORCE_COLOR: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let portUrl;
let viteOutput = '';
viteProc.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  viteOutput += text;
  process.stdout.write(`[vite] ${text}`);
  portUrl ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1];
});
viteProc.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  viteOutput += text;
  process.stderr.write(`[vite-err] ${text}`);
});

let browser;
let failure;
try {
  const deadline = Date.now() + 30_000;
  while (!portUrl && Date.now() < deadline) {
    if (viteProc.exitCode !== null) break;
    await sleep(100);
  }
  if (!portUrl) throw new Error(`Vite did not publish a URL: ${viteOutput}`);
  if (!portUrl.includes(`:${port}`)) throw new Error(`unexpected Vite URL: ${portUrl}`);

  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--ignore-gpu-blocklist',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  const logs = [];
  const pageErrors = [];
  const consoleErrors = [];
  page.on('console', (message) => {
    logs.push(message.text());
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(portUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector('#asset-status')?.textContent?.includes('Reel Game Level 1'),
    null,
    { timeout: 30_000 },
  );
  const beforePath = resolve(artifactDir, 'before-hmr.png');
  await page.screenshot({ path: beforePath });

  writeFileSync(sourcePath, `${JSON.stringify(mutated, null, 2)}\n`);
  await page.waitForFunction(
    (title) => document.querySelector('#asset-status')?.textContent?.includes(title),
    mutatedTitle,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(500);
  const afterPath = resolve(artifactDir, 'after-hmr.png');
  await page.screenshot({ path: afterPath });

  const before = PNG.sync.read(readFileSync(beforePath));
  const after = PNG.sync.read(readFileSync(afterPath));
  const changedPixels = pixelmatch(before.data, after.data, undefined, before.width, before.height, {
    threshold: 0.1,
  });
  const reloadLogs = logs.filter((line) => line.includes('[custom-importer] loaded reel-game blob'));
  const changedLog = reloadLogs.find((line) => line.includes(JSON.stringify(mutatedTitle)));
  if (!changedLog) throw new Error(`browser did not log the mutated blob; logs=${JSON.stringify(reloadLogs)}`);
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  const unexpectedConsoleErrors = consoleErrors.filter((line) => !line.includes('404'));
  if (unexpectedConsoleErrors.length > 0) {
    throw new Error(`console errors: ${unexpectedConsoleErrors.join(' | ')}`);
  }

  console.log(`[smoke-browser] artifacts: before=${beforePath} after=${afterPath}`);
  console.log(
    `[smoke-browser] PASS - browser HMR reloaded changed host asset content; title=${JSON.stringify(mutatedTitle)}, changedPixels=${changedPixels}.`,
  );
} catch (error) {
  failure = error;
} finally {
  writeFileSync(sourcePath, originalSource);
  if (browser) await browser.close();
  viteProc.kill('SIGTERM');
  await sleep(300);
}

if (failure) {
  console.error(`[smoke-browser] FAIL - ${failure instanceof Error ? failure.message : String(failure)}`);
  process.exitCode = 1;
}
