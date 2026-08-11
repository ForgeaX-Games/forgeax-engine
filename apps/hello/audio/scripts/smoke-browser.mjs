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
import { extractViteLocalUrl } from './vite-local-url.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ARTIFACT_DIR = resolve(REPO_ROOT, 'apps', 'hello', 'audio', '.forgeax-audio', 'browser');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const READINESS_TIMEOUT_MS = Number.parseInt(
  process.env.FORGEAX_AUDIO_READINESS_TIMEOUT_MS ?? '90000',
  10,
);

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-audio', 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  // pnpm owns a Vite child. Put the whole dev-server tree in its own POSIX
  // process group so a successful browser probe cannot leave the grandchild
  // holding the smoke command open after the direct pnpm process is signalled.
  detached: process.platform !== 'win32',
});
const WATCHDOG_MS = 180_000;
const watchdog = setTimeout(() => {
  console.error(`[smoke-browser] FAIL - watchdog exceeded ${WATCHDOG_MS / 1000}s`);
  viteProc.kill('SIGKILL');
  process.exit(124);
}, WATCHDOG_MS);
let portUrl;
let viteOutput = '';
viteProc.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  viteOutput += text;
  process.stdout.write(`[vite] ${text}`);
  portUrl ??= extractViteLocalUrl(viteOutput);
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

async function closeWithTimeout(label, close, timeoutMs = 5_000) {
  let timedOut = false;
  try {
    await Promise.race([
      close(),
      sleep(timeoutMs).then(() => {
        timedOut = true;
      }),
    ]);
  } catch (error) {
    console.error(`[smoke-browser] ${label} close failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (timedOut) {
    console.error(`[smoke-browser] ${label} close exceeded ${timeoutMs}ms`);
    return false;
  }
  return true;
}

function viteExited() {
  return viteProc.exitCode !== null || viteProc.signalCode !== null;
}

function signalVite(signal) {
  if (viteProc.pid === undefined) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-viteProc.pid, signal);
    } else {
      viteProc.kill(signal);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function stopVite() {
  if (viteExited()) return;
  signalVite('SIGTERM');
  await Promise.race([
    new Promise((resolve) => viteProc.once('exit', resolve)),
    sleep(2_000),
  ]);
  if (viteExited()) return;
  console.error('[smoke-browser] vite did not exit after SIGTERM; forcing SIGKILL');
  signalVite('SIGKILL');
  await sleep(300);
}

async function readPageDiagnostics(page) {
  try {
    return await Promise.race([
      page.evaluate(() => ({
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        bodyText: document.body?.innerText?.slice(0, 2_000) ?? '',
        overlay: document.querySelector('#overlay')?.textContent ?? null,
        physics: document.querySelector('#physics-status')?.textContent ?? null,
        audio: document.querySelector('#audio-status')?.textContent ?? null,
        canvas: (() => {
          const canvas = document.querySelector('#app');
          return canvas instanceof HTMLCanvasElement
            ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight }
            : null;
        })(),
        capabilities: {
          webgpu: 'gpu' in navigator,
          audioContext: 'AudioContext' in window || 'webkitAudioContext' in window,
        },
      })),
      sleep(2_000).then(() => ({ evaluate: 'timed out after 2000ms' })),
    ]);
  } catch (error) {
    return { evaluate: error instanceof Error ? error.message : String(error) };
  }
}

let failed = false;
try {
  const deadline = Date.now() + 30_000;
  while (!portUrl && Date.now() < deadline) await sleep(200);
  if (!portUrl) throw new Error('vite did not become ready in 30s');
  portUrl = portUrl.replace(/\/$/, '');

  const browser = await chromium.launch({
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',
    timeout: 30_000,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--use-vulkan=swiftshader',
      '--disable-vulkan-surface',
      '--ignore-gpu-blocklist',
      '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis',
      '--autoplay-policy=user-gesture-required',
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const pageErrors = [];
    const consoleErrors = [];
    const consoleMessages = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
      console.error(`[smoke-browser] pageerror: ${error.message}`);
    });
    page.on('console', (message) => {
      consoleMessages.push(`${message.type()}: ${message.text()}`);
      if (message.type() === 'error' && !message.text().includes('404')) {
        consoleErrors.push(message.text());
        console.error(`[smoke-browser] console-error: ${message.text()}`);
      }
    });

    try {
      await page.goto(`${portUrl}/`, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForFunction(
        () => document.querySelector('#overlay')?.textContent?.includes('distance ='),
        undefined,
        { timeout: READINESS_TIMEOUT_MS, polling: 100 },
      );
      await page.waitForFunction(
        () => document.querySelector('#audio-status')?.textContent?.includes('audio='),
        undefined,
        { timeout: READINESS_TIMEOUT_MS, polling: 100 },
      );
    } catch (error) {
      const diagnostics = await readPageDiagnostics(page);
      const recentConsole = consoleMessages.slice(-20);
      throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(diagnostics)}; pageErrors=${JSON.stringify(pageErrors)}; console=${JSON.stringify(recentConsole)}`);
    }

    const initialStatus = await page.locator('#audio-status').textContent();
    const initialOverlay = await page.locator('#overlay').textContent();
    const beforePath = resolve(ARTIFACT_DIR, 'before-gesture.png');
    await page.screenshot({ path: beforePath });

    // A real keydown is the browser gesture consumed by WebAudioEngine's
    // one-shot resume listener; the keyup is also the demo's play trigger.
    await page.keyboard.down('Space');
    await page.waitForTimeout(100);
    await page.keyboard.up('Space');
    await page.waitForFunction(
      () => {
        const text = document.querySelector('#audio-status')?.textContent ?? '';
        return text.includes('audio=running') && /starts=[1-9]/.test(text);
      },
      undefined,
      { timeout: 30_000, polling: 100 },
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
      { timeout: 30_000, polling: 100 },
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
      { timeout: 30_000, polling: 100 },
    );
    const movedOverlay = await page.locator('#overlay').textContent();
    const afterPath = resolve(ARTIFACT_DIR, 'after-gesture-and-pan.png');
    await page.screenshot({ path: afterPath });
    const pixels = countChangedPixels(beforePath, afterPath);

    await closeWithTimeout('page', () => page.close());
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    if (pixels < 100) throw new Error(`gesture/pan produced too few changed pixels: ${pixels}`);

    console.log(`[smoke-browser] initial=${initialStatus} overlay=${initialOverlay}`);
    console.log(`[smoke-browser] afterGesture=${afterGestureStatus} moved=${movedOverlay}`);
    console.log(`[smoke-browser] collision=${collisionStatus} cleanupAudio=${cleanupAudioStatus}`);
    console.log(`[smoke-browser] artifacts: before=${beforePath} after=${afterPath}`);
    console.log(`[smoke-browser] PASS - real Chrome gesture resumed AudioContext, collision triggered spatial SFX, despawn cleaned audio, and listener pan moved; changedPixels=${pixels}.`);
  } finally {
    await closeWithTimeout('browser', () => browser.close());
  }
} catch (error) {
  failed = true;
  console.error(`[smoke-browser] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await stopVite();
  process.exit(process.exitCode ?? (failed ? 1 : 0));
}
