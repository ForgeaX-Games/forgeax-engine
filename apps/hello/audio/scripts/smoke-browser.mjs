#!/usr/bin/env node
// Real Chrome/WebGPU/Web Audio smoke for hello-audio.
// The probe exercises the consumer path: an actual key gesture resumes the
// AudioContext, spacebar reaches declarative AudioSource playback, a falling
// physics actor triggers a second spatial source on collision, and despawn
// returns the backend to zero active sources.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ARTIFACT_DIR = resolve(REPO_ROOT, 'apps', 'hello', 'audio', '.forgeax-audio', 'browser');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-audio', 'dev'], {
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

function countChangedPixels(beforePath, afterPath) {
  const before = PNG.sync.read(readFileSync(beforePath));
  const after = PNG.sync.read(readFileSync(afterPath));
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(`screenshots have different sizes: ${before.width}x${before.height} vs ${after.width}x${after.height}`);
  }
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const delta = Math.abs((before.data[i] ?? 0) - (after.data[i] ?? 0))
      + Math.abs((before.data[i + 1] ?? 0) - (after.data[i + 1] ?? 0))
      + Math.abs((before.data[i + 2] ?? 0) - (after.data[i + 2] ?? 0));
    if (delta > 12) changed++;
  }
  return changed;
}

try {
  const deadline = Date.now() + 30_000;
  while (!portUrl && Date.now() < deadline) await sleep(200);
  if (!portUrl) throw new Error('vite did not become ready in 30s');
  portUrl = portUrl.replace(/\/$/, '');

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=user-gesture-required',
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404')) {
        consoleErrors.push(message.text());
      }
    });

    await page.goto(`${portUrl}/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelector('#overlay')?.textContent?.includes('distance ='),
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForFunction(
      () => document.querySelector('#audio-status')?.textContent?.includes('audio='),
      undefined,
      { timeout: 15_000 },
    );

    const initialStatus = await page.locator('#audio-status').textContent();
    const initialOverlay = await page.locator('#overlay').textContent();
    const beforePath = resolve(ARTIFACT_DIR, 'before-gesture.png');
    await page.screenshot({ path: beforePath });

    // A real keydown is the browser gesture consumed by WebAudioEngine's
    // one-shot resume listener; the keyup is also the demo's play trigger.
    await page.keyboard.press('Space');
    await page.waitForFunction(
      () => {
        const text = document.querySelector('#audio-status')?.textContent ?? '';
        return text.includes('audio=running') && /starts=[1-9]/.test(text);
      },
      undefined,
      { timeout: 10_000 },
    );
    const afterGestureStatus = await page.locator('#audio-status').textContent();

    await page.waitForFunction(
      () => {
        const physics = document.querySelector('#physics-status')?.textContent ?? '';
        const audio = document.querySelector('#audio-status')?.textContent ?? '';
        return physics.includes('collision=1') && physics.includes('cleanup=1')
          && audio.includes('active=0') && /starts=[2-9]/.test(audio);
      },
      undefined,
      { timeout: 10_000 },
    );
    const collisionStatus = await page.locator('#physics-status').textContent();
    const cleanupAudioStatus = await page.locator('#audio-status').textContent();

    // Move left of the emitter. The emitter is at x=0, so it must pan right.
    await page.keyboard.down('a');
    await page.waitForTimeout(350);
    await page.keyboard.up('a');
    await page.waitForFunction(
      () => document.querySelector('#overlay')?.textContent?.includes('pan = R'),
      undefined,
      { timeout: 10_000 },
    );
    const movedOverlay = await page.locator('#overlay').textContent();
    const afterPath = resolve(ARTIFACT_DIR, 'after-gesture-and-pan.png');
    await page.screenshot({ path: afterPath });
    const pixels = countChangedPixels(beforePath, afterPath);

    await page.close();
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    if (pixels < 100) throw new Error(`gesture/pan produced too few changed pixels: ${pixels}`);

    console.log(`[smoke-browser] initial=${initialStatus} overlay=${initialOverlay}`);
    console.log(`[smoke-browser] afterGesture=${afterGestureStatus} moved=${movedOverlay}`);
    console.log(`[smoke-browser] collision=${collisionStatus} cleanupAudio=${cleanupAudioStatus}`);
    console.log(`[smoke-browser] artifacts: before=${beforePath} after=${afterPath}`);
    console.log(`[smoke-browser] PASS - real Chrome gesture resumed AudioContext, collision triggered spatial SFX, despawn cleaned audio, and listener pan moved; changedPixels=${pixels}.`);
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
