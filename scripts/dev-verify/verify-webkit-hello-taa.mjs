// Verify the hello-taa carrier through WebKit's real wgpu-wasm WebGL2 fallback.
// This is the required raster/readback lane; the smoke-fleet lane only checks
// the static temporal admission contract.

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { webkit } from 'playwright';
import UPNG from 'upng-js';
import {
  activePassCountersFromInspection,
  cpuAffinityFromEnv,
  performanceAdmissionUnavailable,
  performanceIdentityFromEnv,
  runnerProvenanceFromEnv,
  WEBGL2_PERFORMANCE_ADMISSION_SCHEMA_VERSION,
} from '../../apps/hello/taa/scripts/performance-contract.mjs';
import {
  closeBrowserWithDeadline,
  detectWasmCrash,
  evaluateWithDeadline,
  runWithRetry,
} from './retry-until-pass.mjs';

const URL = process.env.TAA_SERVER_URL ?? process.env.URL ?? 'http://127.0.0.1:5183/';
const REQUIRED_FRAMES = Math.max(Number(process.env.SMOKE_MIN_FRAMES ?? 60), 60);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 120_000);
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR ?? '/tmp/hello-taa-webgl2';
const STATUS_OUTPUT = process.env.TAA_RUNTIME_PROBE_STATUS_OUTPUT;
const performanceIdentity = performanceIdentityFromEnv();
const TESTED_SHA = performanceIdentity.testedRevision;
const SOURCE_REVISION = performanceIdentity.sourceRevision;
if (!performanceIdentity.testedRevisionMatchesCheckout) {
  throw new Error(
    `testedRevision does not match checkout HEAD: ${TESTED_SHA} !== ${performanceIdentity.checkoutRevision}`,
  );
}
const RUNNER_NAME = process.env.RUNNER_NAME;
const runnerProvenance = runnerProvenanceFromEnv(process.env);
const cpuAffinity = cpuAffinityFromEnv(process.env);
const PLAYWRIGHT_VERSION = process.env.PLAYWRIGHT_VERSION ?? 'unknown';
const PERFORMANCE_OUTPUT = process.env.TAA_PERFORMANCE_ADMISSION_OUTPUT;
const PERFORMANCE_SAMPLE_COUNT = 10;

const hashVitePayload = (root) => {
  const hash = createHash('sha256');
  const add = (path, relative) => {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      for (const name of readdirSync(path).sort()) add(`${path}/${name}`, `${relative}/${name}`);
      return;
    }
    hash.update(relative).update('\0').update(readFileSync(path));
  };
  add(`${root}/index.html`, 'index.html');
  add(`${root}/src`, 'src');
  add(`${root}/dist/index.html`, 'dist/index.html');
  add(`${root}/dist/shaders/manifest.json`, 'dist/shaders/manifest.json');
  return hash.digest('hex');
};

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const buildRoot = resolve(process.cwd(), 'apps/hello/taa');
const buildArtifact = {
  root: 'apps/hello/taa/dist',
  indexSha256: sha256File(resolve(buildRoot, 'dist', 'index.html')),
  shaderManifestSha256: sha256File(resolve(buildRoot, 'dist', 'shaders', 'manifest.json')),
  sourcePayload: 'apps/hello/taa/index.html+src',
};

const writePerformanceUnavailable = (reason) => {
  if (PERFORMANCE_OUTPUT === undefined) return;
  mkdirSync(dirname(PERFORMANCE_OUTPUT), { recursive: true });
  writeFileSync(
    PERFORMANCE_OUTPUT,
    `${JSON.stringify(
      {
        ...performanceAdmissionUnavailable(reason),
        testedRevision: TESTED_SHA,
        sourceRevision: SOURCE_REVISION,
        buildDigest: hashVitePayload(buildRoot),
        buildArtifact,
        runnerName: runnerProvenance.runnerName,
        runnerFacts: runnerProvenance.runnerFacts,
        cpuAffinity: cpuAffinity.ok ? cpuAffinity.cpuAffinity : null,
      },
      null,
      2,
    )}\n`,
  );
};

const readInspection = async (page) => {
  const state = await evaluateWithDeadline(
    page,
    () => {
      const text = document.querySelector('#inspection')?.textContent ?? '';
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    },
    undefined,
    TIMEOUT_MS,
    'hello-taa WebGL2 inspection',
  );
  if (state === undefined) throw new Error('hello-taa inspection never published valid JSON');
  return state;
};

const frameIdOf = (state) =>
  typeof state?.frame === 'number' ? state.frame : state?.frame?.frameId;

const assertFreshRendererSubmission = (before, after, label) => {
  const beforeFrame = frameIdOf(before);
  const afterFrame = frameIdOf(after);
  if (!Number.isFinite(beforeFrame) || !Number.isFinite(afterFrame) || afterFrame <= beforeFrame) {
    throw new Error(
      `${label}: renderer submission did not advance inspection frame (${beforeFrame} -> ${afterFrame})`,
    );
  }
  return after;
};

const waitForFrame = async (page, minimum) => {
  await page.waitForFunction(
    (target) => {
      const text = document.querySelector('#inspection')?.textContent ?? '';
      try {
        const state = JSON.parse(text);
        const frame = typeof state.frame === 'number' ? state.frame : state.frame?.frameId;
        return Number.isFinite(frame) && frame >= target;
      } catch {
        return false;
      }
    },
    minimum,
    { timeout: TIMEOUT_MS },
  );
  return readInspection(page);
};

const waitForRendererTransition = async (page, before, transition) => {
  const beforeFrame = frameIdOf(before);
  if (!Number.isFinite(beforeFrame)) {
    throw new Error(`${transition} transition has no finite baseline inspection frame`);
  }
  await page.waitForFunction(
    ({ minimum, transition: expectedTransition }) => {
      const text = document.querySelector('#inspection')?.textContent ?? '';
      try {
        const state = JSON.parse(text);
        const frame = typeof state.frame === 'number' ? state.frame : state.frame?.frameId;
        if (!Number.isFinite(frame) || frame < minimum) return false;
        const motionBlur = state.motionBlur;
        if (expectedTransition === 'off') {
          return motionBlur?.enabled === false && motionBlur?.status === 'off';
        }
        if (expectedTransition !== 'on') return false;
        return (
          motionBlur?.enabled === true &&
          motionBlur?.status === 'active' &&
          motionBlur?.temporalDemand === 'scene-data-temporal-v1' &&
          ['standard-scene-data', 'motion-blur', 'output-transform'].every((pass) =>
            (state.passes ?? []).includes(pass),
          )
        );
      } catch {
        return false;
      }
    },
    { minimum: beforeFrame + 1, transition },
    { timeout: TIMEOUT_MS },
  );
  return assertFreshRendererSubmission(
    before,
    await readInspection(page),
    `motion-blur-${transition} transition`,
  );
};

const waitForInspection = async (page) => {
  await page.waitForFunction(
    () => {
      const text = document.querySelector('#inspection')?.textContent ?? '';
      try {
        const state = JSON.parse(text);
        return state !== null && typeof state === 'object' && typeof state.backend === 'string';
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: TIMEOUT_MS },
  );
  return readInspection(page);
};

const measureFrameSamples = async (page) =>
  page.evaluate(async (sampleCount) => {
    const readFrame = () => {
      const text = document.querySelector('#inspection')?.textContent ?? '';
      try {
        const state = JSON.parse(text);
        const frame = typeof state.frame === 'number' ? state.frame : state.frame?.frameId;
        return Number.isFinite(frame) ? frame : null;
      } catch {
        return null;
      }
    };
    const waitForFrames = (target) =>
      new Promise((resolve) => {
        const startedAt = performance.now();
        const tick = () => {
          const frame = readFrame();
          if (frame !== null && frame >= target) {
            resolve({ frame, elapsed: performance.now() - startedAt });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    let frame = readFrame();
    if (frame === null)
      throw new Error('page timing started before inspection frame was available');
    const warmup = await waitForFrames(frame + 2);
    frame = warmup.frame;
    const samples = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const sample = await waitForFrames(frame + 2);
      samples.push(sample.elapsed / 2);
      frame = sample.frame;
    }
    return samples;
  }, PERFORMANCE_SAMPLE_COUNT);

const readback = async (page, label) => {
  const png = await page.locator('#app').screenshot({ type: 'png' });
  const decoded = UPNG.decode(png);
  const pixels = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
  let nonBlack = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if ((pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0) > 12) {
      nonBlack += 1;
    }
  }
  if (nonBlack === 0) throw new Error(`${label} WebGL2 compositor readback is entirely black`);
  const evidence = {
    label,
    width: decoded.width,
    height: decoded.height,
    nonBlack,
    sha256: createHash('sha256').update(png).digest('hex'),
  };
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  writeFileSync(`${SCREENSHOT_DIR}/${label}.png`, png);
  console.log(`[hello-taa-webgl2] ${label}: ${JSON.stringify(evidence)}`);
  return evidence;
};

const assertWebgl2Capability = (state, label) => {
  if (state.backend !== 'wgpu-webgl2') {
    throw new Error(`${label}: unexpected backend=${state.backend ?? 'unknown'}`);
  }
  if (state.capabilities?.rgba16floatRenderable !== true) {
    throw new Error(
      `${label}: rgba16floatRenderable=false; WebGL2 temporal raster evidence is unavailable`,
    );
  }
};

const assertWebgl2State = (state, label) => {
  assertWebgl2Capability(state, label);
  if (!['off', 'stable'].includes(state.temporal?.status)) {
    throw new Error(
      `${label}: temporal state is not stable/off: ${JSON.stringify(state.temporal)}`,
    );
  }
  if (state.temporal?.status === 'stable' && state.temporal.historyValid !== true) {
    throw new Error(`${label}: stable temporal state is not history-valid`);
  }
  if (state.motionBlur?.enabled !== true || state.motionBlur?.status !== 'active') {
    throw new Error(`${label}: Motion Blur is not active: ${JSON.stringify(state.motionBlur)}`);
  }
  if (state.motionBlur?.temporalDemand !== 'scene-data-temporal-v1') {
    throw new Error(
      `${label}: Motion Blur temporal demand is not scene-data-temporal-v1: ${JSON.stringify(state.motionBlur)}`,
    );
  }
  for (const pass of ['standard-scene-data', 'motion-blur', 'output-transform']) {
    if (!(state.passes ?? []).includes(pass)) throw new Error(`${label}: missing pass ${pass}`);
  }
};

async function runAttempt() {
  let browser;
  const logs = [];
  let webkitVersion = 'unavailable';
  let channel = { hasGpu: null, webgl2: null };
  let observedInspection;
  try {
    if (PERFORMANCE_OUTPUT !== undefined && (!runnerProvenance.ok || !cpuAffinity.ok)) {
      const reason = !runnerProvenance.ok ? runnerProvenance.reason : cpuAffinity.reason;
      writePerformanceUnavailable(reason);
      return {
        ok: false,
        summary: reason,
        report: {
          ...performanceAdmissionUnavailable(reason),
          testedRevision: TESTED_SHA,
          sourceRevision: SOURCE_REVISION,
          buildDigest: hashVitePayload(buildRoot),
          buildArtifact,
          runnerName: runnerProvenance.runnerName,
          runnerFacts: runnerProvenance.runnerFacts,
          cpuAffinity: cpuAffinity.ok ? cpuAffinity.cpuAffinity : null,
        },
      };
    }
    browser = await webkit.launch({ headless: true });
    webkitVersion = browser.version();
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') logs.push(`[console] ${message.text()}`);
    });
    page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));
    await page.goto(`${URL.replace(/\/$/, '')}/?taa-smoke=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    channel = await page.evaluate(() => ({
      hasGpu: typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu,
      webgl2: !!document.createElement('canvas').getContext('webgl2'),
    }));
    if (channel.hasGpu !== false || channel.webgl2 !== true) {
      throw new Error(`WebKit Channel 3 proof failed: ${JSON.stringify(channel)}`);
    }
    const resolution = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        canvas: canvas === null ? null : { width: canvas.width, height: canvas.height },
      };
    });
    if (
      resolution.viewport.width !== 1920 ||
      resolution.viewport.height !== 1080 ||
      resolution.canvas?.width !== 1920 ||
      resolution.canvas?.height !== 1080
    ) {
      throw new Error(
        `WebKit performance-admission resolution is not 1920x1080: ${JSON.stringify(resolution)}`,
      );
    }

    const capability = await waitForInspection(page);
    observedInspection = capability;
    assertWebgl2Capability(capability, 'initial WebGL2 capability inspection');
    const initial = await waitForFrame(page, REQUIRED_FRAMES);
    observedInspection = initial;
    assertWebgl2State(initial, 'initial 60-frame inspection');
    const initialOn = await readback(page, 'motion-blur-on');
    const initialFrame = frameIdOf(initial);

    await page.locator('#pause-toggle').click();
    await page.waitForFunction(
      () => document.querySelector('#control-status')?.textContent?.startsWith('Paused') === true,
      undefined,
      { timeout: 5_000 },
    );
    const paused = await readInspection(page);
    const pausedFrame = frameIdOf(paused);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (frameIdOf(await readInspection(page)) !== pausedFrame)
      throw new Error('pause did not freeze frame loop');

    await page.locator('#pause-toggle').click();
    await page.waitForFunction(
      () => document.querySelector('#control-status')?.textContent?.startsWith('Running') === true,
      undefined,
      { timeout: 5_000 },
    );
    const resumed = await waitForFrame(page, pausedFrame + 3);
    observedInspection = resumed;
    assertWebgl2State(resumed, 'post-resume inspection');
    const resumedOn = await readback(page, 'motion-blur-on-resumed');
    const beforeOff = await readInspection(page);
    await page.locator('#motion-blur-toggle').click();
    await page.waitForFunction(
      () =>
        document.querySelector('#control-status')?.textContent?.includes('Motion Blur Off') ===
        true,
      undefined,
      { timeout: 5_000 },
    );
    const off = await waitForRendererTransition(page, beforeOff, 'off');
    observedInspection = off;
    if (off.motionBlur?.enabled !== false || off.motionBlur?.status !== 'off') {
      throw new Error(`Motion Blur off state was not published: ${JSON.stringify(off.motionBlur)}`);
    }
    const offReadback = await readback(page, 'motion-blur-off');
    const offSamplesMs = await measureFrameSamples(page);
    const beforeOn = await readInspection(page);
    await page.locator('#motion-blur-toggle').click();
    await page.waitForFunction(
      () =>
        document.querySelector('#control-status')?.textContent?.includes('Motion Blur On') === true,
      undefined,
      { timeout: 5_000 },
    );
    const on = await waitForRendererTransition(page, beforeOn, 'on');
    observedInspection = on;
    assertWebgl2State(on, 'post-off/on inspection');
    const onReadback = await readback(page, 'motion-blur-on-final');
    const onSamplesMs = await measureFrameSamples(page);
    if (offReadback.sha256 === resumedOn.sha256)
      throw new Error('Motion Blur on/off readbacks are identical');
    if (logs.length > 0) throw new Error(`WebKit page errors: ${JSON.stringify(logs)}`);

    const report = {
      schemaVersion: 'hello-taa-webgl2-smoke/1',
      testedRevision: TESTED_SHA,
      sourceRevision: SOURCE_REVISION,
      runner: RUNNER_NAME ?? null,
      runnerName: runnerProvenance.ok ? runnerProvenance.runnerName : null,
      runnerClass: runnerProvenance.ok ? runnerProvenance.runnerClass : null,
      runnerFacts: runnerProvenance.runnerFacts,
      cpuAffinity: cpuAffinity.ok ? cpuAffinity.cpuAffinity : null,
      webkitVersion,
      playwrightVersion: PLAYWRIGHT_VERSION,
      adapter: { channel: 'webkit-webgl2', navigatorGpu: channel.hasGpu, webgl2: channel.webgl2 },
      lane: 'cpu-webgl2',
      caps: initial.capabilities,
      backend: initial.backend,
      requiredFrames: REQUIRED_FRAMES,
      resolution,
      frame: {
        initial: initialFrame,
        paused: pausedFrame,
        resumed: frameIdOf(resumed),
        off: frameIdOf(off),
      },
      controls: { pauseResume: true, motionBlurToggle: true, onOffDifferent: true },
      rgba16floatRenderable: true,
      temporalTarget: on.temporalTarget ?? null,
      inspection: { initial, resumed, off },
      passTrace: {
        initial: initial.passes,
        resumed: resumed.passes,
        off: off.passes,
      },
      readbacks: [initialOn, resumedOn, offReadback, onReadback],
      errors: logs,
      performance: {
        source: 'page-rAF',
        unit: 'ms/frame',
        gpuTimestamp: false,
        warmupCount: 2,
        order: ['off', 'on'],
        sampleCount: PERFORMANCE_SAMPLE_COUNT,
        rawSamplesMs: { off: offSamplesMs, on: onSamplesMs },
        passCounters: {
          off: activePassCountersFromInspection(off),
          on: activePassCountersFromInspection(on),
        },
      },
    };
    if (PERFORMANCE_OUTPUT !== undefined) {
      writeFileSync(
        PERFORMANCE_OUTPUT,
        `${JSON.stringify(
          {
            schemaVersion: WEBGL2_PERFORMANCE_ADMISSION_SCHEMA_VERSION,
            status: 'observed',
            testedRevision: TESTED_SHA,
            sourceRevision: SOURCE_REVISION,
            buildDigest: hashVitePayload(buildRoot),
            buildArtifact,
            runner: RUNNER_NAME,
            adapter: report.adapter,
            backend: report.backend,
            runnerName: runnerProvenance.runnerName,
            runnerClass: runnerProvenance.runnerClass,
            runnerFacts: runnerProvenance.runnerFacts,
            cpuAffinity: cpuAffinity.cpuAffinity,
            queue: runnerProvenance.runnerFacts.queue,
            execution: 'browser-page-rAF',
            adapterId: 'webkit-webgl2',
            capabilities: report.caps,
            resolution: { width: resolution.canvas.width, height: resolution.canvas.height },
            temporalTarget: report.temporalTarget,
            timing: { source: 'page-rAF', unit: 'ms/frame', gpuTimestamp: false },
            protocol: {
              warmupCount: 2,
              sampleCount: PERFORMANCE_SAMPLE_COUNT,
              order: ['off', 'on'],
            },
            rawSamplesMs: { off: offSamplesMs, on: onSamplesMs },
            passCounters: {
              off: activePassCountersFromInspection(off),
              on: activePassCountersFromInspection(on),
            },
            passTrace: report.passTrace,
          },
          null,
          2,
        )}\n`,
      );
    }
    console.log(`[hello-taa-webgl2] PASS ${JSON.stringify(report)}`);
    return {
      ok: true,
      summary: 'WebKit WebGL2 60-frame raster/readback/toggle/pause-resume pass',
      report,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const crash = detectWasmCrash(logs.map((text) => ({ text })));
    console.error(`[hello-taa-webgl2] FAIL: ${message}`);
    return {
      ok: false,
      summary: message,
      retryable: crash !== null,
      report: {
        testedRevision: TESTED_SHA,
        sourceRevision: SOURCE_REVISION,
        runner: RUNNER_NAME ?? null,
        runnerName: runnerProvenance.ok ? runnerProvenance.runnerName : null,
        runnerClass: runnerProvenance.ok ? runnerProvenance.runnerClass : null,
        runnerFacts: runnerProvenance.runnerFacts,
        webkitVersion,
        playwrightVersion: PLAYWRIGHT_VERSION,
        adapter: { channel: 'webkit-webgl2', ...channel },
        lane: 'cpu-webgl2',
        caps: observedInspection?.capabilities,
        inspection: observedInspection,
        passTrace: observedInspection?.passes,
        errors: logs,
      },
    };
  } finally {
    if (browser !== undefined)
      await closeBrowserWithDeadline(browser, 10_000, 'hello-taa WebKit browser close');
  }
}

const result = await runWithRetry(runAttempt, { maxAttempts: 3, label: 'hello-taa-webgl2' });
if (STATUS_OUTPUT) {
  mkdirSync(dirname(STATUS_OUTPUT), { recursive: true });
  writeFileSync(
    STATUS_OUTPUT,
    `${JSON.stringify(
      {
        schemaVersion: 'hello-taa-webgl2-runtime-probe-status/1',
        backendId: 'webkit-webgl2',
        testedRevision: TESTED_SHA,
        sourceRevision: SOURCE_REVISION,
        runner: RUNNER_NAME,
        playwrightVersion: PLAYWRIGHT_VERSION,
        status: result.ok ? 'pass' : 'failed',
        summary: result.summary,
        ...(result.report ?? {}),
      },
      null,
      2,
    )}\n`,
  );
}
process.exitCode = result.ok ? 0 : 1;
