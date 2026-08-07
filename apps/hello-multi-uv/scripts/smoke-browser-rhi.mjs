#!/usr/bin/env node
// M3 custom-pipeline RHI gate: capture the live multi-UV scene after selecting
// the user-registered RenderGraph, then replay and inspect the tape on fresh Dawn.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(APP_ROOT, '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(APP_ROOT, '.forgeax-debug', 'm3-custom-pipeline-rhi'),
);
const falsifyPipeline = process.env.FORGEAX_M3_FALSIFY === '1';
const useMsaa = process.env.FORGEAX_M3_MSAA === '1';
const falsifyMsaaResolve = process.env.FORGEAX_M3_FALSIFY_MSAA_RESOLVE === '1';
const selectedVariant = process.env.FORGEAX_M3_VARIANT === 'true' ? 'true' : 'false';
const selectedPost = process.env.FORGEAX_M3_POST === 'inversion' ? 'inversion' : 'passthrough';
const switchVariantAfterPipeline = process.env.FORGEAX_M3_SWITCH_VARIANT === '1';
const switchPostAfterPipeline = process.env.FORGEAX_M3_SWITCH_POST === '1';
const resizeChurn = process.env.FORGEAX_M3_RESIZE_CHURN === '1';
const doubleResizeChurn = process.env.FORGEAX_M3_DOUBLE_RESIZE_CHURN === '1';
const expectedVariant = switchVariantAfterPipeline
  ? selectedVariant === 'true'
    ? 'false'
    : 'true'
  : selectedVariant;
const expectedPost = switchPostAfterPipeline
  ? selectedPost === 'inversion'
    ? 'passthrough'
    : 'inversion'
  : selectedPost;
mkdirSync(ARTIFACT_DIR, { recursive: true });

async function findFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (port === undefined) {
          reject(new Error('could not resolve an ephemeral Vite port'));
        } else {
          resolvePort(String(port));
        }
      });
    });
  });
}

const requestedVitePort = process.env.FORGEAX_M3_RHI_PORT;
const vitePort = requestedVitePort !== undefined && requestedVitePort !== '0' ? requestedVitePort : await findFreePort();

function fail(message) {
  console.error(`[m3-browser-rhi] FAIL - ${message}`);
  process.exitCode = 1;
}

function resolveArtifact(path) {
  if (typeof path !== 'string') throw new Error('capture path is not a string');
  if (path.startsWith('/')) return path;
  const inApp = resolve(APP_ROOT, path);
  if (existsSync(inApp)) return inApp;
  return resolve(REPO_ROOT, path);
}

function countLiveTextures(report, matches) {
  const live = new Set();
  for (const event of report.events) {
    const handleId = event.handleId ?? event.id;
    if (handleId === undefined || handleId === null) continue;
    if (event.kind === 'createTexture' && matches(event.desc)) {
      live.add(handleId);
    } else if (event.kind === 'destroyTexture') {
      live.delete(handleId);
    }
  }
  return live.size;
}

async function waitForVite(proc) {
  let url;
  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`[vite] ${text}`);
    url ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
  });
  proc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));
  const deadline = Date.now() + 30_000;
  while (url === undefined && Date.now() < deadline) await sleep(200);
  if (url === undefined) throw new Error('vite did not become ready in 30s');
  return url;
}

async function bootstrapDawn(recordedCaps) {
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
  const requiredFeatures = [
    [recordedCaps.textureCompressionBc, 'texture-compression-bc'],
    [recordedCaps.textureCompressionEtc2, 'texture-compression-etc2'],
    [recordedCaps.textureCompressionAstc, 'texture-compression-astc'],
  ]
    .filter(([recorded]) => recorded)
    .map(([, feature]) => feature)
    .filter((feature) => adapter.value.features.has(feature));
  const device = await adapter.value.requestDevice({
    requiredFeatures,
    requiredLimits: { maxUniformBufferBindingSize: 262144 },
  });
  if (!device.ok) throw new Error(`Dawn requestDevice failed: ${device.error.code}`);
  return { device: device.value, rhiWebgpu };
}

const viteProc = spawn(process.execPath, [
  resolve(REPO_ROOT, 'node_modules/vite/bin/vite.js'),
  '--host',
  '127.0.0.1',
  '--port',
  vitePort,
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

  const query = `?pipeline=custom&variant=${selectedVariant}&post=${selectedPost}${falsifyPipeline ? '&falsify-pipeline' : ''}${useMsaa ? '&msaa' : ''}${falsifyMsaaResolve ? '&falsify-msaa-resolve' : ''}`;
  await page.goto(`${baseUrl}/${query}`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(
    ({ variant, post, useMsaa: expectedMsaa }) =>
      document.querySelector('#pipeline-status')?.textContent === 'M3_PIPELINE=custom' &&
      document.querySelector('#variant-status')?.textContent === `M3_MULTI_UV_VARIANT=${variant}` &&
      document.querySelector('#texture-status')?.textContent === 'M3_TEXTURE_BINDING=baseColorTexture+detailTexture' &&
      document.querySelector('#post-status')?.textContent === `M3_POST_EFFECT=${post}` &&
      document.querySelector('#antialias-status')?.textContent === `M3_ANTIALIAS=${expectedMsaa ? 'msaa' : 'none'}`,
    { variant: selectedVariant, post: selectedPost, useMsaa },
    { timeout: 30_000 },
  );
  const initialPostStatus = await page.locator('#post-status').textContent();
  await page.waitForTimeout(2500);
  const canvas = page.locator('#app');
  const initialCanvasSize = await canvas.evaluate((element) => ({ width: element.width, height: element.height }));
  const resizeHistory = [];
  const resizeCanvas = async (width, height) => {
    await canvas.evaluate((element, size) => {
      element.width = size.width;
      element.height = size.height;
      element.style.width = `${size.width}px`;
      element.style.height = `${size.height}px`;
    }, { width, height });
    await page.waitForFunction(
      (size) => {
        const element = document.querySelector('#app');
        return element?.width === size.width && element.height === size.height;
      },
      { width, height },
      { timeout: 30_000 },
    );
    await page.waitForTimeout(700);
    const current = await canvas.evaluate((element) => ({ width: element.width, height: element.height }));
    resizeHistory.push(`${current.width}x${current.height}`);
  };
  await resizeCanvas(640, 360);
  if (resizeChurn) {
    await resizeCanvas(480, 270);
    await resizeCanvas(720, 405);
    await resizeCanvas(640, 360);
    if (doubleResizeChurn) {
      await resizeCanvas(480, 270);
      await resizeCanvas(720, 405);
      await resizeCanvas(640, 360);
    }
  }
  const resizedCanvasSize = await canvas.evaluate((element) => ({ width: element.width, height: element.height }));
  if (initialCanvasSize.width === resizedCanvasSize.width && initialCanvasSize.height === resizedCanvasSize.height) {
    throw new Error(`canvas did not resize: ${initialCanvasSize.width}x${initialCanvasSize.height}`);
  }
  await page.selectOption('#pipeline-select', 'standard');
  await page.waitForFunction(
    () => document.querySelector('#pipeline-status')?.textContent === 'M3_PIPELINE=standard',
    undefined,
    { timeout: 30_000 },
  );
  await page.selectOption('#pipeline-select', 'custom');
  await page.waitForFunction(
    () => document.querySelector('#pipeline-status')?.textContent === 'M3_PIPELINE=custom',
    undefined,
    { timeout: 30_000 },
  );
  if (switchVariantAfterPipeline) {
    await page.selectOption('#variant-select', expectedVariant);
    await page.waitForFunction(
      (variant) => document.querySelector('#variant-status')?.textContent === `M3_MULTI_UV_VARIANT=${variant}`,
      expectedVariant,
      { timeout: 30_000 },
    );
  }
  if (switchPostAfterPipeline) {
    await page.selectOption('#post-select', expectedPost);
    await page.waitForFunction(
      (post) => document.querySelector('#post-status')?.textContent === `M3_POST_EFFECT=${post}`,
      expectedPost,
      { timeout: 30_000 },
    );
  }
  await page.waitForTimeout(1000);
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('canvas bounding box missing');
  await page.locator('#variant-control, #pipeline-control').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden';
  });
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'custom-live.png'), clip: box });
  const captured = await page.evaluate(async ({ falsifyPipeline: shouldFalsify, shouldSwitchVariant, shouldSwitchPost, selectedVariant: startupVariant, selectedPost: startupPost, resizeHistory: capturedResizeHistory }) => ({
    pipeline: document.querySelector('#pipeline-status')?.textContent ?? '',
    variant: document.querySelector('#variant-status')?.textContent ?? '',
    post: document.querySelector('#post-status')?.textContent ?? '',
    selectedVariant: startupVariant,
    selectedPost: startupPost,
    texture: document.querySelector('#texture-status')?.textContent ?? '',
    antialias: document.querySelector('#antialias-status')?.textContent ?? '',
    canvas: { width: document.querySelector('#app')?.width ?? 0, height: document.querySelector('#app')?.height ?? 0 },
    resizeHistory: capturedResizeHistory,
    pipelineSwitchedAfterResize: true,
    variantSwitchedAfterPipeline: shouldSwitchVariant,
    postSwitchedAfterPipeline: shouldSwitchPost,
    falsifyPipeline: shouldFalsify,
    tape: await globalThis.__forgeax?.captureFrame(1),
  }), { falsifyPipeline, shouldSwitchVariant: switchVariantAfterPipeline, shouldSwitchPost: switchPostAfterPipeline, selectedVariant, selectedPost: initialPostStatus, resizeHistory });
  writeFileSync(resolve(ARTIFACT_DIR, 'capture.json'), `${JSON.stringify(captured, null, 2)}\n`);
  await browser.close();
  browser = undefined;
  viteProc.kill('SIGTERM');
  await sleep(500);

  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
  if (captured.pipeline !== 'M3_PIPELINE=custom') throw new Error(`wrong pipeline status: ${captured.pipeline}`);
  if (captured.variant !== `M3_MULTI_UV_VARIANT=${expectedVariant}`) throw new Error(`wrong variant status: ${captured.variant}`);
  if (captured.post !== `M3_POST_EFFECT=${expectedPost}`) throw new Error(`wrong post status: ${captured.post}`);
  if (captured.selectedPost !== `M3_POST_EFFECT=${selectedPost}`) throw new Error(`wrong selected post status: ${captured.selectedPost}`);
  if (captured.texture !== 'M3_TEXTURE_BINDING=baseColorTexture+detailTexture') throw new Error(`wrong texture status: ${captured.texture}`);
  if (captured.antialias !== `M3_ANTIALIAS=${useMsaa ? 'msaa' : 'none'}`) throw new Error(`wrong antialias status: ${captured.antialias}`);
  if (captured.canvas.width !== 640 || captured.canvas.height !== 360) {
    throw new Error(`wrong resized canvas: ${captured.canvas.width}x${captured.canvas.height}`);
  }
  const expectedResizeHistory = doubleResizeChurn
    ? '640x360>480x270>720x405>640x360>480x270>720x405>640x360'
    : resizeChurn
      ? '640x360>480x270>720x405>640x360'
      : '640x360';
  if (captured.resizeHistory.join('>') !== expectedResizeHistory) {
    throw new Error(`wrong resize history: ${captured.resizeHistory.join('>')}`);
  }
  const tape = captured.tape;
  if (tape === undefined || typeof tape !== 'object') throw new Error('captureFrame returned no tape result');
  const tapePath = resolveArtifact(tape.tapePath);
  const reportPath = resolveArtifact(tape.reportPath);
  if (!existsSync(tapePath) || !existsSync(reportPath)) {
    throw new Error(`capture artifacts missing: tape=${tapePath} report=${reportPath}`);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const textureResourceCount = countLiveTextures(
    report,
    (desc) => desc?.size?.width === 2 && desc?.size?.height === 2,
  );
  if (textureResourceCount < 2) throw new Error(`capture report has fewer than two 2x2 texture resources: ${textureResourceCount}`);
  const msaaTextureResourceCount = countLiveTextures(report, (desc) => desc?.sampleCount === 4);
  if (useMsaa && msaaTextureResourceCount < 2) {
    throw new Error(`capture report has fewer than two sampleCount=4 targets: ${msaaTextureResourceCount}`);
  }
  const resolveTargetCount = report.events.filter(
    (event) =>
      event.kind === 'beginRenderPass' &&
      event.colorAttachmentResolveTargetHandleIds?.some(
        (handleId) => handleId !== undefined && handleId !== null,
      ),
  ).length;
  if (useMsaa && !falsifyMsaaResolve && resolveTargetCount < 1) {
    throw new Error(`capture report has no recorded MSAA resolve target: ${resolveTargetCount}`);
  }
  copyFileSync(tapePath, resolve(ARTIFACT_DIR, 'frame-0.tape.bin'));
  copyFileSync(reportPath, resolve(ARTIFACT_DIR, 'frame-0.report.json'));
  const tapeJson = JSON.stringify({ header: report.header, events: report.events });
  const tapeBlob = new Uint8Array(readFileSync(tapePath));
  const { deserializeTape, createReplay } = await import('@forgeax/engine-rhi-debug');
  const deserialized = deserializeTape(tapeJson, tapeBlob);
  if (!deserialized.ok) throw new Error(`deserializeTape failed: ${deserialized.error.code}`);
  const parsedTape = deserialized.value;
  const drawCount = parsedTape.events.filter((event) => event.kind === 'draw' || event.kind === 'drawIndexed').length;
  const minimumDraws = falsifyPipeline ? 1 : 2;
  if (drawCount < minimumDraws) {
    throw new Error(`pipeline tape has only ${drawCount} draw calls; expected at least ${minimumDraws}`);
  }
  const { device, rhiWebgpu } = await bootstrapDawn(parsedTape.rhiCapsRecorded);
  const replayResult = createReplay(parsedTape, device, rhiWebgpu.createShaderModule);
  if (!replayResult.ok) throw new Error(`createReplay failed: ${replayResult.error.code}`);
  const replay = replayResult.value;
  const stepped = await replay.stepTo(parsedTape.events.length - 1);
  if (!stepped.ok) throw new Error(`replay.stepTo failed: ${stepped.error.code}`);
  const dawnReadbackResult = await replay.readbackRt();
  if (!dawnReadbackResult.ok) throw new Error(`replay.readbackRt failed: ${dawnReadbackResult.error.code}`);
  const dawnPixels = dawnReadbackResult.value.pixels;
  let nonBlackPixelCount = 0;
  let rgbTotal = 0;
  for (let index = 0; index < dawnPixels.length; index += 4) {
    const red = dawnPixels[index] ?? 0;
    const green = dawnPixels[index + 1] ?? 0;
    const blue = dawnPixels[index + 2] ?? 0;
    if (red !== 0 || green !== 0 || blue !== 0) nonBlackPixelCount++;
    rgbTotal += red + green + blue;
  }
  const dawnReadbackSha256 = createHash('sha256').update(dawnPixels).digest('hex');
  const dawnReadback = {
    width: dawnReadbackResult.value.width,
    height: dawnReadbackResult.value.height,
    byteLength: dawnPixels.byteLength,
    nonBlackPixelCount,
    meanRgb: rgbTotal / (dawnReadbackResult.value.width * dawnReadbackResult.value.height * 3),
    sha256: dawnReadbackSha256,
    source: 'fresh-dawn-replay.readbackRt',
  };
  writeFileSync(resolve(ARTIFACT_DIR, 'dawn-readback.rgba'), dawnPixels);
  writeFileSync(resolve(ARTIFACT_DIR, 'dawn-readback.json'), `${JSON.stringify(dawnReadback, null, 2)}\n`);
  const { inspectDrawJson } = await import('@forgeax/engine-rhi-debug/inspect-core');
  const inspections = [];
  for (const drawIdx of [...new Set([0, drawCount - 1])]) {
    const inspected = await inspectDrawJson(replay, drawIdx, parsedTape.events, device);
    if (!inspected.ok) throw new Error(`inspect draw ${drawIdx} failed: ${inspected.error.code}`);
    const value = inspected.value;
    if (value.bindings.length === 0 || value.drawCall === undefined || value.rt === undefined) {
      throw new Error(`inspect draw ${drawIdx} missing binding/draw/rt evidence`);
    }
    inspections.push({ drawIdx, bindings: value.bindings.length, hasDrawCall: true, hasRenderTarget: true });
  }
  device.destroy?.();
  const result = {
    pipeline: captured.pipeline,
    variant: captured.variant,
    post: captured.post,
    texture: captured.texture,
    antialias: captured.antialias,
    textureResourceCount,
    msaaTextureResourceCount,
    resolveTargetCount,
    canvas: captured.canvas,
    resizeHistory: captured.resizeHistory,
    pipelineSwitchedAfterResize: captured.pipelineSwitchedAfterResize,
    variantSwitchedAfterPipeline: captured.variantSwitchedAfterPipeline,
    falsifyPipeline: captured.falsifyPipeline,
    runId: tape.runId,
    eventCount: parsedTape.events.length,
    blobCount: parsedTape.blobPool.size,
    drawCount,
    inspections,
    dawnReadback,
    screenshot: resolve(ARTIFACT_DIR, 'custom-live.png'),
  };
  writeFileSync(resolve(ARTIFACT_DIR, 'rhi-summary.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (useMsaa && falsifyMsaaResolve) {
    if (resolveTargetCount !== 0) {
      throw new Error(`MSAA resolve falsifier unexpectedly retained a resolve target: ${resolveTargetCount}`);
    }
    console.log(
      `[m3-browser-rhi] PASS_FALSIFY - sampleCount=4 scene target had no resolve target and was offered to the single-sample fullscreen input; textureResourceCount=${textureResourceCount} msaaTextureResourceCount=${msaaTextureResourceCount} draws=${drawCount} resolveTargetCount=0 resizeHistory=${captured.resizeHistory.join('>')} dawnReadbackSha256=${dawnReadbackSha256} artifacts=${ARTIFACT_DIR}`,
    );
    process.exit(0);
  }
  console.log(`[m3-browser-rhi] PASS - pipeline=${captured.pipeline} variant=${captured.variant} texture=${captured.texture} post=${captured.post} antialias=${captured.antialias} textureResourceCount=${textureResourceCount} msaaTextureResourceCount=${msaaTextureResourceCount} resolveTargetCount=${resolveTargetCount} draws=${drawCount} events=${parsedTape.events.length} variantSwitch=${captured.variantSwitchedAfterPipeline} postSwitch=${captured.postSwitchedAfterPipeline} resizeHistory=${captured.resizeHistory.join('>')} dawnReadbackSha256=${dawnReadbackSha256} artifacts=${ARTIFACT_DIR}`);
} catch (error) {
  if (browser !== undefined) await browser.close();
  viteProc.kill('SIGTERM');
  await sleep(300);
  fail(error instanceof Error ? error.message : String(error));
}
