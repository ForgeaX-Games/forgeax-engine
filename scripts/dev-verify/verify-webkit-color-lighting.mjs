// Verify the required WebKit fallback sentinel slice against the live parity app.
// The page runs ForgeaX rhi-wgpu WebGL2 and Three r184 WebGLRenderer in one
// WebKit process; the result is an input to the primary parity status index.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { webkit } from 'playwright';
import UPNG from 'upng-js';

const URL = process.env.URL ?? 'http://localhost:5182/';
const OUTPUT =
  process.env.PARITY_STATUS_OUTPUT ?? 'report/color-lighting-parity/webkit-status.json';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 120000);
const EVALUATE_TIMEOUT_MS = Number(process.env.EVALUATE_TIMEOUT_MS ?? Math.max(TIMEOUT_MS, 300000));
const BROWSER_OPERATION_TIMEOUT_MS = Number(process.env.BROWSER_OPERATION_TIMEOUT_MS ?? 30000);
const HARD_TIMEOUT_MS = Number(
  process.env.HARD_TIMEOUT_MS ?? Math.max(EVALUATE_TIMEOUT_MS + 120000, 300000),
);
const LIFECYCLE_TIMEOUT_MS = Number(process.env.LIFECYCLE_TIMEOUT_MS ?? 2000);
const TEARDOWN_TIMEOUT_MS = Number(process.env.TEARDOWN_TIMEOUT_MS ?? 10000);
const headless = !['0', 'false'].includes(
  (process.env.FORGEAX_BROWSER_HEADLESS ?? '1').toLowerCase(),
);

const baseFailure = (reason) => ({
  backendId: 'webkit-webgl2',
  executionStatus: 'failed',
  status: 'failed',
  caseStatuses: {},
  caseBackendStatuses: {},
  error: reason,
});

const withDeadline = async (promise, timeoutMs, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const closeWithDeadline = async (promise, label) => {
  try {
    await withDeadline(promise, TEARDOWN_TIMEOUT_MS, label);
  } catch (error) {
    console.error(
      `[webkit-color-lighting] ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const waitForAnimationFrameOrTimeout = async (page) => {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(finish, 250);
        requestAnimationFrame(() => {
          clearTimeout(timer);
          finish();
        });
      }),
  );
};

let result = baseFailure('runner did not execute');
let browser;
let context;
let page;
const hardTimer = setTimeout(() => {
  const timeoutResult = baseFailure(`WebKit parity process timed out after ${HARD_TIMEOUT_MS}ms`);
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(timeoutResult, null, 2)}\n`, 'utf8');
  console.error(`[webkit-color-lighting] ${timeoutResult.error}`);
  process.exit(1);
}, HARD_TIMEOUT_MS);
try {
  browser = await withDeadline(
    webkit.launch({ headless }),
    BROWSER_OPERATION_TIMEOUT_MS,
    'WebKit browser launch',
  );
  context = await withDeadline(
    // GTK WebKit on the heavy Xvfb runner can deadlock while creating a page
    // when Playwright asks it to emulate a viewport. The parity canvases set
    // their own case-sized pixel dimensions, so native viewport sizing is the
    // correct contract for this fallback probe.
    browser.newContext({ noDefaultViewport: true }),
    BROWSER_OPERATION_TIMEOUT_MS,
    'WebKit context creation',
  );
  page = await withDeadline(
    context.newPage(),
    BROWSER_OPERATION_TIMEOUT_MS,
    'WebKit page creation',
  );
  page.setDefaultTimeout(TIMEOUT_MS);
  await page.exposeFunction('__forgeaxWebkitCanvasReadback', async (request) => {
    const clip = {
      x: request.x,
      y: request.y,
      width: request.width,
      height: request.height,
    };
    const png = await page.screenshot({ clip, animations: 'disabled', omitBackground: true });
    const decoded = UPNG.decode(png);
    const pixels = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
    if (decoded.width !== request.width || decoded.height !== request.height) {
      throw new Error(
        `WebKit compositor screenshot is ${decoded.width}x${decoded.height}; expected ${request.width}x${request.height}`,
      );
    }
    return Array.from(pixels ?? []);
  });
  const logs = [];
  page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));
  await withDeadline(
    page.goto(URL, { waitUntil: 'networkidle', timeout: BROWSER_OPERATION_TIMEOUT_MS }),
    BROWSER_OPERATION_TIMEOUT_MS,
    'WebKit page navigation',
  );
  await withDeadline(
    page.waitForFunction(() => typeof window.__colorLightingWebkitParity === 'function', null, {
      timeout: BROWSER_OPERATION_TIMEOUT_MS,
    }),
    BROWSER_OPERATION_TIMEOUT_MS,
    'WebKit parity runner discovery',
  );
  console.log('[webkit-color-lighting] invoking parity sentinel matrix');
  result = await withDeadline(
    page.evaluate(async () => window.__colorLightingWebkitParity?.('color-lighting-parity-webkit')),
    EVALUATE_TIMEOUT_MS,
    'WebKit parity sentinel matrix',
  );
  if (result === undefined || result === null || typeof result !== 'object') {
    result = baseFailure('page did not expose the WebKit parity runner');
  }
  // Renderer disposal is part of this gate: a green case result is not
  // sufficient if the WebGL2 surface panics while the page tears down.
  await withDeadline(
    waitForAnimationFrameOrTimeout(page),
    LIFECYCLE_TIMEOUT_MS,
    'WebKit parity lifecycle settle',
  );
  await withDeadline(
    waitForAnimationFrameOrTimeout(page),
    LIFECYCLE_TIMEOUT_MS,
    'WebKit parity lifecycle settle',
  );
  const lifecycleFailures = logs.filter(
    (entry) => entry.startsWith('[pageerror]') || /Surface\[|surface panic/i.test(entry),
  );
  if (lifecycleFailures.length > 0) {
    result = {
      ...result,
      executionStatus: 'failed',
      status: 'failed',
      error: `${result.error ? `${result.error}; ` : ''}WebKit page reported surface lifecycle errors: ${lifecycleFailures.join(' | ')}`,
    };
  }
  result.logs = logs;
} catch (error) {
  result = baseFailure(error instanceof Error ? error.message : String(error));
} finally {
  if (page !== undefined) {
    await closeWithDeadline(page.close({ runBeforeUnload: false }), 'WebKit page close');
  }
  if (context !== undefined) {
    await closeWithDeadline(context.close(), 'WebKit context close');
  }
  if (browser !== undefined) {
    await closeWithDeadline(browser.close(), 'WebKit browser close');
  }
}

clearTimeout(hardTimer);
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(`[webkit-color-lighting] ${result.status === 'pass' ? 'PASS' : 'FAIL'} ${OUTPUT}`);
if (result.error) console.error(`[webkit-color-lighting] ${result.error}`);
process.exit(result.status === 'pass' ? 0 : 1);
