import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const browserMocks = vi.hoisted(() => {
  let captureReady: string | null = null;
  let rootChildren = 1;
  let openShadowRoots = 1;
  let engineFrameId = 1;
  let canvasRendered = true;
  const canvasScreenshot = vi.fn(async (options?: { readonly style?: string }) => {
    const overlayHidden = options?.style?.includes('visibility: hidden') === true;
    return Buffer.from(canvasRendered || !overlayHidden ? 'canvas-rendered' : 'canvas-black');
  });
  const page = {
    on: vi.fn(),
    goto: vi.fn(),
    waitForFunction: vi.fn(async (_predicate: unknown, value: unknown) => {
      if (typeof value === 'string') captureReady = value;
    }),
    waitForTimeout: vi.fn(),
    screenshot: vi.fn(async () => Buffer.from('compositor-png')),
    locator: vi.fn(() => ({ first: () => ({ screenshot: canvasScreenshot }) })),
    evaluate: vi.fn(async (callback: unknown) =>
      String(callback).includes('requestAdapter')
        ? {
            title: 'Persistent fixture',
            canvas: { width: 1280, height: 720 },
            domUi: { rootChildren, openShadowRoots, textWitness: rootChildren > 0 ? 'HUD' : '' },
            adapter: { device: 'SwiftShader Device (LLVM)' },
            adapterError: null,
            engineFrameId,
            captureReady,
            userAgent: 'Chrome Beta fixture',
          }
        : undefined,
    ),
  };
  const browser = {
    newPage: vi.fn(async () => page),
    version: vi.fn(() => '153.0.0.0'),
    close: vi.fn(),
  };
  const server = {
    resolvedUrls: { local: ['http://127.0.0.1:43123/'] },
    listen: vi.fn(),
    close: vi.fn(),
  };
  return {
    page,
    canvasScreenshot,
    browser,
    server,
    launch: vi.fn(async () => browser),
    createServer: vi.fn(async () => server),
    reset() {
      captureReady = null;
      rootChildren = 1;
      openShadowRoots = 1;
      engineFrameId = 1;
      canvasRendered = true;
      for (const mock of [
        page.on,
        page.goto,
        page.waitForFunction,
        page.waitForTimeout,
        page.screenshot,
        page.locator,
        canvasScreenshot,
        page.evaluate,
        browser.newPage,
        browser.version,
        browser.close,
        server.listen,
        server.close,
        this.launch,
        this.createServer,
      ]) {
        mock.mockClear();
      }
    },
    setUiWitness(nextRootChildren: number, nextOpenShadowRoots: number) {
      rootChildren = nextRootChildren;
      openShadowRoots = nextOpenShadowRoots;
    },
    setCanvasRendered(nextCanvasRendered: boolean) {
      canvasRendered = nextCanvasRendered;
    },
  };
});

vi.mock('playwright', () => ({ chromium: { launch: browserMocks.launch } }));
vi.mock('vite', () => ({ createServer: browserMocks.createServer }));
vi.mock('../host.js', () => ({ createViteConfig: vi.fn(async () => ({})) }));
vi.mock('@forgeax/engine-image/parse-image', () => ({
  parseImage: (encoded: Uint8Array) => {
    const bytes = new Uint8Array(16 * 16 * 4);
    const rendered = Buffer.from(encoded).toString() !== 'canvas-black';
    for (let index = 0; index < 16 * 16; index += 1) {
      const value = rendered && index % 2 === 0 ? 255 : 0;
      bytes.set([value, 255 - value, value, 255], index * 4);
    }
    return { ok: true, value: { bytes, width: 16, height: 16 } };
  },
}));

import { createBrowserCapture, createSoftwareBrowser } from '../software-capture.js';
import { execCommand } from '../tools/commands.js';

afterEach(() => {
  browserMocks.reset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('software browser session', () => {
  it('keeps one page alive across ordered named checkpoint captures', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('DISPLAY', ':fixture');
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-software-session-'));
    const executable = resolve(root, 'chrome-beta');
    await Promise.all([
      writeFile(executable, ''),
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'session-fixture',
          name: 'Session Fixture',
          schemaVersion: '1.0.0',
          entry: 'main.ts',
          plugins: [],
        })}\n`,
      ),
      writeFile(
        resolve(root, 'package.json'),
        `${JSON.stringify({ name: 'session-fixture', forgeax: { assets: { roots: [] } } })}\n`,
      ),
      writeFile(resolve(root, 'main.ts'), 'export default {};\n'),
    ]);

    const software = createSoftwareBrowser(root);
    const session = await software.open({
      software: true,
      browser: executable,
      deterministic: true,
      requireUi: true,
      runId: 'ordered-checkpoints',
    });

    const first = await session.capture('spawn');
    expect(browserMocks.browser.close).not.toHaveBeenCalled();
    const second = await session.capture('boss-hit');
    expect(browserMocks.browser.newPage).toHaveBeenCalledTimes(1);
    expect(browserMocks.page.screenshot).toHaveBeenCalledTimes(2);
    expect(browserMocks.canvasScreenshot).toHaveBeenCalledTimes(2);
    expect(first.output).toMatch(/001-spawn\.png$/);
    expect(second.output).toMatch(/002-boss-hit\.png$/);
    expect(session.report().captures.map((capture) => capture.checkpoint)).toEqual([
      'spawn',
      'boss-hit',
    ]);

    await session.close();
    expect(browserMocks.browser.close).toHaveBeenCalledTimes(1);
    expect(browserMocks.server.close).toHaveBeenCalledTimes(1);
    const report = JSON.parse(await readFile(session.reportPath, 'utf8'));
    expect(report).toMatchObject({
      schemaVersion: '2.0.0',
      ok: true,
      runId: 'ordered-checkpoints',
      captures: [
        { index: 1, checkpoint: 'spawn', ok: true },
        { index: 2, checkpoint: 'boss-hit', ok: true },
      ],
    });

    const generic = createBrowserCapture(root);
    const hardwareSession = await generic.open({
      backend: 'hardware',
      browser: executable,
      requireUi: true,
    });
    try {
      await expect(hardwareSession.capture('ready')).rejects.toMatchObject({
        code: 'browser-capture-runtime-failed',
      });
      expect(hardwareSession.report()).toMatchObject({
        backendRequested: 'hardware',
        backend: 'software',
        captures: [{ ok: false, checkpoint: 'ready' }],
      });
    } finally {
      await generic.close();
    }
  });

  it('adds the browser owner beside the existing operation client in exec', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-exec-browser-'));
    await Promise.all([
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'exec-browser-fixture',
          name: 'Exec Browser Fixture',
          schemaVersion: '1.0.0',
          entry: 'main.ts',
          plugins: [],
        })}\n`,
      ),
      writeFile(
        resolve(root, 'package.json'),
        `${JSON.stringify({ name: 'exec-browser-fixture', forgeax: { assets: { roots: [] } } })}\n`,
      ),
      writeFile(resolve(root, 'main.ts'), 'export default {};\n'),
      writeFile(
        resolve(root, 'scenario.mjs'),
        [
          'export default async function scenario(forgeax) {',
          '  return { browser: typeof forgeax.browser.open, operations: typeof forgeax.run };',
          '}',
          '',
        ].join('\n'),
      ),
    ]);

    await expect(execCommand({ root, program: 'scenario.mjs' })).resolves.toEqual({
      ok: true,
      value: { browser: 'function', operations: 'function' },
    });
  });

  it('does not treat ShadowRoots outside the game UI root as mounted game UI', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('DISPLAY', ':fixture');
    browserMocks.setUiWitness(0, 15);
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-software-ui-witness-'));
    const executable = resolve(root, 'chrome-beta');
    await Promise.all([
      writeFile(executable, ''),
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'ui-witness-fixture',
          name: 'UI Witness Fixture',
          schemaVersion: '1.0.0',
          entry: 'main.ts',
          plugins: [],
        })}\n`,
      ),
      writeFile(
        resolve(root, 'package.json'),
        `${JSON.stringify({ name: 'ui-witness-fixture', forgeax: { assets: { roots: [] } } })}\n`,
      ),
      writeFile(resolve(root, 'main.ts'), 'export default {};\n'),
    ]);

    const software = createSoftwareBrowser(root);
    const session = await software.open({
      software: true,
      browser: executable,
      deterministic: true,
      requireUi: true,
    });
    try {
      await expect(session.capture('ready')).rejects.toMatchObject({
        code: 'software-capture-runtime-failed',
      });
      expect(session.report().captures).toEqual([
        expect.objectContaining({
          ok: false,
          runtime: expect.objectContaining({
            domUi: { rootChildren: 0, openShadowRoots: 15, textWitness: '' },
          }),
        }),
      ]);
    } finally {
      await session.close();
    }
  });

  it('does not treat visible page UI as proof that the game canvas rendered', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(120_001);
    vi.stubEnv('DISPLAY', ':fixture');
    browserMocks.setCanvasRendered(false);
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-software-canvas-witness-'));
    const executable = resolve(root, 'chrome-beta');
    await Promise.all([
      writeFile(executable, ''),
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'canvas-witness-fixture',
          name: 'Canvas Witness Fixture',
          schemaVersion: '1.0.0',
          entry: 'main.ts',
          plugins: [],
        })}\n`,
      ),
      writeFile(
        resolve(root, 'package.json'),
        `${JSON.stringify({ name: 'canvas-witness-fixture', forgeax: { assets: { roots: [] } } })}\n`,
      ),
      writeFile(resolve(root, 'main.ts'), 'export default {};\n'),
    ]);

    const software = createSoftwareBrowser(root);
    const session = await software.open({
      software: true,
      browser: executable,
      deterministic: true,
      requireUi: true,
    });
    try {
      await expect(session.capture('ready')).rejects.toMatchObject({
        code: 'software-capture-runtime-failed',
      });
      expect(session.report().captures).toEqual([
        expect.objectContaining({
          ok: false,
          pixels: expect.objectContaining({ rendered: false }),
        }),
      ]);
      expect(browserMocks.page.screenshot).toHaveBeenCalled();
      expect(browserMocks.canvasScreenshot).toHaveBeenCalledWith(
        expect.objectContaining({ style: expect.stringContaining('visibility: hidden') }),
      );
    } finally {
      await session.close();
    }
  });
});
