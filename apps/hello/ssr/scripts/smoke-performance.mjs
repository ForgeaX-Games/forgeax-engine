#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(appDir, '../../..');
const WIDTH = 1920;
const HEIGHT = 1080;
const MIN_FRAMES = 60;
const FEATURE_ID = 'feat-20260831-ssr-probe-environment-fallback';
const BUDGET_BYTES = 45_088_768;
const CPU_INCREMENT_BUDGET_MS = 0.25;
const artifactDir = resolve(rootDir, 'artifacts/ssr-fallback');

function deriveIndependentDescriptor(width, height) {
  // Keep this arithmetic independent from Render's implementation while
  // following the same admitted descriptor: all spatial intermediates use
  // the half-resolution extent, and each reflection mip is floor-halved.
  const halfWidth = Math.max(1, Math.floor(width / 2));
  const halfHeight = Math.max(1, Math.floor(height / 2));
  let mipWidth = halfWidth;
  let mipHeight = halfHeight;
  let mipLevels = 0;
  let depthPyramidBytes = 0;
  let resolvedBytes = 0;
  const levels = [];
  while (true) {
    levels.push({ level: mipLevels, width: mipWidth, height: mipHeight });
    depthPyramidBytes += mipWidth * mipHeight * 4;
    resolvedBytes += mipWidth * mipHeight * 8;
    mipLevels += 1;
    if (mipWidth === 1 && mipHeight === 1) break;
    mipWidth = Math.max(1, Math.floor(mipWidth / 2));
    mipHeight = Math.max(1, Math.floor(mipHeight / 2));
  }
  const traceBytes = halfWidth * halfHeight * 8;
  const hitReactivityBytes = halfWidth * halfHeight * 4;
  // Two history slots each carry rgba16f radiance + rgba8 surface metadata.
  const historyBytes = halfWidth * halfHeight * 12 * 2;
  const temporalParamsBytes = 32;
  const fallbackInputBytes = width * height * 8;
  const ssrOwnedBytes =
    depthPyramidBytes +
    traceBytes +
    hitReactivityBytes +
    resolvedBytes +
    historyBytes +
    temporalParamsBytes +
    fallbackInputBytes;
  return {
    width,
    height,
    halfWidth,
    halfHeight,
    mipLevels: levels,
    depthPyramidBytes,
    traceBytes,
    hitReactivityBytes,
    resolvedBytes,
    historyBytes,
    temporalParamsBytes,
    fallbackInputBytes,
    ssrOwnedBytes,
    budgetBytes: BUDGET_BYTES,
    withinBudget: ssrOwnedBytes <= BUDGET_BYTES,
  };
}

const descriptorProjection = (descriptor) => ({
  width: descriptor.width,
  height: descriptor.height,
  halfWidth: descriptor.halfWidth,
  halfHeight: descriptor.halfHeight,
  depthPyramidBytes: descriptor.depthPyramidBytes,
  traceBytes: descriptor.traceBytes,
  hitReactivityBytes: descriptor.hitReactivityBytes,
  resolvedBytes: descriptor.resolvedBytes,
  historyBytes: descriptor.historyBytes,
  temporalParamsBytes: descriptor.temporalParamsBytes,
  fallbackInputBytes: descriptor.fallbackInputBytes,
  ssrOwnedBytes: descriptor.ssrOwnedBytes,
  budgetBytes: descriptor.budgetBytes,
  withinBudget: descriptor.withinBudget,
});

const independentDescriptor = deriveIndependentDescriptor(WIDTH, HEIGHT);
const render = await import('@forgeax/engine-render/internal');
const ownerDescriptor = render.estimateSsrSpatialMemory({ width: WIDTH, height: HEIGHT }, { temporal: true });
const descriptorMatchesOwner =
  JSON.stringify(descriptorProjection(ownerDescriptor)) ===
  JSON.stringify(descriptorProjection(independentDescriptor));

const percentile = (values, fraction) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * (sorted.length - 1))));
  return sorted[index];
};

function runDawn({ disableSsr, reportPath }) {
  const env = {
    ...process.env,
    FORGEAX_SKIP_HARNESS_SYNC: '1',
    SMOKE_MIN_FRAMES: String(MIN_FRAMES),
    SMOKE_PERF_TIMING: '1',
    SMOKE_WAIT_DRAW_COMPLETION: '1',
    SMOKE_WIDTH: String(WIDTH),
    SMOKE_HEIGHT: String(HEIGHT),
    SMOKE_REPORT_FILE: reportPath,
    SMOKE_QUIET: '1',
    VITE_REFLECTION_PROBE_EVIDENCE: '0',
    VITE_SSR_EVIDENCE: '1',
  };
  if (disableSsr) env.SMOKE_DISABLE_SSR = '1';
  else delete env.SMOKE_DISABLE_SSR;
  const child = spawnSync(process.execPath, ['scripts/smoke-dawn.mjs'], {
    cwd: appDir,
    encoding: 'utf8',
    timeout: Number(process.env.SSR_PERF_TIMEOUT_MS ?? 900_000),
    maxBuffer: 32 * 1024 * 1024,
    env,
  });
  const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    const reportMatch = output.match(/^\[hello-ssr\] report=(\{.*\})$/m);
    if (reportMatch !== null) {
      try {
        report = JSON.parse(reportMatch[1]);
      } catch {
        report = undefined;
      }
    }
  }
  return { child, output, report };
}

mkdirSync(artifactDir, { recursive: true });
const baselineRun = runDawn({
  disableSsr: true,
  reportPath: resolve(artifactDir, 'performance-baseline-runtime-report.json'),
});
const ssrRun = runDawn({
  disableSsr: false,
  reportPath: resolve(artifactDir, 'performance-runtime-report.json'),
});
process.stdout.write(`${baselineRun.output}\n${ssrRun.output}`);
const child = ssrRun.child;
const runtimeReport = ssrRun.report;
const baselineReport = baselineRun.report;

const passStats = runtimeReport?.performanceTiming?.gpu?.passStats ?? {};
const ssrPassStats = Object.fromEntries(
  Object.entries(passStats).filter(([name]) => name.startsWith('ssr-') || name.startsWith('depth-pyramid-')),
);
const passFamilies = {
  depthPyramid: Object.entries(ssrPassStats).filter(([name]) => name.startsWith('depth-pyramid-')),
  trace: Object.entries(ssrPassStats).filter(([name]) => name === 'ssr-trace'),
  temporal: Object.entries(ssrPassStats).filter(([name]) => name === 'ssr-temporal'),
  compose: Object.entries(ssrPassStats).filter(([name]) => name === 'ssr-compose'),
};
const sumRawSamples = (entries) => {
  const lengths = entries.map(([, stats]) => Array.isArray(stats.samples) ? stats.samples.length : -1);
  const sampleCount = lengths[0] ?? 0;
  const valid = entries.length > 0 && sampleCount > 0 && lengths.every((length) => length === sampleCount);
  if (!valid) return { samples: [], sampleCount, lengths, valid: false };
  const samples = Array.from({ length: sampleCount }, (_, index) =>
    entries.reduce((sum, [, stats]) => sum + stats.samples[index], 0),
  );
  return { samples, sampleCount, lengths, valid: true };
};
const gpuSsrAggregate = sumRawSamples(Object.entries(ssrPassStats));
const gpuSsrFamilyAggregates = Object.fromEntries(
  Object.entries(passFamilies).map(([family, entries]) => [family, sumRawSamples(entries)]),
);
const gpuSsrBudget = {
  // Percentiles are computed after summing matching per-frame pass samples;
  // summing independent pass percentiles would describe different frames.
  samplesMs: gpuSsrAggregate.samples,
  sampleCount: gpuSsrAggregate.sampleCount,
  p50Ms: gpuSsrAggregate.valid ? percentile(gpuSsrAggregate.samples, 0.5) : null,
  p95Ms: gpuSsrAggregate.valid ? percentile(gpuSsrAggregate.samples, 0.95) : null,
  thresholdsMs: { p50: 3, p95: 5 },
  families: Object.fromEntries(
    Object.entries(passFamilies).map(([family, entries]) => [family, {
      passNames: entries.map(([name]) => name),
      samplesMs: gpuSsrFamilyAggregates[family].samples,
      sampleCount: gpuSsrFamilyAggregates[family].sampleCount,
      p50Ms: gpuSsrFamilyAggregates[family].valid
        ? percentile(gpuSsrFamilyAggregates[family].samples, 0.5) : null,
      p95Ms: gpuSsrFamilyAggregates[family].valid
        ? percentile(gpuSsrFamilyAggregates[family].samples, 0.95) : null,
    }]),
  ),
};
const cpu = runtimeReport?.performanceTiming?.cpu;
const baselineCpu = baselineReport?.performanceTiming?.cpu;
const cpuIncrementSampleCount = Math.min(
  MIN_FRAMES,
  baselineCpu?.samples?.length ?? 0,
  cpu?.samples?.length ?? 0,
);
const cpuIncrementSamples = Array.from({ length: Math.max(0, cpuIncrementSampleCount) }, (_, index) =>
  cpu.samples[index] - baselineCpu.samples[index],
);
const cpuIncrement = {
  method: 'paired-frame-delta',
  samples: cpuIncrementSamples,
  sampleCount: cpuIncrementSamples.length,
  p50Ms: percentile(cpuIncrementSamples, 0.5),
  p95Ms: percentile(cpuIncrementSamples, 0.95),
  thresholdsMs: { p50: CPU_INCREMENT_BUDGET_MS },
  baseline: baselineCpu ?? null,
  ssr: cpu ?? null,
};
const gpu = runtimeReport?.performanceTiming?.gpu;
const shaderIdentity = runtimeReport?.shaderIdentity;
const baselineShaderIdentity = baselineReport?.shaderIdentity;
const adapterIdentity = runtimeReport?.adapter;
const baselineAdapterIdentity = baselineReport?.adapter;
const hostIdentity = runtimeReport?.host;
const baselineHostIdentity = baselineReport?.host;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const errors = [];
if (child.error !== undefined) errors.push(`runner error=${child.error.message}`);
if (child.status !== 0) errors.push(`runner exit=${child.status}`);
if (baselineRun.child.error !== undefined) errors.push(`baseline runner error=${baselineRun.child.error.message}`);
if (baselineRun.child.status !== 0) errors.push(`baseline runner exit=${baselineRun.child.status}`);
if (baselineReport === undefined) errors.push('baseline hello-ssr runtime report missing');
if (baselineReport?.frames !== MIN_FRAMES) errors.push(`baseline frames=${baselineReport?.frames} != ${MIN_FRAMES}`);
if (baselineReport?.ssr?.status !== 'not-requested') {
  errors.push(`SSR baseline was not disabled (status=${baselineReport?.ssr?.status ?? 'missing'})`);
}
if (runtimeReport === undefined) errors.push('hello-ssr runtime report missing');
if (adapterIdentity === null || typeof adapterIdentity !== 'object') {
  errors.push('runtime adapter identity is missing');
}
if (baselineAdapterIdentity === null || typeof baselineAdapterIdentity !== 'object') {
  errors.push('baseline adapter identity is missing');
}
if (JSON.stringify(adapterIdentity) !== JSON.stringify(baselineAdapterIdentity)) {
  errors.push('baseline/runtime adapter identity mismatch');
}
if (hostIdentity === null || typeof hostIdentity !== 'object') {
  errors.push('runtime host identity is missing');
}
if (baselineHostIdentity === null || typeof baselineHostIdentity !== 'object') {
  errors.push('baseline host identity is missing');
}
if (JSON.stringify(hostIdentity) !== JSON.stringify(baselineHostIdentity)) {
  errors.push('baseline/runtime host identity mismatch');
}
for (const field of ['traceShaderSha256', 'composeShaderSha256', 'shaderManifestSha256']) {
  if (!/^[0-9a-f]{64}$/.test(shaderIdentity?.[field] ?? '')) {
    errors.push(`runtime shader identity ${field} is missing or invalid`);
  }
  if (!/^[0-9a-f]{64}$/.test(baselineShaderIdentity?.[field] ?? '')) {
    errors.push(`baseline shader identity ${field} is missing or invalid`);
  }
  if (shaderIdentity?.[field] !== baselineShaderIdentity?.[field]) {
    errors.push(`baseline/runtime shader identity mismatch for ${field}`);
  }
}
if (runtimeReport?.frames !== MIN_FRAMES) errors.push(`frames=${runtimeReport?.frames} != ${MIN_FRAMES}`);
if (runtimeReport?.ssr?.status !== 'admitted') errors.push(`SSR inspection was not admitted (status=${runtimeReport?.ssr?.status ?? 'missing'})`);
if (runtimeReport?.performanceTiming?.resolution?.width !== WIDTH || runtimeReport?.performanceTiming?.resolution?.height !== HEIGHT) {
  errors.push(`runtime resolution is not ${WIDTH}x${HEIGHT}`);
}
if (!independentDescriptor.withinBudget || !ownerDescriptor.withinBudget) errors.push('SSR descriptor exceeds memory budget');
if (!descriptorMatchesOwner) errors.push('independent descriptor does not match Render owner estimate');
if (!finite(cpu?.p50Ms) || !finite(cpu?.p95Ms)) errors.push('CPU p50/p95 is unavailable');
if (cpu?.samples?.length < MIN_FRAMES) errors.push(`CPU timing samples=${cpu?.samples?.length ?? 0} < ${MIN_FRAMES}`);
if (cpuIncrement.sampleCount < MIN_FRAMES) errors.push(`CPU increment samples=${cpuIncrement.sampleCount} < ${MIN_FRAMES}`);
if (!finite(cpuIncrement.p50Ms) || !finite(cpuIncrement.p95Ms)) errors.push('CPU planning/record increment p50/p95 is unavailable');
if (finite(cpuIncrement.p50Ms) && cpuIncrement.p50Ms > CPU_INCREMENT_BUDGET_MS) {
  errors.push(`SSR CPU increment p50=${cpuIncrement.p50Ms}ms > ${CPU_INCREMENT_BUDGET_MS}ms`);
}
if (!['complete', 'partial'].includes(gpu?.status)) errors.push(`GPU timing status=${gpu?.status ?? 'missing'}`);
if (Object.keys(ssrPassStats).length < 4) errors.push(`SSR pass timing coverage=${Object.keys(ssrPassStats).length}`);
for (const [family, entries] of Object.entries(passFamilies)) {
  if (entries.length === 0) errors.push(`SSR ${family} timing family is missing`);
}
if (!finite(gpuSsrBudget.p50Ms) || !finite(gpuSsrBudget.p95Ms)) {
  errors.push('SSR aggregate GPU timing is unavailable');
} else {
  if (gpuSsrBudget.p50Ms > gpuSsrBudget.thresholdsMs.p50) errors.push(`SSR GPU p50=${gpuSsrBudget.p50Ms}ms > ${gpuSsrBudget.thresholdsMs.p50}ms`);
  if (gpuSsrBudget.p95Ms > gpuSsrBudget.thresholdsMs.p95) errors.push(`SSR GPU p95=${gpuSsrBudget.p95Ms}ms > ${gpuSsrBudget.thresholdsMs.p95}ms`);
}
if (!gpuSsrAggregate.valid) {
  errors.push(`SSR aggregate GPU raw sample lengths are invalid: ${JSON.stringify(gpuSsrAggregate.lengths)}`);
}
for (const [name, stats] of Object.entries(ssrPassStats)) {
  if (!finite(stats.p50Ms) || !finite(stats.p95Ms) || !Array.isArray(stats.samples) || stats.samples.length === 0) {
    errors.push(`SSR pass ${name} has no raw timing samples`);
  }
}

const identity = {
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim(),
  sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: rootDir, encoding: 'utf8' }).trim(),
  lockSha256: createHash('sha256').update(readFileSync(resolve(rootDir, 'pnpm-lock.yaml'))).digest('hex'),
  buildSha256: createHash('sha256').update(readFileSync(resolve(rootDir, 'packages/render/dist/index.mjs'))).digest('hex'),
};
const artifact = {
  schemaVersion: 'hello-ssr-performance/1',
  featureId: FEATURE_ID,
  status: errors.length === 0 ? 'pass' : 'fail',
  identity,
  runner: {
    lane: 'dawn',
    backend: runtimeReport?.backend ?? null,
    adapter: adapterIdentity ?? null,
    host: hostIdentity ?? null,
    frames: runtimeReport?.frames ?? 0,
    resolution: { width: WIDTH, height: HEIGHT },
  },
  descriptor: {
    owner: ownerDescriptor,
    independent: independentDescriptor,
    matchesOwner: descriptorMatchesOwner,
  },
  shaderIdentity: shaderIdentity ?? null,
  runs: {
    baseline: baselineReport?.run ?? null,
    runtime: runtimeReport?.run ?? null,
  },
  timing: {
    cpu: cpu ?? null,
    cpuIncrement,
    gpu: gpu === undefined ? null : { ...gpu, passStats: ssrPassStats },
    ssrGpuBudget: gpuSsrBudget,
  },
  ...(errors.length === 0 ? {} : { errors }),
};
writeFileSync(resolve(artifactDir, 'performance.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`[hello-ssr] performance=${JSON.stringify(artifact)}`);
process.exitCode = errors.length === 0 ? 0 : 1;
