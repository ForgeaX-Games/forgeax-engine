// @perf-budget-skip: real generated game, asset cooking and Chromium interaction journey.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ExecutionReport } from '@forgeax/engine-app';
import { parseImage } from '@forgeax/engine-image/parse-image';
import { type Browser, chromium, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';
import { materializeTemplate } from '../templates/materialize.js';
import { allocateLoopbackPort } from '../tools/browser-host.js';

interface PlayerState {
  readonly position: readonly number[];
  readonly grounded: boolean;
  readonly camera: {
    readonly yaw: number;
    readonly pitch: number;
    readonly pointerLocked: boolean;
  };
  readonly simulation: { readonly fixedTick: number };
  readonly animation: { readonly walkWeight: number; readonly walkTime: number };
}

declare global {
  var __forgeaxGameInspection:
    | {
        list(): Promise<{ reads: string[] }>;
        read(id: string): Promise<PlayerState>;
        renderer(): { state: string; execution: ExecutionReport };
      }
    | undefined;
}

it('new game-3d defaults to combined workers with visible UI, input, physics and animation', async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), 'forgeax-new-worker-game-'));
  const root = resolve(scratch, 'game');
  const errors: string[] = [];
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  const previous = process.env.FORGEAX_EXECUTION_WORKERS;
  delete process.env.FORGEAX_EXECUTION_WORKERS;
  try {
    const generated = await materializeTemplate({
      templateRoot: resolve(import.meta.dirname, '../../../../templates/game-3d'),
      targetRoot: root,
      targetBasename: 'game',
    });
    if (!generated.ok) throw generated.error;
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'serve');
    const port = await allocateLoopbackPort();
    server = await createServer({
      ...config,
      server: { ...config.server, host: '127.0.0.1', port, strictPort: true },
    });
    await server.listen();
    const executablePath = [
      process.env.FORGEAX_BROWSER_EXECUTABLE,
      '/opt/google/chrome-beta/chrome',
      '/usr/bin/google-chrome',
      chromium.executablePath(),
    ].find((path): path is string => path !== undefined && existsSync(path));
    browser = await chromium.launch({
      headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
      ...(executablePath === undefined ? {} : { executablePath }),
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
        '--use-vulkan=swiftshader',
        '--use-angle=swiftshader',
        '--ignore-gpu-blocklist',
        '--disable-gpu-driver-bug-workarounds',
        '--disable-dawn-features=disallow_unsafe_apis',
      ],
    });
    page = await browser.newPage({ viewport: { width: 320, height: 180 } });
    const currentPage = page;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'commit', timeout: 120_000 });
    await expect
      .poll(
        () =>
          currentPage.evaluate(
            async () =>
              (await globalThis.__forgeaxGameInspection?.list())?.reads.includes(
                'game-3d.player',
              ) ?? false,
          ),
        { timeout: 120_000 },
      )
      .toBe(true);
    const read = async (): Promise<PlayerState> => {
      const state = await currentPage.evaluate(() =>
        globalThis.__forgeaxGameInspection?.read('game-3d.player'),
      );
      if (state === undefined) throw new Error('game-3d player projection missing');
      return state;
    };
    const report = await page.evaluate(
      () => globalThis.__forgeaxGameInspection?.renderer().execution,
    );
    expect(report?.workers.engine.enabled).toBe(true);
    expect(report?.workers.render.enabled).toBe(true);
    expect(report?.workers.kernels.enabled).toBe(true);
    await expect.poll(async () => (await read()).grounded, { timeout: 30_000 }).toBe(true);
    await page.waitForFunction(() => {
      const loading = document.querySelector('#forgeax-loading');
      return (
        loading !== null &&
        loading.getAttribute('data-fading') !== 'true' &&
        getComputedStyle(loading).display === 'none'
      );
    });
    const ui = page.locator('#game-ui [data-ui-slot="lock"]');
    expect(await ui.textContent()).toContain('Click to lock camera');
    expect(await page.locator('#game-ui > *').count()).toBe(1);
    await page.locator('#app').click({ position: { x: 40, y: 90 } });
    await expect
      .poll(async () => (await read()).camera.pointerLocked, { timeout: 10_000 })
      .toBe(true);
    expect(await ui.textContent()).toContain('Camera locked');
    const initial = await read();
    // Keep native pointer-lock admission; use the browser input event path for
    // deterministic relative motion under both Xvfb and headed Chrome.
    await page.locator('#app').evaluate((canvas) => {
      const event = new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'mouse',
        isPrimary: true,
      });
      Object.defineProperties(event, { movementX: { value: 40 }, movementY: { value: 12 } });
      canvas.dispatchEvent(event);
    });
    await expect
      .poll(async () => Math.abs((await read()).camera.yaw - initial.camera.yaw), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0.01);
    const beforeWalk = await read();
    await page.keyboard.down('KeyW');
    let walked: PlayerState;
    try {
      await expect
        .poll(
          async () => {
            const state = await read();
            return Math.hypot(
              (state.position[0] ?? 0) - (beforeWalk.position[0] ?? 0),
              (state.position[2] ?? 0) - (beforeWalk.position[2] ?? 0),
            );
          },
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0.3);
      walked = await read();
      expect(walked.animation.walkWeight).toBeGreaterThan(0);
      // Clip time wraps at its duration; progression is not monotonic.
      expect(walked.animation.walkTime).not.toBe(beforeWalk.animation.walkTime);
      expect(walked.simulation.fixedTick).toBeGreaterThan(beforeWalk.simulation.fixedTick);
    } finally {
      await page.keyboard.up('KeyW');
    }
    await page.keyboard.down('Space');
    try {
      await expect
        .poll(async () => (await read()).position[1] ?? 0, { timeout: 10_000 })
        .toBeGreaterThan((walked.position[1] ?? 0) + 0.2);
    } finally {
      await page.keyboard.up('Space');
    }
    await expect.poll(async () => (await read()).grounded, { timeout: 20_000 }).toBe(true);
    await page.keyboard.press('Escape');
    // CDP key events do not trigger Chrome's trusted browser Escape shortcut.
    // Exercise native unlock and its pointerlockchange event explicitly.
    await page.evaluate(() => document.exitPointerLock());
    await expect
      .poll(async () => (await read()).camera.pointerLocked, { timeout: 10_000 })
      .toBe(false);
    expect(await ui.textContent()).toContain('Click to lock camera');
    const evidence = resolve(
      import.meta.dirname,
      '../../../../artifacts/worker-execution-policy-3297/new-project',
    );
    const frameWaitStarted = performance.now();
    const framePage = page;
    const frameSamples: { elapsedMs: number; execution: ExecutionReport | null }[] = [];
    const sampleFrames = async () => {
      const execution = await framePage.evaluate(
        () => globalThis.__forgeaxGameInspection?.renderer().execution ?? null,
      );
      const sample = { elapsedMs: Math.round(performance.now() - frameWaitStarted), execution };
      frameSamples.push(sample);
      process.stdout.write(`[new-project-workers] frame-progress ${JSON.stringify(sample)}\n`);
    };
    await sampleFrames();
    let sampling = Promise.resolve();
    const sampleTimer = setInterval(() => {
      sampling = sampling.then(sampleFrames);
      // The finally block joins and reports sampling failures.
      void sampling.catch(() => {});
    }, 30_000);
    try {
      await page.waitForFunction(
        () =>
          (globalThis.__forgeaxGameInspection?.renderer().execution.render?.completedFrame ?? 0) >=
          300,
        undefined,
        { timeout: 240_000 },
      );
    } finally {
      clearInterval(sampleTimer);
      await sampling;
      await sampleFrames();
      await mkdir(evidence, { recursive: true });
      await writeFile(
        resolve(evidence, 'frame-progress.json'),
        JSON.stringify(frameSamples, null, 2),
      );
    }
    const pixels = parseImage(await page.locator('#app').screenshot(), 'image/png', {
      mipmap: false,
    });
    if (!pixels.ok) throw pixels.error;
    expect(new Set(pixels.value.bytes).size).toBeGreaterThan(32);
    expect(errors).toEqual([]);
    await page.screenshot({ path: resolve(evidence, 'game-3d.png') });
    await writeFile(
      resolve(evidence, 'report.json'),
      JSON.stringify(
        {
          initial,
          walked,
          final: await read(),
          frameSamples,
          report: await page.evaluate(() => globalThis.__forgeaxGameInspection?.renderer()),
          errors,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const state = await page
      ?.evaluate(() => ({
        fatal: document.querySelector('#forgeax-fatal-details')?.textContent,
        frame: document.documentElement.dataset.forgeaxFrameSubmitted,
        execution: globalThis.__forgeaxGameInspection?.renderer().execution,
      }))
      .catch(() => undefined);
    throw new Error(`${String(error)}\n${JSON.stringify({ state, errors })}`, { cause: error });
  } finally {
    await page?.close();
    await browser?.close();
    await server?.close();
    await rm(scratch, { recursive: true, force: true });
    if (previous === undefined) delete process.env.FORGEAX_EXECUTION_WORKERS;
    else process.env.FORGEAX_EXECUTION_WORKERS = previous;
  }
}, 360_000);
