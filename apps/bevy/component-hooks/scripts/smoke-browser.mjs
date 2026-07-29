#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const repoRoot = new URL('../../../../', import.meta.url).pathname;
let vite;
let browser;
let appUrl;
let stopping = false;
const errors = [];
async function waitFor(predicate, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

try {
  vite = spawn('pnpm', ['-F', '@forgeax/bevy-component-hooks', 'dev'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  vite.stdout.on('data', (chunk) => {
    if (stopping) return;
    const text = String(chunk);
    process.stdout.write(`[vite] ${text}`);
    appUrl ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1];
  });
  vite.stderr.on('data', (chunk) => { if (!stopping) process.stderr.write(`[vite-err] ${chunk}`); });
  await waitFor(() => appUrl !== undefined, 'Vite dev server');
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon.ico')) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await waitFor(() => page.evaluate(() => Boolean(globalThis.__bevyComponentHooksReady)), 'component hooks app');
  await sleep(2_500);
  const state = await page.evaluate(() => globalThis.__bevyComponentHooksState?.());
  if (errors.length > 0) throw new Error(`browser errors:\n${errors.join('\n')}`);
  if (!state || state.add !== 2 || state.insert !== 3 || state.discard !== 2 || state.remove !== 1 || state.indexSize !== 1 || state.rekey !== 3 || state.remaining !== 0) {
    throw new Error(`invalid component hook state: ${JSON.stringify(state)}`);
  }
  console.log(`[smoke] PASS - browser ready, state=${JSON.stringify(state)}`);
} finally {
  await browser?.close();
  stopping = true;
  vite?.kill();
}
