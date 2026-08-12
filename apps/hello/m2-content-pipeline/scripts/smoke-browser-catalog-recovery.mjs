#!/usr/bin/env node
// M9 browser proof: baseline catalog/loadByGuid -> valid revision/payload HMR
// -> malformed source rejection with LKG -> repaired revision in one page.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const appRoot = resolve(repoRoot, 'apps/hello/custom-importer');
const sourcePath = resolve(appRoot, 'assets/level-1.reel.json');
const metaPath = resolve(appRoot, 'assets/level-1.reel.json.meta.json');
const artifactDir = resolve(appRoot, '.forgeax-debug/m2-catalog-recovery');
const port = Number.parseInt(process.env.FORGEAX_CUSTOM_IMPORTER_PORT ?? '5196', 10);

mkdirSync(artifactDir, { recursive: true });
const originalSource = readFileSync(sourcePath, 'utf8');
const originalMetaSource = readFileSync(metaPath, 'utf8');
const original = JSON.parse(originalSource);
const originalMeta = JSON.parse(originalMetaSource);
const validTitle = `${original.title} M9 Valid`;
const recoveredTitle = `${original.title} M9 Recovered`;
const validSource = {
  ...original,
  title: validTitle,
  reels: original.reels.map((reel, index) => ({
    ...reel,
    x: reel.x + (index === 1 ? 0.5 : 0),
  })),
};
const recoveredSource = {
  ...validSource,
  title: recoveredTitle,
  reels: validSource.reels.map((reel, index) => ({
    ...reel,
    x: reel.x + (index === 2 ? 0.5 : 0),
  })),
};
const validMeta = {
  ...originalMeta,
  revision: { ...originalMeta.revision, digest: 'level-1-reel-v2', observedAt: 2 },
};
const recoveredMeta = {
  ...originalMeta,
  revision: { ...originalMeta.revision, digest: 'level-1-reel-v3', observedAt: 3 },
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
  let pageLoads = 0;
  page.on('load', () => {
    pageLoads += 1;
  });
  page.on('console', (message) => {
    logs.push(message.text());
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(portUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    (title) => document.querySelector('#asset-status')?.textContent?.includes(title),
    original.title,
    { timeout: 30_000 },
  );
  const baselinePath = resolve(artifactDir, 'baseline.png');
  await page.screenshot({ path: baselinePath });

  writeFileSync(sourcePath, `${JSON.stringify(validSource, null, 2)}\n`);
  writeFileSync(metaPath, `${JSON.stringify(validMeta, null, 2)}\n`);
  await page.waitForFunction(
    (title) => document.querySelector('#asset-status')?.textContent?.includes(title),
    validTitle,
    { timeout: 30_000 },
  );
  const validPath = resolve(artifactDir, 'valid-revision.png');
  await page.screenshot({ path: validPath });

  writeFileSync(sourcePath, '{\n  "format": "reel-game-blob",\n');
  await page.waitForFunction(
    (title) => {
      const status = document.querySelector('#asset-status')?.textContent ?? '';
      return status.includes('catalog rejected code=') && status.includes(`retained title="${title}"`);
    },
    validTitle,
    { timeout: 30_000 },
  );
  const rejectedPath = resolve(artifactDir, 'malformed-retained-lkg.png');
  await page.screenshot({ path: rejectedPath });

  writeFileSync(sourcePath, `${JSON.stringify(recoveredSource, null, 2)}\n`);
  writeFileSync(metaPath, `${JSON.stringify(recoveredMeta, null, 2)}\n`);
  await page.waitForFunction(
    (title) => document.querySelector('#asset-status')?.textContent?.includes(title),
    recoveredTitle,
    { timeout: 30_000 },
  );
  const recoveredPath = resolve(artifactDir, 'recovered-same-process.png');
  await page.screenshot({ path: recoveredPath });

  if (pageLoads > 1) throw new Error(`catalog recovery required a page reload: pageLoads=${pageLoads}`);
  if (!logs.some((line) => line.includes('[custom-importer] catalog baseline rows=1 stableGuid=true'))) {
    throw new Error(`baseline catalog evidence missing: logs=${JSON.stringify(logs)}`);
  }
  if (!logs.some((line) => line.includes('[custom-importer] catalog rejected code='))) {
    throw new Error(`structured malformed-source diagnostic missing: logs=${JSON.stringify(logs)}`);
  }
  if (!logs.some((line) => line.includes(JSON.stringify(recoveredTitle)))) {
    throw new Error(`same-process recovery load missing: logs=${JSON.stringify(logs)}`);
  }
  if (logs.some((line) => line.includes('M9 Invalid'))) {
    throw new Error(`malformed payload was applied: logs=${JSON.stringify(logs)}`);
  }
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  const unexpectedConsoleErrors = consoleErrors.filter((line) => !line.includes('404'));
  if (unexpectedConsoleErrors.length > 0) {
    throw new Error(`console errors: ${unexpectedConsoleErrors.join(' | ')}`);
  }

  console.log(
    `[m2-catalog-recovery] PASS - baseline stable GUID, valid revision HMR, malformed LKG retention, ` +
      `same-process repair, pageLoads=${pageLoads}`,
  );
  console.log(
    `[m2-catalog-recovery] artifacts: baseline=${baselinePath} valid=${validPath} ` +
      `rejected=${rejectedPath} recovered=${recoveredPath}`,
  );
} catch (error) {
  failure = error;
} finally {
  writeFileSync(sourcePath, originalSource);
  writeFileSync(metaPath, originalMetaSource);
  if (browser) await browser.close();
  viteProc.kill('SIGTERM');
  await sleep(300);
}

if (failure) {
  console.error(`[m2-catalog-recovery] FAIL - ${failure instanceof Error ? failure.message : String(failure)}`);
  process.exitCode = 1;
}
