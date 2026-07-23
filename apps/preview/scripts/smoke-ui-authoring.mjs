import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { chromium } from 'playwright';

const port = 65476;
const falsifyCompanion = process.argv.includes('--falsify-companion');
const appDir = fileURLToPath(new URL('..', import.meta.url));
const viteBin = fileURLToPath(new URL('../../../node_modules/vite/bin/vite.js', import.meta.url));
const server = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: appDir,
  stdio: 'ignore',
});
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);
try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}/?game=game-default`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(globalThis.__forgeaxUiAuthoring), null, { timeout: 30_000 });
  const captureSelector = '[data-ui-authoring-root] [data-ui-asset]';
  const waitForPaint = async () => {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.evaluate(() => document.fonts.ready);
  };
  const screenshotRenderable = async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await waitForPaint();
      // Capture the target above the live game overlay so compositor frames cannot leak into PNG bytes.
      const previousBackground = await page.evaluate((selector) => {
        const target = document.querySelector(selector);
        if (!(target instanceof HTMLElement)) throw new Error('preview capture target is unavailable');
        const previous = target.style.backgroundColor;
        const authoringRoot = target.closest('[data-ui-authoring-root]');
        if (!(authoringRoot instanceof HTMLElement)) throw new Error('preview authoring root is unavailable');
        authoringRoot.dataset.uiCaptureZIndex = authoringRoot.style.zIndex;
        authoringRoot.style.zIndex = '2147483647';
        target.style.backgroundColor = 'rgb(0, 0, 0)';
        return previous;
      }, captureSelector);
      try {
        const bytes = await page.locator(captureSelector).screenshot({ animations: 'disabled' });
        if (bytes.length >= 100) return bytes;
      } finally {
        await page.evaluate(([selector, background]) => {
          const target = document.querySelector(selector);
          if (!(target instanceof HTMLElement)) return;
          target.style.backgroundColor = background;
          const authoringRoot = target.closest('[data-ui-authoring-root]');
          if (authoringRoot instanceof HTMLElement) {
            authoringRoot.style.zIndex = authoringRoot.dataset.uiCaptureZIndex ?? '';
            delete authoringRoot.dataset.uiCaptureZIndex;
          }
        }, [captureSelector, previousBackground]);
      }
    }
    throw new Error('preview screenshot did not become renderable');
  };
  const captureWithBytes = async (bytes) =>
    page.evaluate(async (pngBytes) => {
      const host = globalThis.__forgeaxUiAuthoring;
      if (!host) throw new Error('preview authoring host is unavailable');
      const mountedHost = () =>
        document.querySelector('[data-ui-authoring-root] [data-ui-asset]')?.shadowRoot;
      return host.capture({
        viewport: { width: 320, height: 180 },
        deviceScaleFactor: 1,
        readiness: async () => ({
          viewport: window.innerWidth === 320 && window.innerHeight === 180,
          deviceScale: window.devicePixelRatio === 1,
          fonts: document.fonts.status === 'loaded',
          resources: [...(mountedHost()?.querySelectorAll('img') ?? [])].every(
            (image) => image.complete && image.naturalWidth > 0,
          ),
          scenario: (mountedHost()?.querySelectorAll('[data-ui-scenario-ready]').length ?? 0) >= 2,
          clock: true,
          failures: { console: [], page: [], request: [] },
        }),
        freezeClock: async () => ({ ok: true, value: { timeMs: 1000 } }),
        screenshot: async () => new Uint8Array(pngBytes),
      });
    }, Array.from(bytes));
  const setup = await page.evaluate(async ({ falsify }) => {
    const host = globalThis.__forgeaxUiAuthoring;
    if (!host) throw new Error('preview authoring host is unavailable');
    const before = await host.validate();
    const invalid = await host.repair({ html: '<script>bad</script>', css: '' });
    if (invalid.ok) throw new Error('invalid authoring source unexpectedly passed');
    const repaired = await host.repair({
      html: '<section data-ui-part="root"><strong data-ui-part="score">Score 0</strong><span data-ui-part="stress-meter">Ready</span></section>',
      css: ':host { display: block; color: white; font: 16px sans-serif; } section { padding: 12px; }',
    });
    if (!repaired.ok) throw new Error('repaired authoring source failed validation');
    if (falsify) {
      const missingResource = await host.repair({
        html: '<section data-ui-part="root"><strong data-ui-part="score">Score 0</strong><img alt="" /></section>',
        css: ':host { display: block; }',
      });
      if (!missingResource.ok) throw new Error('missing-resource falsification source failed validation');
    }
    const opened = await host.open('default');
    if (!opened.ok) throw new Error(`default scenario failed: ${opened.error.code}`);
    if (falsify) {
      return { initiallyValid: before.ok, repaired: repaired.ok, falsified: true };
    }
    return { initiallyValid: before.ok, repaired: repaired.ok };
  }, { falsify: falsifyCompanion });
  if (falsifyCompanion) {
    await waitForPaint();
    const failed = await captureWithBytes(new Uint8Array());
    if (failed.ok || failed.error.code !== 'capture-not-ready') {
      throw new Error('companion falsification did not identify resources');
    }
    if (!failed.error.detail.unmet.includes('resources')) {
      throw new Error('companion falsification did not identify resources');
    }
    await page.evaluate(() => globalThis.__forgeaxUiAuthoring?.dispose());
    console.log(JSON.stringify({ ...setup, falsified: true, unmet: failed.error.detail.unmet }));
    await browser.close();
  } else {
    const captures = [];
    await screenshotRenderable();
    for (let index = 0; index < 3; index += 1) {
      const bytes = await screenshotRenderable();
      captures.push(await captureWithBytes(bytes));
    }
    if (captures.some((capture) => !capture.ok)) {
      throw new Error(`default capture failed: ${JSON.stringify(captures)}`);
    }
    const defaultBytes = captures.map((capture) =>
      capture.ok ? Array.from(capture.value.png) : [],
    );
    if (defaultBytes.some((bytes) => bytes.length < 100)) {
      throw new Error('real preview screenshot was unexpectedly tiny');
    }
    await page.evaluate(async () => {
      const host = globalThis.__forgeaxUiAuthoring;
      if (!host) throw new Error('preview authoring host is unavailable');
      const extreme = await host.open('extreme');
      if (!extreme.ok) throw new Error(`extreme scenario failed: ${extreme.error.code}`);
    });
    const extremeBytes = await screenshotRenderable();
    const extremeCapture = await captureWithBytes(extremeBytes);
    if (!extremeCapture.ok) throw new Error('extreme capture failed');
    const discovered = await page.evaluate(() => {
      const host = globalThis.__forgeaxUiAuthoring;
      if (!host) throw new Error('preview authoring host is unavailable');
      const value = host.discover();
      host.dispose();
      return value;
    });
    const report = {
      ...setup,
      defaultBytes,
      extremeEvidence: extremeCapture.value.evidence,
      discovered,
    };
    if (report.defaultBytes.some((bytes) => JSON.stringify(bytes) !== JSON.stringify(report.defaultBytes[0]))) {
      throw new Error('capture PNG bytes were not deterministic');
    }
    if (!report.initiallyValid || !report.repaired || report.discovered.length !== 1) {
      throw new Error('authoring smoke report failed');
    }
    console.log(JSON.stringify(report));
    await browser.close();
  }
} finally {
  stop();
}
