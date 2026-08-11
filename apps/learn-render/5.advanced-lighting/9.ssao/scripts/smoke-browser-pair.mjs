// Browser OFF/ON pair for the SSAO forensic oracle.
// The single-lane smoke proves capture/replay fidelity; this pair proves that
// the enabled SSAO path changes the final image and exposes its intermediate
// targets and pipelines in the capture tape.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const appDir = resolve(import.meta.dirname, '..');
const engineRoot = resolve(appDir, '../../../..');
const rhiDebugDir = resolve(engineRoot, 'packages/rhi-debug');
const rhiDebugCli = resolve(rhiDebugDir, 'dist/cli.mjs');
const { PNG } = createRequire(resolve(rhiDebugDir, 'package.json'))('pngjs');
const executionKinds = new Set([
  'draw',
  'drawIndexed',
  'drawIndirect',
  'drawIndexedIndirect',
  'dispatchWorkgroups',
  'dispatchWorkgroupsIndirect',
]);
const artifactDir = process.env.FORGEAX_SSAO_PAIR_ARTIFACT_DIR
  ? resolve(process.env.INIT_CWD ?? process.cwd(), process.env.FORGEAX_SSAO_PAIR_ARTIFACT_DIR)
  : resolve(appDir, '.forgeax-debug');

function facts(report) {
  const events = Array.isArray(report.events) ? report.events : [];
  const pipelines = events
    .filter((event) => event.kind === 'createRenderPipeline')
    .map((event) => event.desc?.fragment?.entryPoint)
    .filter((entryPoint) => entryPoint === 'fs_ssao_calc' || entryPoint === 'fs_ssao_blur');
  const aoTextures = events
    .filter(
      (event) =>
        event.kind === 'createTexture' &&
        event.desc?.format === 'r8unorm' &&
        event.desc?.size?.width === 640 &&
        event.desc?.size?.height === 360,
    )
    .map((event) => event.handleId);
  const aoViews = new Set(
    events
      .filter((event) => event.kind === 'createTextureView' && aoTextures.includes(event.sourceHandleId))
      .map((event) => event.resultHandleId),
  );
  const aoPasses = events.filter(
    (event) =>
      event.kind === 'beginRenderPass' &&
      event.colorAttachmentViewHandleIds?.length === 1 &&
      event.colorAttachmentViewHandleIds.some((handleId) => aoViews.has(handleId)),
  ).length;
  return {
    eventCount: events.length,
    blobCount: report.header?.blobEntries?.length ?? null,
    pipelines,
    aoTextures: aoTextures.length,
    aoPasses,
    valid: report.valid,
  };
}

function pixelOracle(offB64, onB64) {
  const off = Buffer.from(offB64, 'base64');
  const on = Buffer.from(onB64, 'base64');
  if (off.length !== on.length || off.length === 0 || off.length % 4 !== 0) {
    throw new Error(`pixel buffers disagree: off=${off.length} on=${on.length}`);
  }
  let diffCount = 0;
  let sumRgbDelta = 0;
  for (let index = 0; index < off.length; index += 4) {
    let differs = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(off[index + channel] - on[index + channel]);
      sumRgbDelta += delta;
      if (delta > 0) differs = true;
    }
    if (differs) diffCount += 1;
  }
  const totalPixels = off.length / 4;
  return {
    diffCount,
    totalPixels,
    diffFraction: diffCount / totalPixels,
    meanRgbDelta: sumRgbDelta / (totalPixels * 3 * 255),
  };
}

function findPipelineDraws(report) {
  const pipelineEntries = new Map(
    report.events
      .filter((event) => event.kind === 'createRenderPipeline')
      .map((event) => [event.handleId, event.desc?.fragment?.entryPoint]),
  );
  const passPipelines = new Map();
  const draws = { fs_ssao_calc: [], fs_ssao_blur: [] };
  let drawIndex = 0;
  for (const event of report.events) {
    if (event.kind === 'setPipeline') {
      passPipelines.set(event.passHandleId, pipelineEntries.get(event.pipelineHandleId));
    } else if (executionKinds.has(event.kind)) {
      const entryPoint = passPipelines.get(event.passHandleId);
      if (entryPoint in draws) draws[entryPoint].push(drawIndex);
      drawIndex += 1;
    }
  }
  return draws;
}

function patchStats(png, x, y, width, height) {
  let total = 0;
  let min = 255;
  let max = 0;
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      const value = png.data[(row * png.width + column) * 4];
      total += value;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return { mean: total / (width * height) / 255, min, max };
}

function readPngStats(pngPath) {
  const png = PNG.sync.read(readFileSync(pngPath));
  let total = 0;
  let min = 255;
  let max = 0;
  let nonUniform = 0;
  const unique = new Set();
  for (let index = 0; index < png.width * png.height; index += 1) {
    const value = png.data[index * 4];
    total += value;
    min = Math.min(min, value);
    max = Math.max(max, value);
    if (value !== 255) nonUniform += 1;
    unique.add(value);
  }
  return {
    width: png.width,
    height: png.height,
    min,
    max,
    mean: total / (png.width * png.height) / 255,
    nonUniform,
    unique: unique.size,
    center: png.data[((Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4)],
    empty: patchStats(png, 0, 0, 96, 96),
    object: patchStats(png, 256, 280, 128, 56),
  };
}

function comparePngs(firstPath, secondPath) {
  const first = PNG.sync.read(readFileSync(firstPath));
  const second = PNG.sync.read(readFileSync(secondPath));
  if (first.width !== second.width || first.height !== second.height) {
    throw new Error(`SSAO intermediate dimensions disagree: ${first.width}x${first.height} / ${second.width}x${second.height}`);
  }
  let changed = 0;
  let totalDelta = 0;
  for (let index = 0; index < first.width * first.height; index += 1) {
    const delta = Math.abs(first.data[index * 4] - second.data[index * 4]);
    if (delta > 0) changed += 1;
    totalDelta += delta;
  }
  const totalPixels = first.width * first.height;
  return {
    changed,
    changedFraction: changed / totalPixels,
    meanAbsDelta: totalDelta / totalPixels / 255,
  };
}

function inspectIntermediate(tapePath, reportPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const draws = findPipelineDraws(report);
  const intermediates = {};
  for (const entryPoint of ['fs_ssao_calc', 'fs_ssao_blur']) {
    if (draws[entryPoint].length !== 1) {
      throw new Error(`expected one ${entryPoint} draw, got ${JSON.stringify(draws[entryPoint])}`);
    }
    const inspected = spawnSync(
      process.execPath,
      [rhiDebugCli, 'inspect-offline', tapePath, String(draws[entryPoint][0]), '--fields=rt'],
      { cwd: engineRoot, encoding: 'utf8' },
    );
    if (inspected.status !== 0) {
      throw new Error(`${entryPoint} inspect-offline failed: ${inspected.stderr.trim()}`);
    }
    const result = JSON.parse(inspected.stdout);
    if (result.pipelineState?.shaders?.fragmentEntryPoint !== entryPoint) {
      throw new Error(`${entryPoint} draw resolved to ${result.pipelineState?.shaders?.fragmentEntryPoint}`);
    }
    const sourcePath = resolve(engineRoot, result.rt);
    if (!existsSync(sourcePath)) throw new Error(`${entryPoint} RT is missing: ${sourcePath}`);
    const targetPath = resolve(artifactDir, `ssao-on-${entryPoint === 'fs_ssao_calc' ? 'calc' : 'blur'}.png`);
    copyFileSync(sourcePath, targetPath);
    const stats = readPngStats(sourcePath);
    if (stats.width !== 640 || stats.height !== 360 || stats.max !== 255 || stats.nonUniform < 1_000) {
      throw new Error(`${entryPoint} RT lacks a structured AO field: ${JSON.stringify(stats)}`);
    }
    if (stats.empty.mean - stats.object.mean < 0.2) {
      throw new Error(`${entryPoint} RT lacks empty-space/object separation: ${JSON.stringify(stats)}`);
    }
    intermediates[entryPoint] = { drawIndex: draws[entryPoint][0], path: targetPath, stats };
  }
  const delta = comparePngs(intermediates.fs_ssao_calc.path, intermediates.fs_ssao_blur.path);
  if (delta.changedFraction < 0.1 || delta.meanAbsDelta < 0.005) {
    throw new Error(`SSAO raw/blur intermediate oracle failed: ${JSON.stringify(delta)}`);
  }
  return { draws, intermediates, delta };
}

const server = spawn(process.execPath, [resolve(appDir, 'node_modules/vite/bin/vite.js')], {
  cwd: appDir,
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let url;
server.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(`[vite] ${text}`);
  const match = text.match(/Local:\s+(http:\/\/[^\s]+)/);
  if (match) url = match[1];
});
server.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

async function capture(browser, label, suffix) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  try {
    await page.goto(`${url}${suffix}`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForTimeout(8_000);
    const result = await page.evaluate(async () => {
      const capture = globalThis.__forgeax?.captureFrame;
      const readPixels = globalThis.__captureSsao;
      if (typeof capture !== 'function' || typeof readPixels !== 'function') {
        throw new Error('captureFrame or __captureSsao missing');
      }
      const out = await capture(1);
      const value = await readPixels();
      const pixels = value instanceof Uint8Array ? value : new Uint8Array(value);
      let binary = '';
      for (let index = 0; index < pixels.length; index += 0x2000) {
        binary += String.fromCharCode(...pixels.subarray(index, index + 0x2000));
      }
      return { out, pixels: btoa(binary) };
    });
    const tapePath = resolve(appDir, result.out.tapePath);
    const reportPath = resolve(appDir, result.out.reportPath);
    if (!existsSync(tapePath) || !existsSync(reportPath)) {
      throw new Error(`capture ${label} missing artifacts: ${tapePath} / ${reportPath}`);
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    mkdirSync(artifactDir, { recursive: true });
    const targetTapePath = resolve(artifactDir, `ssao-${label}.tape.bin`);
    const targetReportPath = resolve(artifactDir, `ssao-${label}.report.json`);
    copyFileSync(tapePath, targetTapePath);
    copyFileSync(reportPath, targetReportPath);
    return {
      label,
      pixels: result.pixels,
      tapePath: targetTapePath,
      reportPath: targetReportPath,
      facts: facts(report),
      consoleErrors,
    };
  } finally {
    await context.close();
  }
}

let browser;
try {
  const deadline = Date.now() + 30_000;
  while (!url && Date.now() < deadline) await sleep(200);
  if (!url) throw new Error('vite did not become ready in 30s');
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
  });
  const off = await capture(browser, 'off', '?falsify=ssao-off');
  const on = await capture(browser, 'on', '');
  const oracle = pixelOracle(off.pixels, on.pixels);
  const intermediate = inspectIntermediate(on.tapePath, on.reportPath);
  if (off.facts.pipelines.length !== 0 || off.facts.aoPasses !== 0) {
    throw new Error(`OFF tape unexpectedly executes SSAO work: ${JSON.stringify(off.facts)}`);
  }
  if (
    on.facts.pipelines.length < 2 ||
    on.facts.aoTextures !== 2 ||
    on.facts.aoPasses < 2
  ) {
    throw new Error(`ON tape lacks SSAO intermediate evidence: ${JSON.stringify(on.facts)}`);
  }
  if (oracle.diffCount < 1 || oracle.meanRgbDelta < 0.001 || oracle.diffFraction > 0.5) {
    throw new Error(`SSAO OFF/ON oracle failed: ${JSON.stringify(oracle)}`);
  }
  const result = {
    url,
    off: { ...off, pixels: undefined },
    on: { ...on, pixels: undefined },
    oracle,
    intermediate,
  };
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(resolve(artifactDir, 'ssao-pair.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
}
