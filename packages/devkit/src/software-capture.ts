import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { FORGEAX_FRAME_SUBMITTED_DATASET } from '@forgeax/engine-app';
import { parseImage } from '@forgeax/engine-image/parse-image';
import { type Browser, chromium, type Page } from 'playwright';
import type { ViteDevServer } from 'vite';
import { createViteConfig } from './host.js';
import { commandError, readProjectFacts } from './project.js';
import type {
  BrowserCaptureOptions,
  CaptureBackend,
  CommandError,
  CommandResult,
  SoftwareCaptureOptions,
} from './types.js';

interface VirtualDisplay {
  readonly value?: string;
  close(): Promise<void>;
}

export interface CapturePixelWitness {
  readonly width: number;
  readonly height: number;
  readonly sampledPixels: number;
  readonly lumaMin: number;
  readonly lumaMax: number;
  readonly lumaRange: number;
  readonly varyingPixels: number;
  readonly rendered: boolean;
}

export interface SoftwareCaptureRuntimeWitness {
  readonly title: string;
  readonly canvas: { readonly width: number; readonly height: number } | null;
  readonly domUi: {
    readonly rootChildren: number;
    readonly openShadowRoots: number;
    readonly textWitness: string;
  };
  readonly adapter: Readonly<Record<string, unknown>> | null;
  readonly adapterError: string | null;
  readonly engineFrameId: number | null;
  readonly captureReady: string | null;
  readonly userAgent: string;
}

export interface SoftwareCaptureRecord {
  readonly index: number;
  readonly checkpoint: string | null;
  readonly ok: boolean;
  readonly output: string;
  readonly digest: string;
  readonly pixels: CapturePixelWitness;
  readonly runtime: SoftwareCaptureRuntimeWitness;
}

export interface SoftwareCaptureRunReport {
  readonly schemaVersion: '2.0.0';
  readonly runId: string;
  readonly ok: boolean;
  readonly mode: 'browser-compositor' | 'advanced-cpu-only-development';
  readonly root: string;
  readonly url: string;
  readonly report: string;
  readonly backendRequested: CaptureBackend;
  readonly backend: 'software' | 'hardware' | 'unknown';
  /** @deprecated Read `backendRequested` instead. */
  readonly softwareRequested: boolean;
  readonly deterministicRequested: boolean;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly deviceScaleFactor: 1;
    readonly colorProfile: 'srgb';
    readonly colorScheme: 'light';
    readonly locale: 'en-US';
    readonly timezone: 'UTC';
  };
  readonly browser: { readonly version: string; readonly executable: string };
  readonly display: string | null;
  readonly lavapipeIcd: string | null;
  readonly captures: readonly SoftwareCaptureRecord[];
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  readonly closedAt?: string;
  readonly boundary: string;
}

export interface SoftwareBrowserOpenOptions {
  /** `auto` preserves the host/browser lane; the other values are assertions. */
  readonly backend?: CaptureBackend;
  /** @deprecated Use `backend: 'software'`. */
  readonly software?: boolean;
  readonly browser?: string;
  readonly width?: number;
  readonly height?: number;
  readonly port?: number;
  readonly requireUi?: boolean;
  readonly deterministic?: boolean;
  readonly outputDir?: string;
  readonly report?: string;
  readonly runId?: string;
  readonly headless?: boolean;
}

export interface SoftwareCaptureCheckpointOptions {
  readonly output?: string;
  readonly waitMs?: number;
  readonly requireUi?: boolean;
}

export interface SoftwareBrowserSession {
  readonly page: Page;
  readonly url: string;
  readonly reportPath: string;
  capture(
    checkpoint?: string,
    options?: SoftwareCaptureCheckpointOptions,
  ): Promise<SoftwareCaptureRecord>;
  report(): SoftwareCaptureRunReport;
  close(): Promise<void>;
}

export interface SoftwareBrowser {
  open(options: SoftwareBrowserOpenOptions): Promise<SoftwareBrowserSession>;
  close(): Promise<void>;
}

/** General browser-compositor capture surface. */
export type BrowserCaptureRuntimeWitness = SoftwareCaptureRuntimeWitness;
export type BrowserCaptureRecord = SoftwareCaptureRecord;
export type BrowserCaptureRunReport = SoftwareCaptureRunReport;
export type BrowserCaptureOpenOptions = SoftwareBrowserOpenOptions;
export type BrowserCaptureCheckpointOptions = SoftwareCaptureCheckpointOptions;
export type BrowserCaptureSession = SoftwareBrowserSession;
export type BrowserCapture = SoftwareBrowser;

class SoftwareCaptureError extends Error implements CommandError {
  constructor(
    readonly code: string,
    readonly expected: string,
    readonly hint: string,
    readonly detail: Readonly<Record<string, unknown>>,
  ) {
    super(`${code}: ${hint}`);
    this.name = 'SoftwareCaptureError';
  }
}

function fail(
  code: string,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>> = {},
): never {
  throw new SoftwareCaptureError(code, expected, hint, detail);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function reservePort(): Promise<number> {
  const reservation = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    reservation.once('error', rejectListen);
    reservation.listen(0, '127.0.0.1', resolveListen);
  });
  const address = reservation.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose, rejectClose) => {
    reservation.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
  if (port === 0) throw new Error('OS did not assign an ephemeral capture port');
  return port;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolveStop();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

async function startVirtualDisplay(width: number, height: number): Promise<VirtualDisplay> {
  if (process.platform !== 'linux' || process.env.DISPLAY !== undefined) {
    return {
      ...(process.env.DISPLAY === undefined ? {} : { value: process.env.DISPLAY }),
      async close() {},
    };
  }
  for (let offset = 0; offset < 100; offset += 1) {
    const number = 90 + ((process.pid + offset) % 100);
    const socket = `/tmp/.X11-unix/X${number}`;
    const lock = `/tmp/.X${number}-lock`;
    if ((await pathExists(socket)) || (await pathExists(lock))) continue;
    const display = `:${number}`;
    const child = spawn(
      'Xvfb',
      [display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let diagnostic = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      diagnostic += chunk;
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(
          () => rejectReady(new Error(`Xvfb did not create ${socket}: ${diagnostic.trim()}`)),
          5_000,
        );
        const poll = setInterval(() => {
          void pathExists(socket).then((exists) => {
            if (!exists) return;
            clearTimeout(timeout);
            clearInterval(poll);
            resolveReady();
          });
        }, 50);
        child.once('error', (error) => {
          clearTimeout(timeout);
          clearInterval(poll);
          rejectReady(error);
        });
        child.once('exit', (code, signal) => {
          clearTimeout(timeout);
          clearInterval(poll);
          rejectReady(
            new Error(`Xvfb exited before ready (${code ?? signal}): ${diagnostic.trim()}`),
          );
        });
      });
      return { value: display, close: () => stopProcess(child) };
    } catch (cause) {
      await stopProcess(child);
      throw cause;
    }
  }
  throw new Error('no free X11 display number was available for browser capture');
}

async function lavapipeIcd(): Promise<string | undefined> {
  for (const candidate of [
    '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json',
    '/usr/share/vulkan/icd.d/lvp_icd.aarch64.json',
  ]) {
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

function evidencePath(output: string): string {
  return output.toLowerCase().endsWith('.png') ? `${output.slice(0, -4)}.json` : `${output}.json`;
}

function newRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

function checkpointSlug(checkpoint: string | undefined): string {
  const value = (checkpoint ?? 'capture')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return value.length === 0 ? 'capture' : value;
}

function captureDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

type CaptureBackendObserved = 'software' | 'hardware' | 'unknown';

function observedBackend(runtime: SoftwareCaptureRuntimeWitness): CaptureBackendObserved {
  if (runtime.adapter === null) return 'unknown';
  return isSoftwareAdapter(runtime) ? 'software' : 'hardware';
}

async function resolveBrowserExecutable(
  requested: string | undefined,
): Promise<string | undefined> {
  if (requested !== undefined && requested.length > 0) {
    return (await pathExists(requested)) ? requested : undefined;
  }
  const candidates = [
    process.env.FORGEAX_BROWSER_EXECUTABLE,
    '/opt/google/chrome-beta/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  // Playwright can supply a managed browser when its browser cache is present.
  // Leave executablePath unset so the caller receives Playwright's own diagnostic
  // rather than a misleading Chrome-Beta-only error.
  return undefined;
}

function browserLaunchArgs(backend: CaptureBackend): string[] {
  const common = [
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--disable-gpu-driver-bug-workarounds',
    '--force-color-profile=srgb',
    '--force-device-scale-factor=1',
  ];
  if (backend !== 'software') return common;
  return [
    ...common,
    '--enable-features=Vulkan',
    '--use-vulkan=swiftshader',
    '--use-angle=swiftshader',
    '--disable-vulkan-surface',
  ];
}

export function summarizeCapturePixels(
  rgba: Uint8Array,
  width: number,
  height: number,
): CapturePixelWitness {
  const pixelCount = width * height;
  const stride = Math.max(1, Math.floor(pixelCount / 4096));
  const histogram = new Uint32Array(16);
  let lumaMin = 255;
  let lumaMax = 0;
  let sampledPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const offset = pixel * 4;
    const red = rgba[offset];
    const green = rgba[offset + 1];
    const blue = rgba[offset + 2];
    if (red === undefined || green === undefined || blue === undefined) break;
    const luma = Math.round((54 * red + 183 * green + 19 * blue) / 256);
    lumaMin = Math.min(lumaMin, luma);
    lumaMax = Math.max(lumaMax, luma);
    const bucket = Math.min(15, Math.floor(luma / 16));
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
    sampledPixels += 1;
  }
  const dominantPixels = histogram.reduce((largest, count) => Math.max(largest, count), 0);
  const varyingPixels = sampledPixels - dominantPixels;
  const lumaRange = lumaMax - lumaMin;
  const requiredVariation = Math.min(sampledPixels, Math.max(8, Math.ceil(sampledPixels * 0.002)));
  return {
    width,
    height,
    sampledPixels,
    lumaMin,
    lumaMax,
    lumaRange,
    varyingPixels,
    rendered: lumaRange >= 8 && varyingPixels >= requiredVariation,
  };
}

function inspectCapturePng(png: Uint8Array): CapturePixelWitness {
  const decoded = parseImage(png, 'image/png', { mipmap: false });
  if (!decoded.ok) throw decoded.error;
  return summarizeCapturePixels(decoded.value.bytes, decoded.value.width, decoded.value.height);
}

async function screenshotWithWitness(
  page: Page,
): Promise<{ readonly png: Uint8Array; readonly pixels: CapturePixelWitness }> {
  const canvasPng = await page.locator('canvas').first().screenshot({
    type: 'png',
    style: '* { visibility: hidden !important; } canvas { visibility: visible !important; }',
  });
  const png = await page.screenshot({ type: 'png', caret: 'hide' });
  return { png, pixels: inspectCapturePng(canvasPng) };
}

async function waitForCompositor(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
  });
}

async function runtimeWitness(page: Page): Promise<SoftwareCaptureRuntimeWitness> {
  return page.evaluate(async (datasetKey) => {
    const canvas = document.querySelector('canvas');
    const uiRoot = document.querySelector('#game-ui');
    const shadowHosts = [...(uiRoot?.querySelectorAll('*') ?? [])].filter(
      (element) => element.shadowRoot?.childElementCount !== 0,
    );
    let adapter: Readonly<Record<string, unknown>> | null = null;
    let adapterError: string | null = null;
    try {
      const gpuAdapter = await navigator.gpu?.requestAdapter();
      if (gpuAdapter === null || gpuAdapter === undefined) {
        adapterError = 'navigator.gpu.requestAdapter() returned null';
      } else {
        const info = gpuAdapter.info;
        adapter = {
          vendor: info.vendor,
          architecture: info.architecture,
          device: info.device,
          description: info.description,
        };
      }
    } catch (cause) {
      adapterError = String(cause);
    }
    const frameId = Number(document.documentElement.dataset[datasetKey]);
    return {
      title: document.title,
      canvas:
        canvas instanceof HTMLCanvasElement ? { width: canvas.width, height: canvas.height } : null,
      domUi: {
        rootChildren: uiRoot?.childElementCount ?? 0,
        openShadowRoots: shadowHosts.length,
        textWitness: shadowHosts
          .map((host) => host.shadowRoot?.textContent?.replace(/\s+/g, ' ').trim() ?? '')
          .filter((text) => text.length > 0)
          .join(' | ')
          .slice(0, 500),
      },
      adapter,
      adapterError,
      engineFrameId: Number.isSafeInteger(frameId) && frameId > 0 ? frameId : null,
      captureReady: document.documentElement.dataset.forgeaxCaptureReady ?? null,
      userAgent: navigator.userAgent,
    };
  }, FORGEAX_FRAME_SUBMITTED_DATASET);
}

function isSoftwareAdapter(runtime: SoftwareCaptureRuntimeWitness): boolean {
  const witness = Object.values(runtime.adapter ?? {})
    .map((value) => String(value).toLowerCase())
    .join(' ');
  return ['swiftshader', 'llvmpipe', 'lavapipe', 'software'].some((token) =>
    witness.includes(token),
  );
}

async function writeRunReport(report: SoftwareCaptureRunReport): Promise<void> {
  await mkdir(dirname(report.report), { recursive: true });
  await writeFile(report.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function openBrowserCaptureSession(
  root: string,
  options: BrowserCaptureOpenOptions,
): Promise<BrowserCaptureSession> {
  const backend: CaptureBackend =
    options.backend ?? (options.software === true ? 'software' : 'auto');
  if (
    options.software === true &&
    options.backend !== undefined &&
    options.backend !== 'software'
  ) {
    fail(
      'browser-capture-option-conflict',
      'software and backend options to describe the same capture lane',
      'Use either software: true or backend: software; use backend: auto for a portable capture.',
      { software: options.software, backend: options.backend },
    );
  }
  const facts = await readProjectFacts(root);
  if (!facts.ok) {
    throw new SoftwareCaptureError(
      facts.error.code,
      facts.error.expected,
      facts.error.hint,
      facts.error.detail,
    );
  }
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const browserPath = await resolveBrowserExecutable(options.browser);
  if (options.browser !== undefined && browserPath === undefined) {
    fail(
      'browser-capture-browser-missing',
      `a runnable browser at ${options.browser}`,
      'Install Chrome/Chromium or pass --browser with an executable path.',
      { browser: options.browser },
    );
  }

  const id = options.runId ?? newRunId();
  const outputDirectory = resolve(
    facts.value.root,
    options.outputDir ?? `artifacts/playthrough/${id}`,
  );
  const reportPath = resolve(
    facts.value.root,
    options.report ?? resolve(outputDirectory, 'run.json'),
  );
  const port =
    options.port === undefined || options.port === 0 ? await reservePort() : options.port;
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let display: VirtualDisplay | undefined;
  try {
    const { createServer } = await import('vite');
    server = await createServer(
      await createViteConfig(facts.value, 'serve', '/', {
        server: { port, strictPort: true },
      }),
    );
    await server.listen(port);
    display = await startVirtualDisplay(width, height);
    const captureDisplay = display;
    const icd = await lavapipeIcd();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const hasDisplay = display.value !== undefined;
    const headless = options.headless ?? (!hasDisplay && process.platform !== 'linux');
    const baseUrl = new URL(server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${port}/`);
    const openPage = async (
      launchBackend: CaptureBackend,
    ): Promise<SoftwareCaptureRuntimeWitness> => {
      const browserEnvironment: Record<string, string> = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ...(launchBackend === 'software' ? { LIBGL_ALWAYS_SOFTWARE: '1' } : {}),
        ...(captureDisplay.value === undefined ? {} : { DISPLAY: captureDisplay.value }),
      };
      const launchOptions = {
        headless,
        env: browserEnvironment,
        args: browserLaunchArgs(launchBackend),
        ...(browserPath === undefined ? {} : { executablePath: browserPath }),
      };
      browser = await chromium.launch(launchOptions);
      page = await browser.newPage({
        viewport: { width, height },
        screen: { width, height },
        deviceScaleFactor: 1,
        colorScheme: 'light',
        locale: 'en-US',
        timezoneId: 'UTC',
        serviceWorkers: 'block',
      });
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(String(error)));
      const captureUrl = new URL(baseUrl.href);
      if (options.deterministic === true) captureUrl.searchParams.set('forgeaxCapture', '1');
      await page.goto(captureUrl.href, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForFunction(
        (requireUi) => {
          const canvas = document.querySelector('canvas');
          if (!(canvas instanceof HTMLCanvasElement) || canvas.width <= 0 || canvas.height <= 0)
            return false;
          if (!requireUi) return true;
          const uiRoot = document.querySelector('#game-ui');
          return uiRoot !== null && uiRoot.childElementCount > 0;
        },
        options.requireUi === true,
        { timeout: 120_000 },
      );
      return runtimeWitness(page);
    };

    // Auto first preserves a physical adapter. If WebGPU is unavailable, retry
    // once through the same explicit software lane used by CPU-only hosts. This
    // keeps the public capture contract portable without masking a flat frame.
    const initialLaunchBackend: CaptureBackend = backend === 'software' ? 'software' : 'hardware';
    let runtime = await openPage(initialLaunchBackend);
    let observed = observedBackend(runtime);
    if (backend === 'auto' && runtime.adapter === null) {
      await browser?.close();
      browser = undefined;
      page = undefined;
      consoleErrors.length = 0;
      pageErrors.length = 0;
      runtime = await openPage('software');
      observed = observedBackend(runtime);
    }
    const captureUrl = new URL(baseUrl.href);
    if (options.deterministic === true) captureUrl.searchParams.set('forgeaxCapture', '1');
    if (page === undefined || browser === undefined) {
      fail(
        'browser-capture-browser-unavailable',
        'the browser capture session to open',
        'Inspect the browser launch diagnostic and retry with --browser or --headless.',
      );
    }

    const captures: SoftwareCaptureRecord[] = [];
    let closed = false;
    const report: SoftwareCaptureRunReport = {
      schemaVersion: '2.0.0',
      runId: id,
      ok: false,
      mode: 'browser-compositor',
      root: facts.value.root,
      url: captureUrl.href,
      report: reportPath,
      backendRequested: backend,
      backend: observed,
      softwareRequested: backend === 'software',
      deterministicRequested: options.deterministic === true,
      viewport: {
        width,
        height,
        deviceScaleFactor: 1,
        colorProfile: 'srgb',
        colorScheme: 'light',
        locale: 'en-US',
        timezone: 'UTC',
      },
      browser: { version: browser.version(), executable: browserPath ?? 'playwright-managed' },
      display: display.value ?? null,
      lavapipeIcd: icd ?? null,
      captures,
      consoleErrors,
      pageErrors,
      boundary:
        'Browser-compositor capture is visual iteration evidence, not physical-GPU performance, HDR-display output, or release acceptance.',
    };
    await writeRunReport(report);

    const updateReport = async (): Promise<void> => {
      Object.assign(report, {
        ok:
          captures.length > 0 &&
          captures.every((capture) => capture.ok) &&
          consoleErrors.length === 0 &&
          pageErrors.length === 0,
      });
      await writeRunReport(report);
    };
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([browser?.close(), display?.close(), server?.close()]);
      Object.assign(report, { closedAt: new Date().toISOString() });
      await updateReport();
    };

    return {
      page,
      url: captureUrl.href,
      reportPath,
      async capture(checkpoint, captureOptions = {}) {
        if (closed) {
          fail(
            'browser-capture-session-closed',
            'capture to run inside an open browser session',
            'Open one session, complete all checkpoints, then close it.',
            { report: reportPath },
          );
        }
        const activePage = page;
        if (activePage === undefined) {
          fail(
            'browser-capture-browser-unavailable',
            'an open Playwright page',
            'Inspect the browser launch diagnostic and retry the capture.',
          );
        }
        const expectedReady = checkpoint ?? (options.deterministic === true ? 'true' : undefined);
        await activePage.waitForFunction(
          ({ datasetKey }) => Number(document.documentElement.dataset[datasetKey]) > 0,
          { datasetKey: FORGEAX_FRAME_SUBMITTED_DATASET },
          { timeout: 120_000 },
        );
        if (expectedReady !== undefined) {
          await activePage.waitForFunction(
            (expected) => document.documentElement.dataset.forgeaxCaptureReady === expected,
            expectedReady,
            { timeout: 120_000 },
          );
        }
        await waitForCompositor(activePage);
        let captured = await screenshotWithWitness(activePage);
        const deadline = Date.now() + 120_000;
        while (!captured.pixels.rendered && Date.now() < deadline) {
          await activePage.waitForTimeout(500);
          await waitForCompositor(activePage);
          captured = await screenshotWithWitness(activePage);
        }
        const waitMs = captureOptions.waitMs ?? 0;
        if (waitMs > 0) {
          await activePage.waitForTimeout(waitMs);
          await waitForCompositor(activePage);
          captured = await screenshotWithWitness(activePage);
          while (!captured.pixels.rendered && Date.now() < deadline) {
            await activePage.waitForTimeout(500);
            await waitForCompositor(activePage);
            captured = await screenshotWithWitness(activePage);
          }
        }
        const runtime = await runtimeWitness(activePage);
        const uiPresent = runtime.domUi.rootChildren > 0;
        const requireUi = captureOptions.requireUi ?? options.requireUi ?? false;
        const captureBackend = observedBackend(runtime);
        if (captureBackend !== 'unknown') Object.assign(report, { backend: captureBackend });
        const backendMatches = backend === 'auto' || captureBackend === backend;
        const ok =
          runtime.canvas !== null &&
          captured.pixels.rendered &&
          backendMatches &&
          runtime.engineFrameId !== null &&
          consoleErrors.length === 0 &&
          pageErrors.length === 0 &&
          (expectedReady === undefined || runtime.captureReady === expectedReady) &&
          (!requireUi || uiPresent);
        const index = captures.length + 1;
        const output = resolve(
          facts.value.root,
          captureOptions.output ??
            resolve(
              outputDirectory,
              `${String(index).padStart(3, '0')}-${checkpointSlug(checkpoint)}.png`,
            ),
        );
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, captured.png);
        const record: SoftwareCaptureRecord = {
          index,
          checkpoint: checkpoint ?? null,
          ok,
          output,
          digest: captureDigest(captured.png),
          pixels: captured.pixels,
          runtime,
        };
        captures.push(record);
        await updateReport();
        if (!ok) {
          fail(
            `${backend === 'software' ? 'software' : 'browser'}-capture-runtime-failed`,
            'non-flat canvas pixels, the requested browser backend/checkpoint, and no browser errors',
            'Inspect the run report and repair the first browser runtime failure.',
            { checkpoint: checkpoint ?? null, output, report: reportPath },
          );
        }
        return record;
      },
      report: () => report,
      close,
    };
  } catch (cause) {
    await Promise.allSettled([browser?.close(), display?.close(), server?.close()]);
    throw cause;
  }
}

export function createBrowserCapture(root: string): BrowserCapture {
  const sessions = new Set<BrowserCaptureSession>();
  return {
    async open(options) {
      const session = await openBrowserCaptureSession(root, options);
      sessions.add(session);
      return session;
    },
    async close() {
      await Promise.allSettled([...sessions].map((session) => session.close()));
      sessions.clear();
    },
  };
}

/**
 * Compatibility facade for callers that still request the original software
 * lane. New integrations should use createBrowserCapture({ backend }).
 */
export function createSoftwareBrowser(root: string): SoftwareBrowser {
  const browser = createBrowserCapture(root);
  return {
    async open(options) {
      return browser.open({ ...options, backend: 'software', software: true });
    },
    close: () => browser.close(),
  };
}

function captureCommandError(cause: unknown, legacySoftware = false): CommandError {
  if (cause instanceof SoftwareCaptureError) {
    const code =
      legacySoftware && cause.code.startsWith('browser-capture-')
        ? cause.code.replace(/^browser-capture-/, 'software-capture-')
        : cause.code;
    return {
      code,
      expected: cause.expected,
      hint: cause.hint,
      detail: cause.detail,
    };
  }
  return commandError(cause, legacySoftware ? 'software-capture-failed' : 'browser-capture-failed');
}

export async function browserCaptureCommand(
  options: BrowserCaptureOptions,
): Promise<CommandResult<BrowserCaptureRunReport>> {
  const root = options.root ?? process.cwd();
  const output = resolve(root, options.output ?? 'artifacts/capture/game-ui.png');
  const browser = createBrowserCapture(root);
  try {
    const backend = options.backend ?? (options.software === true ? 'software' : 'auto');
    const session = await browser.open({
      backend,
      ...(backend === 'software' ? { software: true } : {}),
      ...(options.browser === undefined ? {} : { browser: options.browser }),
      ...(options.width === undefined ? {} : { width: options.width }),
      ...(options.height === undefined ? {} : { height: options.height }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.headless === undefined ? {} : { headless: options.headless }),
      requireUi: options.requireUi === true,
      deterministic: options.deterministic === true,
      outputDir: dirname(output),
      report: evidencePath(output),
    });
    await session.capture(options.deterministic === true ? 'true' : undefined, {
      output,
      waitMs: options.waitMs ?? 4000,
      requireUi: options.requireUi === true,
    });
    await session.close();
    return { ok: true, value: session.report() };
  } catch (cause) {
    return { ok: false, error: captureCommandError(cause) };
  } finally {
    await browser.close();
  }
}

export async function softwareCaptureCommand(
  options: SoftwareCaptureOptions,
): Promise<CommandResult<unknown>> {
  const result = await browserCaptureCommand({ ...options, backend: 'software', software: true });
  if (result.ok) return result;
  return { ok: false, error: captureCommandErrorFromResult(result.error, true) };
}

function captureCommandErrorFromResult(error: CommandError, legacySoftware: boolean): CommandError {
  if (!legacySoftware || !error.code.startsWith('browser-capture-')) return error;
  return { ...error, code: error.code.replace(/^browser-capture-/, 'software-capture-') };
}
