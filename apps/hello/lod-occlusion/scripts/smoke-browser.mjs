#!/usr/bin/env node
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, '');
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const server = await createServer({ root, server: { port: 0 } });
await server.listen();
try {
  await page.goto(`http://localhost:${server.config.server.port}`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  await page.waitForFunction(
    () => document.querySelector('#status')?.textContent?.includes('lod-scene.gltf') === true,
    undefined,
    { timeout: 10_000 },
  );
  console.log('[hello-lod-occlusion] browser consumer reached real glTF sidecar inspection');
} finally {
  await browser.close();
  await server.close();
}
