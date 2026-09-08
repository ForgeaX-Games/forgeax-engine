// Verify the required WebKit fallback sentinel slice against the live parity app.
// Each case runs ForgeaX rhi-wgpu WebGL2 and Three r184 WebGLRenderer in its
// own WebKit process; the result is an input to the primary parity status index.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { webkit } from 'playwright';
import UPNG from 'upng-js';
import { detectWasmCrash, runWithRetry } from './retry-until-pass.mjs';

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
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3);
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

const CASE_IDS = [
  'default-srgb-texture',
  'material-alpha-mask-default',
  'material-alpha-blend',
  'tone-aces-filmic-2',
  'direct-directional-urp',
  'transparent-ldr-urp',
];

const runIsolatedCase = async (caseId) => {
  let caseResult = baseFailure(`${caseId}: runner did not execute`);
  let browser;
  let context;
  let page;
  const logs = [];
  try {
    browser = await withDeadline(
      webkit.launch({ headless }),
      BROWSER_OPERATION_TIMEOUT_MS,
      `${caseId}: WebKit browser launch`,
    );
    context = await withDeadline(
      browser.newContext({ noDefaultViewport: true }),
      BROWSER_OPERATION_TIMEOUT_MS,
      `${caseId}: WebKit context creation`,
    );
    page = await withDeadline(
      context.newPage(),
      BROWSER_OPERATION_TIMEOUT_MS,
      `${caseId}: WebKit page creation`,
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
          `${caseId}: WebKit compositor screenshot is ${decoded.width}x${decoded.height}; expected ${request.width}x${request.height}`,
        );
      }
      return Array.from(pixels ?? []);
    });
    page.on('console', (message) => logs.push(`[${caseId}] [${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`[${caseId}] [pageerror] ${error.message}`));
    await withDeadline(
      page.goto(URL, { waitUntil: 'networkidle', timeout: BROWSER_OPERATION_TIMEOUT_MS }),
      BROWSER_OPERATION_TIMEOUT_MS,
      `${caseId}: WebKit page navigation`,
    );
    await withDeadline(
      page.waitForFunction(() => typeof window.__colorLightingWebkitParity === 'function', null, {
        timeout: BROWSER_OPERATION_TIMEOUT_MS,
      }),
      BROWSER_OPERATION_TIMEOUT_MS,
      `${caseId}: WebKit parity runner discovery`,
    );
    console.log(`[webkit-color-lighting] invoking isolated case ${caseId}`);
    caseResult = await withDeadline(
      page.evaluate(
        async (requestedCaseId) =>
          window.__colorLightingWebkitParity?.(
            `color-lighting-parity-webkit:${requestedCaseId}`,
            requestedCaseId,
          ),
        caseId,
      ),
      EVALUATE_TIMEOUT_MS,
      `${caseId}: WebKit parity sentinel`,
    );
    if (caseResult === undefined || caseResult === null || typeof caseResult !== 'object') {
      caseResult = baseFailure(`${caseId}: page did not expose the WebKit parity runner`);
    }
    await withDeadline(
      waitForAnimationFrameOrTimeout(page),
      LIFECYCLE_TIMEOUT_MS,
      `${caseId}: WebKit parity lifecycle settle`,
    );
    await withDeadline(
      waitForAnimationFrameOrTimeout(page),
      LIFECYCLE_TIMEOUT_MS,
      `${caseId}: WebKit parity lifecycle settle`,
    );
    const lifecycleFailures = logs.filter(
      (entry) => entry.includes('[pageerror]') || /Surface\[|surface panic/i.test(entry),
    );
    if (lifecycleFailures.length > 0) {
      caseResult = {
        ...caseResult,
        executionStatus: 'failed',
        status: 'failed',
        error: `${caseResult.error ? `${caseResult.error}; ` : ''}${caseId}: WebKit page reported surface lifecycle errors: ${lifecycleFailures.join(' | ')}`,
      };
    }
    const wasmCrash = detectWasmCrash(logs.map((text) => ({ text })));
    if (wasmCrash !== null) {
      caseResult = {
        ...caseResult,
        executionStatus: 'failed',
        status: 'failed',
        error: `${caseResult.error ? `${caseResult.error}; ` : ''}${caseId}: WebKit WASM process crash (${wasmCrash})`,
      };
    }
  } catch (error) {
    caseResult = baseFailure(
      `${caseId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (page !== undefined) {
      await closeWithDeadline(
        page.close({ runBeforeUnload: false }),
        `${caseId}: WebKit page close`,
      );
    }
    if (context !== undefined) {
      await closeWithDeadline(context.close(), `${caseId}: WebKit context close`);
    }
    if (browser !== undefined) {
      await closeWithDeadline(browser.close(), `${caseId}: WebKit browser close`);
    }
  }
  return { ...caseResult, logs };
};

const runCaseWithRetry = async (caseId) => {
  let lastResult = baseFailure(`${caseId}: no attempt ran`);
  const attemptResults = [];
  await runWithRetry(
    async () => {
      lastResult = await runIsolatedCase(caseId);
      attemptResults.push(lastResult);
      const crash = detectWasmCrash((lastResult.logs ?? []).map((text) => ({ text })));
      const ok = lastResult.executionStatus === 'complete' && lastResult.status === 'pass';
      return {
        ok,
        retryable: !ok && crash !== null,
        summary: ok
          ? `${caseId}: parity pass`
          : `${caseId}: parity failed${crash ? `; crash=${crash}` : ''}`,
      };
    },
    { maxAttempts: MAX_ATTEMPTS, label: `color-lighting-${caseId}` },
  );
  if (attemptResults.length > 1) {
    return {
      ...lastResult,
      logs: attemptResults.flatMap((entry, index) =>
        entry.logs.map((log) => `[attempt ${index + 1}] ${log}`),
      ),
    };
  }
  return lastResult;
};

const mergeCaseResults = (caseResults) => {
  const error = caseResults
    .map((entry) => entry.error)
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .join('; ');
  return {
    invocationId: 'color-lighting-parity-webkit',
    backendId: 'webkit-webgl2',
    executionStatus: caseResults.every((entry) => entry.executionStatus === 'complete')
      ? 'complete'
      : 'failed',
    status: caseResults.every((entry) => entry.status === 'pass') ? 'pass' : 'failed',
    caseStatuses: Object.assign({}, ...caseResults.map((entry) => entry.caseStatuses ?? {})),
    caseBackendStatuses: Object.assign(
      {},
      ...caseResults.map((entry) => entry.caseBackendStatuses ?? {}),
    ),
    cases: caseResults.flatMap((entry) => entry.cases ?? []),
    provenance: caseResults.find((entry) => entry.provenance !== undefined)?.provenance,
    logs: caseResults.flatMap((entry) => entry.logs ?? []),
    ...(error.length > 0 ? { error } : {}),
  };
};

let result = baseFailure('runner did not execute');
const hardTimer = setTimeout(() => {
  const timeoutResult = baseFailure(`WebKit parity process timed out after ${HARD_TIMEOUT_MS}ms`);
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(timeoutResult, null, 2)}\n`, 'utf8');
  console.error(`[webkit-color-lighting] ${timeoutResult.error}`);
  process.exit(1);
}, HARD_TIMEOUT_MS);
try {
  const caseResults = [];
  for (const caseId of CASE_IDS) {
    caseResults.push(await runCaseWithRetry(caseId));
  }
  result = mergeCaseResults(caseResults);
} catch (error) {
  result = baseFailure(error instanceof Error ? error.message : String(error));
}

clearTimeout(hardTimer);
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(`[webkit-color-lighting] ${result.status === 'pass' ? 'PASS' : 'FAIL'} ${OUTPUT}`);
if (result.error) console.error(`[webkit-color-lighting] ${result.error}`);
if (result.logs?.length) console.error(`[webkit-color-lighting] logs: ${result.logs.join(' | ')}`);
process.exit(result.status === 'pass' ? 0 : 1);
