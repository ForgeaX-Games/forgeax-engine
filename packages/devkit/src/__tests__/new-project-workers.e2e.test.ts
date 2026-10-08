// @perf-budget-skip: real generated game, asset cooking and Chromium interaction journey.
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ExecutionReport } from '@forgeax/engine-app';
import { parseImage } from '@forgeax/engine-image/parse-image';
import { vitePluginRhiDebug } from '@forgeax/engine-vite-plugin-rhi-debug';
import { type Browser, chromium, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';
import { writeProjectIdentity } from '../templates/materialize.js';
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
  var __forgeaxWorkerEvents: unknown[] | undefined;
  var __forgeaxWorkerPresentation:
    | {
        latestCompleted?: unknown;
        readyCount: number;
        firstReadyAtMs?: number;
        loadingWaitStartedAtMs?: number;
      }
    | undefined;
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
  const iblDiagnostic =
    process.env.FOCUS_SELECTOR ===
    'packages/devkit/src/__tests__/view-ibl-startup-diagnostic.integration.test.ts';
  const iblEvents: unknown[] = [];
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  const previous = process.env.FORGEAX_EXECUTION_WORKERS;
  delete process.env.FORGEAX_EXECUTION_WORKERS;
  try {
    await cp(resolve(import.meta.dirname, '../../../../templates/game-3d'), root, {
      recursive: true,
    });
    if (process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1') {
      // This journey checks assembly and interaction at 320x180. Keep all
      // three shadow cascades, but avoid twelve million shadow texels per
      // frame in software WebGPU. Only the disposable test project changes.
      const scenePath = resolve(root, 'assets/scene.pack.ts');
      const scene = await readFile(scenePath, 'utf8');
      expect(scene).toContain('mapSize: 2048,');
      await writeFile(scenePath, scene.replace('mapSize: 2048,', 'mapSize: 256,'));
    }
    await writeProjectIdentity(root, { id: 'game', name: 'game', packageName: '@local/game' });
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'serve');
    if (iblDiagnostic) {
      const observer = await readFile(
        resolve(import.meta.dirname, 'fixtures/ibl-startup-observer.mjs'),
        'utf8',
      );
      const preload = `${observer.replace('export function', 'function')}\nobserveIblStartup();\n`;
      config.plugins = [
        ...(config.plugins ?? []),
        vitePluginRhiDebug({ rootDir: root }),
        {
          name: 'view-ibl-startup-diagnostic',
          enforce: 'pre',
          transform(code, id) {
            if (/\/(?:render|engine)-worker-runtime\.mjs(?:\?|$)/.test(id)) {
              process.stdout.write(
                `[view-ibl-transform] ${JSON.stringify({ entry: id.split('/').at(-1)?.split('?')[0] })}\n`,
              );
              return preload + code;
            }
            if (id.includes('/.forgeax/generated/') && code.includes('const app = result.value;'))
              return (
                preload +
                code.replace(
                  'const app = result.value;',
                  `const app = result.value;
              globalThis.__viewStartupCapture = () => app.remoteEval(\`return (async () => {
                if (!rhiCapture) return {ok:false,error:{code:'capture-unavailable'}};
                const captured = await rhiCapture.captureFrame({snapshotTimeoutMs:120000});
                return captured.ok ? rhiCapture.upload(captured.value, {runId:'view-ibl-startup-diagnostic'}) : captured;
              })();\`);`,
                )
              );
            return undefined;
          },
        },
      ];
    }
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
        '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
      ],
    });
    page = await browser.newPage({ viewport: { width: 320, height: 180 } });
    const currentPage = page;
    await page.addInitScript(() => {
      const NativeWorker = Worker;
      globalThis.__forgeaxWorkerEvents = [];
      globalThis.__forgeaxWorkerPresentation = { readyCount: 0 };
      globalThis.Worker = class extends NativeWorker {
        constructor(...args: ConstructorParameters<typeof NativeWorker>) {
          super(...args);
          this.addEventListener('message', (event) => {
            const kind = event.data?.kind;
            const presentation = globalThis.__forgeaxWorkerPresentation;
            if (kind === 'render-complete' && presentation) {
              presentation.latestCompleted = { atMs: performance.now(), message: event.data };
              if (event.data.frame?.presentation === 'ready') {
                presentation.readyCount++;
                presentation.firstReadyAtMs ??= performance.now();
              }
            }
            if (
              ![
                'render-ready',
                'render-submitted',
                'render-complete',
                'render-lost',
                'fault',
              ].includes(kind)
            )
              return;
            const events = globalThis.__forgeaxWorkerEvents;
            if (events && (events.length < 64 || kind === 'render-lost' || kind === 'fault'))
              events.push({ atMs: performance.now(), message: event.data });
          });
        }
      };
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (iblDiagnostic && message.text().startsWith('[view-ibl-startup]')) {
        const event = JSON.parse(message.text().slice('[view-ibl-startup]'.length));
        iblEvents.push(event);
        process.stdout.write(`[view-ibl-startup] ${JSON.stringify(event)}\n`);
      }
      if (message.type() === 'error') {
        errors.push(message.text());
        process.stderr.write(`[generated-game] ${message.text()}\n`);
      }
    });
    await page.goto(`http://127.0.0.1:${port}/${iblDiagnostic ? '?forgeax-rhi-capture=1' : ''}`, {
      waitUntil: 'commit',
      timeout: 120_000,
    });
    await expect
      .poll(
        () =>
          currentPage.evaluate(
            async () =>
              (
                await Promise.race([
                  globalThis.__forgeaxGameInspection?.list(),
                  new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
                ])
              )?.reads.includes('game-3d.player') ?? false,
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
    await page.evaluate(() => {
      if (globalThis.__forgeaxWorkerPresentation)
        globalThis.__forgeaxWorkerPresentation.loadingWaitStartedAtMs = performance.now();
    });
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
    await page.locator('#game-ui [data-ui-action="language-fr"]').click();
    await expect
      .poll(() => currentPage.locator('#game-ui [data-ui-part="guide-title"]').textContent())
      .toBe('Prototype 3C');
    expect((await read()).camera.pointerLocked).toBe(false);
    await page.locator('#game-ui [data-ui-action="language-en"]').click();
    await expect.poll(() => ui.textContent()).toContain('Click to lock camera');
    // Native canvas input must start outside the interactive guide's language buttons.
    await page.locator('#app').click({ position: { x: 4, y: 4 } });
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
      // CI qualifies sixty completed real frames; the 300-frame soak remains
      // available outside CI. Keep the complete interaction and resize journey.
      const completedFrames = process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 60 : 300;
      await page.waitForFunction(
        (frames) =>
          (globalThis.__forgeaxGameInspection?.renderer().execution.render?.completedFrame ?? 0) >=
          frames,
        completedFrames,
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
    const framesBeforeResize =
      (await page.evaluate(
        () => globalThis.__forgeaxGameInspection?.renderer().execution.render?.completedFrame,
      )) ?? 0;
    await page.setViewportSize(
      process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1'
        ? { width: 640, height: 360 }
        : { width: 1280, height: 720 },
    );
    await page.waitForFunction(
      (before) =>
        (globalThis.__forgeaxGameInspection?.renderer().execution.render?.completedFrame ?? 0) >=
        before + 60,
      framesBeforeResize,
      // The outer 480-second deadline and sixty completed resized frames remain.
      { timeout: 240_000 },
    );
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
          workerPresentation: await page.evaluate(() => globalThis.__forgeaxWorkerPresentation),
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
        workerEvents: globalThis.__forgeaxWorkerEvents,
        workerPresentation: globalThis.__forgeaxWorkerPresentation,
        loading: (() => {
          const element = document.querySelector('#forgeax-loading');
          return element === null
            ? null
            : {
                fading: element.getAttribute('data-fading'),
                display: getComputedStyle(element).display,
              };
        })(),
      }))
      .catch(() => undefined);
    const failureEvidence = resolve(
      import.meta.dirname,
      '../../../../artifacts/worker-execution-policy-3297/new-project',
    );
    await mkdir(failureEvidence, { recursive: true });
    await writeFile(
      resolve(failureEvidence, 'failure.json'),
      JSON.stringify({ error: String(error), state, errors }, null, 2),
    );
    await page?.screenshot({ path: resolve(failureEvidence, 'failure.png') }).catch(() => {});
    if (iblDiagnostic) {
      const diagnosticRoot = resolve(
        import.meta.dirname,
        '../../../../artifacts/ci-focus/view-ibl-startup',
      );
      await mkdir(diagnosticRoot, { recursive: true });
      const captureStartedAt = Date.now();
      let captureTimer: ReturnType<typeof setTimeout> | undefined;
      const capturePromise = page
        ?.evaluate(async () => {
          const capture = (
            globalThis as typeof globalThis & { __viewStartupCapture?: () => Promise<unknown> }
          ).__viewStartupCapture;
          if (!capture) return { ok: false, error: { code: 'capture-unavailable' } };
          const result = await capture();
          return {
            ...(typeof result === 'object' && result !== null ? result : { result }),
            stateAfterCapture: globalThis.__forgeaxGameInspection?.renderer(),
          };
        })
        .catch((cause) => ({ ok: false, error: String(cause) }));
      const captured = await Promise.race([
        capturePromise,
        new Promise((resolve) => {
          captureTimer = setTimeout(
            () => resolve({ ok: false, error: { code: 'diagnostic-capture-timeout' } }),
            120_000,
          );
        }),
      ]).finally(() => clearTimeout(captureTimer));
      const captureFinishedAt = Date.now();
      await writeFile(
        resolve(diagnosticRoot, 'observations.json'),
        JSON.stringify(
          {
            diagnosticOnly: true,
            error: String(error),
            state,
            iblEvents,
            captured,
            captureStartedAt,
            captureFinishedAt,
            errors,
          },
          null,
          2,
        ),
      );
      const capturePath = (captured as { ok?: boolean; value?: { path?: string } } | undefined)
        ?.value?.path;
      if (capturePath) await cp(capturePath, resolve(diagnosticRoot, 'diagnostic-frame.rhitape'));
    }
    throw new Error(`${String(error)}\n${JSON.stringify({ state, errors })}`, { cause: error });
  } finally {
    await page?.close();
    await browser?.close();
    await server?.close();
    await rm(scratch, { recursive: true, force: true });
    if (previous === undefined) delete process.env.FORGEAX_EXECUTION_WORKERS;
    else process.env.FORGEAX_EXECUTION_WORKERS = previous;
  }
}, 480_000);
