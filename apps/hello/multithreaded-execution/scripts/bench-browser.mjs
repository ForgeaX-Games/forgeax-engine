import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import {
  assessProductImprovement,
  summarize,
} from './benchmark-statistics.mjs';
import { chromeLaunchOptions } from './chrome-options.mjs';

const port = 5200;
const warmupCount = 20;
const sampleCount = 240;
const requiredImprovement = 0.15;
const server = await preview({
  preview: { host: '127.0.0.1', port, strictPort: true },
  logLevel: 'error',
});

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('benchmark preview server deadline exceeded');
}

async function measure(browser, tier) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/?tier=${tier}&profile=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    (required) => globalThis.__forgeaxExecutionFrameSamples?.length >= required,
    warmupCount + sampleCount,
    { timeout: 120_000 },
  );
  const result = await page.evaluate(() => ({
    report: globalThis.__forgeaxExecutionReport(),
    frameSamples: globalThis.__forgeaxExecutionFrameSamples,
    hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    capture: globalThis.__forgeaxExecutionCapture(),
  }));
  await page.close();
  if (errors.length > 0) throw new Error(`${tier} page errors: ${errors.join(' | ')}`);
  return result;
}

function hostFrameSamples(capture) {
  return capture.records
    .filter(
      (record) =>
        record.kind === 'phase' && record.source === 'app' && record.phase === 'host-frame',
    )
    .map((record) => record.durationMicros / 1_000);
}

try {
  await waitForServer();
  const browser = await chromium.launch(chromeLaunchOptions());
  const inline = await measure(browser, 'engine-worker');
  const shared = await measure(browser, 'shared');
  await browser.close();
  const inlineCadence = inline.frameSamples.slice(warmupCount, warmupCount + sampleCount);
  const sharedCadence = shared.frameSamples.slice(warmupCount, warmupCount + sampleCount);
  const inlineSamples = hostFrameSamples(inline.capture).slice(
    warmupCount,
    warmupCount + sampleCount,
  );
  const sharedSamples = hostFrameSamples(shared.capture).slice(
    warmupCount,
    warmupCount + sampleCount,
  );
  if (inlineSamples.length !== sampleCount || sharedSamples.length !== sampleCount) {
    throw new Error(
      `profile sample count mismatch: inline=${inlineSamples.length}, shared=${sharedSamples.length}`,
    );
  }
  const inlineFrame = summarize(inlineSamples);
  const sharedFrame = summarize(sharedSamples);
  const verdict = assessProductImprovement(
    inlineSamples,
    sharedSamples,
    requiredImprovement,
  );
  const evidence = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    protocol: {
      productionBuild: true,
      sameBrowser: true,
      sameWorkload: true,
      warmupCount,
      sampleCount,
      workload: { rows: 65_536, iterationsPerRow: 96 },
    },
    environment: {
      hardwareConcurrency: shared.hardwareConcurrency,
      userAgent: shared.userAgent,
      crossOriginIsolated: shared.crossOriginIsolated,
    },
    inline: {
      tier: inline.report.actualTier,
      frame: inlineFrame,
      rawSamplesMs: inlineSamples,
      presentationCadence: summarize(inlineCadence),
      workerRoundTrip: inline.report.performance.hostFrameMs,
      engineUpdate: inline.report.performance.engineUpdateMs,
    },
    shared: {
      tier: shared.report.actualTier,
      frame: sharedFrame,
      rawSamplesMs: sharedSamples,
      presentationCadence: summarize(sharedCadence),
      workerRoundTrip: shared.report.performance.hostFrameMs,
      engineUpdate: shared.report.performance.engineUpdateMs,
      kernelWait: shared.report.performance.kernelWaitMs,
      kernelDispatch: shared.report.kernelDispatch,
    },
    verdict,
  };
  const evidencePath = resolve(
    process.cwd(),
    '../../../.forgeax-harness/forgeax-loop/feat-20260807-web-ts-multithreaded-engine-architecture/m3/evidence/product-benchmark.json',
  );
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (!evidence.verdict.passed) process.exitCode = 1;
} finally {
  await server.close();
}
