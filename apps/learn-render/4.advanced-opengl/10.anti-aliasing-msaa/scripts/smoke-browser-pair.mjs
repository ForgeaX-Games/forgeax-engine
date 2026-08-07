// Browser/RHI-debug MSAA OFF/ON capture gate.
// It keeps the tutorial's user-facing toggle on the public path and checks the
// tape facts that a single default-OFF capture cannot prove.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const appDir = resolve(import.meta.dirname, '..');
const artifactDir = process.env.FORGEAX_MSAA_PAIR_ARTIFACT_DIR
  ? resolve(process.env.INIT_CWD ?? process.cwd(), process.env.FORGEAX_MSAA_PAIR_ARTIFACT_DIR)
  : resolve(appDir, '.forgeax-debug');

function tapeFacts(report, runId) {
  const msaaTextures = report.events
    .filter((event) => event.kind === 'createTexture' && (event.desc.sampleCount ?? 1) > 1)
    .map((event) => ({
      handleId: event.handleId,
      sampleCount: event.desc.sampleCount,
      format: event.desc.format,
      size: event.desc.size,
    }));
  const msaaPipelines = report.events
    .filter((event) => event.kind === 'createRenderPipeline' && (event.desc.multisample?.count ?? 1) > 1)
    .map((event) => ({
      handleId: event.handleId,
      sampleCount: event.desc.multisample.count,
      targetFormats: event.desc.fragment?.targets?.map((target) => target.format) ?? [],
    }));
  const resolvePasses = report.events
    .filter((event) => event.kind === 'beginRenderPass')
    .map((event) => ({
      passHandleId: event.passHandleId,
      views: event.colorAttachmentViewHandleIds,
      resolveTargets: event.colorAttachmentResolveTargetHandleIds ?? [],
    }))
    .filter((pass) => pass.resolveTargets.some((handleId) => handleId !== undefined && handleId !== null));
  return {
    runId,
    eventCount: report.events.length,
    blobCount: report.header?.blobEntries?.length ?? null,
    msaaTextures,
    msaaPipelines,
    resolvePasses,
    valid: report.valid,
  };
}

function pixelOracle(offB64, onB64) {
  const off = Buffer.from(offB64, 'base64');
  const on = Buffer.from(onB64, 'base64');
  if (off.length !== on.length || off.length % 4 !== 0) {
    throw new Error(`pixel buffers disagree: off=${off.length} on=${on.length}`);
  }
  let diffCount = 0;
  let sumRgbDelta = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < off.length; i += 4) {
    let pixelDiff = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(off[i + channel] - on[i + channel]);
      if (delta > 0) pixelDiff = true;
      sumRgbDelta += delta;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    if (pixelDiff) diffCount += 1;
  }
  const totalPixels = off.length / 4;
  return {
    diffCount,
    totalPixels,
    diffFraction: diffCount / totalPixels,
    meanRgbDelta: sumRgbDelta / (totalPixels * 3 * 255),
    maxChannelDelta: maxChannelDelta / 255,
  };
}

async function capture(page, label) {
  const result = await page.evaluate(async (captureLabel) => {
    const capture = globalThis.__forgeax?.captureFrame;
    if (typeof capture !== 'function') throw new Error('window.__forgeax.captureFrame missing');
    const readPixels = globalThis.__captureAntiAliasingMsaa;
    if (typeof readPixels !== 'function') throw new Error('window.__captureAntiAliasingMsaa missing');
    const out = await capture(1);
    const pixelsValue = await readPixels();
    const pixels = pixelsValue instanceof Uint8Array ? pixelsValue : new Uint8Array(pixelsValue);
    let binary = '';
    for (let i = 0; i < pixels.length; i += 0x2000) {
      binary += String.fromCharCode(...pixels.subarray(i, i + 0x2000));
    }
    return {
      label: captureLabel,
      out,
      hud: document.querySelector('#msaa-hud')?.textContent ?? null,
      pixels: btoa(binary),
    };
  }, label);
  const tapePath = resolve(appDir, result.out.tapePath);
  const reportPath = resolve(appDir, result.out.reportPath);
  if (!existsSync(tapePath) || !existsSync(reportPath)) {
    throw new Error(`capture ${label} missing artifacts: ${tapePath} / ${reportPath}`);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const targetTapePath = resolve(artifactDir, `msaa-${label}.tape.bin`);
  const targetReportPath = resolve(artifactDir, `msaa-${label}.report.json`);
  copyFileSync(tapePath, targetTapePath);
  copyFileSync(reportPath, targetReportPath);
  return {
    label,
    runId: result.out.runId,
    hud: result.hud,
    tapePath: targetTapePath,
    reportPath: targetReportPath,
    pixels: result.pixels,
    facts: tapeFacts(report, result.out.runId),
  };
}

mkdirSync(artifactDir, { recursive: true });
const server = spawn(process.execPath, [resolve(appDir, 'node_modules/vite/bin/vite.js')], {
  cwd: appDir,
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
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

const consoleErrors = [];
const notFound = [];
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
  const page = await (await browser.newContext()).newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() === 404) notFound.push(response.url());
  });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(3_000);

  const off = await capture(page, 'off');
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
  });
  await page.waitForTimeout(750);
  const on = await capture(page, 'on');
  const oracle = pixelOracle(off.pixels, on.pixels);
  if (off.hud !== 'MSAA: OFF' || on.hud !== 'MSAA: ON') {
    throw new Error(`HUD lineage failed: off=${off.hud} on=${on.hud}`);
  }
  if (on.facts.msaaTextures.length === 0 || on.facts.msaaPipelines.length === 0 || on.facts.resolvePasses.length === 0) {
    throw new Error('MSAA capture lacks multisample texture, pipeline, or resolve evidence');
  }
  if (oracle.diffCount < 1 || oracle.diffFraction > 0.5) {
    throw new Error(`localized off/on oracle failed: ${JSON.stringify(oracle)}`);
  }
  const result = {
    url,
    off: { ...off, pixels: undefined },
    on: { ...on, pixels: undefined },
    oracle,
    consoleErrors,
    notFound,
  };
  writeFileSync(resolve(artifactDir, 'msaa-pair.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  if (server.pid !== undefined) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
}
