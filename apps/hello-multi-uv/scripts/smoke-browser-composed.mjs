#!/usr/bin/env node
// M3 composed browser gate: drive the public custom RenderGraph, multi-UV
// material, texture, post-process, resize, and RHI selectors in one live scene.
// The inheritance falsifier can isolate slot attribution, pipeline topology, or both.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(APP_ROOT, '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(APP_ROOT, '.forgeax-debug', 'm3-composed'),
);
const resizeChurn = process.env.FORGEAX_M3_RESIZE_CHURN === '1';
const doubleResizeChurn = process.env.FORGEAX_M3_DOUBLE_RESIZE_CHURN === '1';
const useMsaa = process.env.FORGEAX_M3_MSAA === '1';
const depthPost = process.env.FORGEAX_M3_DEPTH_POST === '1';
const depthLiveSwitch = process.env.FORGEAX_M3_DEPTH_LIVE_SWITCH === '1';
const depthReverseLiveSwitch = process.env.FORGEAX_M3_DEPTH_REVERSE_LIVE_SWITCH === '1';
const inheritanceLiveMaterialScenario = process.env.FORGEAX_M3_INHERITANCE_LIVE_MATERIAL === '1';
const requestedInheritancePost =
  process.env.FORGEAX_M3_INHERITANCE_POST ??
  (process.env.FORGEAX_M3_INHERITANCE_DEPTH_POST === '1' ? 'depth' : 'inversion');
if (requestedInheritancePost !== 'depth' && requestedInheritancePost !== 'inversion') {
  throw new Error(`unsupported inherited post effect: ${requestedInheritancePost}`);
}
const inheritancePost = inheritanceLiveMaterialScenario ? requestedInheritancePost : 'inversion';
const inheritanceDepthPost =
  inheritanceLiveMaterialScenario && inheritancePost === 'depth';
const liveVariantSwitch = inheritanceLiveMaterialScenario && process.env.FORGEAX_M3_LIVE_VARIANT_SWITCH === '1';
const inheritanceFalsifierKind = process.env.FORGEAX_M3_INHERITANCE_FALSIFIER_KIND ?? 'texture';
if (
  inheritanceLiveMaterialScenario &&
  inheritanceFalsifierKind !== 'texture' &&
  inheritanceFalsifierKind !== 'pipeline' &&
  inheritanceFalsifierKind !== 'reverse-pipeline' &&
  inheritanceFalsifierKind !== 'reverse-pipeline-texture'
) {
  throw new Error(`unsupported inheritance falsifier kind: ${inheritanceFalsifierKind}`);
}
const reversePipelineFalsifier =
  inheritanceFalsifierKind === 'reverse-pipeline' || inheritanceFalsifierKind === 'reverse-pipeline-texture';
const textureSlotFalsifier =
  inheritanceFalsifierKind === 'texture' || inheritanceFalsifierKind === 'reverse-pipeline-texture';
const liveMaterialScenario = process.env.FORGEAX_M3_LIVE_MATERIAL === '1' || inheritanceLiveMaterialScenario;
const startVariant = process.env.FORGEAX_M3_START_VARIANT ?? 'true';
if (startVariant !== 'true' && startVariant !== 'false') {
  throw new Error(`unsupported start variant: ${startVariant}`);
}
const switchedVariant = startVariant === 'true' ? 'false' : 'true';
const falsifierKind = process.env.FORGEAX_M3_FALSIFIER_KIND ?? 'texture';
if (falsifierKind !== 'texture' && falsifierKind !== 'pipeline') {
  throw new Error(`unsupported falsifier kind: ${falsifierKind}`);
}
const falsifierQuery = falsifierKind === 'pipeline' ? 'falsify-pipeline' : 'falsify-texture';
const falsifierLabel = falsifierKind === 'pipeline' ? 'falsified-pipeline-inversion' : 'falsified-second-texture-inversion';
const querySuffix = useMsaa ? '&msaa' : '';
mkdirSync(ARTIFACT_DIR, { recursive: true });

function decodePng(buffer) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const start = pos + 8;
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8];
      colorType = buffer[start + 9];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }
    pos = start + length + 4;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported screenshot PNG: bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let rawPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++];
    const rowStart = y * stride;
    const previousStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const source = raw[rawPos++];
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const above = y > 0 ? pixels[previousStart + x] : 0;
      const upperLeft = x >= channels && y > 0 ? pixels[previousStart + x - channels] : 0;
      let value;
      switch (filter) {
        case 0: value = source; break;
        case 1: value = source + left; break;
        case 2: value = source + above; break;
        case 3: value = source + ((left + above) >> 1); break;
        case 4: {
          const predictor = left + above - upperLeft;
          const pa = Math.abs(predictor - left);
          const pb = Math.abs(predictor - above);
          const pc = Math.abs(predictor - upperLeft);
          value = source + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft);
          break;
        }
        default: throw new Error(`unsupported PNG filter ${filter}`);
      }
      pixels[rowStart + x] = value & 0xff;
    }
  }
  return { width, height, pixels, channels };
}

function changedPixels(before, after, threshold = 12) {
  if (before.width !== after.width || before.height !== after.height) return null;
  let changed = 0;
  const channels = Math.min(before.channels, after.channels);
  for (let i = 0; i < before.pixels.length; i += before.channels) {
    const delta = Math.abs((before.pixels[i] ?? 0) - (after.pixels[i] ?? 0))
      + Math.abs((before.pixels[i + 1] ?? 0) - (after.pixels[i + 1] ?? 0))
      + Math.abs((before.pixels[i + 2] ?? 0) - (after.pixels[i + 2] ?? 0));
    if (delta > threshold) changed++;
  }
  return { changed, channels, threshold };
}

function hasDepthBinding(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const text = JSON.stringify(report);
  return text.includes('sceneDepth') && text.includes('depthSampler') && text.includes('"binding":3');
}

async function waitForVite(proc) {
  let portUrl;
  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`[vite] ${text}`);
    portUrl ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
  });
  proc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));
  const deadline = Date.now() + 30_000;
  while (!portUrl && Date.now() < deadline) await sleep(200);
  if (!portUrl) throw new Error('vite did not become ready in 30s');
  return portUrl;
}

async function select(page, id, value, status) {
  await page.selectOption(id, value);
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.textContent === expected,
    {
      selector: status,
      expected:
        id === '#pipeline-select'
          ? `M3_PIPELINE=${value}`
          : value === 'false'
            ? 'M3_MULTI_UV_VARIANT=false'
            : `M3_${id === '#post-select' ? 'POST_EFFECT' : 'MULTI_UV_VARIANT'}=${value}`,
    },
    { timeout: 10_000 },
  );
  await page.waitForTimeout(700);
}

async function resizeCanvas(page, width, height, history) {
  await page.setViewportSize({ width, height });
  await page.waitForFunction(
    (size) => document.querySelector('#app') instanceof HTMLCanvasElement
      && document.querySelector('#app').width === size.width
      && document.querySelector('#app').height === size.height,
    { width, height },
    { timeout: 10_000 },
  );
  await page.waitForTimeout(400);
  history.push(`${width}x${height}`);
}

async function waitForNonBlackCanvas(page, label) {
  const canvas = page.locator('#app');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error(`canvas bounding box missing for ${label}`);
  for (let attempt = 0; attempt < 24; attempt++) {
    const png = await page.screenshot({ clip: box });
    const decoded = decodePng(png);
    let nonBlack = 0;
    for (let index = 0; index < decoded.pixels.length; index += decoded.channels) {
      if ((decoded.pixels[index] ?? 0) !== 0 || (decoded.pixels[index + 1] ?? 0) !== 0 || (decoded.pixels[index + 2] ?? 0) !== 0) {
        nonBlack++;
      }
    }
    if (nonBlack > 0) return;
    await sleep(250);
  }
  throw new Error(`canvas stayed black while waiting for ${label}`);
}

async function capture(page, label) {
  const canvas = page.locator('#app');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error(`canvas bounding box missing for ${label}`);
  const pngPath = resolve(ARTIFACT_DIR, `${label}.png`);
  await page.locator('#variant-control, #pipeline-control, #post-control').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden';
  });
  let png;
  try {
    png = await page.screenshot({ path: pngPath, clip: box });
  } finally {
    await page.locator('#variant-control, #pipeline-control, #post-control').evaluateAll((elements) => {
      for (const element of elements) element.style.visibility = 'visible';
    });
  }
  const decoded = decodePng(png);
  const state = await page.evaluate(() => ({
    variant: document.querySelector('#variant-status')?.textContent ?? '',
    pipeline: document.querySelector('#pipeline-status')?.textContent ?? '',
    post: document.querySelector('#post-status')?.textContent ?? '',
    texture: document.querySelector('#texture-status')?.textContent ?? '',
    canvas: document.querySelector('#app') instanceof HTMLCanvasElement
      ? { width: document.querySelector('#app').width, height: document.querySelector('#app').height }
      : null,
  }));
  return { ...decoded, pngPath, state };
}

async function captureRhi(page, label) {
  const result = await page.evaluate(async () => {
    if (typeof globalThis.__forgeax?.captureFrame !== 'function') {
      throw new Error('window.__forgeax.captureFrame is unavailable');
    }
    return globalThis.__forgeax.captureFrame(1);
  });
  if (typeof result?.tapePath !== 'string' || typeof result?.reportPath !== 'string') {
    throw new Error(`RHI capture did not return tape/report paths: ${JSON.stringify(result)}`);
  }
  const resolveCapturePath = (path) => {
    if (path.startsWith('/')) return path;
    const appPath = resolve(APP_ROOT, path);
    return existsSync(appPath) ? appPath : resolve(REPO_ROOT, path);
  };
  const sourceTape = resolveCapturePath(result.tapePath);
  const sourceReport = resolveCapturePath(result.reportPath);
  const rhiDir = resolve(ARTIFACT_DIR, 'rhi');
  mkdirSync(rhiDir, { recursive: true });
  const tape = resolve(rhiDir, `${label}.tape.bin`);
  const report = resolve(rhiDir, `${label}.report.json`);
  let reportJson;
  const captureDeadline = Date.now() + 5_000;
  while (Date.now() < captureDeadline) {
    try {
      reportJson = JSON.parse(readFileSync(sourceReport, 'utf8'));
      if (readFileSync(sourceTape).byteLength > 0) break;
    } catch {
      reportJson = undefined;
    }
    await sleep(50);
  }
  if (reportJson === undefined) throw new Error(`RHI capture files were not complete: tape=${sourceTape} report=${sourceReport}`);
  copyFileSync(sourceTape, tape);
  copyFileSync(sourceReport, report);
  const cli = resolve(REPO_ROOT, 'packages/rhi-debug/dist/cli.mjs');
  const summary = JSON.parse(execFileSync('node', [cli, 'summary', tape], { encoding: 'utf8' }));
  const inspectedDraw = Math.max(0, (summary.draws?.length ?? 1) - 1);
  const inspect = JSON.parse(execFileSync('node', [cli, 'inspect-offline', tape, String(inspectedDraw), '--fields=bindings,drawCall,rt'], { encoding: 'utf8' }));
  writeFileSync(resolve(rhiDir, `${label}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(resolve(rhiDir, `${label}.inspect.json`), `${JSON.stringify(inspect, null, 2)}\n`);
  const { create, globals } = await import('webgpu');
  Object.assign(globalThis, globals);
  if (globalThis.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  }
  const gpu = create([]);
  Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
  gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
  const rhiWebgpu = await import('@forgeax/engine-rhi-webgpu');
  const adapter = await rhiWebgpu.rhi.requestAdapter();
  if (!adapter.ok) throw new Error(`Dawn requestAdapter failed: ${adapter.error.code}`);
  const recordedCaps = reportJson.header.rhiCapsRecorded ?? {};
  const compressionFeatures = [
    ['textureCompressionBc', 'texture-compression-bc'],
    ['textureCompressionEtc2', 'texture-compression-etc2'],
    ['textureCompressionAstc', 'texture-compression-astc'],
  ];
  const requiredFeatures = compressionFeatures
    .filter(([cap, feature]) => recordedCaps[cap] === true && adapter.value.features.has(feature))
    .map(([, feature]) => feature);
  const device = await adapter.value.requestDevice({
    requiredFeatures,
    requiredLimits: { maxUniformBufferBindingSize: 262144 },
  });
  if (!device.ok) throw new Error(`Dawn requestDevice failed: ${device.error.code}`);
  const { deserializeTape, createReplay } = await import('@forgeax/engine-rhi-debug');
  const parsed = deserializeTape(JSON.stringify({ header: reportJson.header, events: reportJson.events }), new Uint8Array(readFileSync(tape)));
  if (!parsed.ok) throw new Error(`deserializeTape failed: ${parsed.error.code}`);
  const replayResult = createReplay(parsed.value, device.value, rhiWebgpu.createShaderModule);
  if (!replayResult.ok) throw new Error(`createReplay failed: ${replayResult.error.code}`);
  const stepped = await replayResult.value.stepTo(parsed.value.events.length - 1);
  if (!stepped.ok) throw new Error(`replay.stepTo failed: ${stepped.error.code}`);
  const readback = await replayResult.value.readbackRt();
  if (!readback.ok) throw new Error(`replay.readbackRt failed: ${readback.error.code}`);
  const pixels = readback.value.pixels;
  let nonBlackPixelCount = 0;
  let rgbTotal = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index] ?? 0;
    const green = pixels[index + 1] ?? 0;
    const blue = pixels[index + 2] ?? 0;
    if (red !== 0 || green !== 0 || blue !== 0) nonBlackPixelCount++;
    rgbTotal += red + green + blue;
  }
  const dawnReadback = {
    width: readback.value.width,
    height: readback.value.height,
    byteLength: pixels.byteLength,
    nonBlackPixelCount,
    meanRgb: rgbTotal / (readback.value.width * readback.value.height * 3),
    sha256: createHash('sha256').update(pixels).digest('hex'),
    source: 'fresh-dawn-replay.readbackRt',
  };
  writeFileSync(resolve(rhiDir, `${label}.dawn-readback.rgba`), pixels);
  writeFileSync(resolve(rhiDir, `${label}.dawn-readback.json`), `${JSON.stringify(dawnReadback, null, 2)}\n`);
  device.value.destroy?.();
  return { tape, report, draws: summary.draws?.length ?? 0, inspectedDraw, inspect, dawnReadback };
}

async function runLiveMaterialScenario(baseUrl, page) {
  const expectedVariant = `M3_MULTI_UV_VARIANT=${startVariant}`;
  const expectedPost = inheritanceLiveMaterialScenario ? inheritancePost : 'inversion';
  const reversePipelineJourney = inheritanceLiveMaterialScenario && reversePipelineFalsifier;
  const expectedHistory = doubleResizeChurn
    ? '640x360>480x270>720x405>640x360>480x270>720x405>640x360'
    : resizeChurn
      ? '640x360>480x270>720x405>640x360'
      : '640x360';

  const runLeg = async (falsified, label) => {
    const falsifierQuery = falsified
      ? inheritanceLiveMaterialScenario
        ? inheritanceFalsifierKind === 'pipeline'
          ? '&falsify-pipeline'
          : reversePipelineFalsifier
            ? inheritanceFalsifierKind === 'reverse-pipeline-texture'
              ? '&falsify-reverse-pipeline&falsify-live-inheritance'
              : '&falsify-reverse-pipeline'
            : '&falsify-live-inheritance'
        : '&falsify-live-material'
      : '';
    const liveMaterialQuery = inheritanceLiveMaterialScenario
      ? 'inheritance-two-slot-swap-resize'
      : 'two-slot-swap-resize';
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(
      `${baseUrl}/?pipeline=custom&variant=${startVariant}&post=passthrough&live-material=${liveMaterialQuery}${falsifierQuery}${querySuffix}${liveVariantSwitch ? '&live-variant-switch' : ''}`,
      { waitUntil: 'networkidle', timeout: 30_000 },
    );
    await page.waitForFunction(
      ({ expectedAntialias, expectedVariant }) => document.querySelector('#variant-status')?.textContent === expectedVariant
        && document.querySelector('#pipeline-status')?.textContent === 'M3_PIPELINE=custom'
        && document.querySelector('#post-status')?.textContent === 'M3_POST_EFFECT=passthrough'
        && document.querySelector('#texture-status')?.textContent === 'M3_TEXTURE_BINDING=baseColorTexture+detailTexture'
        && document.querySelector('#antialias-status')?.textContent === expectedAntialias
        && globalThis.__forgeaxMultiUvEvidence?.ready === true,
      { expectedAntialias: `M3_ANTIALIAS=${useMsaa ? 'msaa' : 'none'}`, expectedVariant },
      { timeout: 15_000 },
    );
    await waitForNonBlackCanvas(page, `${label} baseline`);
    if (liveVariantSwitch) {
      await select(page, '#variant-select', switchedVariant, '#variant-status');
    }
    await select(page, '#post-select', expectedPost, '#post-status');
    const resizeHistory = [];
    await resizeCanvas(page, 640, 360, resizeHistory);
    if (resizeChurn) {
      await resizeCanvas(page, 480, 270, resizeHistory);
      await resizeCanvas(page, 720, 405, resizeHistory);
      await resizeCanvas(page, 640, 360, resizeHistory);
      if (doubleResizeChurn) {
        await resizeCanvas(page, 480, 270, resizeHistory);
        await resizeCanvas(page, 720, 405, resizeHistory);
        await resizeCanvas(page, 640, 360, resizeHistory);
      }
    }
    if (reversePipelineJourney) {
      await select(page, '#pipeline-select', 'standard', '#pipeline-status');
      await waitForNonBlackCanvas(page, `${label} reverse standard pipeline`);
    }
    await page.evaluate((history) => {
      const evidence = globalThis.__forgeaxMultiUvEvidence;
      if (evidence !== undefined) evidence.liveMaterial.resizeHistory = history;
    }, resizeHistory);
    await waitForNonBlackCanvas(page, `${label} resized before rebind`);
    const before = await capture(page, `${label}-before`);
    const beforeEvidence = await page.evaluate(() => globalThis.__forgeaxMultiUvEvidence?.liveMaterial);
    const mutation = await page.evaluate(() => globalThis.__forgeaxMultiUvEvidence?.applyLiveMaterialRebind());
    if (mutation?.ok !== true) throw new Error(`${label} live material rebind failed: ${JSON.stringify(mutation)}`);
    await page.waitForFunction(() => globalThis.__forgeaxMultiUvEvidence?.liveMaterial.applied === true, null, { timeout: 10_000 });
    await waitForNonBlackCanvas(page, `${label} resized after rebind`);
    const after = await capture(page, `${label}-after`);
    const rhi = await captureRhi(page, `${label}-after`);
    const afterEvidence = await page.evaluate(() => globalThis.__forgeaxMultiUvEvidence?.liveMaterial);
    return {
      before,
      after,
      delta: changedPixels(before, after, liveMaterialScenario ? 0 : 12),
      beforeEvidence,
      afterEvidence,
      rhi,
    };
  };

  const normal = await runLeg(false, 'live-material-normal');
  const falsifier = await runLeg(true, 'live-material-falsifier');
  writeFileSync(resolve(ARTIFACT_DIR, 'live-material-browser.json'), `${JSON.stringify({
    normal: {
      before: { state: normal.before.state, png: normal.before.pngPath },
      after: { state: normal.after.state, png: normal.after.pngPath },
      delta: normal.delta,
      beforeEvidence: normal.beforeEvidence,
      afterEvidence: normal.afterEvidence,
      rhi: normal.rhi,
    },
    falsifier: {
      before: { state: falsifier.before.state, png: falsifier.before.pngPath },
      after: { state: falsifier.after.state, png: falsifier.after.pngPath },
      delta: falsifier.delta,
      beforeEvidence: falsifier.beforeEvidence,
      afterEvidence: falsifier.afterEvidence,
      rhi: falsifier.rhi,
    },
  }, null, 2)}\n`);

  const normalLive = normal.afterEvidence;
  const falsifiedLive = falsifier.afterEvidence;
  if (normal.delta === null || normal.delta.changed < 1000) throw new Error(`two-slot rebind did not change normal pixels: ${JSON.stringify(normal.delta)}`);
  if (normalLive?.baseColorSlotChanged !== true || normalLive.detailSlotChanged !== true) {
    throw new Error(`normal two-slot evidence did not change both slots: ${JSON.stringify(normalLive)}`);
  }
  if (normalLive.afterComponentMaterialHandle !== normalLive.afterMaterialHandle) {
    throw new Error(`normal component handle did not follow rebind: ${JSON.stringify(normalLive)}`);
  }
  const expectedPipeline = reversePipelineJourney ? 'M3_PIPELINE=standard' : 'M3_PIPELINE=custom';
  if (normal.after.state.pipeline !== expectedPipeline || normal.after.state.post !== `M3_POST_EFFECT=${expectedPost}`) {
    throw new Error(`normal rebind left composed scene: ${JSON.stringify(normal.after.state)}`);
  }
  if (textureSlotFalsifier && falsifiedLive?.baseColorSlotChanged === true && falsifiedLive.detailSlotChanged === true) {
    throw new Error(`live-material falsifier still changed both slots: ${JSON.stringify(falsifiedLive)}`);
  }
  if (
    inheritanceLiveMaterialScenario &&
    (inheritanceFalsifierKind === 'texture' || inheritanceFalsifierKind === 'reverse-pipeline-texture')
  ) {
    if (falsifier.delta === null || falsifier.delta.changed !== 0) {
      throw new Error(`inheritance live-material falsifier changed pixels: ${JSON.stringify(falsifier.delta)}`);
    }
  } else if (falsifier.delta === null || falsifier.delta.changed < 1000) {
    throw new Error(`live-material falsifier was not observable: ${JSON.stringify(falsifier.delta)}`);
  }
  if (inheritanceLiveMaterialScenario) {
    if (normalLive?.inheritanceBacked !== true || falsifiedLive?.inheritanceBacked !== true) {
      throw new Error(`inheritance live material path was not marked inheritance-backed: ${JSON.stringify({ normalLive, falsifiedLive })}`);
    }
    if (
      normalLive.sourceRootGuid === null ||
      normalLive.sourceDerivedGuid === null ||
      normalLive.sourceRootGuid === normalLive.sourceDerivedGuid ||
      normalLive.sourceRootArtifactDigest !== normalLive.sourceArtifactDigest ||
      normalLive.sourceRootCookInputDigest !== normalLive.sourceCookInputDigest
    ) {
      throw new Error(`inheritance live material source evidence is incomplete: ${JSON.stringify(normalLive)}`);
    }
    const inheritanceMaterialCausality =
      normalLive.beforeTextureHandles[0] !== normalLive.afterTextureHandles[0] &&
      normalLive.beforeTextureHandles[1] !== normalLive.afterTextureHandles[1];
    const falsifierMaterialCausality =
      falsifiedLive.beforeTextureHandles[0] !== falsifiedLive.afterTextureHandles[0] &&
      falsifiedLive.beforeTextureHandles[1] !== falsifiedLive.afterTextureHandles[1];
    if (!inheritanceMaterialCausality) {
      throw new Error(`inheritance live material texture causality failed: ${JSON.stringify({ normalLive, falsifiedLive })}`);
    }
    if (textureSlotFalsifier) {
      if (
        falsifierMaterialCausality ||
        falsifiedLive.falsifierMarker !== 'FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind'
      ) {
        throw new Error(`inheritance live material texture falsifier failed: ${JSON.stringify({ normalLive, falsifiedLive })}`);
      }
      if (
        reversePipelineFalsifier &&
        (falsifier.rhi.draws === normal.rhi.draws || falsifier.rhi.dawnReadback.sha256 === normal.rhi.dawnReadback.sha256)
      ) {
        throw new Error(`inheritance reverse pipeline texture falsifier failed: ${JSON.stringify({ normalLive, falsifiedLive, normalRhi: normal.rhi, falsifierRhi: falsifier.rhi })}`);
      }
    } else if (
      !falsifierMaterialCausality ||
      falsifiedLive.falsifierMarker !== null ||
      falsifier.rhi.draws === normal.rhi.draws ||
      falsifier.rhi.dawnReadback.sha256 === normal.rhi.dawnReadback.sha256
    ) {
      throw new Error(`inheritance pipeline falsifier failed: ${JSON.stringify({ normalLive, falsifiedLive, normalRhi: normal.rhi, falsifierRhi: falsifier.rhi })}`);
    }
  }
  if (liveVariantSwitch) {
    const expectedAfterVariant = `M3_MULTI_UV_VARIANT=${switchedVariant}`;
    if (normal.after.state.variant !== expectedAfterVariant || falsifier.after.state.variant !== expectedAfterVariant) {
      throw new Error(`inheritance live-material variant switch failed: ${JSON.stringify({ normal: normal.after.state, falsifier: falsifier.after.state })}`);
    }
  }
  if (inheritanceDepthPost) {
    const normalHasDepth = hasDepthBinding(normal.rhi.report);
    const falsifierHasDepth = hasDepthBinding(falsifier.rhi.report);
    const expectedFalsifierHasDepth = !reversePipelineFalsifier && inheritanceFalsifierKind !== 'pipeline';
    if (!normalHasDepth || falsifierHasDepth !== expectedFalsifierHasDepth) {
      throw new Error(
        `inherited depth post binding topology mismatch: normal=${normalHasDepth} falsifier=${falsifierHasDepth} expectedFalsifier=${expectedFalsifierHasDepth}`,
      );
    }
  }
  for (const [label, leg] of [['normal', normal], ['falsifier', falsifier]]) {
    if (leg.afterEvidence?.resizeHistory.join('>') !== expectedHistory) {
      throw new Error(`${label} resize history wrong: ${leg.afterEvidence?.resizeHistory.join('>')}`);
    }
    if (leg.rhi.draws === 0 || leg.rhi.inspect?.drawCall === undefined || leg.rhi.dawnReadback.nonBlackPixelCount === 0) {
      throw new Error(`${label} RHI/Dawn evidence missing: ${JSON.stringify(leg.rhi)}`);
    }
  }
  console.log(`[m3-live-material] PASS pipeline=${expectedPipeline.replace('M3_PIPELINE=', '')} post=${expectedPost} msaa=${useMsaa} startVariant=${startVariant} variantSwitch=${liveVariantSwitch} falsifier=${inheritanceLiveMaterialScenario ? inheritanceFalsifierKind : 'texture'} normalChanged=${normal.delta.changed} falsifierChanged=${falsifier.delta.changed} normalSlots=${normalLive.baseColorSlotChanged}/${normalLive.detailSlotChanged} falsifierSlots=${falsifiedLive?.baseColorSlotChanged}/${falsifiedLive?.detailSlotChanged} resizeHistory=${expectedHistory} draws=${normal.rhi.draws}/${falsifier.rhi.draws} dawnSha=${normal.rhi.dawnReadback.sha256}/${falsifier.rhi.dawnReadback.sha256} artifacts=${ARTIFACT_DIR}`);
}

async function runDepthPostScenario(baseUrl, page) {
  const expectedAntialias = `M3_ANTIALIAS=${useMsaa ? 'msaa' : 'none'}`;
  const expectedHistory = doubleResizeChurn
    ? '640x360>480x270>720x405>640x360>480x270>720x405>640x360'
    : resizeChurn
      ? '640x360>480x270>720x405>640x360'
      : '640x360';
  const depthQuery = `${useMsaa ? '&msaa' : ''}&post=depth`;
  const waitForReady = async () => {
    await page.waitForFunction(
      ({ expectedAntialias }) => document.querySelector('#variant-status')?.textContent === 'M3_MULTI_UV_VARIANT=true'
        && document.querySelector('#pipeline-status')?.textContent === 'M3_PIPELINE=custom'
        && document.querySelector('#post-status')?.textContent === 'M3_POST_EFFECT=depth'
        && document.querySelector('#antialias-status')?.textContent === expectedAntialias,
      { expectedAntialias },
      { timeout: 15_000 },
    );
  };

  await page.goto(`${baseUrl}/?pipeline=custom&variant=true${depthQuery}`, { waitUntil: 'networkidle', timeout: 30_000 });
  await waitForReady();
  await waitForNonBlackCanvas(page, 'depth baseline');
  const normalBaseline = await capture(page, 'depth-normal-baseline');
  await select(page, '#variant-select', 'false', '#variant-status');
  await waitForNonBlackCanvas(page, 'depth variant');
  const normalVariant = await capture(page, 'depth-normal-variant-false');
  const resizeHistory = [];
  await resizeCanvas(page, 640, 360, resizeHistory);
  if (resizeChurn) {
    await resizeCanvas(page, 480, 270, resizeHistory);
    await resizeCanvas(page, 720, 405, resizeHistory);
    await resizeCanvas(page, 640, 360, resizeHistory);
    if (doubleResizeChurn) {
      await resizeCanvas(page, 480, 270, resizeHistory);
      await resizeCanvas(page, 720, 405, resizeHistory);
      await resizeCanvas(page, 640, 360, resizeHistory);
    }
  }
  await waitForNonBlackCanvas(page, 'depth resized');
  const normalResized = await capture(page, 'depth-normal-resized');
  const normalRhi = await captureRhi(page, 'depth-normal-resized');
  await waitForNonBlackCanvas(page, 'depth post-rhi');
  const normalRendered = await capture(page, 'depth-normal-rendered');

  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${baseUrl}/?pipeline=custom&falsify-depth&variant=true${depthQuery}`, { waitUntil: 'networkidle', timeout: 30_000 });
  await waitForReady();
  await waitForNonBlackCanvas(page, 'depth falsifier');
  const falsifiedBaseline = await capture(page, 'depth-falsified-baseline');
  const falsifiedRhi = await captureRhi(page, 'depth-falsified-baseline');
  const delta = changedPixels(normalBaseline, falsifiedBaseline);
  const normalHasDepth = hasDepthBinding(normalRhi.report);
  const falsifierHasDepth = hasDepthBinding(falsifiedRhi.report);
  if (delta === null || delta.changed < 1000) throw new Error(`depth falsifier did not change pixels: ${JSON.stringify(delta)}`);
  if (!normalHasDepth || falsifierHasDepth) {
    throw new Error(`depth binding topology mismatch: normal=${normalHasDepth} falsifier=${falsifierHasDepth}`);
  }
  if (normalRhi.dawnReadback.nonBlackPixelCount === 0 || falsifiedRhi.dawnReadback.nonBlackPixelCount === 0) {
    throw new Error('depth post fresh-Dawn replay was black');
  }
  if (resizeHistory.join('>') !== expectedHistory) {
    throw new Error(`depth resize history wrong: ${resizeHistory.join('>')}`);
  }
  writeFileSync(resolve(ARTIFACT_DIR, 'depth-browser.json'), `${JSON.stringify({
    normal: {
      baseline: { state: normalBaseline.state, sha256: createHash('sha256').update(normalBaseline.pixels).digest('hex') },
      variant: { state: normalVariant.state, sha256: createHash('sha256').update(normalVariant.pixels).digest('hex') },
      resized: { state: normalResized.state, sha256: createHash('sha256').update(normalResized.pixels).digest('hex') },
      rendered: { state: normalRendered.state, sha256: createHash('sha256').update(normalRendered.pixels).digest('hex') },
      resizeHistory,
      rhi: { report: normalRhi.report, draws: normalRhi.draws, dawn: normalRhi.dawnReadback, hasDepthBinding: normalHasDepth },
    },
    falsifier: {
      baseline: { state: falsifiedBaseline.state, sha256: createHash('sha256').update(falsifiedBaseline.pixels).digest('hex') },
      rhi: { report: falsifiedRhi.report, draws: falsifiedRhi.draws, dawn: falsifiedRhi.dawnReadback, hasDepthBinding: falsifierHasDepth },
    },
    delta,
  }, null, 2)}\n`);
  console.log(`[m3-depth-post] PASS msaa=${useMsaa} resizeHistory=${resizeHistory.join('>')} changedPixels=${delta.changed} depthBinding=${normalHasDepth} falsifierDepthBinding=${falsifierHasDepth} dawnSha=${normalRhi.dawnReadback.sha256}/${falsifiedRhi.dawnReadback.sha256} artifacts=${ARTIFACT_DIR}`);
}

async function runDepthLiveSwitchScenario(baseUrl, page) {
  const expectedAntialias = `M3_ANTIALIAS=${useMsaa ? 'msaa' : 'none'}`;
  const expectedHistory = '640x360>480x270>720x405>640x360>480x270>720x405>640x360';
  const querySuffix = useMsaa ? '&msaa' : '';
  const waitForReady = async (pipeline) => {
    await page.waitForFunction(
      ({ expectedAntialias, expectedPipeline }) => document.querySelector('#variant-status')?.textContent === 'M3_MULTI_UV_VARIANT=true'
        && document.querySelector('#pipeline-status')?.textContent === `M3_PIPELINE=${expectedPipeline}`
        && document.querySelector('#post-status')?.textContent === 'M3_POST_EFFECT=depth'
        && document.querySelector('#antialias-status')?.textContent === expectedAntialias,
      { expectedAntialias, expectedPipeline: pipeline },
      { timeout: 15_000 },
    );
  };

  const drive = async (falsified) => {
    const falsifierQuery = falsified ? '&falsify-pipeline' : '';
    await page.goto(`${baseUrl}/?pipeline=standard&variant=true&post=depth${querySuffix}${falsifierQuery}`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    await waitForReady('standard');
    await waitForNonBlackCanvas(page, `${falsified ? 'falsifier' : 'normal'} standard depth`);
    const standard = await capture(page, `${falsified ? 'falsified' : 'normal'}-depth-standard`);

    await select(page, '#pipeline-select', 'custom', '#pipeline-status');
    await waitForReady('custom');
    await waitForNonBlackCanvas(page, `${falsified ? 'falsifier' : 'normal'} live custom depth`);
    const resizeHistory = [];
    await resizeCanvas(page, 640, 360, resizeHistory);
    await resizeCanvas(page, 480, 270, resizeHistory);
    await resizeCanvas(page, 720, 405, resizeHistory);
    await resizeCanvas(page, 640, 360, resizeHistory);
    await resizeCanvas(page, 480, 270, resizeHistory);
    await resizeCanvas(page, 720, 405, resizeHistory);
    await resizeCanvas(page, 640, 360, resizeHistory);
    await waitForNonBlackCanvas(page, `${falsified ? 'falsifier' : 'normal'} resized custom depth`);
    const custom = await capture(page, `${falsified ? 'falsified' : 'normal'}-depth-live-custom`);
    const rhi = await captureRhi(page, `${falsified ? 'falsified' : 'normal'}-depth-live-custom`);
    const hasDepth = hasDepthBinding(rhi.report);
    if (resizeHistory.join('>') !== expectedHistory) {
      throw new Error(`depth live-switch resize history wrong: ${resizeHistory.join('>')}`);
    }
    if (rhi.dawnReadback.nonBlackPixelCount === 0) {
      throw new Error(`depth live-switch Fresh Dawn replay was black: falsified=${falsified}`);
    }
    return { standard, custom, rhi, hasDepth, resizeHistory };
  };

  const normal = await drive(false);
  const falsifier = await drive(true);
  const delta = changedPixels(normal.custom, falsifier.custom);
  if (!normal.hasDepth || falsifier.hasDepth) {
    throw new Error(`depth live-switch binding topology mismatch: normal=${normal.hasDepth} falsifier=${falsifier.hasDepth}`);
  }
  if (delta === null || delta.changed < 1000) {
    throw new Error(`depth live-switch falsifier did not change pixels: ${JSON.stringify(delta)}`);
  }
  writeFileSync(resolve(ARTIFACT_DIR, 'depth-live-switch-browser.json'), `${JSON.stringify({
    normal: {
      standard: { state: normal.standard.state, sha256: createHash('sha256').update(normal.standard.pixels).digest('hex') },
      custom: { state: normal.custom.state, sha256: createHash('sha256').update(normal.custom.pixels).digest('hex') },
      rhi: { report: normal.rhi.report, draws: normal.rhi.draws, dawn: normal.rhi.dawnReadback, hasDepthBinding: normal.hasDepth },
      resizeHistory: normal.resizeHistory,
    },
    falsifier: {
      standard: { state: falsifier.standard.state, sha256: createHash('sha256').update(falsifier.standard.pixels).digest('hex') },
      custom: { state: falsifier.custom.state, sha256: createHash('sha256').update(falsifier.custom.pixels).digest('hex') },
      rhi: { report: falsifier.rhi.report, draws: falsifier.rhi.draws, dawn: falsifier.rhi.dawnReadback, hasDepthBinding: falsifier.hasDepth },
      resizeHistory: falsifier.resizeHistory,
    },
    delta,
  }, null, 2)}\n`);
  console.log(`[m3-depth-live-switch] PASS msaa=${useMsaa} resizeHistory=${normal.resizeHistory.join('>')} changedPixels=${delta.changed} depthBinding=${normal.hasDepth}/${falsifier.hasDepth} dawnSha=${normal.rhi.dawnReadback.sha256}/${falsifier.rhi.dawnReadback.sha256} artifacts=${ARTIFACT_DIR}`);
}

async function runDepthReverseLiveSwitchScenario(baseUrl, page) {
  const expectedAntialias = `M3_ANTIALIAS=${useMsaa ? 'msaa' : 'none'}`;
  const expectedHistory = '640x360>480x270>720x405>640x360>480x270>720x405>640x360';
  const querySuffix = useMsaa ? '&msaa' : '';
  const waitForReady = async (pipeline) => {
    await page.waitForFunction(
      ({ expectedAntialias, expectedPipeline }) => document.querySelector('#variant-status')?.textContent === 'M3_MULTI_UV_VARIANT=true'
        && document.querySelector('#pipeline-status')?.textContent === `M3_PIPELINE=${expectedPipeline}`
        && document.querySelector('#post-status')?.textContent === 'M3_POST_EFFECT=depth'
        && document.querySelector('#antialias-status')?.textContent === expectedAntialias,
      { expectedAntialias, expectedPipeline: pipeline },
      { timeout: 15_000 },
    );
  };

  const drive = async (falsified) => {
    const falsifierQuery = falsified ? '&falsify-reverse-pipeline' : '';
    await page.goto(`${baseUrl}/?pipeline=custom&variant=true&post=depth${querySuffix}${falsifierQuery}`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    await waitForReady('custom');
    await waitForNonBlackCanvas(page, `${falsified ? 'falsifier' : 'normal'} custom depth`);
    const custom = await capture(page, `${falsified ? 'falsified' : 'normal'}-depth-reverse-custom`);

    await select(page, '#pipeline-select', 'standard', '#pipeline-status');
    await waitForReady('standard');
    const resizeHistory = [];
    await resizeCanvas(page, 640, 360, resizeHistory);
    await resizeCanvas(page, 480, 270, resizeHistory);
    await resizeCanvas(page, 720, 405, resizeHistory);
    await resizeCanvas(page, 640, 360, resizeHistory);
    await resizeCanvas(page, 480, 270, resizeHistory);
    await resizeCanvas(page, 720, 405, resizeHistory);
    await resizeCanvas(page, 640, 360, resizeHistory);
    await waitForNonBlackCanvas(page, `${falsified ? 'falsifier' : 'normal'} resized standard depth`);
    const standard = await capture(page, `${falsified ? 'falsified' : 'normal'}-depth-reverse-live-standard`);
    const rhi = await captureRhi(page, `${falsified ? 'falsified' : 'normal'}-depth-reverse-live-standard`);
    const hasDepth = hasDepthBinding(rhi.report);
    if (resizeHistory.join('>') !== expectedHistory) {
      throw new Error(`depth reverse live-switch resize history wrong: ${resizeHistory.join('>')}`);
    }
    if (rhi.dawnReadback.nonBlackPixelCount === 0) {
      throw new Error(`depth reverse live-switch Fresh Dawn replay was black: falsified=${falsified}`);
    }
    return { custom, standard, rhi, hasDepth, resizeHistory };
  };

  const normal = await drive(false);
  const falsifier = await drive(true);
  const delta = changedPixels(normal.standard, falsifier.standard);
  if (!normal.hasDepth || falsifier.hasDepth) {
    throw new Error(`depth reverse live-switch binding topology mismatch: normal=${normal.hasDepth} falsifier=${falsifier.hasDepth}`);
  }
  if (delta === null || delta.changed < 1000) {
    throw new Error(`depth reverse live-switch falsifier did not change pixels: ${JSON.stringify(delta)}`);
  }
  writeFileSync(resolve(ARTIFACT_DIR, 'depth-reverse-live-switch-browser.json'), `${JSON.stringify({
    normal: {
      custom: { state: normal.custom.state, sha256: createHash('sha256').update(normal.custom.pixels).digest('hex') },
      standard: { state: normal.standard.state, sha256: createHash('sha256').update(normal.standard.pixels).digest('hex') },
      rhi: { report: normal.rhi.report, draws: normal.rhi.draws, dawn: normal.rhi.dawnReadback, hasDepthBinding: normal.hasDepth },
      resizeHistory: normal.resizeHistory,
    },
    falsifier: {
      custom: { state: falsifier.custom.state, sha256: createHash('sha256').update(falsifier.custom.pixels).digest('hex') },
      standard: { state: falsifier.standard.state, sha256: createHash('sha256').update(falsifier.standard.pixels).digest('hex') },
      rhi: { report: falsifier.rhi.report, draws: falsifier.rhi.draws, dawn: falsifier.rhi.dawnReadback, hasDepthBinding: falsifier.hasDepth },
      resizeHistory: falsifier.resizeHistory,
    },
    delta,
  }, null, 2)}\n`);
  console.log(`[m3-depth-reverse-live-switch] PASS msaa=${useMsaa} resizeHistory=${normal.resizeHistory.join('>')} changedPixels=${delta.changed} depthBinding=${normal.hasDepth}/${falsifier.hasDepth} dawnSha=${normal.rhi.dawnReadback.sha256}/${falsifier.rhi.dawnReadback.sha256} artifacts=${ARTIFACT_DIR}`);
}

const port = Number(process.env.FORGEAX_BROWSER_PORT ?? 55980) + Math.floor(Math.random() * 20);
const viteProc = spawn(process.execPath, [
  resolve(REPO_ROOT, 'node_modules/vite/bin/vite.js'),
  '--host', '127.0.0.1', '--port', String(port),
], {
  cwd: APP_ROOT,
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let browser;
try {
  const baseUrl = await waitForVite(viteProc);
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) consoleErrors.push(message.text());
  });

  if (liveMaterialScenario) {
    await runLiveMaterialScenario(baseUrl, page);
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
  } else if (depthReverseLiveSwitch) {
    await runDepthReverseLiveSwitchScenario(baseUrl, page);
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
  } else if (depthLiveSwitch) {
    await runDepthLiveSwitchScenario(baseUrl, page);
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
  } else if (depthPost) {
    await runDepthPostScenario(baseUrl, page);
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
  } else {
  await page.goto(`${baseUrl}/?pipeline=custom&variant=${startVariant}${querySuffix}`, { waitUntil: 'networkidle', timeout: 30_000 });
  try {
    await page.waitForFunction(
      ({ expectedAntialias, expectedVariant }) => document.querySelector('#variant-status')?.textContent === `M3_MULTI_UV_VARIANT=${expectedVariant}`
        && document.querySelector('#pipeline-status')?.textContent === 'M3_PIPELINE=custom'
        && document.querySelector('#post-status')?.textContent === 'M3_POST_EFFECT=passthrough'
        && document.querySelector('#antialias-status')?.textContent === expectedAntialias,
      { expectedAntialias: `M3_ANTIALIAS=${useMsaa ? 'msaa' : 'none'}`, expectedVariant: startVariant },
      { timeout: 15_000 },
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      body: document.body.innerText,
      variant: document.querySelector('#variant-status')?.textContent ?? null,
      post: document.querySelector('#post-status')?.textContent ?? null,
      html: document.documentElement.outerHTML.slice(0, 1600),
    }));
    throw new Error(`${error instanceof Error ? error.message : String(error)} diagnostic=${JSON.stringify({ ...diagnostic, pageErrors, consoleErrors })}`);
  }
  await page.waitForTimeout(500);
  const liveBaseline = await capture(page, `live-${startVariant}-passthrough`);
  await select(page, '#variant-select', switchedVariant, '#variant-status');
  await select(page, '#post-select', 'inversion', '#post-status');
  const liveCombined = await capture(page, 'live-false-inversion');
  await select(page, '#post-select', 'passthrough', '#post-status');
  const livePostControl = await capture(page, 'live-false-passthrough');
  const variantDelta = changedPixels(liveBaseline, liveCombined);
  const postDelta = changedPixels(livePostControl, liveCombined);

  const resizeHistory = [];
  await resizeCanvas(page, 640, 360, resizeHistory);
  if (resizeChurn) {
    await resizeCanvas(page, 480, 270, resizeHistory);
    await resizeCanvas(page, 720, 405, resizeHistory);
    await resizeCanvas(page, 640, 360, resizeHistory);
    if (doubleResizeChurn) {
      await resizeCanvas(page, 480, 270, resizeHistory);
      await resizeCanvas(page, 720, 405, resizeHistory);
      await resizeCanvas(page, 640, 360, resizeHistory);
    }
  }
  await select(page, '#post-select', 'inversion', '#post-status');
  const liveResized = await capture(page, 'live-resized-inversion');
  const rhi = await captureRhi(page, 'live-resized-inversion');

  await page.goto(`${baseUrl}/?pipeline=custom&falsify=constant&variant=${startVariant}${querySuffix}`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(
    ({ expectedAntialias, expectedVariant }) => document.querySelector('#variant-status')?.textContent === `M3_MULTI_UV_VARIANT=${expectedVariant}`
      && document.querySelector('#pipeline-status')?.textContent === 'M3_PIPELINE=custom'
      && document.querySelector('#antialias-status')?.textContent === expectedAntialias,
    { expectedAntialias: `M3_ANTIALIAS=${useMsaa ? 'msaa' : 'none'}`, expectedVariant: startVariant },
    { timeout: 15_000 },
  );
  await select(page, '#post-select', 'inversion', '#post-status');
  const falsifiedStart = await capture(page, `falsified-${startVariant}-inversion`);
  await select(page, '#variant-select', switchedVariant, '#variant-status');
  const falsifiedSwitched = await capture(page, `falsified-${switchedVariant}-inversion`);
  const falsifiedTrue = startVariant === 'true' ? falsifiedStart : falsifiedSwitched;
  const falsifiedFalse = startVariant === 'false' ? falsifiedStart : falsifiedSwitched;
  const falsifiedVariantDelta = changedPixels(falsifiedTrue, falsifiedFalse);

  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${baseUrl}/?pipeline=custom&${falsifierQuery}&variant=${startVariant}${querySuffix}`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(
    ({ expectedAntialias, expectedVariant }) => document.querySelector('#variant-status')?.textContent === `M3_MULTI_UV_VARIANT=${expectedVariant}`
      && document.querySelector('#pipeline-status')?.textContent === 'M3_PIPELINE=custom'
      && document.querySelector('#texture-status')?.textContent === 'M3_TEXTURE_BINDING=baseColorTexture+detailTexture'
      && document.querySelector('#antialias-status')?.textContent === expectedAntialias,
    { expectedAntialias: `M3_ANTIALIAS=${useMsaa ? 'msaa' : 'none'}`, expectedVariant: startVariant },
    { timeout: 15_000 },
  );
  await select(page, '#variant-select', switchedVariant, '#variant-status');
  await select(page, '#post-select', 'inversion', '#post-status');
  const textureResizeHistory = [];
  if (resizeChurn) {
    await resizeCanvas(page, 640, 360, textureResizeHistory);
    await resizeCanvas(page, 480, 270, textureResizeHistory);
    await resizeCanvas(page, 720, 405, textureResizeHistory);
    await resizeCanvas(page, 640, 360, textureResizeHistory);
    if (doubleResizeChurn) {
      await resizeCanvas(page, 480, 270, textureResizeHistory);
      await resizeCanvas(page, 720, 405, textureResizeHistory);
      await resizeCanvas(page, 640, 360, textureResizeHistory);
    }
  }
  const falsified = await capture(page, falsifierLabel);
  const falsifierRhi = await captureRhi(page, falsifierLabel);
  const falsifierDelta = changedPixels(resizeChurn ? liveResized : liveCombined, falsified);

  writeFileSync(resolve(ARTIFACT_DIR, 'browser-composed.json'), `${JSON.stringify({
    live: {
      variantDelta,
      postDelta,
      baseline: { state: liveBaseline.state, png: liveBaseline.pngPath },
      combined: { state: liveCombined.state, png: liveCombined.pngPath },
      resized: { state: liveResized.state, png: liveResized.pngPath },
      resizeHistory,
    },
    falsifier: {
      variantDelta: falsifiedVariantDelta,
      true: falsifiedTrue.state,
      false: falsifiedFalse.state,
      kind: falsifierKind,
      secondTextureDelta: falsifierDelta,
      secondTexture: { state: falsified.state, png: falsified.pngPath },
      resizeHistory: textureResizeHistory,
    },
    rhi: { tape: rhi.tape, report: rhi.report, draws: rhi.draws, inspectedDraw: rhi.inspectedDraw, dawnReadback: rhi.dawnReadback },
    falsifierRhi: { tape: falsifierRhi.tape, report: falsifierRhi.report, draws: falsifierRhi.draws, inspectedDraw: falsifierRhi.inspectedDraw, dawnReadback: falsifierRhi.dawnReadback },
  }, null, 2)}\n`);

  await page.close();
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
  if (variantDelta === null || variantDelta.changed < 1000) throw new Error(`combined variant delta too small: ${JSON.stringify(variantDelta)}`);
  if (postDelta === null || postDelta.changed < 1000) throw new Error(`post-process delta too small: ${JSON.stringify(postDelta)}`);
  if (liveCombined.state.pipeline !== 'M3_PIPELINE=custom' || liveResized.state.pipeline !== 'M3_PIPELINE=custom') throw new Error('combined post effect left the custom pipeline');
  if (falsifiedVariantDelta === null || falsifiedVariantDelta.changed >= 100) throw new Error(`falsifier did not kill variant delta: ${JSON.stringify(falsifiedVariantDelta)}`);
  if (falsifierDelta === null || falsifierDelta.changed < 1000) throw new Error(`${falsifierKind} falsifier did not change pixels: ${JSON.stringify(falsifierDelta)}`);
  if (liveResized.width !== 640 || liveResized.height !== 360) throw new Error(`resize dimensions wrong: ${liveResized.width}x${liveResized.height}`);
  const expectedResizeHistory = doubleResizeChurn
    ? '640x360>480x270>720x405>640x360>480x270>720x405>640x360'
    : resizeChurn
      ? '640x360>480x270>720x405>640x360'
      : '640x360';
  if (resizeHistory.join('>') !== expectedResizeHistory || (resizeChurn && textureResizeHistory.join('>') !== expectedResizeHistory)) {
    throw new Error(`resize churn history wrong: normal=${resizeHistory.join('>')} texture=${textureResizeHistory.join('>')}`);
  }
  if (rhi.draws === 0 || rhi.inspect?.drawCall === undefined) throw new Error(`RHI draw evidence missing: ${JSON.stringify(rhi)}`);
  if (falsifierRhi.draws === 0 || falsifierRhi.inspect?.drawCall === undefined) throw new Error(`RHI falsifier evidence missing: ${JSON.stringify(falsifierRhi)}`);
  if (useMsaa) {
    const reports = [rhi.report, falsifierRhi.report].map((path) => JSON.parse(readFileSync(path, 'utf8')));
    for (const [index, report] of reports.entries()) {
      const msaaTextureResourceCount = report.events.filter((event) => event.kind === 'createTexture' && event.desc?.sampleCount === 4).length;
      const resolveTargetCount = report.events.filter((event) => event.kind === 'beginRenderPass' && event.colorAttachmentResolveTargetHandleIds?.some((handleId) => handleId !== undefined && handleId !== null)).length;
      if (msaaTextureResourceCount < 2 || resolveTargetCount < 1) throw new Error(`MSAA topology missing for ${index === 0 ? 'normal' : 'falsifier'}: resources=${msaaTextureResourceCount} resolves=${resolveTargetCount}`);
    }
    if (rhi.dawnReadback.nonBlackPixelCount === 0 || falsifierRhi.dawnReadback.nonBlackPixelCount === 0) throw new Error('MSAA fresh-Dawn replay was black');
  }
  console.log(`[m3-composed] PASS pipeline=custom msaa=${useMsaa} startVariant=${startVariant} falsifier=${falsifierKind} variantChanged=${variantDelta.changed} postChanged=${postDelta.changed} falsifiedVariantChanged=${falsifiedVariantDelta.changed} secondTextureChanged=${falsifierDelta.changed} resized=${liveResized.width}x${liveResized.height} resizeHistory=${resizeHistory.join('>')} draws=${rhi.draws}/${falsifierRhi.draws} dawnSha=${rhi.dawnReadback.sha256}/${falsifierRhi.dawnReadback.sha256} artifacts=${ARTIFACT_DIR}`);
  }
} catch (error) {
  console.error(`[m3-composed] FAIL - ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  viteProc.kill('SIGTERM');
  await sleep(300);
  await browser?.close();
}
