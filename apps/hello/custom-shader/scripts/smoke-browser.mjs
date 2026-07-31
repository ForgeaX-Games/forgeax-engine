#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const APP = '@forgeax/hello-custom-shader';
const ROOT = new URL('../../../..', import.meta.url).pathname;

function waitForServer(process) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Local:\s+(https?:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    };
    process.stdout.on('data', onData);
    process.stderr.on('data', onData);
    process.once('exit', (code) => reject(new Error(`vite exited before ready: ${code}\n${output}`)));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function falsificationVariant() {
  if (process.env.FORGEAX_FALSIFY_MISSING_PARENT === '1') return 'missing-derived-parent';
  if (process.env.FORGEAX_FALSIFY_UV0_TRANSFORM === '1') return 'uv0-transform-loss';
  if (process.env.FORGEAX_FALSIFY_MISSING_NORMAL_RESOURCE === '1') return 'missing-normal-resource';
  if (process.env.FORGEAX_FALSIFY_SWAPPED_NORMAL_BINDING === '1') return 'swapped-normal-binding';
  if (process.env.FORGEAX_FALSIFY_NORMAL_SLOT_SWAP === '1') return 'normal-slot-swap';
  return undefined;
}

const liveNormalSlotSwap =
  process.env.FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_SWAP === '1' ||
  process.env.FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_SWAP_RESIZE === '1';
const liveNormalSlotResize =
  process.env.FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_RESIZE === '1' ||
  process.env.FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_SWAP_RESIZE === '1';
const liveNormalSlotSwapResize = process.env.FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_SWAP_RESIZE === '1';
const liveTwoSlotSwap =
  process.env.FORGEAX_MATERIAL_LIVE_TWO_SLOT_SWAP === '1' ||
  process.env.FORGEAX_MATERIAL_LIVE_TWO_SLOT_SWAP_RESIZE === '1';
const liveTwoSlotResize =
  process.env.FORGEAX_MATERIAL_LIVE_TWO_SLOT_RESIZE === '1' ||
  process.env.FORGEAX_MATERIAL_LIVE_TWO_SLOT_SWAP_RESIZE === '1';
const liveTwoSlotSwapResize = process.env.FORGEAX_MATERIAL_LIVE_TWO_SLOT_SWAP_RESIZE === '1';
const liveMutationEnabled = liveNormalSlotSwap || liveTwoSlotSwap;
const liveResizeRebuild = liveNormalSlotResize || liveTwoSlotResize;
const liveMode = liveTwoSlotSwapResize
  ? 'two-slot-swap-resize'
  : liveTwoSlotResize
    ? 'two-slot-resize'
    : liveTwoSlotSwap
      ? 'two-slot-swap'
      : liveNormalSlotSwapResize
        ? 'normal-slot-swap-resize'
        : liveNormalSlotResize
          ? 'normal-slot-resize'
          : liveNormalSlotSwap
            ? 'normal-slot-swap'
            : undefined;

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJson(entry)]),
    );
  }
  return value;
}

async function renderBrowserVisualProbe(page, variant, screenshotPath) {
  const evidence = await page.evaluate(async (selectedVariant) => {
    const canvas = document.createElement('canvas');
    canvas.id = 'forgeax-normal-slot-probe';
    canvas.width = 64;
    canvas.height = 64;
    canvas.style.cssText = 'display:block;width:64px;height:64px;position:fixed;left:0;top:0;z-index:10';
    document.body.append(canvas);
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter === null || adapter === undefined) throw new Error('browser visual probe has no WebGPU adapter');
    const device = await adapter.requestDevice();
    const format = 'rgba8unorm';
    const context = canvas.getContext('webgpu');
    if (context === null) throw new Error('browser visual probe has no WebGPU canvas context');
    context.configure({ device, format, alphaMode: 'opaque' });
    const target = device.createTexture({
      size: { width: 64, height: 64 },
      format,
      usage: 1 | 16,
    });
    const readback = device.createBuffer({ size: 16384, usage: 1 | 8 });
    const baseColorTexture = device.createTexture({
      size: { width: 1, height: 1 },
      format,
      usage: 2 | 4,
    });
    const normalTexture = device.createTexture({
      size: { width: 1, height: 1 },
      format,
      usage: 2 | 4,
    });
    device.queue.writeTexture({ texture: baseColorTexture }, new Uint8Array([64, 64, 64, 255]), { bytesPerRow: 4 }, { width: 1, height: 1 });
    device.queue.writeTexture({ texture: normalTexture }, new Uint8Array([32, 224, 32, 255]), { bytesPerRow: 4 }, { width: 1, height: 1 });
    const shader = device.createShaderModule({
      code: `
@group(0) @binding(0) var baseColorTexture : texture_2d<f32>;
@group(0) @binding(1) var normalTexture : texture_2d<f32>;
@group(0) @binding(2) var textureSampler : sampler;
struct VsOut { @builtin(position) position : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs_main(@builtin(vertex_index) index : u32) -> VsOut {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out : VsOut;
  out.position = vec4<f32>(positions[index], 0.0, 1.0);
  out.uv = positions[index] * 0.5 + vec2<f32>(0.5);
  return out;
}
@fragment fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let base = textureSample(baseColorTexture, textureSampler, in.uv);
  let normal = textureSample(normalTexture, textureSampler, in.uv);
  return vec4<f32>(base.rgb * (0.5 + normal.g * 0.5), 1.0);
}`,
    });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs_main' },
      fragment: { module: shader, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: baseColorTexture.createView() },
        { binding: 1, resource: (selectedVariant === 'normal-slot-swap' ? baseColorTexture : normalTexture).createView() },
        { binding: 2, resource: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }) },
      ],
    });
    const encoder = device.createCommandEncoder();
    for (const view of [target.createView(), context.getCurrentTexture().createView()]) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: 256 }, { width: 64, height: 64 });
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    await readback.mapAsync(1);
    const pixel = [...new Uint8Array(readback.getMappedRange()).slice(0, 4)];
    readback.unmap();
    target.destroy();
    readback.destroy();
    baseColorTexture.destroy();
    normalTexture.destroy();
    device.destroy();
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const evidenceCanvas = document.createElement('canvas');
    evidenceCanvas.width = 64;
    evidenceCanvas.height = 64;
    const evidenceContext = evidenceCanvas.getContext('2d');
    if (evidenceContext === null) throw new Error('browser visual probe cannot create evidence canvas');
    evidenceContext.fillStyle = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
    evidenceContext.fillRect(0, 0, 64, 64);
    return { status: 'pass', variant: selectedVariant, pixel, dataUrl: evidenceCanvas.toDataURL('image/png') };
  }, variant);
  const comma = evidence.dataUrl.indexOf(',');
  assert(comma !== -1, 'browser visual probe did not return a PNG data URL');
  writeFileSync(screenshotPath, Buffer.from(evidence.dataUrl.slice(comma + 1), 'base64'));
  return { status: evidence.status, variant: evidence.variant, pixel: evidence.pixel };
}

const vite = spawn('pnpm', ['-F', APP, 'dev', '--', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  const url = await waitForServer(vite);
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const variant = falsificationVariant();
  const query = new URLSearchParams();
  if (variant !== undefined) query.set('falsify', variant);
  if (liveMode !== undefined) query.set('live', liveMode);
  const queryString = query.toString();
  const targetUrl = queryString === '' ? url : `${url}?${queryString}`;
  await page.goto(targetUrl, { waitUntil: 'networkidle' });
  if (variant === 'missing-derived-parent') {
    const marker = `FALSIFY_EXPECTED_FAILURE:${variant}`;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !consoleErrors.some((entry) => entry.includes(marker))) {
      await delay(100);
    }
    assert(consoleErrors.some((entry) => entry.includes(marker)), 'missing-parent falsification was not attributed');
    throw new Error(marker);
  }
  if (variant === 'missing-normal-resource') {
    const marker = `FALSIFY_EXPECTED_FAILURE:${variant}`;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !consoleErrors.some((entry) => entry.includes(marker))) {
      await delay(100);
    }
    assert(consoleErrors.some((entry) => entry.includes(marker)), 'missing-normal-resource falsification was not attributed');
    throw new Error(marker);
  }
  if (variant === 'uv0-transform-loss') {
    await page.waitForFunction(() => globalThis.__forgeaxMaterialEvidence?.ready === true, null, {
      timeout: 5000,
    });
    const evidence = await page.evaluate(() => globalThis.__forgeaxMaterialEvidence);
    assert(
      JSON.stringify(stableJson(evidence.renderedSamplingInput)) !==
        JSON.stringify(stableJson(evidence.resolvedSamplingInput)),
      'UV0 falsification did not change the rendered sampling input',
    );
    throw new Error(`FALSIFY_EXPECTED_FAILURE:${variant}`);
  }
  await page.waitForFunction(() => globalThis.__forgeaxMaterialEvidence?.ready === true, null, {
    timeout: 30000,
  });
  const evidence = await page.evaluate(() => globalThis.__forgeaxMaterialEvidence);
  const artifactDir = process.env.FORGEAX_MATERIAL_ARTIFACT_DIR;
  let liveVisual;
  if (liveMutationEnabled || liveResizeRebuild) {
    await page.waitForFunction(
      () => globalThis.__forgeaxMaterialEvidence?.frameCount >= 2,
      null,
      { timeout: 30000 },
    );
    const beforePath =
      artifactDir === undefined
        ? undefined
        : resolve(artifactDir, liveTwoSlotSwap || liveTwoSlotResize ? 'live-two-slot-before.png' : 'live-normal-slot-before.png');
    if (beforePath !== undefined) {
      mkdirSync(artifactDir, { recursive: true });
      await page.screenshot({ path: beforePath, fullPage: false });
    }
    const beforeEvidence = await page.evaluate(() => globalThis.__forgeaxMaterialEvidence);
    assert(beforeEvidence.liveMutation?.applied === false, 'live mutation occurred before the before-frame capture');
    await page.waitForFunction(
      () => {
        const evidence = globalThis.__forgeaxMaterialEvidence;
        if (evidence?.resizeRebuild?.enabled === true) {
          return evidence.resizeRebuild.afterCanvas?.[0] === 384 &&
            evidence.resizeRebuild.afterCanvas?.[1] === 192 &&
            (evidence.frameCount ?? 0) > 170;
        }
        const mutation = evidence?.liveMutation;
        return mutation?.applied === true &&
          mutation.appliedFrame !== null &&
          (evidence?.frameCount ?? 0) > mutation.appliedFrame + 20;
      },
      null,
      { timeout: 30000 },
    );
    const afterPath = artifactDir === undefined
      ? undefined
      : resolve(
          artifactDir,
          liveResizeRebuild
            ? liveTwoSlotSwap || liveTwoSlotResize
              ? 'live-two-slot-resize-after.png'
              : 'live-normal-slot-resize-after.png'
            : liveTwoSlotSwap
              ? 'live-two-slot-after.png'
              : 'live-normal-slot-after.png',
        );
    if (afterPath !== undefined) {
      await page.screenshot({ path: afterPath, fullPage: false });
    }
    liveVisual = { beforePath, afterPath };
    Object.assign(evidence, await page.evaluate(() => globalThis.__forgeaxMaterialEvidence));
  }
  const screenshotPath =
    artifactDir === undefined ? undefined : resolve(artifactDir, 'custom-material.png');
  if (screenshotPath !== undefined && !liveMutationEnabled) {
    await page.waitForFunction(() => globalThis.__forgeaxMaterialEvidence?.frameCount >= 2, null, {
      timeout: 30000,
    });
    mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: resolve(artifactDir, 'custom-material-app.png'), fullPage: false });
    const browserVisual = await renderBrowserVisualProbe(page, variant ?? 'normal', screenshotPath);
    evidence.browserVisual = browserVisual;
  }
  if (variant === 'swapped-normal-binding') {
    assert(
      evidence.renderedTextureHandles[0] === evidence.resolvedTextureHandles[1] &&
        evidence.renderedTextureHandles[1] === evidence.resolvedTextureHandles[0],
      'swapped-normal-binding falsification did not swap the per-slot resources',
    );
    throw new Error(`FALSIFY_EXPECTED_FAILURE:${variant}`);
  }
  if (variant === 'normal-slot-swap') {
    assert(
      evidence.renderedTextureHandles[0] === evidence.resolvedTextureHandles[0] &&
        evidence.renderedTextureHandles[1] === evidence.resolvedTextureHandles[0],
      'normal-slot-swap falsification changed a slot other than normalTexture',
    );
    throw new Error(`FALSIFY_EXPECTED_FAILURE:${variant}`);
  }
  if (liveMutationEnabled || liveResizeRebuild) {
    const mutation = evidence.liveMutation;
    if (liveNormalSlotSwap) {
      assert(mutation?.enabled === true, 'live normal-slot mutation was not enabled');
      assert(mutation?.applied === true, 'live normal-slot mutation was not applied');
      assert(mutation.beforeMaterialHandle !== mutation.afterMaterialHandle, 'live rebind reused the material handle');
      assert(mutation.afterComponentMaterialHandle === mutation.afterMaterialHandle, 'World.set did not expose the replacement material handle');
      assert(
        mutation.beforeTextureHandles[0] === mutation.afterTextureHandles[0] &&
          mutation.beforeTextureHandles[1] !== mutation.afterTextureHandles[1],
        'live rebind changed a resource other than normalTexture',
      );
    }
    if (liveTwoSlotSwap) {
      assert(mutation?.enabled === true, 'live two-slot mutation was not enabled');
      assert(mutation?.applied === true, 'live two-slot mutation was not applied');
      assert(mutation.beforeMaterialHandle !== mutation.afterMaterialHandle, 'live two-slot rebind reused the material handle');
      assert(mutation.afterComponentMaterialHandle === mutation.afterMaterialHandle, 'World.set did not expose the two-slot replacement material handle');
      assert(mutation.baseColorSlotChanged === true, 'live two-slot rebind did not change baseColorTexture');
      assert(mutation.normalSlotChanged === true, 'live two-slot rebind did not change normalTexture');
      assert(
        mutation.beforeTextureHandles[0] !== mutation.afterTextureHandles[0] &&
          mutation.beforeTextureHandles[1] !== mutation.afterTextureHandles[1],
        'live two-slot rebind did not change both authored texture resources',
      );
    }
    if (liveResizeRebuild) {
      const resize = evidence.resizeRebuild;
      assert(resize?.enabled === true, 'live resize/rebuild was not enabled');
      assert(resize.applied === true, 'live resize/rebuild was not applied');
      assert(JSON.stringify(resize.afterCanvas) === JSON.stringify([384, 192]), 'live resize/rebuild did not reach 384x192');
      assert(
        resize.postResizeMaterialHandle === (liveMutationEnabled ? mutation.afterMaterialHandle : mutation.beforeMaterialHandle),
        'material handle did not survive resize/rebuild',
      );
    }
    evidence.liveVisual = liveVisual;
    assert(evidence.rendererErrorCodes.length === 0, `renderer errors: ${evidence.rendererErrorCodes.join('; ')}`);
    assert(evidence.drawErrorCodes.length === 0, `draw errors: ${evidence.drawErrorCodes.join('; ')}`);
  }
  assert(evidence.browserPath === true, 'browser evidence did not use the Vite path');
  assert(evidence.webgpu === true, 'browser evidence did not reach WebGPU');
  assert(evidence.rootGuid !== evidence.derivedGuid, 'root and derived GUIDs must remain distinct');
  assert(evidence.rootArtifactDigest === evidence.derivedArtifactDigest, 'cooked artifacts diverged');
  assert(evidence.rootCookInputDigest === evidence.derivedCookInputDigest, 'specialization inputs diverged');
  assert(evidence.renderedTextureHandles[0] !== evidence.renderedTextureHandles[1], 'base and normal textures must be distinct');
  assert(
    JSON.stringify(evidence.renderedTextureHandles) === JSON.stringify(evidence.resolvedTextureHandles),
    'browser texture bindings do not match the resolved per-slot resources',
  );
  assert(
    JSON.stringify(stableJson(evidence.values)) === JSON.stringify(stableJson(evidence.resolvedValues)),
    'browser values do not match the runtime-resolved record',
  );
  assert(consoleErrors.length === 0, `browser console errors: ${consoleErrors.join('; ')}`);
  console.log(
    JSON.stringify({
      status: 'pass',
      browserPath: evidence.browserPath,
      rootArtifactDigest: evidence.rootArtifactDigest,
      derivedArtifactDigest: evidence.derivedArtifactDigest,
      rootCookInputDigest: evidence.rootCookInputDigest,
      textureHandlesDistinct: evidence.renderedTextureHandles[0] !== evidence.renderedTextureHandles[1],
      liveMutation: evidence.liveMutation,
      resizeRebuild: evidence.resizeRebuild,
      liveVisual: evidence.liveVisual,
      rendererErrorCodes: evidence.rendererErrorCodes,
      drawErrorCodes: evidence.drawErrorCodes,
      bindGroupCreateCounts: evidence.bindGroupCreateCounts,
      browserVisual: evidence.browserVisual,
    }),
  );
} catch (error) {
  const variant = falsificationVariant();
  if (variant !== undefined) console.error(`FALSIFY_EXPECTED_FAILURE:${variant}`);
  console.error(`custom-shader browser smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
  await delay(100);
}
