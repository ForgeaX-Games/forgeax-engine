#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  assertApplicationBootstrap,
  startViteServer,
  pollHttpReady,
  probeFailureRecord,
  withRestoredFile,
  withServerLifecycle,
} from './shared-inputs-browser-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..', '..');
const packageName = '@forgeax/app-learn-render-4-advanced-opengl-3-blending';
const alphaPath = resolve(appRoot, 'src/alpha-test.wgsl');
const require = createRequire(import.meta.url);
const shaderRoot = resolve(dirname(require.resolve('@forgeax/engine-shader/package.json')), 'src');

async function build(sharedRoot) {
  const manifest = resolve(sharedRoot, 'manifest.json');
  const env = { ...process.env, FORGEAX_SHARED_APP_INPUTS_MANIFEST: manifest };
  const { execa } = await import('execa');
  await execa('node', ['scripts/ci/build-shared-app-inputs.mjs', '--out', sharedRoot, '--shader-root', shaderRoot], { cwd: repoRoot, stdio: 'inherit' });
  await execa('pnpm', ['-F', packageName, 'exec', 'vite', 'build', '--base', '/blending/'], { cwd: repoRoot, env, stdio: 'inherit' });
}

async function browserCheck(origin) {
  const browser = await chromium.launch({ headless: true, channel: process.env.FORGEAX_CHROME_CHANNEL || 'chrome', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage();
    const applicationErrors = [];
    page.on('pageerror', (error) => applicationErrors.push(`PAGEERROR: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') applicationErrors.push(`CONSOLE-ERR: ${message.text()}`);
    });
    await page.goto(`${origin}/blending/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForTimeout(1_000);
    const urls = ['/blending/pack-index.json', '/blending/shaders/manifest.json'];
    const payloads = await Promise.all(urls.map(async (path) => {
      const response = await page.evaluate(async (url) => { const r = await fetch(url); return { ok: r.ok, status: r.status, body: await r.text() }; }, path);
      if (!response.ok) throw new Error(`preview fetch failed ${path}: ${response.status}`);
      return response.body;
    }));
    const catalog = JSON.parse(payloads[0]);
    const manifest = JSON.parse(payloads[1]);
    if (!Array.isArray(catalog) || !catalog.some((entry) => typeof entry.relativeUrl === 'string' && entry.relativeUrl.startsWith('/assets/'))) throw new Error('catalog omitted shared asset URL');
    const source = JSON.stringify(manifest);
    if (!source.includes('alpha-test.wgsl') || !source.includes('discard')) throw new Error('shader manifest omitted alpha-test marker/discard');
    assertApplicationBootstrap(applicationErrors, `${origin}/blending/`);
  } finally {
    await browser.close();
  }
}

async function hmrCheck(origin, original) {
  const browser = await chromium.launch({ headless: true, channel: process.env.FORGEAX_CHROME_CHANNEL || 'chrome' });
  try {
    const page = await browser.newPage();
    const applicationErrors = [];
    page.on('pageerror', (error) => applicationErrors.push(`PAGEERROR: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') applicationErrors.push(`CONSOLE-ERR: ${message.text()}`);
    });
    const session = await page.context().newCDPSession(page);
    const frames = [];
    await session.send('Network.enable');
    session.on('Network.webSocketFrameReceived', ({ response }) => frames.push(response.payloadData));
    await page.goto(`${origin}/blending/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1_000);
    assertApplicationBootstrap(applicationErrors, `${origin}/blending/`);
    // `domcontentloaded` precedes Vite's HMR WebSocket handshake on a busy
    // runner. Mutating before the server sends its protocol `connected` frame
    // produces a legitimate update that this browser was never subscribed to.
    const connectionDeadline = Date.now() + 10_000;
    while (Date.now() < connectionDeadline && !frames.some((frame) => frame.includes('connected'))) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!frames.some((frame) => frame.includes('connected'))) throw new Error('custom-shader-hmr: Vite HMR client did not connect');
    await writeFile(alphaPath, `${original}\n// probe alpha threshold variant ${Date.now()}\n`);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !frames.some((frame) => frame.includes('alpha-test') && frame.includes('update'))) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!frames.some((frame) => frame.includes('alpha-test') && frame.includes('update'))) throw new Error('custom-shader-hmr: target alpha-test update was not observed');
  } finally {
    await browser.close();
  }
}

async function main() {
  const tempRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-blending-probe-'));
  try {
    const sharedRoot = resolve(tempRoot, 'shared-app-inputs');
    await build(sharedRoot);
    await withServerLifecycle(startViteServer({ mode: 'preview', root: appRoot, base: '/blending/', port: 0 }), async ({ origin, server }) => {
      await pollHttpReady(`${origin}/blending/`, { stage: 'preview-readiness' });
      await browserCheck(origin);
      if (!server) throw new Error('preview server missing');
    });
    await withRestoredFile(alphaPath, async (original) => {
      await withServerLifecycle(startViteServer({ mode: 'dev', root: appRoot, base: '/blending/', port: 0 }), async ({ origin }) => {
        await pollHttpReady(`${origin}/blending/`, { stage: 'preview-fetch' });
        await hmrCheck(origin, original);
      });
    });
    process.stdout.write('shared-input browser probe passed\n');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    const record = probeFailureRecord(error);
    if (record !== null) console.error(JSON.stringify(record));
    else console.error(error);
    process.exit(1);
  },
);
