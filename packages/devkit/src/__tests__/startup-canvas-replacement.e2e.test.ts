// @perf-budget-skip: actual DOM propagation of generated startup receipts; no GPU qualification.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

it('enters the generated game after its canvas is replaced during startup', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-startup-canvas-'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await mkdir(resolve(root, 'assets'));
    await Promise.all([
      writeFile(resolve(root, 'package.json'), '{"name":"startup-canvas"}'),
      writeFile(
        resolve(root, 'forge.json'),
        JSON.stringify({
          id: 'startup-canvas',
          name: 'Startup canvas',
          schemaVersion: '3.0.0',
          roots: {},
        }),
      ),
      writeFile(resolve(root, 'main.ts'), 'export {};'),
    ]);
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    await createViteConfig(facts.value, 'build');
    const html = await readFile(resolve(root, '.forgeax/generated/index.html'), 'utf8');
    const executablePath = [
      process.env.FORGEAX_BROWSER_EXECUTABLE,
      '/opt/google/chrome-beta/chrome',
      chromium.executablePath(),
    ].find((path): path is string => path !== undefined && existsSync(path));
    browser = await chromium.launch({
      headless: true,
      ...(executablePath === undefined ? {} : { executablePath }),
      args: ['--disable-gpu', '--disable-software-rasterizer'],
    });
    const page = await browser.newPage();
    // Run the actual generated startup owner. Renderer/device qualification
    // remains in the unchanged generated-worker-game and browser/Dawn gates.
    await page.setContent(html.replace(/<script type="module">[\s\S]*?<\/script>/g, ''));
    const result = await page.evaluate(async () => {
      const startup = (
        globalThis as typeof globalThis & {
          __forgeaxStartup: {
            bindSession(session: string): void;
            prepare(): void;
            bindInput(callback: (enabled: boolean) => void): () => void;
          };
        }
      ).__forgeaxStartup;
      const retired = document.querySelector<HTMLCanvasElement>('#app');
      const loading = document.querySelector<HTMLElement>('#forgeax-loading');
      if (retired === null || loading === null)
        throw new Error('generated startup surface missing');
      let inputEnabled = false;
      startup.bindInput((enabled) => {
        inputEnabled = enabled;
      });
      startup.bindSession('world-1');
      startup.prepare();
      const emit = (
        target: HTMLCanvasElement,
        kind: string,
        frameId: number,
        presentation = 'ready',
      ) =>
        target.dispatchEvent(
          new CustomEvent(`forgeax:frame-${kind}`, {
            detail: { worldIdentity: 'world-1', deviceGeneration: 0, frameId, presentation },
          }),
        );
      emit(retired, 'submitted', 1);
      const current = retired.cloneNode(false) as HTMLCanvasElement;
      retired.replaceWith(current);
      emit(current, 'completed', 1);
      const unownedOldReceipt = loading.dataset.fading;
      emit(retired, 'submitted', 2);
      emit(retired, 'completed', 2, 'pending');
      emit(retired, 'completed', 2);
      const unrelated = document.createElement('canvas');
      document.body.append(unrelated);
      emit(unrelated, 'submitted', 2);
      emit(unrelated, 'completed', 2);
      const before = {
        display: loading.style.display,
        fading: loading.dataset.fading,
        inputEnabled,
      };
      emit(current, 'completed', 3);
      const unsubmitted = loading.dataset.fading;
      emit(current, 'submitted', 3);
      emit(current, 'completed', 3, 'pending');
      emit(current, 'completed', 3);
      const replayedPending = loading.dataset.fading;
      emit(current, 'submitted', 4);
      emit(current, 'completed', 4);
      const fading = loading.dataset.fading;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        before,
        unownedOldReceipt,
        unsubmitted,
        replayedPending,
        fading,
        display: loading.style.display,
        inputEnabled,
      };
    });
    expect(result).toEqual({
      before: { display: 'grid', fading: 'false', inputEnabled: false },
      unownedOldReceipt: 'false',
      unsubmitted: 'false',
      replayedPending: 'false',
      fading: 'true',
      display: 'none',
      inputEnabled: true,
    });
    for (const readyBeforeFade of [false, true]) {
      const fadingPage = await browser.newPage();
      await fadingPage.clock.install({ time: new Date('2026-10-05T00:00:00Z') });
      await fadingPage.clock.pauseAt(new Date('2026-10-05T00:01:00Z'));
      await fadingPage.setContent(html.replace(/<script type="module">[\s\S]*?<\/script>/g, ''));
      await fadingPage.evaluate((readyBefore) => {
        const startup = (
          globalThis as typeof globalThis & {
            __forgeaxStartup: {
              bindSession(session: string): void;
              prepare(): void;
              bindInput(callback: (enabled: boolean) => void): () => void;
            };
          }
        ).__forgeaxStartup;
        startup.bindInput((enabled) => {
          document.documentElement.dataset.testStartupInput = String(enabled);
        });
        startup.bindSession('world-1');
        startup.prepare();
        const oldCanvas = document.querySelector<HTMLCanvasElement>('#app');
        if (oldCanvas === null) throw new Error('startup canvas missing');
        const emit = (canvas: HTMLCanvasElement, frameId: number) => {
          for (const kind of ['submitted', 'completed'])
            canvas.dispatchEvent(
              new CustomEvent(`forgeax:frame-${kind}`, {
                detail: {
                  worldIdentity: 'world-1',
                  deviceGeneration: 0,
                  frameId,
                  presentation: 'ready',
                },
              }),
            );
        };
        emit(oldCanvas, 1);
        const replacement = oldCanvas.cloneNode(false) as HTMLCanvasElement;
        oldCanvas.replaceWith(replacement);
        if (readyBefore) emit(replacement, 2);
      }, readyBeforeFade);
      await fadingPage.clock.runFor(150);
      if (!readyBeforeFade) {
        expect(
          await fadingPage.evaluate(() => ({
            display: document.querySelector<HTMLElement>('#forgeax-loading')?.style.display,
            fading: document.querySelector<HTMLElement>('#forgeax-loading')?.dataset.fading,
            inputEnabled: document.documentElement.dataset.testStartupInput,
          })),
        ).toEqual({ display: 'grid', fading: 'false', inputEnabled: 'false' });
        await fadingPage.evaluate(() => {
          const canvas = document.querySelector('#app');
          if (canvas === null) throw new Error('replacement canvas missing');
          for (const kind of ['submitted', 'completed'])
            canvas.dispatchEvent(
              new CustomEvent(`forgeax:frame-${kind}`, {
                detail: {
                  worldIdentity: 'world-1',
                  deviceGeneration: 0,
                  frameId: 2,
                  presentation: 'ready',
                },
              }),
            );
        });
        await fadingPage.clock.runFor(150);
      }
      expect(
        await fadingPage.evaluate(() => ({
          display: document.querySelector<HTMLElement>('#forgeax-loading')?.style.display,
          inputEnabled: document.documentElement.dataset.testStartupInput,
        })),
      ).toEqual({ display: 'none', inputEnabled: 'true' });
      await fadingPage.close();
    }
  } finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
  }
});
