// Verify the browser fallback sentinel slice against the live parity app.
// Each case runs ForgeaX rhi-wgpu WebGL2 and Three r184 WebGLRenderer in its
// own browser process; the result is an input to the primary parity status index.
//
// WebKit remains available as an explicit local compatibility mode, but CI can
// use the more reproducible Chromium mode by setting
// FORGEAX_FALLBACK_BROWSER=chromium. The browser probe is fail-closed: a
// Chromium run is accepted only when no WebGPU adapter is available and a
// real WebGL2 context is present. Chromium may expose navigator.gpu while its
// requestAdapter() resolves to null when WebGPU is disabled.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium, webkit } from 'playwright';
import UPNG from 'upng-js';
import { detectWasmCrash, runWithRetry } from './retry-until-pass.mjs';

async function runWebgl2TransportSpike() {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.FORGEAX_CHROMIUM_EXECUTABLE === undefined
      ? {}
      : { executablePath: process.env.FORGEAX_CHROMIUM_EXECUTABLE }),
    args: [
      '--disable-features=WebGPU',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-driver-bug-workarounds',
      '--no-sandbox',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<canvas id="probe"></canvas>');
    const result = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const gl = canvas?.getContext('webgl2');
      if (gl === null || gl === undefined) {
        return {
          status: 'unavailable',
          code: 'standard-cluster-transport-unavailable',
          webgl2: false,
        };
      }
      const format = {
        r32ui: true,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        max3dTextureSize: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),
      };
      const texture = gl.createTexture();
      if (texture === null)
        return {
          status: 'unavailable',
          code: 'standard-cluster-transport-unavailable',
          webgl2: true,
          format,
        };
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32UI,
        1,
        1,
        0,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        new Uint32Array([7]),
      );
      const uploadError = gl.getError();
      const framebuffer = gl.createFramebuffer();
      if (framebuffer === null)
        return {
          status: 'unavailable',
          code: 'standard-cluster-transport-unavailable',
          webgl2: true,
          format,
          uploadError,
        };
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      const framebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      const pixel = new Uint32Array(1);
      if (framebufferStatus === gl.FRAMEBUFFER_COMPLETE)
        gl.readPixels(0, 0, 1, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, pixel);
      const readbackError = gl.getError();
      const vertex = gl.createShader(gl.VERTEX_SHADER);
      const fragment = gl.createShader(gl.FRAGMENT_SHADER);
      const outputTexture = gl.createTexture();
      const outputFramebuffer = gl.createFramebuffer();
      let shaderRead = false;
      let shaderError = gl.NO_ERROR;
      const shaderPixel = new Uint8Array(4);
      let outputFramebufferStatus = gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT;
      if (
        vertex !== null &&
        fragment !== null &&
        outputTexture !== null &&
        outputFramebuffer !== null
      ) {
        gl.shaderSource(
          vertex,
          '#version 300 es\\nvoid main(){const vec2 p[3]=vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));gl_Position=vec4(p[gl_VertexID],0.,1.);}',
        );
        gl.shaderSource(
          fragment,
          '#version 300 es\\nprecision highp float; precision highp usampler2D; uniform usampler2D dataTex; out vec4 color; void main(){uint value=texelFetch(dataTex,ivec2(0),0).r;color=vec4(float(value)/255.,0.,0.,1.);}',
        );
        gl.compileShader(vertex);
        gl.compileShader(fragment);
        const program = gl.createProgram();
        if (
          program !== null &&
          gl.getShaderParameter(vertex, gl.COMPILE_STATUS) &&
          gl.getShaderParameter(fragment, gl.COMPILE_STATUS)
        ) {
          gl.attachShader(program, vertex);
          gl.attachShader(program, fragment);
          gl.linkProgram(program);
          if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
            gl.bindTexture(gl.TEXTURE_2D, outputTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, outputFramebuffer);
            gl.framebufferTexture2D(
              gl.FRAMEBUFFER,
              gl.COLOR_ATTACHMENT0,
              gl.TEXTURE_2D,
              outputTexture,
              0,
            );
            outputFramebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
            gl.useProgram(program);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.uniform1i(gl.getUniformLocation(program, 'dataTex'), 0);
            gl.viewport(0, 0, 1, 1);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, shaderPixel);
            shaderError = gl.getError();
            shaderRead =
              outputFramebufferStatus === gl.FRAMEBUFFER_COMPLETE &&
              shaderError === gl.NO_ERROR &&
              shaderPixel[0] === 7;
          }
        }
      }
      const ok =
        uploadError === gl.NO_ERROR &&
        framebufferStatus === gl.FRAMEBUFFER_COMPLETE &&
        readbackError === gl.NO_ERROR &&
        shaderRead;
      return {
        status: ok ? 'admitted' : 'unavailable',
        code: ok ? undefined : 'standard-cluster-transport-unavailable',
        webgl2: true,
        format,
        capacity: { width: 1, height: 1, layers: 1 },
        addressing: 'integer-texel',
        upload: uploadError === gl.NO_ERROR,
        shaderRead,
        shaderError,
        outputFramebufferStatus,
        shaderPixel: Array.from(shaderPixel),
        readback: readbackError === gl.NO_ERROR,
        pixel: Array.from(pixel),
        requested: 256,
        admitted: ok ? 256 : 0,
      };
    });
    console.log(JSON.stringify({ probe: 'webgl2-data-texture', ...result }));
    return 0;
  } finally {
    await browser.close();
  }
}

if (process.env.FORGEAX_WEBGL2_SPIKE === '1') {
  process.exit(await runWebgl2TransportSpike());
}

// Keep the preview bind address and the URL literal aligned. The parity app
// binds to 127.0.0.1, so using localhost here can select a different address
// family and make a ready preview look unavailable to the browser process.
const URL = process.env.URL ?? 'http://127.0.0.1:5182/';
const BROWSER_ENGINE = process.env.FORGEAX_FALLBACK_BROWSER ?? 'chromium';
if (BROWSER_ENGINE !== 'webkit' && BROWSER_ENGINE !== 'chromium') {
  throw new Error(
    `unsupported FORGEAX_FALLBACK_BROWSER=${BROWSER_ENGINE}; expected webkit or chromium`,
  );
}
const IS_CHROMIUM = BROWSER_ENGINE === 'chromium';
const BROWSER_LABEL = IS_CHROMIUM ? 'Chromium' : 'WebKit';
const BACKEND_ID = IS_CHROMIUM ? 'chromium-webgl2' : 'webkit-webgl2';
const RUNNER_NAME = IS_CHROMIUM ? '__colorLightingChromiumParity' : '__colorLightingWebkitParity';
const OUTPUT =
  process.env.PARITY_STATUS_OUTPUT ??
  `report/color-lighting-parity/${IS_CHROMIUM ? 'chromium' : 'webkit'}-status.json`;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 120000);
const BROWSER_OPERATION_TIMEOUT_MS = Number(process.env.BROWSER_OPERATION_TIMEOUT_MS ?? 30000);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3);
// The isolated runner owns one case per fresh browser, so the evaluate deadline
// is per case rather than the old all-cases-in-one-page budget. Keep the
// startup margin from the R5 probe, but do not let one wedged browser consume
// the whole fallback job before a fresh-process retry can run.
const EVALUATE_TIMEOUT_MS = Number(process.env.EVALUATE_TIMEOUT_MS ?? Math.max(TIMEOUT_MS, 120000));
const HARD_TIMEOUT_MS = Number(
  process.env.HARD_TIMEOUT_MS ?? Math.max(EVALUATE_TIMEOUT_MS * MAX_ATTEMPTS + 120000, 300000),
);
const LIFECYCLE_TIMEOUT_MS = Number(process.env.LIFECYCLE_TIMEOUT_MS ?? 2000);
const TEARDOWN_TIMEOUT_MS = Number(process.env.TEARDOWN_TIMEOUT_MS ?? 10000);
const PREVIEW_READY_TIMEOUT_MS = Number(process.env.PREVIEW_READY_TIMEOUT_MS ?? 30000);
const PREVIEW_READY_POLL_MS = Number(process.env.PREVIEW_READY_POLL_MS ?? 250);
const headless = !['0', 'false'].includes(
  (process.env.FORGEAX_BROWSER_HEADLESS ?? '1').toLowerCase(),
);

function failedSurfaceContract(missingCases = ['all']) {
  return {
    status: 'failed',
    backendId: BACKEND_ID,
    endpoint: 'surface.storage.raw',
    cases: [],
    error: {
      code: 'surface-raw-endpoint-failed',
      expected:
        'raw-storage presentation proof and final-display compositor pixels for every fallback case',
      hint: 'run the concrete endpoint probe and post-frame compositor readback; keep the last-known-good surface when proof is absent',
      detail: {
        lane: BACKEND_ID,
        stage: 'surface-probe',
        target: 'surface.storage.raw',
        endpoint: 'surface.storage.raw',
        missingCases,
      },
    },
  };
}

const baseFailure = (reason) => ({
  backendId: BACKEND_ID,
  executionStatus: 'failed',
  status: 'failed',
  caseStatuses: {},
  caseBackendStatuses: {},
  error: reason,
  surfaceContract: failedSurfaceContract(),
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
      `[${BROWSER_ENGINE}-color-lighting] ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const waitForPreviewReady = async () => {
  const deadline = Date.now() + PREVIEW_READY_TIMEOUT_MS;
  let lastError = 'preview did not return an HTTP response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(URL, {
        signal: AbortSignal.timeout(Math.min(BROWSER_OPERATION_TIMEOUT_MS, 5000)),
      });
      if (response.ok) return { url: URL, status: response.status };
      lastError = `preview returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_READY_POLL_MS));
  }
  throw new Error(`preview readiness timed out for ${URL}: ${lastError}`);
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

const browserType = IS_CHROMIUM ? chromium : webkit;
const browserLaunchOptions = IS_CHROMIUM
  ? {
      headless,
      ...(process.env.FORGEAX_CHROMIUM_EXECUTABLE === undefined
        ? {}
        : { executablePath: process.env.FORGEAX_CHROMIUM_EXECUTABLE }),
      ...(process.env.FORGEAX_CHROME_CHANNEL === undefined
        ? {}
        : { channel: process.env.FORGEAX_CHROME_CHANNEL }),
      args: [
        '--disable-features=WebGPU',
        '--disable-gpu',
        '--enable-unsafe-swiftshader',
        '--disable-gpu-driver-bug-workarounds',
        '--no-sandbox',
      ],
    }
  : { headless };

const runIsolatedCase = async (caseId) => {
  let caseResult = baseFailure(`${caseId}: runner did not execute`);
  let browser;
  let browserServer;
  let context;
  let page;
  let channelProof;
  let closing = false;
  const logs = [];
  const lifecycle = {
    browserPid: null,
    browserDisconnected: false,
    pageClosedUnexpectedly: false,
    stderr: [],
  };
  try {
    browserServer = await withDeadline(
      browserType.launchServer(browserLaunchOptions),
      BROWSER_OPERATION_TIMEOUT_MS,
      `${caseId}: ${BROWSER_LABEL} browser launch`,
    );
    const browserProcess = browserServer.process();
    lifecycle.browserPid = browserProcess?.pid ?? null;
    browserProcess?.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text.length > 0) lifecycle.stderr.push(text);
    });
    browser = await withDeadline(
      browserType.connect(browserServer.wsEndpoint()),
      BROWSER_OPERATION_TIMEOUT_MS,
      `${caseId}: ${BROWSER_LABEL} browser connect`,
    );
    browser.on('disconnected', () => {
      lifecycle.browserDisconnected = true;
      logs.push(`[${caseId}] [browser-disconnected] pid=${lifecycle.browserPid ?? 'unknown'}`);
    });
    context = await withDeadline(
      browser.newContext({ noDefaultViewport: true }),
      BROWSER_OPERATION_TIMEOUT_MS,
      `${caseId}: ${BROWSER_LABEL} context creation`,
    );
    page = await withDeadline(
      context.newPage(),
      BROWSER_OPERATION_TIMEOUT_MS,
      `${caseId}: ${BROWSER_LABEL} page creation`,
    );
    page.setDefaultTimeout(TIMEOUT_MS);
    page.on('close', () => {
      if (!closing) {
        lifecycle.pageClosedUnexpectedly = true;
        logs.push(`[${caseId}] [page-closed-unexpectedly]`);
      }
    });
    if (!IS_CHROMIUM) {
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
    }
    page.on('console', (message) => logs.push(`[${caseId}] [${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`[${caseId}] [pageerror] ${error.message}`));
    await page.addInitScript(() => {
      addEventListener('unhandledrejection', (event) => {
        const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
        console.error(`[unhandledrejection] ${reason}`);
      });
    });
    await withDeadline(
      page.goto(URL, { waitUntil: 'networkidle', timeout: BROWSER_OPERATION_TIMEOUT_MS }),
      BROWSER_OPERATION_TIMEOUT_MS,
      `${caseId}: ${BROWSER_LABEL} page navigation`,
    );
    channelProof = await withDeadline(
      page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2');
        const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info');
        const gpu = typeof navigator !== 'undefined' ? navigator.gpu : undefined;
        let webgpuAdapterStatus = 'absent';
        if (gpu !== undefined && typeof gpu.requestAdapter === 'function') {
          try {
            webgpuAdapterStatus =
              (await gpu.requestAdapter()) === null ? 'unavailable' : 'available';
          } catch {
            webgpuAdapterStatus = 'error';
          }
        }
        return {
          userAgent: navigator.userAgent,
          hasGpu: gpu !== undefined && !!gpu,
          webgpuAdapterStatus,
          webgl2: gl !== null,
          vendor:
            debugInfo === null ? null : (gl?.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? null),
          renderer:
            debugInfo === null
              ? null
              : (gl?.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? null),
        };
      }),
      BROWSER_OPERATION_TIMEOUT_MS,
      `${caseId}: ${BROWSER_LABEL} channel probe`,
    );
    logs.push(`[${caseId}] [channel-proof] ${JSON.stringify(channelProof)}`);
    const fallbackChannelValid =
      channelProof.webgl2 === true &&
      (IS_CHROMIUM
        ? channelProof.webgpuAdapterStatus === 'absent' ||
          channelProof.webgpuAdapterStatus === 'unavailable'
        : channelProof.hasGpu === false);
    if (!fallbackChannelValid) {
      throw new Error(
        `${caseId}: ${BROWSER_LABEL} fallback channel proof failed: ${JSON.stringify(channelProof)}`,
      );
    }
    await withDeadline(
      page.waitForFunction(
        (runnerName) => typeof globalThis[runnerName] === 'function',
        RUNNER_NAME,
        {
          timeout: BROWSER_OPERATION_TIMEOUT_MS,
        },
      ),
      BROWSER_OPERATION_TIMEOUT_MS,
      `${caseId}: ${BROWSER_LABEL} parity runner discovery`,
    );
    console.log(`[${BROWSER_ENGINE}-color-lighting] invoking isolated case ${caseId}`);
    caseResult = await withDeadline(
      page.evaluate(
        async ({ requestedCaseId, runnerName }) =>
          globalThis[runnerName]?.(
            `color-lighting-parity-${runnerName}:${requestedCaseId}`,
            requestedCaseId,
          ),
        { requestedCaseId: caseId, runnerName: RUNNER_NAME },
      ),
      EVALUATE_TIMEOUT_MS,
      `${caseId}: ${BROWSER_LABEL} parity sentinel`,
    );
    if (caseResult === undefined || caseResult === null || typeof caseResult !== 'object') {
      caseResult = baseFailure(`${caseId}: page did not expose the ${BROWSER_LABEL} parity runner`);
    }
    if (
      !IS_CHROMIUM &&
      caseId === 'default-srgb-texture' &&
      (caseResult.lifecycle?.status !== 'pass' ||
        caseResult.lifecycle?.stages?.length !== 2 ||
        caseResult.lifecycle?.disposal?.length !== 2 ||
        caseResult.lifecycle?.stages?.some(
          (stage) =>
            stage.frameCount !== 60 ||
            stage.byteLength !== stage.viewport.canvasWidth * stage.viewport.canvasHeight * 4 ||
            stage.nonBlackPixels <= 0 ||
            stage.completed !== 'ok' ||
            typeof stage.surfaceIdentity !== 'string' ||
            stage.surfaceIdentity.length === 0 ||
            typeof stage.attachmentWorldIdentity !== 'string' ||
            stage.attachmentWorldIdentity.length === 0 ||
            !Array.isArray(stage.rendererErrors) ||
            stage.rendererErrors.length !== 0 ||
            !Number.isSafeInteger(stage.attachmentGeneration) ||
            stage.actualBackendKind !== 'wgpu-webgl2',
        ) === true)
    ) {
      caseResult = {
        ...caseResult,
        executionStatus: 'failed',
        status: 'failed',
        error: `${caseResult.error ? `${caseResult.error}; ` : ''}${caseId}: WebKit 60-frame lifecycle regression did not produce two valid recreated stages`,
      };
    }
    await withDeadline(
      waitForAnimationFrameOrTimeout(page),
      LIFECYCLE_TIMEOUT_MS,
      `${caseId}: ${BROWSER_LABEL} parity lifecycle settle`,
    );
    await withDeadline(
      waitForAnimationFrameOrTimeout(page),
      LIFECYCLE_TIMEOUT_MS,
      `${caseId}: ${BROWSER_LABEL} parity lifecycle settle`,
    );
    const lifecycleFailures = logs.filter(
      (entry) =>
        entry.includes('[pageerror]') ||
        entry.includes('[unhandledrejection]') ||
        /Surface\[|surface panic/i.test(entry),
    );
    if (lifecycleFailures.length > 0) {
      caseResult = {
        ...caseResult,
        executionStatus: 'failed',
        status: 'failed',
        error: `${caseResult.error ? `${caseResult.error}; ` : ''}${caseId}: ${BROWSER_LABEL} page reported surface lifecycle errors: ${lifecycleFailures.join(' | ')}`,
      };
    }
    const wasmCrash = detectWasmCrash(logs.map((text) => ({ text })));
    if (wasmCrash !== null) {
      caseResult = {
        ...caseResult,
        executionStatus: 'failed',
        status: 'failed',
        error: `${caseResult.error ? `${caseResult.error}; ` : ''}${caseId}: ${BROWSER_LABEL} WASM process crash (${wasmCrash})`,
      };
    }
  } catch (error) {
    caseResult = baseFailure(
      `${caseId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    closing = true;
    if (page !== undefined) {
      await closeWithDeadline(
        page.close({ runBeforeUnload: false }),
        `${caseId}: ${BROWSER_LABEL} page close`,
      );
    }
    if (context !== undefined) {
      await closeWithDeadline(context.close(), `${caseId}: ${BROWSER_LABEL} context close`);
    }
    if (browser !== undefined) {
      await closeWithDeadline(browser.close(), `${caseId}: ${BROWSER_LABEL} browser close`);
    }
    if (browserServer !== undefined) {
      await closeWithDeadline(
        browserServer.close(),
        `${caseId}: ${BROWSER_LABEL} browser server close`,
      );
    }
  }
  return {
    ...caseResult,
    logs,
    lifecycle,
    ...(channelProof === undefined ? {} : { channelProof }),
  };
};

const runCaseWithRetry = async (caseId) => {
  let lastResult = baseFailure(`${caseId}: no attempt ran`);
  const attemptResults = [];
  let targetCloseRetries = 0;
  await runWithRetry(
    async () => {
      lastResult = await runIsolatedCase(caseId);
      attemptResults.push(lastResult);
      const crash = detectWasmCrash((lastResult.logs ?? []).map((text) => ({ text })));
      const ok = lastResult.executionStatus === 'complete' && lastResult.status === 'pass';
      const pageReportedError = (lastResult.logs ?? []).some(
        (entry) =>
          entry.includes('[pageerror]') ||
          entry.includes('[unhandledrejection]') ||
          /Surface\[|surface panic/i.test(entry),
      );
      const browserStall =
        !ok &&
        !pageReportedError &&
        typeof lastResult.error === 'string' &&
        lastResult.error.includes(`${BROWSER_LABEL} parity sentinel timed out`);
      const targetClosed =
        !ok &&
        typeof lastResult.error === 'string' &&
        /Target page, context or browser has been closed/i.test(lastResult.error) &&
        (lastResult.lifecycle?.browserDisconnected === true ||
          lastResult.lifecycle?.pageClosedUnexpectedly === true);
      const freshBrowserRetry = targetClosed && targetCloseRetries < 1;
      if (freshBrowserRetry) targetCloseRetries += 1;
      return {
        ok,
        // A timeout without a page error means the browser process stopped
        // answering rather than returning a failed parity assertion. Retry it
        // with a fresh browser, while repeated stalls still fail closed.
        retryable: !ok && (crash !== null || browserStall || freshBrowserRetry),
        summary: ok
          ? `${caseId}: parity pass`
          : `${caseId}: parity failed${crash ? `; crash=${crash}` : browserStall ? '; browser stall' : freshBrowserRetry ? '; fresh-browser retry' : ''}`,
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
  const surfaceContracts = caseResults.map((entry) => entry.surfaceContract).filter(Boolean);
  const captureIdentities = surfaceContracts.flatMap((contract) =>
    (contract.cases ?? [])
      .map((entry) => entry.captureIdentity)
      .filter((identity) => typeof identity === 'string' && identity.length > 0),
  );
  const duplicateCaptureIdentities = captureIdentities.filter(
    (identity, index, all) => all.indexOf(identity) !== index,
  );
  const surfaceContractsPassed =
    caseResults.length > 0 &&
    surfaceContracts.length === caseResults.length &&
    surfaceContracts.every((entry) => entry.status === 'pass') &&
    duplicateCaptureIdentities.length === 0;
  const identityError =
    duplicateCaptureIdentities.length > 0
      ? `duplicate fallback capture identities across isolated cases: ${[...new Set(duplicateCaptureIdentities)].join(', ')}`
      : '';
  return {
    invocationId: `color-lighting-parity-${BROWSER_ENGINE}`,
    backendId: BACKEND_ID,
    executionStatus: caseResults.every((entry) => entry.executionStatus === 'complete')
      ? 'complete'
      : 'failed',
    status:
      caseResults.every((entry) => entry.status === 'pass') && surfaceContractsPassed
        ? 'pass'
        : 'failed',
    caseStatuses: Object.assign({}, ...caseResults.map((entry) => entry.caseStatuses ?? {})),
    caseBackendStatuses: Object.assign(
      {},
      ...caseResults.map((entry) => entry.caseBackendStatuses ?? {}),
    ),
    cases: caseResults.flatMap((entry) => entry.cases ?? []),
    provenance: caseResults.find((entry) => entry.provenance !== undefined)?.provenance,
    lifecycle: caseResults.find((entry) => entry.lifecycle !== undefined)?.lifecycle,
    surfaceContracts,
    execution: {
      browser: BROWSER_ENGINE,
      channel: process.env.FORGEAX_CHROME_CHANNEL ?? null,
      launchArgs: browserLaunchOptions.args ?? [],
      channelProof:
        caseResults.find((entry) => entry.channelProof !== undefined)?.channelProof ?? null,
      lifecycle: caseResults.map((entry) => entry.lifecycle ?? null),
    },
    logs: caseResults.flatMap((entry) => entry.logs ?? []),
    ...(error.length > 0 || identityError.length > 0
      ? { error: [error, identityError].filter((entry) => entry.length > 0).join('; ') }
      : {}),
  };
};

let result = baseFailure('runner did not execute');
const hardTimer = setTimeout(() => {
  const timeoutResult = baseFailure(
    `${BROWSER_LABEL} parity process timed out after ${HARD_TIMEOUT_MS}ms`,
  );
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(timeoutResult, null, 2)}\n`, 'utf8');
  console.error(`[${BROWSER_ENGINE}-color-lighting] ${timeoutResult.error}`);
  process.exit(1);
}, HARD_TIMEOUT_MS);
try {
  const readiness = await waitForPreviewReady();
  console.log(`[${BROWSER_ENGINE}-color-lighting] preview ready ${JSON.stringify(readiness)}`);
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
console.log(
  `[${BROWSER_ENGINE}-color-lighting] ${result.status === 'pass' ? 'PASS' : 'FAIL'} ${OUTPUT}`,
);
if (result.error) console.error(`[${BROWSER_ENGINE}-color-lighting] ${result.error}`);
if (result.logs?.length)
  console.error(`[${BROWSER_ENGINE}-color-lighting] logs: ${result.logs.join(' | ')}`);
process.exit(result.status === 'pass' ? 0 : 1);
