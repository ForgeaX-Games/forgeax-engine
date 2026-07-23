// Real Vite + browser proof for the preview host's opted-in asset refresh.
//
// This intentionally does not use Vitest's browser dev server: the assertion
// needs to mutate a watched on-disk sidecar and observe Vite's full-reload
// websocket crossing into the actual preview document.

import { readFile, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer, loadConfigFromFile, mergeConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const fixture = resolve(root, 'templates/game-default/assets/base-material.pack.json');
const marker = '"baseColor": [0.6, 0.6, 0.6, 1]';
const replacement = '"baseColor": [0.61, 0.6, 0.6, 1]';

async function availablePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('could not allocate a TCP port');
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

const port = await availablePort();
const config = await loadConfigFromFile(
  { command: 'serve', mode: 'test' },
  resolve(root, 'apps/preview/vite.config.ts'),
);
if (config === null) throw new Error('preview Vite config did not load');

const server = await createServer(
  mergeConfig(config.config, {
    root: resolve(root, 'apps/preview'),
    server: { host: '127.0.0.1', port, strictPort: true },
  }),
);
const original = await readFile(fixture, 'utf8');
let browser;

try {
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || typeof address === 'string') throw new Error('preview Vite server has no TCP address');
  const origin = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--disable-vulkan-surface',
      '--ignore-gpu-blocklist',
      '--disable-gpu-driver-bug-workarounds',
    ],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    const url = message.location().url;
    if (message.type() === 'error' && !url.endsWith('/favicon.ico')) {
      errors.push(`console: ${message.text()} (${url})`);
    }
  });

  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('#app', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    return canvas !== null && canvas.getBoundingClientRect().width > 0 && canvas.getBoundingClientRect().height > 0;
  });

  const before = await page.evaluate(async () => {
    const response = await fetch('/__pack/lookup/eb5bf6e6-2e47-4d9a-99fd-81843228c9b3');
    return { ok: response.ok, row: await response.json() };
  });
  if (!before.ok || before.row.guid !== 'eb5bf6e6-2e47-4d9a-99fd-81843228c9b3') {
    throw new Error('pre-mutation asset catalog lookup failed');
  }

  const navigation = page.waitForEvent('framenavigated', {
    predicate: (frame) => frame === page.mainFrame() && frame.url().startsWith(origin),
    timeout: 30_000,
  });
  if (!original.includes(marker)) throw new Error('preview asset fixture drifted; refresh mutation marker is absent');
  await writeFile(fixture, original.replace(marker, replacement));
  await navigation;

  await page.waitForSelector('#app', { timeout: 30_000 });
  const health = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const rect = canvas?.getBoundingClientRect();
    return {
      canvasLive: canvas instanceof HTMLCanvasElement && (rect?.width ?? 0) > 0 && (rect?.height ?? 0) > 0,
      errorOverlay: document.querySelector('[role="alert"], [data-error-overlay]') !== null,
    };
  });
  if (!health.canvasLive) throw new Error('post-refresh preview canvas is absent or zero-sized');
  if (health.errorOverlay) throw new Error('post-refresh preview displayed an error overlay');
  if (errors.length > 0) throw new Error(`preview reported browser errors after Vite refresh: ${errors.join('; ')}`);

  console.log('GREEN: watched preview asset triggered Vite reload; post-refresh canvas is healthy with no error overlay.');
} finally {
  await writeFile(fixture, original);
  await browser?.close();
  await server.close();
}
