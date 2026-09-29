import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ExecutionReport } from '@forgeax/engine-app';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { devCommand } from '../src/commands.js';
import { disposeDevKitHosts } from '../src/host.js';
// @ts-expect-error The template's shared browser probe is native JavaScript.
import { probeRuntimeVase } from '../../../templates/game-3d/scripts/runtime-vase-probe.mjs';

declare const __forgeaxGameInspection: {
  list(): Promise<{ reads: string[] }>;
  read(id: string): Promise<unknown>;
  renderer(): { state: string; frameId: number; execution: ExecutionReport };
};

it.for([false, true])('game-3d generates through its UI with Engine Worker=%s', { timeout: 420000 }, async (worker, { signal, onTestFinished }) => {
  const repository = resolve(import.meta.dirname, '../../..');
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-game3d-vase-'));
  const evidence = resolve(repository, 'artifacts/runtime-pack-worker', `game-3d-${worker ? 'worker' : 'main'}`);
  const previousWorkers = process.env.FORGEAX_EXECUTION_WORKERS;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const errors: string[] = [];
  const progress: unknown[] = [];
  const closeBrowser = () => browser?.close();
  const abortBrowser = () => { void closeBrowser()?.catch(() => {}); };
  signal.addEventListener('abort', abortBrowser, { once: true });
  onTestFinished(closeBrowser);
  const inspectWithinDeadline = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Game inspection exceeded 15 seconds')), 15_000);
      })]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await rm(evidence, { recursive: true, force: true });
    await mkdir(evidence, { recursive: true });
    await cp(resolve(repository, 'templates/game-3d/assets'), resolve(root, 'assets'), { recursive: true });
    await cp(resolve(repository, 'templates/game-3d/forge.json'), resolve(root, 'forge.json'));
    await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'game-3d-runtime-vase', type: 'module', dependencies: { '@forgeax/engine': '*' } }));
    await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
    await symlink(resolve(repository, 'packages/engine'), resolve(root, 'node_modules/@forgeax/engine'), 'dir');
    process.env.FORGEAX_EXECUTION_WORKERS = JSON.stringify({ engine: worker, render: false, kernels: false });
    const started = await devCommand({ root, port: 0, json: true });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    if (!started.ok) throw started.error;
    const url = (started.value as { urls: { local: string[] } }).urls.local[0]!;
    browser = await chromium.launch({
      executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE ?? '/opt/google/chrome-beta/chrome',
      headless: false,
      args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
        '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--enable-unsafe-swiftshader', '--disable-vulkan-surface', '--ignore-gpu-blocklist'],
    });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('requestfailed', request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.goto(url);
    await expect.poll(() => inspectWithinDeadline(page.evaluate(async () => {
      const inspect = typeof __forgeaxGameInspection === 'undefined' ? undefined : __forgeaxGameInspection;
      return inspect && (await inspect.list())?.reads?.includes('game-3d.runtime-vase');
    })), { timeout: 120_000 }).toBe(true);
    const read = () => inspectWithinDeadline(page.evaluate(() => __forgeaxGameInspection.read('game-3d.runtime-vase')));
    const result = await probeRuntimeVase(page, read, evidence);
    // Keep UI evidence at full size; use the existing template smoke resolution
    // for the software-GPU continuity gate.
    await page.setViewportSize({ width: 320, height: 180 });
    const snapshot = () => inspectWithinDeadline(page.evaluate(() => {
      const canvas = document.querySelector('canvas')!;
      const rect = canvas.getBoundingClientRect();
      return {
        renderer: __forgeaxGameInspection.renderer(),
        canvas: { width: canvas.width, height: canvas.height, cssWidth: rect.width,
          cssHeight: rect.height, dpr: devicePixelRatio },
      };
    }));
    await expect.poll(async () => (await snapshot()).canvas, { timeout: 30_000 })
      .toMatchObject({ width: 320, height: 180 });
    const startedAt = performance.now();
    const baseline = await snapshot();
    const rendererBefore = baseline.renderer;
    const validate = (sample: typeof baseline) => {
      const { renderer: current } = sample;
      expect(sample.canvas).toMatchObject({ width: 320, height: 180 });
      expect(current.state).toBe('alive');
      expect(current.execution.engine).toEqual({ realm: worker ? 'worker' : 'host', health: 'running' });
      expect(current.execution.world.identity).toBeTruthy();
      expect(current.execution.world).toMatchObject({ identity: rendererBefore.execution.world.identity,
        health: 'healthy', partialWrite: false });
      expect(current.execution.fault).toBeNull();
      expect(current.execution.render?.epoch).toBe(rendererBefore.execution.render?.epoch);
      if (current.execution.render) expect(current.execution.render.state).toBe('alive');
      expect(errors).toEqual([]);
    };
    const record = async (sample: typeof baseline) => {
      progress.push({ elapsedMs: performance.now() - startedAt, ...sample });
      // Write before assertions so unhealthy/stalled samples survive failure too.
      await writeFile(resolve(evidence, 'frame-progress.json'), JSON.stringify(progress, null, 2));
      validate(sample);
    };
    await record(baseline);
    let current = baseline;
    let previous = baseline;
    let previousSample = baseline;
    let sampledAt = startedAt;
    let stalledSamples = 0;
    const target = rendererBefore.execution.frame.completed + 60;
    while (current.renderer.execution.frame.completed < target && performance.now() - startedAt < 240_000) {
      await page.waitForTimeout(1_000);
      current = await snapshot();
      try {
        validate(current);
        expect(current.renderer.execution.frame.completed).toBeGreaterThanOrEqual(previous.renderer.execution.frame.completed);
        expect(current.renderer.execution.frame.submitted).toBeGreaterThanOrEqual(previous.renderer.execution.frame.submitted);
        expect(current.renderer.frameId).toBeGreaterThanOrEqual(previous.renderer.frameId);
      } catch (error) {
        await record(current);
        throw error;
      }
      previous = current;
      if (performance.now() - sampledAt >= 30_000) {
        await record(current);
        stalledSamples = current.renderer.execution.frame.completed === previousSample.renderer.execution.frame.completed
          ? stalledSamples + 1 : 0;
        expect(stalledSamples, 'No completed-frame progress for two consecutive 30-second samples').toBeLessThan(2);
        previousSample = current;
        sampledAt = performance.now();
      }
    }
    await record(current);
    const stable = current.renderer;
    expect(stable.execution.frame.completed).toBeGreaterThanOrEqual(target);
    await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ worker, ...result, rendererBefore, stable, errors }, null, 2));
  } catch (error) {
    await mkdir(evidence, { recursive: true });
    await writeFile(resolve(evidence, 'failure.json'), JSON.stringify({ errors, progress, message: String(error) }, null, 2));
    throw error;
  } finally {
    signal.removeEventListener('abort', abortBrowser);
    await browser?.close();
    await disposeDevKitHosts();
    if (previousWorkers === undefined) delete process.env.FORGEAX_EXECUTION_WORKERS;
    else process.env.FORGEAX_EXECUTION_WORKERS = previousWorkers;
    await rm(root, { recursive: true, force: true });
  }
});
